/**
 * 领域产物到渲染条目的纯转换 (零 IO): 上游接收 `@iyowei/sweep` 的 `SweepEntry` / `SweepOutcomeEntry` /
 * `SweepReport`, 下游产出 `render.ts` 所需的 `RenderEntry`, 供 `cli.ts` 与单测直接导入 (不触发顶层 `main`)。
 * 红线: 统一锁定 `[TRASH]` 标注、`trashed` 计数标记与整批中止未删计数口径 (`not-attempted`)。
 */
import { basename } from 'node:path';

import {
  type SweepEntry,
  type SweepOutcomeEntry,
  type SweepReport,
  type SweepSummary,
  crossDeviceNote,
  summarizeReport,
} from '@iyowei/sweep';

import type { RenderEntry } from './render.ts';

/** 单条清理结果 (对应 render 条目的 ok / trashed / error 字段) */
export interface RemovalOutcome {
  ok: boolean;
  trashed?: boolean;
  error?: string;
}

/** 整批中止时给未被处理条目的统一说明 (与普通失败区分: 这些目标根本没被动过) */
export const ABORTED_HINT = '整批中止, 未执行删除';

/**
 * 领域条目 -> 渲染条目: 行尾 `note` 按 `[TRASH]` -> 疑似安装树 -> 跨设备 -> 体积统计失败 顺序双空格拼接,
 * `project` 取末段目录名 (`basename` 为空时保留原值)。
 *
 * ### 数据流转示例
 * ```text
 * Input  : { target: '/w/app/logs', project: '/w/app', bytes: 1048576, action: 'trash', kind: 'project' }
 * 步骤 1 : action === 'trash' -> notes = ['[TRASH]']; basename('/w/app') -> 'app'
 * Output : { target: '/w/app/logs', bytes: 1048576, project: 'app', suspect: false, action: 'trash', note: '[TRASH]' }
 * ```
 */
export function toRenderEntry(entry: SweepEntry): RenderEntry {
  const notes: string[] = [];
  if (entry.action === 'trash') notes.push('[TRASH]');
  if (entry.kind === 'suspect-install-tree') {
    notes.push(`疑似安装树: ${entry.kindReason}`);
  }
  if (entry.crossDevice !== undefined) {
    notes.push(crossDeviceNote(entry.crossDevice));
  }
  if (entry.bytes === undefined && entry.unmeasuredReason !== undefined) {
    notes.push(`体积统计失败: ${entry.unmeasuredReason}`);
  }
  return {
    target: entry.target,
    bytes: entry.bytes,
    project: basename(entry.project) || entry.project,
    suspect: entry.kind === 'suspect-install-tree',
    action: entry.action,
    ...(notes.length > 0 ? { note: notes.join('  ') } : {}),
  };
}

/**
 * 执行结果 -> 渲染的 `ok` / `trashed` 与行尾 `error`:
 * - `removed` / `missing` / `stale`: `{ ok: true }`; `trashed`: `{ ok: true, trashed: true }` (供汇总统计回收站数);
 * - `failed`: 附 `failure.message` (含 `TRASH_FAILED` 保留原文件提示);
 * - `skipped`: `unmeasured` 仅置 `{ ok: false }` (防与 `note` 的体积失败说明重复), 其余附 `skipNote`;
 * - `not-attempted`: 附 `ABORTED_HINT`; `rejected` / `not-expected`: `{ ok: false }`。
 */
export function outcomeResult(entry: SweepOutcomeEntry): RemovalOutcome {
  const { outcome } = entry;
  switch (outcome.kind) {
    case 'removed':
    case 'missing':
    case 'stale':
      return { ok: true };
    case 'trashed':
      return { ok: true, trashed: true };
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
      return { ok: false };
  }
}

/**
 * 执行面条目 = `toRenderEntry(entry)` + `outcomeResult(entry)`。
 *
 * ### 数据流转示例
 * ```text
 * Input  : { target: '/w/app/logs', project: '/w/app', bytes: 1048576, action: 'trash', kind: 'project', outcome: { kind: 'trashed' } }
 * 步骤 1 : toRenderEntry -> { ..., action: 'trash', note: '[TRASH]' }
 * 步骤 2 : outcomeResult -> { ok: true, trashed: true } (驱动 render.ts 的 footExecute 显示「含回收站 N 处」)
 * Output : { target: '/w/app/logs', bytes: 1048576, project: 'app', suspect: false, action: 'trash', note: '[TRASH]', ok: true, trashed: true }
 * ```
 */
export const toExecuteEntry = (entry: SweepOutcomeEntry): RenderEntry => ({
  ...toRenderEntry(entry),
  ...outcomeResult(entry),
});

/** 整批中止时实际未执行清理的条目数 (取 summarizeReport 的 not-attempted 计数) */
export function abortedUnattemptedCount(
  report: SweepReport,
  summary: SweepSummary = summarizeReport(report),
): number {
  return summary.counts['not-attempted'];
}
