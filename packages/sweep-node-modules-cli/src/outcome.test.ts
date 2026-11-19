/**
 * 执行报告转换与整批中止计数的单元测试: 钉死整批中止播报口径取
 * summarizeReport(report).counts['not-attempted'], 而非 report.plan.batch.length
 * (4 路并发窗口内已派发条目会完成并如实报告, 不算未执行删除)。
 */
import { describe, expect, test } from 'bun:test';

import type {
  SweepOutcomeEntry,
  SweepReport,
} from '@iyowei/sweep-node-modules';

import {
  ABORTED_HINT,
  abortedUnattemptedCount,
  toExecuteEntry,
} from './outcome.ts';

function makeEntry(
  name: string,
  outcome: SweepOutcomeEntry['outcome'],
): SweepOutcomeEntry {
  return {
    target: `/w/${name}/node_modules`,
    project: `/w/${name}`,
    root: '/w',
    bytes: 4096,
    basis: 'disk-usage',
    kind: 'project',
    inBatch: outcome.kind !== 'skipped',
    outcome,
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
});
