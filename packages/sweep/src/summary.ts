/**
 * 结果缝合层 (纯函数, 零 IO): 成功侧判据 (`isSuccessOutcome`) 与四档计数摘要 (`summarizeReport`)。
 * 契约基准: packages/sweep/docs/designs/api-surface.md §2.7 与 §7.8。
 * 上游: `sweep.ts` 用 `isSuccessOutcome` 累计 `releasedBytes`, CLI/外部调用方用 `summarizeReport` 决定退出码与统计面板。
 * 红线: 成功侧四类为 `removed` / `trashed` / `missing` / `stale`; 新增 `EntryOutcome.kind` 时必须在本文件显式归类,
 * 避免调用方手写排除式条件把新成功态误判为失败。
 */
import type {
  EntryOutcome,
  EntryOutcomeKind,
  SweepReport,
  SweepSummary,
} from './types.ts';

/**
 * 成功侧 kind 全集 (目标已达成): `removed` 永久删除 / `trashed` 移入回收站 /
 * `missing` 删除阶段核验已不存在 / `stale` 安全闸前已不存在被摘出。新增 kind 时必须在本表显式归类。
 */
const SUCCESS_KINDS: ReadonlySet<EntryOutcomeKind> = /*#__PURE__*/ new Set([
  'removed',
  'trashed',
  'missing',
  'stale',
]);

/** 条目的「达成没有」: 成功侧为真, 其余 (真失败与未处理) 为假 */
export function isSuccessOutcome(outcome: EntryOutcome): boolean {
  return SUCCESS_KINDS.has(outcome.kind);
}

/**
 * 结果计数摘要: 成功侧 / 未处理 / 真失败 / 整批中止四档, 口径与 api-surface.md §2.7 严格档配方同源。
 * 计数表以显式字面量初始化: 新增 `EntryOutcomeKind` 时 TS 会在本处报缺键, 强制显式归类。
 * 注: `not-attempted` 覆盖删除阶段复核中止未派发 (`AbortCode`) 与安全闸整批拒绝连带未删 (`'BATCH_REJECTED'`) 两类,
 * 二者同归 `unprocessed`, 而 `aborted` 布尔仍由 `report.removal?.aborted !== undefined` 唯一判定。
 *
 * ### 数据流转示例
 * ```text
 * Input: report.entries = [{ outcome: { kind: 'removed' } }, { outcome: { kind: 'trashed' } },
 *                          { outcome: { kind: 'missing' } }, { outcome: { kind: 'skipped', reason: 'suspect-install-tree' } },
 *                          { outcome: { kind: 'skipped', reason: 'unmeasured' } }, { outcome: { kind: 'failed', failure: {...} } }]
 *        report.removal = { removed: [...], trashed: [...], missing: [...], failed: [...] } (无 aborted)
 * 步骤 1: 逐条累计 9 种 kind 的 counts -> removed: 1, trashed: 1, missing: 1, skipped: 2, failed: 1, 其余 0
 * 步骤 2: 四档聚合 -> succeeded = 1 + 1 + 1 + 0 = 3; unprocessed = 2 + 0 + 0 + 0 = 2; failed = 1; aborted = false
 * Output: { counts, succeeded: 3, unprocessed: 2, failed: 1, aborted: false }
 * ```
 */
export function summarizeReport(report: SweepReport): SweepSummary {
  const counts: Record<EntryOutcomeKind, number> = {
    removed: 0,
    trashed: 0,
    missing: 0,
    stale: 0,
    failed: 0,
    rejected: 0,
    'not-attempted': 0,
    'not-expected': 0,
    skipped: 0,
  };
  for (const entry of report.entries) counts[entry.outcome.kind] += 1;

  return {
    counts,
    succeeded: counts.removed + counts.trashed + counts.missing + counts.stale,
    unprocessed:
      counts.skipped +
      counts.rejected +
      counts['not-attempted'] +
      counts['not-expected'],
    failed: counts.failed,
    aborted: report.removal?.aborted !== undefined,
  };
}
