import { describe, expect, test } from 'bun:test';

import {
  classifyRejectedQueue,
  evaluateRejectedEntry,
  evaluateStopping,
} from './ledger.ts';
import type { EnvFingerprint, ExperimentRecord } from './types.ts';

const baseFp: EnvFingerprint = {
  sourceHashes: { 'src/scan.ts': 'hash-v1', 'src/other.ts': 'other-v1' },
  benchHash: 'bench-v1',
  runtimeVersions: { bun: '1.4.5', node: '24.18.0' },
  acceptedCountAtAttempt: 2,
  highImpactAcceptedCountAtAttempt: 1,
};

function makeRecord(
  id: string,
  ts: number,
  verdict: 'KEEP' | 'REVERT',
  tier: 'P0' | 'P1' | 'P2' | null,
  failureReason: ExperimentRecord['failureReason'] = null,
): ExperimentRecord {
  return {
    id,
    ts,
    package: '@iyowei/demo',
    proposal: `proposal-${id}`,
    rationale: 'test',
    dimension: 'impl',
    expectedTier: tier ?? 'P2',
    verdict,
    measuredTier: tier,
    failureReason,
    touchedFiles: ['src/scan.ts'],
    metrics: [],
    overallGainPct: verdict === 'KEEP' ? 5 : 0,
    overallRssGainPct: null,
    nodeRegressionPct: null,
    fingerprint: baseFp,
    docActionRequired: tier === 'P0' || tier === 'P1',
    docNotes: null,
  };
}

describe('ledger 精准解封与复合停止判据', () => {
  test('环境指纹未变时失败记录保持 LOCKED, 且无关 P2 增补不会误解封无关失败项', () => {
    const rec = makeRecord('r1', 1, 'REVERT', null, 'NO_GAIN');
    const afterUnrelatedP2: EnvFingerprint = {
      ...baseFp,
      sourceHashes: { 'src/scan.ts': 'hash-v1', 'src/other.ts': 'other-v2' },
      acceptedCountAtAttempt: 3,
      highImpactAcceptedCountAtAttempt: 1,
    };

    const res = evaluateRejectedEntry(rec, afterUnrelatedP2, 1);
    expect(res.status).toBe('LOCKED');
    expect(res.reasons).toEqual([]);
  });

  test('直接源码变更 / 新 P0-P1 落地 / bench 变动 / 运行时升级任一发生即自动解封为 REELIGIBLE', () => {
    const rec = makeRecord('r1', 1, 'REVERT', null, 'NO_GAIN');

    const bySource = evaluateRejectedEntry(
      rec,
      {
        ...baseFp,
        sourceHashes: { 'src/scan.ts': 'hash-v2', 'src/other.ts': 'other-v1' },
      },
      1,
    );
    expect(bySource.status).toBe('REELIGIBLE');

    const byHighImpact = evaluateRejectedEntry(rec, baseFp, 2);
    expect(byHighImpact.status).toBe('REELIGIBLE');

    const byRuntime = evaluateRejectedEntry(
      rec,
      { ...baseFp, runtimeVersions: { bun: '1.5.0', node: '24.18.0' } },
      1,
    );
    expect(byRuntime.status).toBe('REELIGIBLE');

    const byQueue = classifyRejectedQueue([rec], baseFp, 1);
    expect(byQueue.locked).toHaveLength(1);
    expect(byQueue.reeligible).toHaveLength(0);
  });

  test('最近 20 个提案仅 <= 3 个 KEEP 且全为 P2 时触发 STOP_DIMINISHING_RETURNS', () => {
    const accepted = [
      makeRecord('a1', 3, 'KEEP', 'P2'),
      makeRecord('a2', 9, 'KEEP', 'P2'),
      makeRecord('a3', 18, 'KEEP', 'P2'),
    ];
    const rejected: ExperimentRecord[] = [];
    for (let i = 1; i <= 20; i += 1) {
      if (i === 3 || i === 9 || i === 18) continue;
      rejected.push(makeRecord(`r${i}`, i, 'REVERT', null, 'NO_GAIN'));
    }

    const decision = evaluateStopping(accepted, rejected);
    expect(decision.decision).toBe('STOP_DIMINISHING_RETURNS');
    expect(decision.keptInWindow).toBe(3);
    expect(decision.highImpactInWindow).toBe(0);
  });

  test('连续 12 轮无 P0/P1 且仅混入 1 个微弱 P2 时阻止续命空转并收口', () => {
    const accepted = [makeRecord('a7', 7, 'KEEP', 'P2')];
    const rejected: ExperimentRecord[] = [];
    for (let i = 1; i <= 12; i += 1) {
      if (i === 7) continue;
      rejected.push(makeRecord(`r${i}`, i, 'REVERT', null, 'NO_GAIN'));
    }
    const decision = evaluateStopping(accepted, rejected);
    expect(decision.decision).toBe('STOP_DIMINISHING_RETURNS');
  });

  test('最近 20 个提案里虽 <= 3 个 KEEP 但含 1 个 P1 时继续探索', () => {
    const accepted = [
      makeRecord('a1', 3, 'KEEP', 'P2'),
      makeRecord('a2', 12, 'KEEP', 'P1'),
      makeRecord('a3', 18, 'KEEP', 'P2'),
    ];
    const rejected: ExperimentRecord[] = [];
    for (let i = 1; i <= 20; i += 1) {
      if (i === 3 || i === 12 || i === 18) continue;
      rejected.push(makeRecord(`r${i}`, i, 'REVERT', null, 'NO_GAIN'));
    }

    const decision = evaluateStopping(accepted, rejected);
    expect(decision.decision).toBe('CONTINUE');
    expect(decision.highImpactInWindow).toBe(1);
  });

  test('连续 5 轮未出 P0/P1 触发 PIVOT_REQUIRED, 连败 8 轮触发 STOP_STREAK_EXHAUSTED', () => {
    const fiveReverts = [1, 2, 3, 4, 5].map((i) =>
      makeRecord(`r${i}`, i, 'REVERT', null, 'NO_GAIN'),
    );
    expect(evaluateStopping([], fiveReverts).decision).toBe('PIVOT_REQUIRED');

    const eightReverts = [1, 2, 3, 4, 5, 6, 7, 8].map((i) =>
      makeRecord(`r${i}`, i, 'REVERT', null, 'NO_GAIN'),
    );
    expect(evaluateStopping([], eightReverts).decision).toBe(
      'STOP_STREAK_EXHAUSTED',
    );
  });
});
