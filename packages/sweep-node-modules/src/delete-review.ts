/**
 * 内部模块: 删除前安全复核链 (形态硬拒绝 / 归属根 / 根完整祖先链 lstat / 根至父目录逐级 lstat)。
 * 不属于公开 API 面 (已在 tsconfig.build.json 与 scripts/build.ts 中排除出发行 .d.ts)。
 */
import { lstat } from 'node:fs/promises';

import type { AbortCode, RemoveFailureCode } from './codes.ts';
import {
  type PathStyle,
  anchorChainPaths,
  dedupeKey,
  hasNodeModulesLeaf,
  insideAnyRoot,
} from './guard.ts';

/** 常见错误码的人话映射, 未收录的码回落通用提示 */
export const ERROR_HINTS: Record<string, string> = {
  EACCES: '权限不足, 拒绝删除',
  EPERM: '操作不被允许',
  EBUSY: '目标被占用',
  ENOTEMPTY: '目录非空',
  EROFS: '目标位于只读文件系统',
};

/** fs 错误对象的最小形态 (避免依赖 NodeJS 命名空间) */
export interface FsError {
  code?: string;
  message?: string;
}

/** 错误码到人话前缀 */
export function describeCode(error: unknown): string {
  const fsError = error as FsError | null;
  const code = fsError?.code;
  if (typeof code !== 'string' || code === '') {
    return `未知错误: ${fsError?.message ?? String(error)}`;
  }
  return `${code}: ${ERROR_HINTS[code] ?? '删除未成功'}`;
}

/** 复核阶段自身出错 (未尝试删除, 故不附「内容可能已残缺」提示) */
function describeReviewError(
  target: string,
  path: string,
  error: unknown,
): string {
  return `安全复核未完成 (${describeCode(error)}) (目标: ${target}; 组件: ${path}; 未执行删除)`;
}

/** 复核时链上组件消失 (ENOENT) 的可读串 */
function describeVanishedReview(target: string, path: string): string {
  return `安全复核未完成 (ENOENT: 路径组件消失) (目标: ${target}; 组件: ${path}; 请复查目标是否仍存在; 未执行删除; 若目标确已不存在, 可忽略此条)`;
}

/** 信任根最小形态 (与 delete.ts 的 TrustRoot 同形, 避免循环依赖) */
interface ReviewRoot {
  configured: string;
  real: string;
}

/** 复核产出的整批中止信息 (与 AbortedBatch 同形) */
interface ReviewAbort {
  target: string;
  code: AbortCode;
  message: string;
  path?: string;
}

/** 复核产出的单条失败信息 (与 TargetFailure 同形) */
interface ReviewFailure {
  target: string;
  code: RemoveFailureCode;
  errno?: string;
  message: string;
  partialRisk: boolean;
}

/** 逐条删除前复核结论: ok 放行进 rm; aborted 触发整批中止; failed 仅阻断本条 */
export type PreRmReview =
  | { kind: 'ok' }
  | { kind: 'aborted'; aborted: ReviewAbort }
  | { kind: 'failed'; failure: ReviewFailure };

type ReviewFinding =
  | { kind: 'unsafe'; path: string }
  | { kind: 'vanished'; path: string }
  | { kind: 'unverified'; path: string; error: unknown };

/** 复核链: 自 root 至 target 父目录 (root 含, target 本体不含) */
function componentChain(
  root: string,
  target: string,
  style: PathStyle,
): string[] {
  const fold = (p: string): string =>
    style.caseInsensitive ? p.toLowerCase() : p;
  const rel = style.ops.relative(fold(root), fold(target));
  const chain = [root];
  let cursor = root;
  for (const part of rel.split(style.ops.sep).slice(0, -1)) {
    cursor = style.ops.join(cursor, part);
    chain.push(cursor);
  }
  return chain;
}

/**
 * 目标形态前置校验 (公开写原语 fail-closed 防线):
 * 拒绝含尾分隔符 (防 fs.rm 跟随末段符号链接)、含 `.` / `..` 段 (防 relative 词法消去跳过中间符号链接)
 * 或末段非 node_modules 的目标; 合法返回 null, 违约返回中文原因。
 */
function targetShapeViolation(target: string, style: PathStyle): string | null {
  if (target.endsWith('/') || target.endsWith('\\')) {
    return `安全复核失败 (目标路径不得含尾分隔符): ${target}`;
  }
  const segments =
    style.name === 'win32' ? target.split(/[\\/]+/) : target.split('/');
  if (segments.some((segment) => segment === '.' || segment === '..')) {
    return `安全复核失败 (目标路径不得含相对段 . 或 ..): ${target}`;
  }
  if (!hasNodeModulesLeaf(target, style)) {
    return `安全复核失败 (路径末段不是 node_modules): ${target}`;
  }
  return null;
}

/**
 * 信任根完整祖先链: 先收 configured 的全祖先链 (检出配置拼写及任意上层被换位),
 * 再补 real 祖先链中未重复的级 (去重防重复 lstat)。
 */
function rootAncestorChain(root: ReviewRoot, style: PathStyle): string[] {
  const chain: string[] = [];
  const seen = new Set<string>();
  const append = (raw: string): void => {
    for (const step of anchorChainPaths(raw, style)) {
      const key = dedupeKey(step, style);
      if (seen.has(key)) continue;
      seen.add(key);
      chain.push(step);
    }
  };
  append(root.configured);
  append(root.real);
  return chain;
}

/** 逐级复核链上组件: 全通过返回 null; 符号链接与非目录统一由 isDirectory 判定拦下 */
async function reviewComponents(
  chain: string[],
): Promise<ReviewFinding | null> {
  for (const path of chain) {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory()) return { kind: 'unsafe', path };
    } catch (error) {
      const code = (error as FsError | null)?.code;
      if (code === 'ENOENT') return { kind: 'vanished', path };
      return { kind: 'unverified', path, error };
    }
  }
  return null;
}

/** 将复核阶段的 vanished / unverified 转为单条失败对象 (未执行删除, partialRisk 恒 false) */
function toReviewFailure(
  target: string,
  finding: Extract<ReviewFinding, { kind: 'vanished' | 'unverified' }>,
): ReviewFailure {
  if (finding.kind === 'vanished') {
    return {
      target,
      code: 'REVIEW_COMPONENT_VANISHED',
      errno: 'ENOENT',
      message: describeVanishedReview(target, finding.path),
      partialRisk: false,
    };
  }
  return {
    target,
    code: 'REVIEW_UNVERIFIED',
    errno: (finding.error as FsError | null)?.code,
    message: describeReviewError(target, finding.path, finding.error),
    partialRisk: false,
  };
}

/** 同步前置校验结果 */
export type SyncReviewResult =
  { kind: 'ok'; root: ReviewRoot } | { kind: 'aborted'; aborted: ReviewAbort };

/**
 * 同步前置校验 (零 await, 确保在并发 pump() 派发下一条前即可同步置起 aborted 停泵):
 * 校验目标形态 (尾分隔符 / . / .. / 末段 node_modules) 与归属信任根。
 */
export function resolveTargetRootSync(
  target: string,
  roots: readonly ReviewRoot[],
  style: PathStyle,
): SyncReviewResult {
  const violation = targetShapeViolation(target, style);
  if (violation !== null) {
    return {
      kind: 'aborted',
      aborted: {
        target,
        code: 'REVIEW_NOT_UNDER_ANY_ROOT',
        message: violation,
        path: target,
      },
    };
  }

  const root = roots.find((candidate) =>
    insideAnyRoot(target, [candidate.real], style),
  );
  if (root === undefined) {
    return {
      kind: 'aborted',
      aborted: {
        target,
        code: 'REVIEW_NOT_UNDER_ANY_ROOT',
        message: `安全复核失败 (目标不在任何 roots 之下): ${target}`,
        path: target,
      },
    };
  }
  return { kind: 'ok', root };
}

/**
 * 异步文件系统复核: 信任根完整祖先链 lstat → 根至目标父目录逐级 lstat。
 * 任一级检出替换即返回 aborted; 消失或不可核验仅阻断本条 (failed), 绝不进入 rm。
 */
export async function reviewPathOnDisk(
  target: string,
  root: ReviewRoot,
  style: PathStyle,
): Promise<PreRmReview> {
  // 信任根完整祖先链复核先于目标组件复核: 根自身或任一祖先被换位时, 只有全祖先链逐级 lstat 能识破
  const headFinding = await reviewComponents(rootAncestorChain(root, style));
  if (headFinding !== null) {
    if (headFinding.kind === 'unsafe') {
      const location =
        headFinding.path === root.configured
          ? root.configured
          : `${headFinding.path} (根: ${root.configured})`;
      return {
        kind: 'aborted',
        aborted: {
          target,
          code: 'REVIEW_HEAD_SYMLINK',
          message: `安全复核失败 (根被替换为符号链接): ${location}`,
          path: headFinding.path,
        },
      };
    }
    return { kind: 'failed', failure: toReviewFailure(target, headFinding) };
  }

  const finding = await reviewComponents(
    componentChain(root.real, target, style),
  );
  if (finding !== null) {
    if (finding.kind === 'unsafe') {
      return {
        kind: 'aborted',
        aborted: {
          target,
          code: 'REVIEW_COMPONENT_REPLACED',
          message: `安全复核失败 (路径组件被替换): ${finding.path}`,
          path: finding.path,
        },
      };
    }
    return { kind: 'failed', failure: toReviewFailure(target, finding) };
  }

  return { kind: 'ok' };
}
