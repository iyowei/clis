/**
 * 陈旧容忍分拣 (内部模块, 供 `delete.ts` 的 `removeBatch` 与 `sweep.ts` 的 `executeRun` 共享, 规则只此一处)。
 * 消费 `guard.ts` 产出的 `RejectedTarget[]`; 严禁导出至公开 API 面 (已在 tsconfig.build.json 与 scripts/build.ts 中排除)。
 * 红线: 仅当 `staleTargets === 'missing'` 时摘出 `GUARD_TARGET_MISSING` (目标已达成, EC-01),
 * `GUARD_TARGET_UNREADABLE` 等其余任何拒绝码一律保留在 `rejected` 中维持整批拒绝。
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
