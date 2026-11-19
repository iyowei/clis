/**
 * 内部模块: 陈旧容忍分拣 (removeBatch 与编排层 sweep.ts 共用, 规则只此一处)。
 * 不属于公开 API 面 (已在 tsconfig.build.json 与 scripts/build.ts 中排除出发行 .d.ts)。
 */
import type { RejectedTarget } from './guard.ts';

/**
 * staleTargets 为 'missing' 时把 GUARD_TARGET_MISSING 一类无安全信号的拒绝摘出
 * (目标已达成, EC-01 语义), 其余任何拒绝码一律留在 rejected 侧
 * (不可读等拒绝没有任何「已达成」的语义), 维持整批拒绝。两侧均保输入顺序。
 */
export function splitStaleRejections(
  rejected: RejectedTarget[],
  staleTargets: 'reject' | 'missing' | undefined,
): { rejected: RejectedTarget[]; stale: string[] } {
  if (staleTargets !== 'missing') return { rejected, stale: [] };
  const rest: RejectedTarget[] = [];
  const stale: string[] = [];
  for (const item of rejected) {
    if (item.code === 'GUARD_TARGET_MISSING') stale.push(item.target);
    else rest.push(item);
  }
  return { rejected: rest, stale };
}
