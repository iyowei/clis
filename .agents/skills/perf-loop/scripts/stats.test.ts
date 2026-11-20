import { describe, expect, test } from 'bun:test';

import {
  assignMeasuredTier,
  describeSamples,
  judgeSuiteEvaluation,
  mannWhitneyU,
} from './stats.ts';
import type { BenchCaseRole, BenchJsonReport } from './types.ts';

function makeMultiCaseReport(
  runtime: 'bun' | 'node',
  entries: {
    name: string;
    role?: BenchCaseRole;
    samplesMs: number[];
    peakRssMB?: number;
    digest?: string;
  }[],
): BenchJsonReport {
  return {
    schemaVersion: 1,
    package: '@iyowei/demo',
    runtime,
    runtimeVersion: '1.0.0',
    suite: 'quick',
    cases: entries.map((e) => {
      const sorted = [...e.samplesMs].sort((a, b) => a - b);
      return {
        name: e.name,
        role: e.role ?? 'primary',
        iterations: e.samplesMs.length,
        samplesMs: e.samplesMs,
        minMs: sorted[0] ?? 0,
        medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
        p95Ms: sorted[sorted.length - 1] ?? 0,
        peakRssMB: e.peakRssMB ?? 50,
        digest: e.digest ?? 'abc123',
      };
    }),
  };
}

describe('stats 描述统计与 Mann-Whitney U', () => {
  test('describeSamples 精确计算分位数与均值', () => {
    const s = describeSamples([10, 20, 30, 40, 50]);
    expect(s.min).toBe(10);
    expect(s.median).toBe(30);
    expect(s.mean).toBe(30);
    expect(s.count).toBe(5);
  });

  test('两组无重叠分布给出显著极小 pValue', () => {
    const base = [100, 102, 99, 101, 103, 98, 104, 100];
    const cand = [70, 72, 69, 71, 73, 68, 74, 70];
    const res = mannWhitneyU(base, cand);
    expect(res.u).toBe(0);
    expect(res.pValue).toBeLessThan(0.01);
  });

  test('完全相同分布给出不显著 pValue', () => {
    const base = [50, 51, 52, 50, 49, 51, 50, 52];
    const cand = [50, 51, 52, 50, 49, 51, 50, 52];
    const res = mannWhitneyU(base, cand);
    expect(res.pValue).toBeGreaterThan(0.9);
  });
});

describe('judgeSuiteEvaluation 双运行时裁定、主对照分离与定级', () => {
  test('单核心主路径暴涨 +45% 不会被其余 4 个不变或对照组用例中位数压成 0%', () => {
    const bunBase = [
      makeMultiCaseReport('bun', [
        {
          name: 'scan:prune',
          role: 'reference',
          samplesMs: [50, 50, 50, 50, 50],
        },
        {
          name: 'scan:native',
          role: 'reference',
          samplesMs: [80, 80, 80, 80, 80],
        },
        {
          name: 'scan:parallel',
          role: 'primary',
          samplesMs: [100, 101, 99, 102, 100],
        },
        {
          name: 'size:du',
          role: 'primary',
          samplesMs: [20, 20, 20, 20, 20],
        },
        {
          name: 'size:js',
          role: 'primary',
          samplesMs: [30, 30, 30, 30, 30],
        },
      ]),
    ];
    const bunCand = [
      makeMultiCaseReport('bun', [
        {
          name: 'scan:prune',
          role: 'reference',
          samplesMs: [50, 50, 50, 50, 50],
        },
        {
          name: 'scan:native',
          role: 'reference',
          samplesMs: [80, 80, 80, 80, 80],
        },
        {
          name: 'scan:parallel',
          role: 'primary',
          samplesMs: [55, 56, 54, 55, 55],
        },
        {
          name: 'size:du',
          role: 'primary',
          samplesMs: [20, 20, 20, 20, 20],
        },
        {
          name: 'size:js',
          role: 'primary',
          samplesMs: [30, 30, 30, 30, 30],
        },
      ]),
    ];

    const verdict = judgeSuiteEvaluation(bunBase, bunCand);
    expect(verdict.verdict).toBe('KEEP');
    expect(verdict.measuredTier).toBe('P0');
    expect(verdict.overallGainPct).toBeGreaterThanOrEqual(44);
  });

  test('Bun 显著提速但 Node 主路径劣化超 3% 触发双运行时守卫回退', () => {
    const bunBase = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [100, 101, 102, 99, 100] },
      ]),
    ];
    const bunCand = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [80, 81, 82, 79, 80] },
      ]),
    ];
    const nodeBase = [
      makeMultiCaseReport('node', [
        { name: 'core', samplesMs: [100, 101, 102, 99, 100] },
      ]),
    ];
    const nodeCand = [
      makeMultiCaseReport('node', [
        { name: 'core', samplesMs: [115, 116, 114, 115, 117] },
      ]),
    ];

    const verdict = judgeSuiteEvaluation(bunBase, bunCand, nodeBase, nodeCand);
    expect(verdict.verdict).toBe('REVERT');
    expect(verdict.failureReason).toBe('CROSS_RUNTIME_REGRESSION');
  });

  test('digest 不一致立即判定 CORRECTNESS_FAIL', () => {
    const bunBase = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [100, 101, 102, 99, 100], digest: 'aaa' },
      ]),
    ];
    const bunCand = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [50, 51, 52, 49, 50], digest: 'bbb' },
      ]),
    ];

    const verdict = judgeSuiteEvaluation(bunBase, bunCand);
    expect(verdict.verdict).toBe('REVERT');
    expect(verdict.failureReason).toBe('CORRECTNESS_FAIL');
  });

  test('提升低于 2% 噪声门槛被回退为 NO_GAIN', () => {
    const bunBase = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [100, 100, 100, 100, 100] },
      ]),
    ];
    const bunCand = [
      makeMultiCaseReport('bun', [
        { name: 'core', samplesMs: [99, 99, 99, 99, 99] },
      ]),
    ];

    const verdict = judgeSuiteEvaluation(bunBase, bunCand);
    expect(verdict.verdict).toBe('REVERT');
    expect(verdict.failureReason).toBe('NO_GAIN');
  });

  test('assignMeasuredTier 按百分比精确划分 P0/P1/P2', () => {
    expect(assignMeasuredTier(26, null)).toBe('P0');
    expect(assignMeasuredTier(12, null)).toBe('P1');
    expect(assignMeasuredTier(4, null)).toBe('P2');
    expect(assignMeasuredTier(1.5, null)).toBeNull();
    expect(assignMeasuredTier(3, 42)).toBe('P0');
  });
});
