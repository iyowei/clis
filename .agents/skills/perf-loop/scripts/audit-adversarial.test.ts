/**
 * 五阶对齐审计的对抗性证伪套件:
 * 在 ~/tmp 隔离靶场实跑真实的 Bun/Node A/B 交替调度、Node V8 退化诊断、Profile 分桶与仓内文档提示。
 */
import { describe, expect, test } from 'bun:test';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { collectNodeCpuHotspots, runInterleavedAb } from './bench-protocol.ts';
import { parseProfileMarkdowns } from './profile-parse.ts';
import { judgeSuiteEvaluation } from './stats.ts';
import { collectDocHints, savePackageSnapshot } from './workspace-ops.ts';

function buildRealDualRuntimeTarget(): {
  root: string;
  pkgDir: string;
  srcFile: string;
} {
  const root = join(
    tmpdir(),
    `perf-loop-adv-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  const pkgDir = 'packages/target';
  mkdirSync(join(root, pkgDir, 'src'), { recursive: true });
  mkdirSync(join(root, pkgDir, 'bench'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'adv-mono', workspaces: ['packages/*'] }),
  );
  writeFileSync(
    join(root, pkgDir, 'package.json'),
    JSON.stringify({ name: '@adv/target', type: 'module' }),
  );

  const srcFile = join(root, pkgDir, 'src', 'algo.ts');
  // 基线实现: O(N^2) 线性查重 (可测耗时在几毫秒~十几毫秒量级)
  writeFileSync(
    srcFile,
    `export function countCommon(a: number[], b: number[]): number {
  let count = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (b.includes(a[i]!)) count += 1;
  }
  return count;
}
`,
  );

  // 基准脚本: 双运行时兼容, 含 primary 与不变的 reference 对照用例
  writeFileSync(
    join(root, pkgDir, 'bench', 'run.ts'),
    `import { countCommon } from '../src/algo.ts';

const arrA = Array.from({ length: 4500 }, (_, i) => i * 2);
const arrB = Array.from({ length: 4500 }, (_, i) => i * 3);

function measurePrimary() {
  countCommon(arrA, arrB);
  const samplesMs: number[] = [];
  let hits = 0;
  for (let i = 0; i < 6; i += 1) {
    const t0 = performance.now();
    hits = countCommon(arrA, arrB);
    samplesMs.push(performance.now() - t0);
  }
  const sorted = [...samplesMs].sort((a, b) => a - b);
  return {
    name: 'common-intersection',
    role: 'primary',
    iterations: samplesMs.length,
    samplesMs,
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    p95Ms: sorted[sorted.length - 1] ?? 0,
    digest: String(hits),
  };
}

function measureReference() {
  const samplesMs = [1.0, 1.0, 1.0, 1.0, 1.0, 1.0];
  return {
    name: 'baseline-reference',
    role: 'reference',
    iterations: 6,
    samplesMs,
    minMs: 1.0,
    medianMs: 1.0,
    p95Ms: 1.0,
    digest: 'ref-ok',
  };
}

const isBun = typeof Bun !== 'undefined';
const report = {
  schemaVersion: 1,
  package: '@adv/target',
  runtime: isBun ? 'bun' : 'node',
  runtimeVersion: isBun ? Bun.version : process.version.replace(/^v/, ''),
  suite: 'quick',
  cases: [measurePrimary(), measureReference()],
};
process.stdout.write(\`\${JSON.stringify(report)}\\n\`);
`,
  );

  return { root, pkgDir, srcFile };
}

describe('对抗性真机验证 (真实 Bun + Node 子进程交替 A/B)', () => {
  test('用例 A+C1: O(N^2)->O(N) 真提速在 Bun+Node 交替采样下真实判 KEEP 且 P0', () => {
    const { root, pkgDir, srcFile } = buildRealDualRuntimeTarget();
    const baseSnap = join(root, '.snap-base');
    const candSnap = join(root, '.snap-cand');
    try {
      savePackageSnapshot(root, pkgDir, baseSnap);

      // 替换为 Set O(N) 实现
      writeFileSync(
        srcFile,
        `export function countCommon(a: number[], b: number[]): number {
  const setB = new Set(b);
  let count = 0;
  for (let i = 0; i < a.length; i += 1) {
    if (setB.has(a[i]!)) count += 1;
  }
  return count;
}
`,
      );
      savePackageSnapshot(root, pkgDir, candSnap);

      const ab = runInterleavedAb({
        repoRoot: root,
        pkgDir,
        baselineSnapshotDir: baseSnap,
        candidateSnapshotDir: candSnap,
        cycles: 2,
        suite: 'quick',
        includeNode: true,
      });
      const verdict = judgeSuiteEvaluation(
        ab.bunBaseline,
        ab.bunCandidate,
        ab.nodeBaseline,
        ab.nodeCandidate,
      );

      expect(verdict.verdict).toBe('KEEP');
      expect(verdict.measuredTier).toBe('P0');
      expect(verdict.overallGainPct).toBeGreaterThan(50);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('用例 C2: 仅破坏 Node 性能的写法被拦截, 且按需抽取出 V8 CPU Top 热点函数', () => {
    const { root, pkgDir, srcFile } = buildRealDualRuntimeTarget();
    const baseSnap = join(root, '.snap-base');
    const candSnap = join(root, '.snap-cand');
    const profDir = join(root, '.node-prof');
    try {
      savePackageSnapshot(root, pkgDir, baseSnap);

      // Bun 快 (Set O(N)), 但故意在 Node 下走双倍 O(N^2) 触发跨运行时回归
      writeFileSync(
        srcFile,
        `export function nodeSlowPenalty(a: number[], b: number[]): number {
  let count = 0;
  for (let r = 0; r < 2; r += 1) {
    count = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (b.includes(a[i]!)) count += 1;
    }
  }
  return count;
}

export function countCommon(a: number[], b: number[]): number {
  if (typeof Bun !== 'undefined') {
    const setB = new Set(b);
    let count = 0;
    for (let i = 0; i < a.length; i += 1) {
      if (setB.has(a[i]!)) count += 1;
    }
    return count;
  }
  return nodeSlowPenalty(a, b);
}
`,
      );
      savePackageSnapshot(root, pkgDir, candSnap);

      const ab = runInterleavedAb({
        repoRoot: root,
        pkgDir,
        baselineSnapshotDir: baseSnap,
        candidateSnapshotDir: candSnap,
        cycles: 2,
        suite: 'quick',
        includeNode: true,
      });
      const verdict = judgeSuiteEvaluation(
        ab.bunBaseline,
        ab.bunCandidate,
        ab.nodeBaseline,
        ab.nodeCandidate,
      );

      expect(verdict.verdict).toBe('REVERT');
      expect(verdict.failureReason).toBe('CROSS_RUNTIME_REGRESSION');

      const hints = collectNodeCpuHotspots({
        repoRoot: root,
        pkgDir,
        profDir,
        suite: 'quick',
      });
      expect(hints.length).toBeGreaterThan(0);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('用例 C3: 提速但算错结果立即触发 CORRECTNESS_FAIL', () => {
    const { root, pkgDir, srcFile } = buildRealDualRuntimeTarget();
    const baseSnap = join(root, '.snap-base');
    const candSnap = join(root, '.snap-cand');
    try {
      savePackageSnapshot(root, pkgDir, baseSnap);
      writeFileSync(
        srcFile,
        `export function countCommon(): number { return 42; }\n`,
      );
      savePackageSnapshot(root, pkgDir, candSnap);

      const ab = runInterleavedAb({
        repoRoot: root,
        pkgDir,
        baselineSnapshotDir: baseSnap,
        candidateSnapshotDir: candSnap,
        cycles: 1,
        suite: 'quick',
        includeNode: false,
      });
      const verdict = judgeSuiteEvaluation(ab.bunBaseline, ab.bunCandidate);
      expect(verdict.verdict).toBe('REVERT');
      expect(verdict.failureReason).toBe('CORRECTNESS_FAIL');
      expect(readFileSync(srcFile, 'utf8')).toContain('return 42');
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('用例 D+F: Profile setup 噪音分离与全仓真实 ADR 下一号计算准确', () => {
    const dir = join(
      tmpdir(),
      `perf-loop-prof-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(dir, { recursive: true });
    try {
      const cpuMd = join(dir, 'cpu.md');
      writeFileSync(
        cpuMd,
        [
          '## Hot Functions (Self Time)',
          '| Self% | Self | Total% | Total | Function | Location |',
          '|---:|---:|---:|---:|---|---|',
          '| 44.8% | 900ms | 44.8% | 900ms | `writeFile` | `[native code]` |',
          '| 14.0% | 280ms | 14.0% | 280ms | `makeWorkspace` | `src/fixtures.ts:10` |',
          '| 21.5% | 430ms | 21.5% | 430ms | `walkParallel` | `src/scan-parallel.ts:42` |',
        ].join('\n'),
      );
      const digest = parseProfileMarkdowns(cpuMd, null, 1.2, 0.25);
      expect(digest.ioDominatedHint).toBe(true);
      expect(digest.setupHotFunctions).toHaveLength(2);
      expect(digest.targetHotFunctions).toHaveLength(1);
      expect(digest.targetHotFunctions[0]).toContain('walkParallel');

      const repoRoot = join(import.meta.dir, '..', '..', '..', '..');
      const hints = collectDocHints(repoRoot, 'packages/sweep-cli');
      expect(Number(hints.nextGlobalAdrNumber)).toBeGreaterThanOrEqual(25);
      expect(hints.pkgDesignsDir).toBe('packages/sweep/docs/designs');
      expect(hints.existingDesigns).toContain('scan-and-size.md');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
