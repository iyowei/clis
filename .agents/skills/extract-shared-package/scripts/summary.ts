/**
 * 确定性收敛汇总结算器: 一键汇总已抽包、已回收库、否决台账、冷却中私库、孤立公开库与 Rust 预警。
 */
import type { ExtractLedger, ScanReport } from './types.ts';

export interface ExtractSummaryReport {
  schemaVersion: number;
  generatedAt: string;
  repoRoot: string;
  roundsExecuted: number;
  activeRoundId: string | null;
  convergence: ScanReport['convergence'];
  nextAction: ScanReport['nextAction'];
  extractedPackages: Array<{
    packageName: string;
    fingerprint: string;
    reason: string;
    recordedAt: string;
  }>;
  reabsorbedPackages: Array<{
    packageName: string;
    fingerprint: string;
    reason: string;
    recordedAt: string;
  }>;
  rejectedOrDeferred: Array<{
    fingerprint: string;
    status: 'rejected' | 'deferred';
    packageName?: string;
    reason: string;
  }>;
  coolingDownLibs: Array<{
    pkgName: string;
    pkgDir: string;
    remainingDays: number;
    firstObservedAt?: string;
    consumers: string[];
  }>;
  orphanedPublicLibs: Array<{
    pkgName: string;
    pkgDir: string;
    consumers: string[];
    reason: string;
  }>;
  rustReadinessAlerts: Array<{
    file: string;
    pkgName: string;
    score: number;
    ioBoundaryMixed: boolean;
    recommendation: string;
  }>;
}

export function buildExtractSummary(
  report: ScanReport,
  ledger: ExtractLedger,
): ExtractSummaryReport {
  const extractedPackages = ledger.records
    .filter((r) => r.status === 'accepted' && r.packageName !== undefined)
    .map((r) => ({
      packageName: r.packageName!,
      fingerprint: r.fingerprint,
      reason: r.reason,
      recordedAt: r.recordedAt,
    }));

  const reabsorbedPackages = ledger.records
    .filter((r) => r.status === 'reabsorbed' && r.packageName !== undefined)
    .map((r) => ({
      packageName: r.packageName!,
      fingerprint: r.fingerprint,
      reason: r.reason,
      recordedAt: r.recordedAt,
    }));

  const rejectedOrDeferred = ledger.records
    .filter(
      (r): r is typeof r & { status: 'rejected' | 'deferred' } =>
        r.status === 'rejected' || r.status === 'deferred',
    )
    .map((r) => ({
      fingerprint: r.fingerprint,
      status: r.status,
      packageName: r.packageName,
      reason: r.reason,
    }));

  const coolingDownLibs = report.degeneratedLibs
    .filter((d) => d.status === 'cooling-down' && !d.suppressed)
    .map((d) => ({
      pkgName: d.pkgName,
      pkgDir: d.pkgDir,
      remainingDays: d.remainingDays ?? 0,
      firstObservedAt: d.firstObservedAt,
      consumers: d.transitiveBusinessConsumers,
    }));

  const orphanedPublicLibs = report.degeneratedLibs
    .filter((d) => d.status === 'orphaned-public-lib')
    .map((d) => ({
      pkgName: d.pkgName,
      pkgDir: d.pkgDir,
      consumers: d.transitiveBusinessConsumers,
      reason: d.reason,
    }));

  const rustReadinessAlerts = report.files
    .filter((f) => !f.isInfra && f.rustReadiness.grade === 'low')
    .sort((a, b) => a.rustReadiness.score - b.rustReadiness.score)
    .slice(0, 15)
    .map((f) => ({
      file: f.file,
      pkgName: f.pkgName,
      score: f.rustReadiness.score,
      ioBoundaryMixed: f.rustReadiness.ioBoundaryMixed,
      recommendation: f.rustReadiness.recommendation,
    }));

  return {
    schemaVersion: 1,
    generatedAt: report.scannedAt,
    repoRoot: report.repoRoot,
    roundsExecuted: ledger.roundsExecuted,
    activeRoundId: ledger.activeRoundId ?? null,
    convergence: report.convergence,
    nextAction: report.nextAction,
    extractedPackages,
    reabsorbedPackages,
    rejectedOrDeferred,
    coolingDownLibs,
    orphanedPublicLibs,
    rustReadinessAlerts,
  };
}
