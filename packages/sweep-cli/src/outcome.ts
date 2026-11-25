/**
 * 领域产物到渲染条目的纯转换 (零 IO, 支持中英双语标注)。
 */
import { basename } from 'node:path';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type SweepEntry,
  type SweepOutcomeEntry,
  type SweepReport,
  type SweepSummary,
  crossDeviceNote,
  summarizeReport,
} from '@iyowei/sweep';

import type { RenderEntry } from './render.ts';

export interface RemovalOutcome {
  ok: boolean;
  trashed?: boolean;
  error?: string;
}

export const ABORTED_HINT = '整批中止, 未执行删除';
export const ABORTED_HINT_EN = 'Batch aborted, not removed';

export function toRenderEntry(
  entry: SweepEntry,
  locale: Locale = 'zh',
): RenderEntry {
  const notes: string[] = [];
  if (entry.action === 'trash') notes.push('[TRASH]');
  if (entry.kind === 'suspect-install-tree') {
    notes.push(
      t(
        locale,
        `疑似安装树: ${entry.kindReason}`,
        `Suspect install tree: ${entry.kindReason ?? ''}`,
      ),
    );
  }
  if (entry.crossDevice !== undefined) {
    notes.push(
      locale === 'en'
        ? `Cross-device mount (${entry.crossDevice})`
        : crossDeviceNote(entry.crossDevice),
    );
  }
  if (entry.bytes === undefined && entry.unmeasuredReason !== undefined) {
    notes.push(
      t(
        locale,
        `体积统计失败: ${entry.unmeasuredReason}`,
        `Size check failed: ${entry.unmeasuredReason}`,
      ),
    );
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

export function outcomeResult(
  entry: SweepOutcomeEntry,
  locale: Locale = 'zh',
): RemovalOutcome {
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
        : {
            ok: false,
            error:
              locale === 'en' ? `Skipped (${outcome.reason})` : entry.skipNote,
          };
    case 'not-attempted':
      return {
        ok: false,
        error: t(locale, ABORTED_HINT, ABORTED_HINT_EN),
      };
    case 'rejected':
    case 'not-expected':
      return { ok: false };
  }
}

export const toExecuteEntry = (
  entry: SweepOutcomeEntry,
  locale: Locale = 'zh',
): RenderEntry => ({
  ...toRenderEntry(entry, locale),
  ...outcomeResult(entry, locale),
});

export function abortedUnattemptedCount(
  report: SweepReport,
  summary: SweepSummary = summarizeReport(report),
): number {
  return summary.counts['not-attempted'];
}
