/**
 * perf-loop 评估、A/B 裁定、快照还原与异常恢复阶段 (evaluate / recover)。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { collectNodeCpuHotspots, runInterleavedAb } from './bench-protocol.ts';
import {
  captureScopedCandidates,
  restoreScopedVariant,
  runScopedValidationGates,
} from './companion-scope.ts';
import {
  appendExperimentRecord,
  evaluateStopping,
  loadPackageLedger,
} from './ledger.ts';
import type { RunState } from './planner.ts';
import { judgeSuiteEvaluation } from './stats.ts';
import type { ExperimentRecord, PerfDimension, PriorityTier } from './types.ts';
import {
  checkPolicyViolations,
  collectDocHints,
  computeEnvFingerprint,
  discoverTargetPackages,
  shouldRebuildPackageDist,
} from './workspace-ops.ts';

function finalizeRevert(options: {
  repoRoot: string;
  runDir: string;
  state: RunState;
  pkgName: string;
  proposal: string;
  rationale: string;
  dimension: PerfDimension;
  expectedTier: PriorityTier;
  touchedFiles: string[];
  fp: ExperimentRecord['fingerprint'];
  reason: ExperimentRecord['failureReason'];
  detail: string;
  rebuildIfNeeded?: boolean;
  extra?: Partial<ExperimentRecord>;
  nodeProfileHints?: string[];
}) {
  const { state, repoRoot } = options;
  restoreScopedVariant({
    repoRoot,
    pkgDir: state.pkgDir,
    primarySnapshotDir: state.baselineDir,
    companions: state.companionPackages,
    variant: 'baseline',
    rebuildIfNeeded: options.rebuildIfNeeded,
    ignoreRebuildFailure: true,
  });
  const record: ExperimentRecord = {
    id: createHash('sha256')
      .update(`${state.runId}:${options.proposal}`)
      .digest('hex')
      .slice(0, 12),
    ts: Date.now(),
    package: options.pkgName,
    proposal: options.proposal,
    rationale: options.rationale,
    dimension: options.dimension,
    expectedTier: options.expectedTier,
    verdict: 'REVERT',
    measuredTier: null,
    failureReason: options.reason,
    touchedFiles: options.touchedFiles,
    metrics: options.extra?.metrics ?? [],
    overallGainPct: options.extra?.overallGainPct ?? 0,
    overallRssGainPct: options.extra?.overallRssGainPct ?? null,
    nodeRegressionPct: options.extra?.nodeRegressionPct ?? null,
    fingerprint: options.fp,
    docActionRequired: false,
    docNotes: options.detail,
  };
  const ledgerFile = appendExperimentRecord(repoRoot, state.pkgDir, record);
  const updated = loadPackageLedger(repoRoot, state.pkgDir);
  const stopping = evaluateStopping(updated.accepted, updated.rejected);
  rmSync(options.runDir, { recursive: true, force: true });
  return {
    record,
    ledgerFile,
    stopping,
    detail: options.detail,
    nodeProfileHints: options.nodeProfileHints ?? [],
  };
}

export function runEvaluateCommand(options: {
  repoRoot: string;
  tmpBase: string;
  pkgHint: string;
  runId: string;
  proposal: string;
  dimension: PerfDimension;
  expectedTier: PriorityTier;
  rationale: string;
  caseFilter?: string;
  allowCrossPkg: boolean;
  cycles: number;
}) {
  const rDir = join(options.tmpBase, options.runId);
  const statePath = join(rDir, 'state.json');
  if (!existsSync(statePath)) {
    throw new Error(`找不到运行状态文件: ${statePath}, 请先执行 prepare`);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as RunState;
  const [pkg] = discoverTargetPackages(options.repoRoot, options.pkgHint);
  if (pkg === undefined || pkg.dir !== state.pkgDir) {
    throw new Error(`包参数与 runId (${state.pkgDir}) 不匹配`);
  }

  const companions = state.companionPackages ?? [];
  const {
    primaryTouched,
    companionTouchedByDir,
    activeCompanions,
    allTouchedFiles,
  } = captureScopedCandidates(
    options.repoRoot,
    pkg.dir,
    state.baselineDir,
    state.candidateDir,
    companions,
  );
  const touchedFiles = options.allowCrossPkg ? allTouchedFiles : primaryTouched;
  const crossPkgActive = options.allowCrossPkg && companions.length > 0;
  const needsDistRebuild =
    crossPkgActive || shouldRebuildPackageDist(options.repoRoot, pkg.dir);
  const ledger = loadPackageLedger(options.repoRoot, pkg.dir);
  const fp = computeEnvFingerprint({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    acceptedCountAtAttempt: ledger.accepted.length,
    highImpactAcceptedCountAtAttempt: ledger.highImpactCount,
    runtimes: state.runtimes,
  });

  const commonRevert = {
    repoRoot: options.repoRoot,
    runDir: rDir,
    state,
    pkgName: pkg.name,
    proposal: options.proposal,
    rationale: options.rationale,
    dimension: options.dimension,
    expectedTier: options.expectedTier,
    touchedFiles,
    fp,
    rebuildIfNeeded: needsDistRebuild,
  };

  const policyViolation = checkPolicyViolations({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    baselineBenchHashes: state.baselineBenchHashes,
    baselineOutsideDigest: state.baselineOutsideDigest,
    allowCrossPkg: options.allowCrossPkg,
    companionPackages: companions,
    baselineOutsidePairDigest: state.baselineOutsidePairDigest,
  });
  if (policyViolation !== null) {
    return finalizeRevert({
      ...commonRevert,
      reason: 'POLICY_VIOLATION',
      detail: policyViolation,
    });
  }

  if (touchedFiles.length === 0) {
    return finalizeRevert({
      ...commonRevert,
      reason: 'NO_GAIN',
      detail: '目标包源码未发生任何实际变更',
    });
  }

  const validation = runScopedValidationGates({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    primaryTouched,
    allowCrossPkg: options.allowCrossPkg,
    companions,
    companionTouchedByDir,
  });
  if (!validation.ok) {
    return finalizeRevert({
      ...commonRevert,
      reason: 'CORRECTNESS_FAIL',
      detail: `验证闸门 [${validation.stage}] 失败:\n${validation.output.slice(0, 1000)}`,
    });
  }

  const ab = runInterleavedAb({
    repoRoot: options.repoRoot,
    pkgDir: pkg.dir,
    baselineSnapshotDir: state.baselineDir,
    candidateSnapshotDir: state.candidateDir,
    companionPackages: crossPkgActive ? activeCompanions : undefined,
    rebuildOnSwitch: crossPkgActive && activeCompanions.length > 0,
    cycles: options.cycles,
    suite: state.suite,
    includeNode: state.runtimes.node !== null,
    caseFilter: options.caseFilter,
  });

  const suiteVerdict = judgeSuiteEvaluation(
    ab.bunBaseline,
    ab.bunCandidate,
    ab.nodeBaseline,
    ab.nodeCandidate,
  );

  if (suiteVerdict.verdict === 'REVERT') {
    const nodeProfileHints =
      suiteVerdict.failureReason === 'CROSS_RUNTIME_REGRESSION'
        ? collectNodeCpuHotspots({
            repoRoot: options.repoRoot,
            pkgDir: pkg.dir,
            profDir: state.profDir,
            suite: state.suite,
          })
        : [];
    return finalizeRevert({
      ...commonRevert,
      reason: suiteVerdict.failureReason,
      detail: suiteVerdict.reason,
      extra: {
        metrics: suiteVerdict.caseSummaries,
        overallGainPct: suiteVerdict.overallGainPct,
        overallRssGainPct: suiteVerdict.overallRssGainPct,
        nodeRegressionPct: suiteVerdict.nodeRegressionPct,
      },
      nodeProfileHints,
    });
  }

  const docActionRequired =
    suiteVerdict.measuredTier === 'P0' || suiteVerdict.measuredTier === 'P1';
  const docHints = docActionRequired
    ? collectDocHints(options.repoRoot, pkg.dir)
    : undefined;
  const record: ExperimentRecord = {
    id: createHash('sha256')
      .update(`${options.runId}:${options.proposal}`)
      .digest('hex')
      .slice(0, 12),
    ts: Date.now(),
    package: pkg.name,
    proposal: options.proposal,
    rationale: options.rationale,
    dimension: options.dimension,
    expectedTier: options.expectedTier,
    verdict: 'KEEP',
    measuredTier: suiteVerdict.measuredTier,
    failureReason: null,
    touchedFiles,
    metrics: suiteVerdict.caseSummaries,
    overallGainPct: suiteVerdict.overallGainPct,
    overallRssGainPct: suiteVerdict.overallRssGainPct,
    nodeRegressionPct: suiteVerdict.nodeRegressionPct,
    fingerprint: fp,
    docActionRequired,
    docNotes: docActionRequired
      ? `实测 ${suiteVerdict.measuredTier}: 须当场按 docs-distillation-guide.md 融合更新项目 docs`
      : '实测 P2: 记入账本与源码注释即可, 不写进 docs',
  };

  const ledgerFile = appendExperimentRecord(options.repoRoot, pkg.dir, record);
  const updated = loadPackageLedger(options.repoRoot, pkg.dir);
  const stopping = evaluateStopping(updated.accepted, updated.rejected);
  rmSync(rDir, { recursive: true, force: true });

  return {
    record,
    ledgerFile,
    stopping,
    detail: suiteVerdict.reason,
    docHints,
  };
}

export function runRecoverCommand(
  repoRoot: string,
  tmpBase: string,
  runId: string,
): string {
  const rDir = join(tmpBase, runId);
  const statePath = join(rDir, 'state.json');
  if (!existsSync(statePath)) {
    throw new Error(`找不到可恢复的运行记录: ${statePath}`);
  }
  const state = JSON.parse(readFileSync(statePath, 'utf8')) as RunState;
  const companions = state.companionPackages ?? [];
  restoreScopedVariant({
    repoRoot,
    pkgDir: state.pkgDir,
    primarySnapshotDir: state.baselineDir,
    companions,
    variant: 'baseline',
    rebuildIfNeeded:
      companions.length > 0 || shouldRebuildPackageDist(repoRoot, state.pkgDir),
    ignoreRebuildFailure: true,
  });
  rmSync(rDir, { recursive: true, force: true });
  const scopeLabel = [state.pkgDir, ...companions.map((c) => c.pkgDir)].join(
    ', ',
  );
  return `已安全将 ${scopeLabel} 恢复到基线快照并清理临时目录`;
}
