/**
 * 领域产物 → 渲染条目与中止统计的纯转换 (零 IO): 从 cli.ts 抽出供单测直接验证
 * (不触发 cli.ts 顶层 main), 同时将执行报告的中止未删计数口径单源锁定。
 */
import { basename } from 'node:path';

import {
  type SweepEntry,
  type SweepOutcomeEntry,
  type SweepReport,
  type SweepSummary,
  crossDeviceNote,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

import type { RenderEntry } from './render.ts';

/** 单条删除结果 (对应 render 条目的 ok / error 字段) */
export interface RemovalOutcome {
  ok: boolean;
  error?: string;
}

/** 整批中止时给未被删除条目的统一说明 (与普通删除失败区分: 这些目标根本没被动过) */
export const ABORTED_HINT = '整批中止, 未执行删除';

/**
 * 领域条目 → 渲染条目: 行尾说明按 疑似安装树 → 跨设备 → 体积失败 的次序并置 (两空格分隔);
 * 跳过类的「为什么没删」不在这里 (那是执行面的 ok / error)。
 */
export function toRenderEntry(entry: SweepEntry): RenderEntry {
  const notes: string[] = [];
  if (entry.kind === 'suspect-install-tree')
    notes.push(`疑似安装树: ${entry.kindReason}`);
  if (entry.crossDevice !== undefined)
    notes.push(crossDeviceNote(entry.crossDevice));
  if (entry.bytes === undefined && entry.unmeasuredReason !== undefined)
    notes.push(`体积统计失败: ${entry.unmeasuredReason}`);
  return {
    target: entry.target,
    bytes: entry.bytes,
    project: basename(entry.project) || entry.project,
    suspect: entry.kind === 'suspect-install-tree',
    ...(notes.length > 0 ? { note: notes.join('  ') } : {}),
  };
}

/**
 * 执行结果 → 渲染的 ok 与行尾原因:
 * removed / missing / stale 计成功侧; failed 附失败串; skipped 附跳过类的放行说明
 * (未测到体积者不重复附原因, 原因已在行尾 note 上); not-attempted 附整批中止的统一说明。
 */
export function outcomeResult(entry: SweepOutcomeEntry): RemovalOutcome {
  const { outcome } = entry;
  switch (outcome.kind) {
    case 'removed':
    case 'missing':
    case 'stale':
      return { ok: true };
    case 'failed':
      return { ok: false, error: outcome.failure.message };
    case 'skipped':
      return outcome.reason === 'unmeasured'
        ? { ok: false }
        : { ok: false, error: entry.skipNote };
    case 'not-attempted':
      return { ok: false, error: ABORTED_HINT };
    case 'rejected':
    case 'not-expected':
      // 本层不产生这两种分支 (整批拒绝走专用分支; 不传 expectedBatch), 兜底按未达成呈现
      return { ok: false };
  }
}

/** 执行面条目 = 渲染条目 + ok 与行尾原因 */
export const toExecuteEntry = (entry: SweepOutcomeEntry): RenderEntry => ({
  ...toRenderEntry(entry),
  ...outcomeResult(entry),
});

/**
 * 整批中止时实际未执行删除的条目数: 取 summarizeReport 的 not-attempted 计数,
 * 而非 report.plan.batch.length (4 路并发窗口内已派发条目会完成并如实报告, 不算未执行删除)。
 */
export function abortedUnattemptedCount(
  report: SweepReport,
  summary: SweepSummary = summarizeReport(report),
): number {
  return summary.counts['not-attempted'];
}
