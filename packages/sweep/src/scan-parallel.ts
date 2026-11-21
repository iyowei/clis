/**
 * 候选 C (生产胜出实现): 有界并发多预设/多规则遍历引擎。
 * 上游: scan.ts 门面; 下游: scan-roots.ts (根预检)、scan-match.ts (匹配与锚定)、guard.ts (去重键)。
 * 并发与安全红线:
 * - 原生 `node:fs` 回调 `readdir(..., { withFileTypes: true })` 32 路有界并发池 (`CONCURRENCY = 32`) + 显式 LIFO 回压栈 (零深递归);
 * - 独立根共享同一并发池, 存在嵌套关系的根自动串行以严守归属序; 符号链接既不跟进也不命中, `.git` 固定跳过;
 * - 命中目录目标后剪枝不再下钻; 普通候选目录锚定未通过时回压栈继续下钻, 绕过默认护栏 (如项目 `.gradle`) 者未命中严禁回压下钻。
 */
import { type Dirent, readdir } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, sep } from 'node:path';

import type { EntryKind } from './codes.ts';
import { SweepError } from './errors.ts';
import { type PathStyle, dedupeKey, nativeStyle } from './guard.ts';
import {
  type CompiledScanMatcher,
  type TargetMatchResult,
  canBypassDefaultGradleExclude,
  createScanMatcher,
  evaluateTargetMatch,
  isPotentialTarget,
  mergeCleanupActions,
} from './scan-match.ts';
import { hasNestedRoots, precheckRoots } from './scan-roots.ts';
import type {
  ScanHit,
  ScanOptions,
  ScanProgressEvent,
  ScanResult,
  Scanner,
  SweepWarning,
} from './types.ts';

const GIT_DIR = '.git';

/** 同时最多在飞的目录数 (32 为实测平台期起点) */
const CONCURRENCY = 32;

/** 待遍历目录: 绝对路径 + 所属根 + 是否入口根 + 白名单态 + 自根下级起的祖先目录名链 */
interface Pending {
  dir: string;
  root: string;
  isRoot: boolean;
  included: boolean;
  ancestors: readonly string[];
}

interface PendingCandidate {
  name: string;
  kind: EntryKind;
  targetPath: string;
  parentDir: string;
  root: string;
  siblingFiles: ReadonlySet<string>;
  ancestors: readonly string[];
  /** 若为目录且锚定未命中时用于回压栈继续下钻 */
  nextIncluded: boolean;
  nextAncestors: readonly string[];
  /** true 表示该候选曾绕过默认护栏 (如项目级 .gradle), 未命中时严禁回压栈下钻 */
  bypassedExclude?: boolean;
}

function compareTarget(a: ScanHit, b: ScanHit): number {
  if (a.target < b.target) return -1;
  if (a.target > b.target) return 1;
  return 0;
}

interface WalkContext {
  style: PathStyle;
  exclude: Set<string>;
  excludeCounts: Map<string, number>;
  include: Set<string>;
  includeCounts: Map<string, number>;
  matcher: CompiledScanMatcher;
  hits: Map<string, ScanHit>;
  warnings: SweepWarning[];
  signal?: AbortSignal;
  onProgress?: (event: ScanProgressEvent) => void;
}

/** 处理单目录全部 Dirent: 推入普通待下钻子目录, 收集待锚定核验的候选文件/目录 */
function processDirectoryEntries(
  entries: readonly Dirent[],
  item: Pending,
  ctx: WalkContext,
  stack: Pending[],
): PendingCandidate[] {
  const { exclude, excludeCounts, include, includeCounts, matcher } = ctx;
  const hasInclude = include.size > 0;
  const hasExclude = exclude.size > 0;
  let prefix: string | null = null;
  const candidates: PendingCandidate[] = [];

  const getPrefix = (): string => {
    if (prefix === null) {
      prefix = item.isRoot
        ? join(item.dir, 'a').slice(0, -1)
        : `${item.dir}${sep}`;
    }
    return prefix;
  };

  // 先一次线性扫描提取普通同级文件集合, 供预设同级锚定校验 O(1) 查询 (零额外磁盘 IO)
  const siblingFiles = new Set<string>();
  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    if (entry.isFile()) siblingFiles.add(entry.name);
  }

  for (let i = 0; i < entries.length; i += 1) {
    const entry = entries[i]!;
    // 符号链接既不跟进也不纳入目标命中 (安全红线)
    if (entry.isSymbolicLink()) continue;

    const name = entry.name;
    if (entry.isDirectory()) {
      if (name === GIT_DIR) continue;

      const matchedInclude = !item.included && hasInclude && include.has(name);
      if (matchedInclude) {
        includeCounts.set(name, (includeCounts.get(name) ?? 0) + 1);
      }

      const bypassGradle = canBypassDefaultGradleExclude(
        name,
        item.dir,
        siblingFiles,
        matcher,
      );

      if (!bypassGradle && hasExclude) {
        if (exclude.has(name)) {
          excludeCounts.set(name, (excludeCounts.get(name) ?? 0) + 1);
          continue;
        }
      }

      const nextIncluded = item.included || matchedInclude;
      const targetPath = `${getPrefix()}${name}`;
      const nextAncestors = [...item.ancestors, name];

      if (nextIncluded && isPotentialTarget(name, 'dir', matcher)) {
        candidates.push({
          name,
          kind: 'dir',
          targetPath,
          parentDir: item.dir,
          root: item.root,
          siblingFiles,
          ancestors: item.ancestors,
          nextIncluded,
          nextAncestors,
          bypassedExclude: bypassGradle,
        });
        continue;
      }

      // 即使目录名是 .gradle 但未通过上述目标条件 (如白名单未命中), 也不得越过护栏下钻
      if (bypassGradle) continue;

      stack.push({
        dir: targetPath,
        root: item.root,
        isRoot: false,
        included: nextIncluded,
        ancestors: nextAncestors,
      });
    } else if (entry.isFile() && matcher.hasFileTargets) {
      const matchedInclude = !item.included && hasInclude && include.has(name);
      if (matchedInclude) {
        includeCounts.set(name, (includeCounts.get(name) ?? 0) + 1);
      }
      if (hasExclude && exclude.has(name)) {
        excludeCounts.set(name, (excludeCounts.get(name) ?? 0) + 1);
        continue;
      }
      const fileIncluded = item.included || matchedInclude;
      if (!fileIncluded || !isPotentialTarget(name, 'file', matcher)) continue;

      candidates.push({
        name,
        kind: 'file',
        targetPath: `${getPrefix()}${name}`,
        parentDir: item.dir,
        root: item.root,
        siblingFiles,
        ancestors: item.ancestors,
        nextIncluded: fileIncluded,
        nextAncestors: item.ancestors,
      });
    }
  }

  return candidates;
}

/** 使用原生回调 readdir 有界并发池遍历一组互不相交的根 */
function walkRoots(roots: readonly string[], ctx: WalkContext): Promise<void> {
  return new Promise((resolve, reject) => {
    const { style, include, hits, warnings, matcher, signal, onProgress } = ctx;
    const initialIncluded = include.size === 0;
    const stack: Pending[] = [];
    for (let i = roots.length - 1; i >= 0; i -= 1) {
      const root = roots[i]!;
      stack.push({
        dir: root,
        root,
        isRoot: true,
        included: initialIncluded,
        ancestors: [],
      });
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

    const recordMatchedHit = async (
      candidate: PendingCandidate,
      match: TargetMatchResult,
    ): Promise<void> => {
      const resolved = await realpath(candidate.targetPath).catch(
        () => candidate.targetPath,
      );
      if (stopped()) return;
      const key = dedupeKey(resolved, style);
      const existing = hits.get(key);
      if (existing !== undefined) {
        // 多根或多源碰撞时, 保留首个命中归属, 但动作取保守优先 ('trash' > 'delete')
        const merged = mergeCleanupActions(
          existing.action ?? 'delete',
          match.action,
        );
        if (merged !== existing.action) {
          hits.set(key, { ...existing, action: merged });
        }
        return;
      }
      const hit: ScanHit = {
        project: candidate.parentDir,
        target: candidate.targetPath,
        root: candidate.root,
        entryKind: candidate.kind,
        action: match.action,
        source: match.source,
      };
      hits.set(key, hit);
      onProgress?.({ kind: 'hit', hit });
    };

    const inspectCandidate = (candidate: PendingCandidate): void => {
      active += 1;
      void evaluateTargetMatch(
        {
          name: candidate.name,
          kind: candidate.kind,
          parentDir: candidate.parentDir,
          targetPath: candidate.targetPath,
          siblingFiles: candidate.siblingFiles,
          ancestors: candidate.ancestors,
        },
        matcher,
      )
        .then(async (match) => {
          if (stopped()) return;
          if (match !== null) {
            await recordMatchedHit(candidate, match);
          } else if (
            candidate.kind === 'dir' &&
            candidate.bypassedExclude !== true
          ) {
            // 候选目录锚定未通过 (如无 Cargo.toml 的普通 target 目录): 回压栈继续下钻, 防漏扫子项目
            stack.push({
              dir: candidate.targetPath,
              root: candidate.root,
              isRoot: false,
              included: candidate.nextIncluded,
              ancestors: candidate.nextAncestors,
            });
          }
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
              const candidates = processDirectoryEntries(
                entries,
                item,
                ctx,
                stack,
              );
              if (!stopped()) {
                for (const candidate of candidates) {
                  inspectCandidate(candidate);
                }
              }
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

/**
 * 构造有界并发多预设/多规则扫描器 (`CONCURRENCY = 32` 原生回调池 + 显式 LIFO 回压栈)。
 * 外部副作用: 只读文件系统 (`readdir` / `realpath` / 按需 `lstat`), 零写入。
 *
 * ### 数据流转示例
 * ```text
 * Input: roots = ['/w'], exclude = ['.nvm', '.gradle'], include = [], presets = { node: {}, rust: {} }
 *   磁盘树 = /w/.nvm/v20/node_modules, /w/app/node_modules (含 package.json),
 *            /w/plain/target/sub/node_modules (plain 无 Cargo.toml, sub 含 package.json)
 * 步骤 1: precheckRoots 并发 realpath + stat 去重; 独立根共享 32 路回调池, 嵌套根自动串行
 * 步骤 2: 回调 readdir 扫同级文件构造 siblingFiles -> .nvm 命中 exclude 整棵剪枝;
 *         /w/app/node_modules 过锚定 -> 命中记录并剪枝不再下钻;
 *         /w/plain/target 初筛命中 rust 但无 Cargo.toml -> 锚定未通过, 回压栈继续下钻扫出 /w/plain/target/sub/node_modules
 * 步骤 3: 命中按 dedupeKey(realpath) 去重 (碰撞时保留先到归属且 'trash' 优先), 按 target 码点升序输出
 * Output: { hits: [app/node_modules, plain/target/sub/node_modules], warnings: [],
 *           excludeMatches: [{ name: '.nvm', hits: 1 }, { name: '.gradle', hits: 0 }], includeMatches: [] }
 * ```
 */
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

      const homeOpt = options.home === undefined ? homedir() : options.home;
      const realHome =
        homeOpt === null ? null : await realpath(homeOpt).catch(() => homeOpt);
      const matcher = createScanMatcher({
        presets: options.presets,
        rules: options.rules,
        excludeExplicit: options.excludeExplicit,
        rawHome: homeOpt,
        realHome,
        nowMs: options.nowMs,
      });

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
        matcher,
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
