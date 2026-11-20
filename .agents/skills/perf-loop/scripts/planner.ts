/**
 * perf-loop 探索排期与现场冻结阶段 (status / next / prepare)。
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { collectPackageProfile, runBenchOnce } from './bench-protocol.ts';
import {
  classifyRejectedQueue,
  evaluateStopping,
  loadPackageLedger,
} from './ledger.ts';
import type {
  BenchSuiteKind,
  DiscoveredPackage,
  StoppingEvaluation,
} from './types.ts';
import {
  buildPackageSourceMap,
  computeBenchDirHashes,
  computeEnvFingerprint,
  computeOutsideScopeDigest,
  detectRuntimes,
  discoverTargetPackages,
  savePackageSnapshot,
} from './workspace-ops.ts';

export interface RunState {
  runId: string;
  pkgName: string;
  pkgDir: string;
  suite: BenchSuiteKind;
  baselineDir: string;
  candidateDir: string;
  profDir: string;
  baselineBenchHashes: Record<string, string>;
  baselineOutsideDigest: string;
  acceptedCount: number;
  highImpactCount: number;
  runtimes: { bun: string | null; node: string | null };
  createdAt: number;
}

const KIND_PRIORITY: Readonly<Record<DiscoveredPackage['kind'], number>> = {
  'public-lib': 0,
  'private-lib': 1,
  cli: 2,
};

export function summarizePackage(
  repoRoot: string,
  pkg: DiscoveredPackage,
  runtimes: { bun: string | null; node: string | null },
) {
  const ledger = loadPackageLedger(repoRoot, pkg.dir);
  const fp = computeEnvFingerprint({
    repoRoot,
    pkgDir: pkg.dir,
    acceptedCountAtAttempt: ledger.accepted.length,
    highImpactAcceptedCountAtAttempt: ledger.highImpactCount,
    runtimes,
  });
  const rejectedStatus = classifyRejectedQueue(
    ledger.rejected,
    fp,
    ledger.highImpactCount,
  );
  const stopping = evaluateStopping(ledger.accepted, ledger.rejected);
  const ready =
    pkg.hasBenchScript &&
    pkg.hasBenchEntry &&
    pkg.supportsJsonBench &&
    !pkg.isStubBench;

  return {
    ...pkg,
    ready,
    acceptedCount: ledger.accepted.length,
    highImpactCount: ledger.highImpactCount,
    rejectedCount: ledger.rejected.length,
    lockedCount: rejectedStatus.locked.length,
    reeligibleCount: rejectedStatus.reeligible.length,
    stopping,
  };
}

export function pickNextTarget(
  summaries: readonly ReturnType<typeof summarizePackage>[],
): {
  action: 'OPTIMIZE' | 'INIT_BENCH' | 'COMPLETE_BENCH_STUB' | 'ALL_CONVERGED';
  target: string | null;
  reason: string;
} {
  const isDone = (s: StoppingEvaluation): boolean =>
    s.decision === 'STOP_DIMINISHING_RETURNS' ||
    s.decision === 'STOP_STREAK_EXHAUSTED';

  const active = summaries.filter((s) => !isDone(s.stopping));
  if (active.length === 0) {
    return {
      action: 'ALL_CONVERGED',
      target: null,
      reason: '全部工作区包均已达成性能收敛或熔断条件',
    };
  }

  const sorted = [...active].sort(
    (a, b) => KIND_PRIORITY[a.kind] - KIND_PRIORITY[b.kind],
  );

  const readyOne = sorted.find((s) => s.ready);
  if (readyOne !== undefined) {
    return {
      action: 'OPTIMIZE',
      target: readyOne.name,
      reason: `优先优化核心库/就绪目标 ${readyOne.name} (${readyOne.dir})`,
    };
  }

  const stubOne = sorted.find((s) => s.isStubBench);
  if (stubOne !== undefined) {
    return {
      action: 'COMPLETE_BENCH_STUB',
      target: stubOne.name,
      reason: `${stubOne.dir}/bench/run.ts 仍含 @perf-loop:stub 占位标记, 须先填充真实业务负载`,
    };
  }

  const nextUnready = sorted[0]!;
  return {
    action: 'INIT_BENCH',
    target: nextUnready.name,
    reason: `${nextUnready.name} (${nextUnready.dir}) 缺少标准化 bench, 应先运行 init-bench 建设基准探针`,
  };
}

export function runStatusCommand(repoRoot: string, pkgHint?: string) {
  const pkgs = discoverTargetPackages(repoRoot, pkgHint);
  const runtimes = detectRuntimes();
  const packages = pkgs.map((pkg) => summarizePackage(repoRoot, pkg, runtimes));
  const next = pickNextTarget(packages);
  return { runtimes, next, packages };
}

export function runNextCommand(repoRoot: string) {
  const pkgs = discoverTargetPackages(repoRoot);
  const runtimes = detectRuntimes();
  const packages = pkgs.map((pkg) => summarizePackage(repoRoot, pkg, runtimes));
  return { next: pickNextTarget(packages), runtimes };
}

export function runPrepareCommand(options: {
  repoRoot: string;
  tmpBase: string;
  pkgHint: string;
  suite: BenchSuiteKind;
  caseFilter?: string;
}) {
  const [pkg] = discoverTargetPackages(options.repoRoot, options.pkgHint);
  if (pkg === undefined) throw new Error('未匹配到包');
  if (pkg.isStubBench) {
    throw new Error(
      `${pkg.dir}/bench/run.ts 仍包含占位标记 (@perf-loop:stub), 严禁对空循环做优化; 请先替换为真实负载并移除该标记`,
    );
  }
  if (!pkg.hasBenchEntry || !pkg.supportsJsonBench) {
    throw new Error(
      `${pkg.name} (${pkg.dir}) 尚无符合 --json 协议的 bench/run.ts, 请先执行 init-bench 并完成基准建设`,
    );
  }

  const ledger = loadPackageLedger(options.repoRoot, pkg.dir);
  const runtimes = detectRuntimes();
  const fp = computeEnvFingerprint({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    acceptedCountAtAttempt: ledger.accepted.length,
    highImpactAcceptedCountAtAttempt: ledger.highImpactCount,
    runtimes,
  });
  const stopping = evaluateStopping(ledger.accepted, ledger.rejected);
  const rejectedStatus = classifyRejectedQueue(
    ledger.rejected,
    fp,
    ledger.highImpactCount,
  );

  if (
    stopping.decision === 'STOP_DIMINISHING_RETURNS' ||
    stopping.decision === 'STOP_STREAK_EXHAUSTED'
  ) {
    return {
      package: pkg,
      stopping,
      acceptedCount: ledger.accepted.length,
      rejectedCount: ledger.rejected.length,
      message: '目标包已达收敛/熔断停止条件, 无需继续新建提案',
    };
  }

  const runId = `${pkg.dir.replaceAll('/', '_')}-${Date.now()}`;
  const rDir = join(options.tmpBase, runId);
  const baselineDir = join(rDir, 'baseline-files');
  const candidateDir = join(rDir, 'candidate-files');
  const profDir = join(rDir, 'profiles');
  mkdirSync(rDir, { recursive: true });

  savePackageSnapshot(options.repoRoot, pkg.dir, baselineDir);
  const state: RunState = {
    runId,
    pkgName: pkg.name,
    pkgDir: pkg.dir,
    suite: options.suite,
    baselineDir,
    candidateDir,
    profDir,
    baselineBenchHashes: computeBenchDirHashes(options.repoRoot, pkg.dir),
    baselineOutsideDigest: computeOutsideScopeDigest(options.repoRoot, pkg.dir),
    acceptedCount: ledger.accepted.length,
    highImpactCount: ledger.highImpactCount,
    runtimes,
    createdAt: Date.now(),
  };
  writeFileSync(join(rDir, 'state.json'), JSON.stringify(state, null, 2));

  const baselineSample = runBenchOnce({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    runtime: 'bun',
    suite: options.suite,
    caseFilter: options.caseFilter,
  });
  const profile = collectPackageProfile({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    profDir,
    suite: options.suite,
  });
  const sourceMap = buildPackageSourceMap(options.repoRoot, pkg.dir);

  return {
    runId,
    package: pkg,
    runtimes,
    stopping,
    baselineCases: baselineSample.cases,
    profile,
    sourceMap,
    recentAccepted: ledger.accepted.slice(-5).map((r) => ({
      id: r.id,
      dimension: r.dimension,
      measuredTier: r.measuredTier,
      overallGainPct: r.overallGainPct,
      proposal: r.proposal,
    })),
    reeligibleProposals: rejectedStatus.reeligible.map((item) => ({
      id: item.record.id,
      proposal: item.record.proposal,
      dimension: item.record.dimension,
      previousFailure: item.record.failureReason,
      reopenReasons: item.reasons,
    })),
    lockedProposals: rejectedStatus.locked.map((item) => ({
      id: item.record.id,
      proposal: item.record.proposal,
      failureReason: item.record.failureReason,
    })),
  };
}
