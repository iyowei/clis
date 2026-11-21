/**
 * 执行报告转换与整批中止计数的单元测试:
 * 1. 钉死整批中止播报口径取 summarizeReport(report).counts['not-attempted'];
 * 2. 覆盖回收站动作 ([TRASH] 标注)、trashed 成功结果 ({ ok: true, trashed: true }) 与失败/跳过透传。
 */
import { describe, expect, test } from 'bun:test';

import type { SweepOutcomeEntry, SweepReport } from '@iyowei/sweep';

import {
  ABORTED_HINT,
  abortedUnattemptedCount,
  outcomeResult,
  toExecuteEntry,
  toRenderEntry,
} from './outcome.ts';

function makeEntry(
  name: string,
  outcome: SweepOutcomeEntry['outcome'],
  overrides: Partial<SweepOutcomeEntry> = {},
): SweepOutcomeEntry {
  return {
    target: `/w/${name}/node_modules`,
    project: `/w/${name}`,
    root: '/w',
    entryKind: 'dir',
    action: 'delete',
    source: { kind: 'preset', name: 'node' },
    bytes: 4096,
    basis: 'disk-usage',
    kind: 'project',
    inBatch: outcome.kind !== 'skipped',
    outcome,
    ...overrides,
  };
}

describe('abortedUnattemptedCount (整批中止未删计数)', () => {
  test('4 路并发窗口内部分已删、部分未尝试: 报实际未尝试数而非 batch 全长', () => {
    const entries: SweepOutcomeEntry[] = [
      makeEntry('p1', { kind: 'removed' }),
      makeEntry('p2', { kind: 'removed' }),
      makeEntry('p3', {
        kind: 'not-attempted',
        code: 'REVIEW_COMPONENT_REPLACED',
      }),
      makeEntry('p4', {
        kind: 'not-attempted',
        code: 'REVIEW_COMPONENT_REPLACED',
      }),
    ];
    const report: SweepReport = {
      status: 'executed',
      plan: {
        roots: ['/w'],
        exclude: [],
        include: [],
        policy: { releaseSuspects: false },
        basis: 'disk-usage',
        entries,
        batch: entries.map((e) => e.target),
        skipped: [],
        trailer: [],
        warnings: [],
        nameMatches: { exclude: [], include: [] },
      },
      removal: {
        removed: ['/w/p1/node_modules', '/w/p2/node_modules'],
        trashed: [],
        missing: [],
        failed: [],
        aborted: {
          target: '/w/p3/node_modules',
          code: 'REVIEW_COMPONENT_REPLACED',
          message: '安全复核失败 (路径组件被替换): /w/p3',
        },
      },
      entries,
      stale: [],
      releasedBytes: 8192,
    };

    // batch 全长是 4, 实际未执行删除的是 not-attempted 的 2 处 (p1 / p2 已删)
    expect(report.plan.batch).toHaveLength(4);
    expect(abortedUnattemptedCount(report)).toBe(2);

    const rendered = toExecuteEntry(entries[2]!);
    expect(rendered.ok).toBe(false);
    expect(rendered.error).toBe(ABORTED_HINT);
  });

  test('根目录项目 (project="/") 保留 "/" 而非空串 (SWEEPCLI-P1-3)', () => {
    const rootEntry: SweepOutcomeEntry = {
      target: '/node_modules',
      project: '/',
      root: '/',
      entryKind: 'dir',
      action: 'delete',
      source: { kind: 'preset', name: 'node' },
      bytes: 1024,
      basis: 'disk-usage',
      kind: 'project',
      inBatch: true,
      outcome: { kind: 'removed' },
    };
    expect(toRenderEntry(rootEntry).project).toBe('/');
  });
});

describe('toRenderEntry / outcomeResult / toExecuteEntry (回收站与动作映射)', () => {
  test('action === "trash" 附带 [TRASH] 行尾标注并与其余说明并置', () => {
    const trashedRule = makeEntry(
      'logs',
      { kind: 'trashed' },
      {
        target: '/w/app/logs',
        project: '/w/app',
        action: 'trash',
        source: { kind: 'rule', name: 'old-logs' },
        bytes: undefined,
        basis: undefined,
        unmeasuredReason: '权限不足',
      },
    );

    const preview = toRenderEntry(trashedRule);
    expect(preview.action).toBe('trash');
    expect(preview.note).toBe('[TRASH]  体积统计失败: 权限不足');
  });

  test('outcome.kind === "trashed" 返回 { ok: true, trashed: true } 并透传到执行条目', () => {
    const entry = makeEntry(
      'cache',
      { kind: 'trashed' },
      {
        action: 'trash',
        source: { kind: 'rule', name: 'cache-trash' },
      },
    );

    expect(outcomeResult(entry)).toEqual({ ok: true, trashed: true });
    const executed = toExecuteEntry(entry);
    expect(executed.ok).toBe(true);
    expect(executed.trashed).toBe(true);
    expect(executed.action).toBe('trash');
    expect(executed.note).toBe('[TRASH]');
  });

  test('failed (TRASH_FAILED) 与 skipped (非 unmeasured) 正确映射错误说明', () => {
    const failed = makeEntry(
      'fail-trash',
      {
        kind: 'failed',
        failure: {
          target: '/w/fail-trash/node_modules',
          code: 'TRASH_FAILED',
          message: '移入回收站失败, 原文件已保留',
          partialRisk: false,
        },
      },
      { action: 'trash' },
    );
    expect(outcomeResult(failed)).toEqual({
      ok: false,
      error: '移入回收站失败, 原文件已保留',
    });

    const skipped = makeEntry(
      'suspect-lib',
      { kind: 'skipped', reason: 'suspect-install-tree' },
      {
        kind: 'suspect-install-tree',
        kindReason: '父目录为 lib',
        skipReason: 'suspect-install-tree',
        skipNote: '已跳过 (加 --force 一并清理)',
      },
    );
    expect(outcomeResult(skipped)).toEqual({
      ok: false,
      error: '已跳过 (加 --force 一并清理)',
    });
  });
});
