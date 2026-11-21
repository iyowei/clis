/**
 * 扫描根预检与嵌套检测 (内部模块, 供 scan-parallel.ts 复用)。
 * 职责: 并发 realpath + stat 核验输入根可用性, 借助 guard.ts 的 dedupeKey/insideAnyRoot 保序去重并判别根间嵌套关系。
 * 红线: 缺失/不可读/非目录根一律转为结构化 SCAN_ROOT_* 告警跳过而不中断扫描;
 * 检测到任意嵌套根时由上游回退串行遍历, 严守多根碰撞时的输入归属序。
 */
import { realpath, stat } from 'node:fs/promises';

import { type PathStyle, dedupeKey, insideAnyRoot } from './guard.ts';
import type { SweepWarning } from './types.ts';

export interface ValidatedRoot {
  root: string;
  real: string;
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

/** 并发预检全部输入根 (按输入顺序保留告警与首次出现的唯一真实根) */
export async function precheckRoots(
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

/** 检查有效根集合是否存在任意一对嵌套包含关系 */
export function hasNestedRoots(
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
