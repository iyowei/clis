/**
 * 域类型的实际调用验证: 从公开面入口 (index.ts) 导入, 按真实调用方的方式构造与消费。
 * 覆盖: 可序列化承诺 (JSON 往返无损) / EntryOutcome 穷举分支 (模拟调用方 switch) /
 * 诊断与跳过集册的形状。
 */
import { describe, expect, test } from 'bun:test';

import type {
  EntryOutcome,
  SkippedTarget,
  SweepEntry,
  SweepPlan,
  SweepReport,
  SweepWarning,
} from './index.ts';

/** 模拟调用方对逐条结果的穷举分支 (TS 穷尽性检查: 漏 case 即编译报错) */
const describeOutcome = (outcome: EntryOutcome): string => {
  switch (outcome.kind) {
    case 'removed':
      return '已删除';
    case 'missing':
      return '核验已不存在';
    case 'stale':
      return '安全闸前已不存在';
    case 'failed':
      return `失败: ${outcome.failure.message}`;
    case 'rejected':
      return `拒绝: ${outcome.rejection.message}`;
    case 'not-attempted':
      return `未尝试: ${outcome.code}`;
    case 'not-expected':
      return '不在期望批次';
    case 'skipped':
      return `跳过: ${outcome.reason}`;
  }
};

describe('编排层域类型的实际调用形态', () => {
  const entries: SweepEntry[] = [
    {
      target: '/ws/app/node_modules',
      project: '/ws/app',
      root: '/ws',
      bytes: 1024,
      basis: 'disk-usage',
      kind: 'project',
      inBatch: true,
    },
    {
      target: '/ws/lib/node_modules',
      project: '/ws/lib',
      root: '/ws',
      kind: 'project',
      unmeasuredCode: 'SIZE_UNMEASURED_PERMISSION',
      unmeasuredReason: '权限不足',
      inBatch: false,
      skipReason: 'unmeasured',
      skipNote: '体积统计失败: 权限不足',
    },
  ];
  const skipped: SkippedTarget[] = [
    {
      target: '/ws/lib/node_modules',
      reason: 'unmeasured',
      note: '体积统计失败: 权限不足',
    },
  ];
  const warnings: SweepWarning[] = [
    {
      code: 'SCAN_DIR_UNREADABLE',
      message: '目录不可读, 已跳过 (路径: /ws/locked)',
      path: '/ws/locked',
    },
  ];
  const plan: SweepPlan = {
    roots: ['/ws'],
    exclude: [],
    include: [],
    policy: { releaseSuspects: false },
    basis: 'disk-usage',
    entries,
    batch: ['/ws/app/node_modules'],
    skipped,
    warnings,
    nameMatches: { exclude: [{ name: 'lib', hits: 1 }], include: [] },
  };

  test('可序列化承诺: 完整计划 JSON 往返无损 (无类实例 / Map / Set / 函数)', () => {
    const roundtrip = JSON.parse(JSON.stringify(plan));
    expect(roundtrip).toEqual(plan);
  });

  test('跳过条目的码与人话逐条并存, 且与 entry 的 skipReason / skipNote 同源', () => {
    expect(entries[1]!.skipReason).toBe(skipped[0]!.reason);
    expect(entries[1]!.skipNote).toBe(skipped[0]!.note);
  });

  test('EntryOutcome 全 kind 的穷举分支可读 (模拟调用方消费)', () => {
    const outcomes: EntryOutcome[] = [
      { kind: 'removed' },
      { kind: 'missing' },
      { kind: 'stale' },
      {
        kind: 'failed',
        failure: {
          target: '/ws/x',
          code: 'REMOVE_FAILED',
          errno: 'EACCES',
          message: 'EACCES: 权限不足',
          partialRisk: true,
        },
      },
      {
        kind: 'rejected',
        rejection: {
          target: '/ws/y',
          code: 'GUARD_OUTSIDE_ROOTS',
          message: 'realpath 后不在任何 root 之下',
        },
      },
      { kind: 'not-attempted', code: 'REVIEW_HEAD_SYMLINK' },
      { kind: 'not-expected' },
      { kind: 'skipped', reason: 'suspect-install-tree' },
    ];

    expect(outcomes.map(describeOutcome)).toEqual([
      '已删除',
      '核验已不存在',
      '安全闸前已不存在',
      '失败: EACCES: 权限不足',
      '拒绝: realpath 后不在任何 root 之下',
      '未尝试: REVIEW_HEAD_SYMLINK',
      '不在期望批次',
      '跳过: suspect-install-tree',
    ]);
  });

  test('完整执行报告可组装并序列化 (模拟一次带对账的执行)', () => {
    const report: SweepReport = {
      status: 'executed',
      plan,
      validation: {
        accepted: ['/ws/app/node_modules'],
        rejected: [],
        mappings: [
          { original: '/ws/app/node_modules', real: '/ws/app/node_modules' },
        ],
      },
      removal: {
        removed: ['/ws/app/node_modules'],
        missing: [],
        failed: [],
      },
      entries: [
        { ...entries[0]!, outcome: { kind: 'removed' } },
        { ...entries[1]!, outcome: { kind: 'skipped', reason: 'unmeasured' } },
      ],
      stale: [],
      releasedBytes: 1024,
      drift: {
        added: ['/ws/new/node_modules'],
        removed: [],
      },
    };

    expect(JSON.parse(JSON.stringify(report))).toEqual(report);
    expect(report.entries.map((e) => e.outcome.kind)).toEqual([
      'removed',
      'skipped',
    ]);
  });
});
