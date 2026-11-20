/**
 * 候选 C: 有界并发遍历。语义与候选 A (scan-prune) 逐条对齐, 差异只在遍历的并行度。
 *
 * 并发模型: 原生 `node:fs` 回调 `readdir` 有界并发池 (`CONCURRENCY = 32`) + 显式 LIFO 栈 (零深递归):
 *   - 根预检并发执行并按输入顺序去重; 互不包含的独立根共享同一并发池,
 *     检测到存在嵌套包含关系的根自动回落逐根串行, 严守嵌套根「先到者胜」归属;
 *   - 仅入口根调用一次 `path.join` 规范前缀, 深层派生目录直接 `${dir}${sep}` 零 `path.join` 开销;
 *   - 命中 node_modules 时先将同级子目录压栈并立刻 `pump()`, 再异步 `realpath` 去重不阻塞子树派发。
 */
import { type Dirent, readdir } from 'node:fs';
import { realpath, stat } from 'node:fs/promises';
import { join, sep } from 'node:path';

import { SweepError } from './errors.ts';
import {
  type PathStyle,
  dedupeKey,
  insideAnyRoot,
  nativeStyle,
} from './guard.ts';
import type {
  ScanHit,
  ScanOptions,
  ScanProgressEvent,
  ScanResult,
  Scanner,
  SweepWarning,
} from './types.ts';

const NODE_MODULES = 'node_modules';
const GIT_DIR = '.git';

/** 同时最多在飞的目录数 (32 为实测平台期起点: 4.8 万目录实测与 64 持平且冷缓存/网络盘 FD 占用更克制) */
const CONCURRENCY = 32;

/** 待遍历目录: 绝对路径 + 所属输入根拼写 + 是否为入口根 + 自根起是否已命中白名单 */
interface Pending {
  dir: string;
  root: string;
  isRoot: boolean;
  included: boolean;
}

function compareTarget(a: ScanHit, b: ScanHit): number {
  if (a.target < b.target) return -1;
  if (a.target > b.target) return 1;
  return 0;
}

function rootFailureWarning(error: unknown, root: string): SweepWarning {
  const { code } = error as { code?: string };
  switch (code) {
    case 'ENOENT':
      return {
        code: 'SCAN_ROOT_MISSING',
        message: `根不存在, 已跳过: ${root}`,
        path: root,
      };
    case 'EACCES':
    case 'EPERM':
      return {
        code: 'SCAN_ROOT_UNREADABLE',
        message: `根不可读 (权限不足), 已跳过: ${root}`,
        path: root,
        errno: code,
      };
    case 'ENOTDIR':
      return {
        code: 'SCAN_ROOT_NOT_DIR',
        message: `根不是目录, 已跳过: ${root}`,
        path: root,
      };
    default:
      return {
        code: 'SCAN_ROOT_UNAVAILABLE',
        message: `根不可用 (${code ?? 'UNKNOWN'}), 已跳过: ${root}`,
        path: root,
        errno: code,
      };
  }
}

interface ValidatedRoot {
  root: string;
  real: string;
}

/** 并发预检全部输入根 (按输入顺序保留告警与首次出现的唯一真实根) */
async function precheckRoots(
  inputRoots: readonly string[],
  style: PathStyle,
  warnings: SweepWarning[],
): Promise<ValidatedRoot[]> {
  type ProbeOutcome =
    | { ok: true; root: string; real: string; key: string }
    | { ok: false; warning: SweepWarning };

  const outcomes = await Promise.all(
    inputRoots.map(async (root): Promise<ProbeOutcome> => {
      try {
        const resolved = await realpath(root);
        if (!(await stat(resolved)).isDirectory()) {
          return {
            ok: false,
            warning: {
              code: 'SCAN_ROOT_NOT_DIR',
              message: `根不是目录, 已跳过: ${root}`,
              path: root,
            },
          };
        }
        return {
          ok: true,
          root,
          real: resolved,
          key: dedupeKey(resolved, style),
        };
      } catch (error) {
        return { ok: false, warning: rootFailureWarning(error, root) };
      }
    }),
  );

  const seenRoots = new Set<string>();
  const valid: ValidatedRoot[] = [];
  for (const item of outcomes) {
    if (!item.ok) {
      warnings.push(item.warning);
      continue;
    }
    if (seenRoots.has(item.key)) continue;
    seenRoots.add(item.key);
    valid.push({ root: item.root, real: item.real });
  }
  return valid;
}

/** 检查有效根集合是否存在任意一对嵌套包含关系 (无嵌套时跨根目录树完全不相交, 可安全共享并发池) */
function hasNestedRoots(
  roots: readonly ValidatedRoot[],
  style: PathStyle,
): boolean {
  for (let i = 0; i < roots.length; i += 1) {
    const a = roots[i]!.real;
    for (let j = i + 1; j < roots.length; j += 1) {
      const b = roots[j]!.real;
      if (insideAnyRoot(a, [b], style) || insideAnyRoot(b, [a], style)) {
        return true;
      }
    }
  }
  return false;
}

interface WalkContext {
  style: PathStyle;
  exclude: Set<string>;
  excludeCounts: Map<string, number>;
  include: Set<string>;
  includeCounts: Map<string, number>;
  hits: Map<string, ScanHit>;
  warnings: SweepWarning[];
  signal?: AbortSignal;
  onProgress?: (event: ScanProgressEvent) => void;
}

/** 处理单目录全部 Dirent: 推入待下钻子目录并返回命中需记录的 node_modules 路径 */
function processDirectoryEntries(
  entries: readonly Dirent[],
  item: Pending,
  ctx: WalkContext,
  stack: Pending[],
): string | null {
  const { exclude, excludeCounts, include, includeCounts } = ctx;
  const hasInclude = include.size > 0;
  const hasExclude = exclude.size > 0;
  let prefix: string | null = null;
  let nodeModulesTarget: string | null = null;

  const getPrefix = (): string => {
    if (prefix === null) {
      // 仅入口根调一次 join 兼容带冗余尾斜杠的根拼写; 深层派生目录直接 `${dir}${sep}` 零 path.join 开销
      prefix = item.isRoot
        ? join(item.dir, 'a').slice(0, -1)
        : `${item.dir}${sep}`;
    }
    return prefix;
  };

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (!entry.isDirectory()) continue;

    const name = entry.name;
    if (name === NODE_MODULES) {
      if (item.included) nodeModulesTarget = `${getPrefix()}${name}`;
      continue;
    }
    if (name === GIT_DIR) continue;

    const matchedInclude = !item.included && hasInclude && include.has(name);
    if (matchedInclude) {
      includeCounts.set(name, (includeCounts.get(name) ?? 0) + 1);
    }

    if (hasExclude && exclude.has(name)) {
      excludeCounts.set(name, (excludeCounts.get(name) ?? 0) + 1);
      continue;
    }

    stack.push({
      dir: `${getPrefix()}${name}`,
      root: item.root,
      isRoot: false,
      included: item.included || matchedInclude,
    });
  }

  return nodeModulesTarget;
}

/** 使用原生回调 readdir 有界并发池遍历一组互不相交的根 */
function walkRoots(roots: readonly string[], ctx: WalkContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const { style, include, hits, warnings, signal, onProgress } = ctx;
    const initialIncluded = include.size === 0;
    const stack: Pending[] = [];
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      const root = roots[i]!;
      stack.push({ dir: root, root, isRoot: true, included: initialIncluded });
    }

    let active = 0;
    let hasError = false;
    let firstError: unknown;
    let cancelled = false;
    let settled = false;

    const stopped = (): boolean => hasError || cancelled;

    const fail = (error: unknown): void => {
      if (!hasError) {
        hasError = true;
        firstError = error;
      }
    };

    const maybeSettle = (): void => {
      if (settled || active > 0) return;
      if (!stopped() && stack.length > 0) return;
      settled = true;
      if (hasError) {
        reject(firstError);
      } else if (cancelled || signal?.aborted) {
        reject(
          new SweepError('CANCELLED', '扫描在遍历任务检查点被取消', {
            phase: 'scan',
          }),
        );
      } else {
        resolve();
      }
    };

    const recordHit = (item: Pending, target: string): void => {
      active += 1;
      void realpath(target)
        .catch(() => target)
        .then((resolved) => {
          if (stopped()) return;
          const key = dedupeKey(resolved, style);
          if (hits.has(key)) return;
          const hit: ScanHit = { project: item.dir, target, root: item.root };
          hits.set(key, hit);
          onProgress?.({ kind: 'hit', hit });
        })
        .catch(fail)
        .finally(() => {
          active -= 1;
          pump();
        });
    };

    const pump = (): void => {
      while (active < CONCURRENCY && stack.length > 0 && !stopped()) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        const item = stack.pop()!;
        active += 1;
        readdir(item.dir, { withFileTypes: true }, (err, entries) => {
          try {
            if (err !== null) {
              const errno = (err as { code?: string }).code;
              warnings.push({
                code: 'SCAN_DIR_UNREADABLE',
                message: `目录不可读, 已跳过: ${item.dir}`,
                path: item.dir,
                ...(typeof errno === 'string' ? { errno } : {}),
              });
            } else {
              const nmTarget = processDirectoryEntries(
                entries,
                item,
                ctx,
                stack,
              );
              // 异步记录 node_modules 命中, 不阻塞同级子目录立即由下方 pump() 派发
              if (nmTarget !== null && !stopped()) recordHit(item, nmTarget);
            }
          } catch (error) {
            fail(error);
          } finally {
            active -= 1;
            pump();
          }
        });
      }
      maybeSettle();
    };

    pump();
  });
}

export function createParallelScanner(): Scanner {
  return {
    name: 'parallel',
    async scan(options: ScanOptions): Promise<ScanResult> {
      if (options.signal?.aborted) {
        throw new SweepError('CANCELLED', '扫描在根预检阶段被取消', {
          phase: 'scan',
        });
      }
      const warnings: SweepWarning[] = [];
      const exclude = new Set(options.exclude);
      const excludeCounts = new Map<string, number>();
      for (const name of options.exclude) {
        if (!excludeCounts.has(name)) excludeCounts.set(name, 0);
      }
      const include = new Set(options.include);
      const includeCounts = new Map<string, number>();
      for (const name of options.include) {
        if (!includeCounts.has(name)) includeCounts.set(name, 0);
      }
      const hitsByRealTarget = new Map<string, ScanHit>();
      const style = nativeStyle();

      const validRoots = await precheckRoots(options.roots, style, warnings);
      if (options.signal?.aborted) {
        throw new SweepError('CANCELLED', '扫描在根预检阶段被取消', {
          phase: 'scan',
        });
      }

      const context: WalkContext = {
        style,
        exclude,
        excludeCounts,
        include,
        includeCounts,
        hits: hitsByRealTarget,
        warnings,
        signal: options.signal,
        onProgress: options.onProgress,
      };

      if (validRoots.length > 1 && !hasNestedRoots(validRoots, style)) {
        await walkRoots(
          validRoots.map((r) => r.root),
          context,
        );
      } else {
        for (const item of validRoots) {
          await walkRoots([item.root], context);
        }
      }

      const hits = [...hitsByRealTarget.values()].sort(compareTarget);
      const excludeMatches = options.exclude.map((name) => ({
        name,
        hits: excludeCounts.get(name) ?? 0,
      }));
      const includeMatches = options.include.map((name) => ({
        name,
        hits: includeCounts.get(name) ?? 0,
      }));
      return { hits, warnings, excludeMatches, includeMatches };
    },
  };
}
