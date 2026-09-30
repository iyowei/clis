/**
 * 结果缝合层 (纯函数, 零 IO): 成功侧判据与计数摘要。
 * 契约基准: packages/sweep-node-modules/docs/designs/api-surface.md §2.7 与 §7.8。
 *
 * 存在价值是「随版本新增 EntryOutcome.kind 时不会静默漏判」: 手写的
 * `every(kind !== 'x' && kind !== 'y')` 在库里新增一种成功侧 kind 后会把新 kind
 * 误判为失败, 而本模块的判据跟着版本走 —— 新增 kind 时必过本文件的归类评审。
 * 退出码口径 (「本次运行算不算成功」) 不在此处: 那是产品口径, 由调用方用
 * summarizeReport 的三档配方自定 (见 §2.7)。
 */
import type {
  EntryOutcome,
  EntryOutcomeKind,
  SweepReport,
  SweepSummary,
} from './types.ts';

/**
 * 成功侧 kind 全集 (目标已达成): removed 实删 / missing 删除阶段核验已不存在 /
 * stale 安全闸前已不存在被摘出。新增 kind 时必须在本表显式归类。
 */
const SUCCESS_KINDS: ReadonlySet<EntryOutcomeKind> = new Set([
  'removed',
  'missing',
  'stale',
]);

/** 条目的「达成没有」: 成功侧为真, 其余 (真失败与未处理) 为假 */
export function isSuccessOutcome(outcome: EntryOutcome): boolean {
  return SUCCESS_KINDS.has(outcome.kind);
}

/**
 * 结果计数摘要: 成功侧 / 未处理 / 真失败 / 整批中止四档, 口径与 §2.7 的严格档配方
 * 同源 (CLI 包即按该档落退出码)。计数表以显式字面量初始化: 新增 kind 时 TS
 * 会在本处报缺键, 强制显式归类。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   report.entries = [{ outcome: { kind: 'removed' } }, { outcome: { kind: 'missing' } },
 *                     { outcome: { kind: 'skipped', reason: 'suspect-install-tree' } },
 *                     { outcome: { kind: 'skipped', reason: 'unmeasured' } },
 *                     { outcome: { kind: 'failed', failure: {...} } }]
 *   report.removal = { removed: [...], missing: [...], failed: [...] }   // 无 aborted
 *
 * 步骤 1：逐条累计 counts
 *   counts = { removed: 1, missing: 1, skipped: 2, failed: 1, 其余 kind 为 0 }
 *
 * 步骤 2：按四档聚合
 *   succeeded = 1 + 1 + 0 = 2; unprocessed = 2 + 0 + 0 + 0 = 2; failed = 1; aborted = false
 *
 * Output（数据契约）
 *   return { counts, succeeded: 2, unprocessed: 2, failed: 1, aborted: false }
 * ```
 */
export function summarizeReport(report: SweepReport): SweepSummary {
  const counts: Record<EntryOutcomeKind, number> = {
    removed: 0,
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
    succeeded: counts.removed + counts.missing + counts.stale,
    unprocessed:
      counts.skipped +
      counts.rejected +
      counts['not-attempted'] +
      counts['not-expected'],
    failed: counts.failed,
    aborted: report.removal?.aborted !== undefined,
  };
}
