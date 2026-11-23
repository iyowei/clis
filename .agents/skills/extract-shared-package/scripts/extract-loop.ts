/**
 * extract-shared-package 主命令行编排入口 (单一权威 CLI 契约 + 事务校验 + 双向自均衡)。
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

import { scanWorkspace } from './analyzer.ts';
import {
  assertInsideRepo,
  assertReabsorbCheckpointMatch,
  assertRoundCheckpointMatch,
  assertValidCliFlags,
  collectSignatureArgs,
  formatCliUsage as formatUsage,
  getFlag,
  hasFlag,
  parseStrictNonNegativeInt,
  resolveRepoRoot,
  runWorkspaceCiVerify,
  saveLastScanToTmp,
  splitCsv,
  writeOut,
} from './cli-helpers.ts';
import { evaluateEssenceProposal } from './essence-gate.ts';
import { buildMemberDigests } from './fs-utils.ts';
import {
  beginRoundCheckpoint,
  loadCheckpoint,
  loadLedger,
  recordFileBackup,
  rollbackRoundCheckpoint,
  syncDegenerationWatches,
  upsertLedgerRecord,
} from './ledger.ts';
import { lintExtractedPackage } from './package-lint.ts';
import { lintReabsorbedTarget } from './reabsorb-lint.ts';
import { buildExtractSummary } from './summary.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

export { resolveRepoRoot };

function cmdScan(argv: readonly string[], repoRoot: string): void {
  const maxRounds = parseStrictNonNegativeInt(argv, '--max-rounds') ?? 10;
  const cooldownDays = parseStrictNonNegativeInt(
    argv,
    '--cooldown-days',
    'EXTRACT_COOLDOWN_DAYS',
  );
  const deadCooldownDays = parseStrictNonNegativeInt(
    argv,
    '--dead-cooldown-days',
    'EXTRACT_DEAD_COOLDOWN_DAYS',
  );

  const ledger = loadLedger(repoRoot);
  const report = scanWorkspace(repoRoot, ledger, maxRounds, {
    cooldownDays,
    deadCooldownDays,
  });
  const watchSync = syncDegenerationWatches(repoRoot, report.degeneratedLibs);
  const savedTo = saveLastScanToTmp(repoRoot, report);

  if (hasFlag(argv, '--full')) {
    writeOut({ savedTo, watchSync, report });
    return;
  }

  writeOut({
    savedTo,
    watchSync,
    scannedAt: report.scannedAt,
    stats: report.stats,
    graph: {
      packages: report.graph.packages,
      layerDomainCounts: report.graph.layerDomainCounts,
      existingViolations: report.graph.existingViolations,
    },
    nextAction: report.nextAction,
    convergence: report.convergence,
    degeneratedLibs: report.degeneratedLibs,
    migrationResidues: report.migrationResidues,
    topClusters: report.clusters.slice(0, 15),
    suppressedCount: report.suppressed.length,
  });
}

function cmdSummary(argv: readonly string[], repoRoot: string): void {
  const cooldownDays = parseStrictNonNegativeInt(
    argv,
    '--cooldown-days',
    'EXTRACT_COOLDOWN_DAYS',
  );
  const deadCooldownDays = parseStrictNonNegativeInt(
    argv,
    '--dead-cooldown-days',
    'EXTRACT_DEAD_COOLDOWN_DAYS',
  );
  const ledger = loadLedger(repoRoot);
  const report = scanWorkspace(repoRoot, ledger, 10, {
    cooldownDays,
    deadCooldownDays,
  });
  writeOut(buildExtractSummary(report, ledger));
}

function cmdCheckProposal(argv: readonly string[], repoRoot: string): void {
  const packageName = getFlag(argv, '--name');
  const description = getFlag(argv, '--description');
  const consumers = splitCsv(getFlag(argv, '--consumers'));
  const exportedSymbols = splitCsv(getFlag(argv, '--exports'));
  const internalDeps = splitCsv(getFlag(argv, '--internal-deps'));
  const apiSignatures = collectSignatureArgs(argv);

  if (
    !packageName ||
    !description ||
    consumers.length === 0 ||
    exportedSymbols.length === 0
  ) {
    process.stderr.write(`${formatUsage('check-proposal')}\n`);
    process.exit(2);
  }

  const graph = buildWorkspaceGraph(repoRoot);
  const res = evaluateEssenceProposal(graph, {
    packageName,
    description,
    consumers,
    exportedSymbols,
    targetKind: 'private-lib',
    internalDeps,
    apiSignatures,
  });
  writeOut(res);
  if (!res.passed) process.exit(1);
}

function cmdBeginRound(argv: readonly string[], repoRoot: string): void {
  const name = getFlag(argv, '--name');
  const dir = getFlag(argv, '--dir');
  const modeRaw = getFlag(argv, '--mode') ?? 'extract';
  if (
    modeRaw !== 'extract' &&
    modeRaw !== 'reabsorb' &&
    modeRaw !== 'residue'
  ) {
    process.stderr.write(
      `不支持的 --mode "${modeRaw}", 仅允许 extract | reabsorb | residue\n`,
    );
    process.exit(2);
  }
  const intoPath = getFlag(argv, '--into');
  if (!name || !dir) {
    process.stderr.write(`${formatUsage('begin-round')}\n`);
    process.exit(2);
  }
  const safeDir = assertInsideRepo(repoRoot, dir, '--dir');
  const safeInto =
    intoPath !== undefined
      ? assertInsideRepo(repoRoot, intoPath, '--into')
      : undefined;

  const defaultTouches =
    modeRaw === 'residue'
      ? []
      : [
          'tsconfig.json',
          'packages/create-clis/scripts/template-manifest.ts',
          'README.md',
          'README.zh-CN.md',
          'docs/README.md',
        ].filter((f) => existsSync(join(repoRoot, f)));

  const touches = [
    ...new Set([...defaultTouches, ...splitCsv(getFlag(argv, '--touch'))]),
  ];
  const cp = beginRoundCheckpoint(
    repoRoot,
    name,
    safeDir,
    touches,
    modeRaw,
    safeInto,
  );
  writeOut(cp);
}

function cmdBackupFile(argv: readonly string[], repoRoot: string): void {
  const roundId = getFlag(argv, '--round');
  const file = getFlag(argv, '--file');
  if (!roundId || !file) {
    process.stderr.write(`${formatUsage('backup-file')}\n`);
    process.exit(2);
  }
  const safeFile = assertInsideRepo(repoRoot, file, '--file');
  const cp = loadCheckpoint(repoRoot, roundId);
  recordFileBackup(cp, safeFile);
  writeOut({ ok: true, roundId, file: safeFile });
}

function cmdVerifyRound(argv: readonly string[], repoRoot: string): void {
  const rawDir = getFlag(argv, '--dir');
  const roundId = getFlag(argv, '--round');
  const modeRaw = getFlag(argv, '--mode');
  if (!rawDir) {
    process.stderr.write(`${formatUsage('verify-round')}\n`);
    process.exit(2);
  }
  const dir = assertInsideRepo(repoRoot, rawDir, '--dir');

  if (modeRaw !== undefined && modeRaw !== 'extract' && modeRaw !== 'residue') {
    process.stderr.write(
      `verify-round 不支持的 --mode "${modeRaw}", 仅允许 extract | residue\n`,
    );
    process.exit(2);
  }

  let effectiveMode: 'extract' | 'residue' =
    modeRaw === 'residue' ? 'residue' : 'extract';
  if (roundId !== undefined) {
    const cpMode = assertRoundCheckpointMatch(repoRoot, roundId, {
      expectedDir: dir,
    });
    if (cpMode === 'residue') effectiveMode = 'residue';
  }

  const graph = buildWorkspaceGraph(repoRoot);
  if (effectiveMode === 'extract') {
    const staticLint = lintExtractedPackage(repoRoot, graph, dir, {
      verifyPack: false,
    });
    if (!staticLint.passed) {
      writeOut({
        ok: false,
        phase: 'essence-lint',
        violations: staticLint.violations,
      });
      process.exit(1);
    }
  }

  if (hasFlag(argv, '--skip-ci')) {
    writeOut({ ok: true, phase: `${effectiveMode}-lint-only`, dir });
    return;
  }

  runWorkspaceCiVerify(repoRoot, 'verify-round');

  if (effectiveMode === 'extract') {
    const packLint = lintExtractedPackage(repoRoot, graph, dir, {
      verifyPack: true,
    });
    if (!packLint.passed) {
      writeOut({
        ok: false,
        phase: 'npm-pack-dry-run',
        violations: packLint.violations,
      });
      process.exit(1);
    }
  }

  writeOut({
    ok: true,
    phase:
      effectiveMode === 'residue'
        ? 'residue-ci-verified'
        : 'full-ci-and-pack-verify',
    dir,
  });
}

function cmdVerifyReabsorb(argv: readonly string[], repoRoot: string): void {
  const name = getFlag(argv, '--name');
  const rawDir = getFlag(argv, '--dir');
  const roundId = getFlag(argv, '--round');
  const intoPath = getFlag(argv, '--into');
  const unused = hasFlag(argv, '--unused');
  if (!name || !rawDir) {
    process.stderr.write(`${formatUsage('verify-reabsorb')}\n`);
    process.exit(2);
  }
  if (unused && intoPath !== undefined) {
    process.stderr.write(
      '参数冲突: --unused (零消费者退役) 与 --into (独立内联目标) 不得同时使用\n',
    );
    process.exit(2);
  }
  const dir = assertInsideRepo(repoRoot, rawDir, '--dir');
  const safeInto =
    intoPath !== undefined
      ? assertInsideRepo(repoRoot, intoPath, '--into')
      : undefined;

  assertReabsorbCheckpointMatch(repoRoot, {
    roundId,
    expectedPkgName: name,
    expectedDir: dir,
    intoPath: safeInto,
  });

  const graph = buildWorkspaceGraph(repoRoot);
  const lint = lintReabsorbedTarget(repoRoot, graph, name, dir, {
    intoPath: safeInto,
    unused,
  });
  if (!lint.passed) {
    writeOut({
      ok: false,
      phase: 'reabsorb-module-lint',
      violations: lint.violations,
    });
    process.exit(1);
  }

  if (!hasFlag(argv, '--skip-ci')) {
    runWorkspaceCiVerify(repoRoot, 'verify-reabsorb');
  }
  writeOut({
    ok: true,
    phase: 'reabsorb-verified',
    name,
    dir,
    into: safeInto ?? null,
    unused,
  });
}

function cmdCommitRound(argv: readonly string[], repoRoot: string): void {
  const fingerprint = getFlag(argv, '--fingerprint');
  const name = getFlag(argv, '--name');
  const reason = getFlag(argv, '--reason');
  const roundId = getFlag(argv, '--round');
  const modeRaw = getFlag(argv, '--mode') ?? 'extract';
  if (!fingerprint || !name || !reason) {
    process.stderr.write(`${formatUsage('commit-round')}\n`);
    process.exit(2);
  }
  if (
    modeRaw !== 'extract' &&
    modeRaw !== 'reabsorb' &&
    modeRaw !== 'residue'
  ) {
    process.stderr.write(
      `不支持的 --mode "${modeRaw}", 仅允许 extract | reabsorb | residue\n`,
    );
    process.exit(2);
  }

  const ledger = loadLedger(repoRoot);
  const closeId = roundId ?? ledger.activeRoundId;
  if (closeId !== undefined) {
    assertRoundCheckpointMatch(repoRoot, closeId, {
      expectedMode: modeRaw,
      expectedPkgName: name,
    });
  }

  const status = modeRaw === 'reabsorb' ? 'reabsorbed' : 'accepted';
  let memberDigests: Record<string, string> = {};
  let distinctDomains = 0;

  if (status === 'accepted') {
    const report = scanWorkspace(repoRoot, ledger);
    const match =
      report.clusters.find((c) => c.fingerprint === fingerprint) ??
      report.suppressed.find((c) => c.fingerprint === fingerprint) ??
      report.migrationResidues.find((c) => c.fingerprint === fingerprint);
    if (match !== undefined) {
      distinctDomains = match.distinctDomainCount;
      memberDigests = buildMemberDigests(match);
    }
  }

  const updated = upsertLedgerRecord(
    repoRoot,
    {
      fingerprint,
      status,
      packageName: name,
      reason,
      memberDigests,
      distinctDomains,
      recordedAt: new Date().toISOString(),
    },
    true,
    closeId,
  );
  writeOut({ ok: true, status, roundsExecuted: updated.roundsExecuted });
}

function cmdReject(argv: readonly string[], repoRoot: string): void {
  const fingerprint = getFlag(argv, '--fingerprint');
  const reason = getFlag(argv, '--reason');
  const statusRaw = getFlag(argv, '--status') ?? 'rejected';
  if (!fingerprint || !reason) {
    process.stderr.write(`${formatUsage('reject')}\n`);
    process.exit(2);
  }
  if (statusRaw !== 'rejected' && statusRaw !== 'deferred') {
    process.stderr.write(
      `不支持的 --status "${statusRaw}", 仅允许 rejected | deferred\n`,
    );
    process.exit(2);
  }

  // 必须现场实扫磁盘最新源码, 禁止复用可能过期的缓存以免写入陈旧 rawDigest
  const ledger = loadLedger(repoRoot);
  const report = scanWorkspace(repoRoot, ledger);

  const clusterMatch =
    report.clusters.find((c) => c.fingerprint === fingerprint) ??
    report.suppressed.find((c) => c.fingerprint === fingerprint) ??
    report.migrationResidues.find((c) => c.fingerprint === fingerprint);
  const degenMatch = report.degeneratedLibs.find(
    (d) => d.fingerprint === fingerprint,
  );

  if (clusterMatch === undefined && degenMatch === undefined) {
    process.stderr.write(
      `未在当前扫仓报告找到匹配指纹: ${fingerprint}, 拒绝写入空台账\n`,
    );
    process.exit(1);
  }

  let memberDigests: Record<string, string> = {};
  let distinctDomains = 0;
  let packageName: string | undefined;

  if (clusterMatch !== undefined) {
    distinctDomains = clusterMatch.distinctDomainCount;
    memberDigests = buildMemberDigests(clusterMatch);
  } else if (degenMatch !== undefined) {
    packageName = degenMatch.pkgName;
    distinctDomains = degenMatch.transitiveConsumerDomains.length;
    memberDigests[degenMatch.pkgName] =
      degenMatch.transitiveBusinessConsumers.join(',');
  }

  const updated = upsertLedgerRecord(
    repoRoot,
    {
      fingerprint,
      status: statusRaw,
      packageName,
      reason,
      memberDigests,
      distinctDomains,
      recordedAt: new Date().toISOString(),
    },
    false,
  );
  writeOut({ ok: true, suppressedCount: updated.records.length });
}

function cmdRollbackRound(argv: readonly string[], repoRoot: string): void {
  const roundId = getFlag(argv, '--round');
  if (!roundId) {
    process.stderr.write(`${formatUsage('rollback-round')}\n`);
    process.exit(2);
  }
  const res = rollbackRoundCheckpoint(repoRoot, roundId);
  writeOut({ ok: true, ...res });
}

const COMMAND_HANDLERS: Record<
  string,
  (argv: readonly string[], repoRoot: string) => void
> = {
  scan: cmdScan,
  summary: cmdSummary,
  'check-proposal': cmdCheckProposal,
  'begin-round': cmdBeginRound,
  'backup-file': cmdBackupFile,
  'verify-round': cmdVerifyRound,
  'verify-reabsorb': cmdVerifyReabsorb,
  'commit-round': cmdCommitRound,
  reject: cmdReject,
  'rollback-round': cmdRollbackRound,
};

function main(): void {
  const [cmd = '', ...rest] = process.argv.slice(2);
  assertValidCliFlags(cmd, rest);
  const repoRoot = resolveRepoRoot(rest);
  COMMAND_HANDLERS[cmd]!(rest, repoRoot);
}

if (import.meta.main) main();
