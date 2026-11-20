/**
 * extract-shared-package 主命令行编排入口 (确定性扫描 + 四道闸门 + 闭环状态机)。
 *
 * 子命令:
 * - scan [--max-rounds N]                             全量扫描最新工作区包并产出结构化 JSON 账本
 * - check-proposal --name <pkg> --description <d> --consumers <a,b> --exports <x,y>
 * - begin-round --name <pkg> --dir <packages/x> [--touch <f1,f2>]
 * - backup-file --round <id> --file <relPath>
 * - verify-round --round <id> --dir <packages/x> [--skip-ci]
 * - commit-round --round <id> --fingerprint <fp> --name <pkg> --reason <text>
 * - reject --fingerprint <fp> --status <rejected|deferred> --reason <text> --clusters-json <path>
 * - rollback-round --round <id>
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkspace } from './analyzer.ts';
import {
  evaluateEssenceProposal,
  lintExtractedPackage,
} from './essence-gate.ts';
import {
  beginRoundCheckpoint,
  loadCheckpoint,
  loadLedger,
  recordFileBackup,
  rollbackRoundCheckpoint,
  upsertLedgerRecord,
} from './ledger.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(SCRIPT_DIR, '../../../..');

function getFlag(argv: readonly string[], name: string): string | undefined {
  const idx = argv.indexOf(name);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function hasFlag(argv: readonly string[], name: string): boolean {
  return argv.includes(name);
}

function splitCsv(raw: string | undefined): string[] {
  if (raw === undefined || raw.trim() === '') return [];
  return raw
    .split(',')
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function writeOut(data: unknown): void {
  process.stdout.write(`${JSON.stringify(data, null, 2)}\n`);
}

function saveLastScanToTmp(report: unknown): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) return '';
  const outPath = join(home, 'tmp', 'extract-shared-package', 'last-scan.json');
  mkdirSync(dirname(outPath), { recursive: true });
  writeFileSync(outPath, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  return outPath;
}

function cmdScan(argv: readonly string[]): void {
  const maxRaw = getFlag(argv, '--max-rounds');
  const maxRounds = maxRaw === undefined ? 5 : Number.parseInt(maxRaw, 10);
  const ledger = loadLedger(REPO_ROOT);
  const report = scanWorkspace(
    REPO_ROOT,
    ledger,
    Number.isFinite(maxRounds) ? maxRounds : 5,
  );
  const savedTo = saveLastScanToTmp(report);

  if (hasFlag(argv, '--full')) {
    writeOut({ savedTo, report });
    return;
  }

  // 默认输出摘要 + Top 15 活跃复用簇, 避免一次性把全部函数签名塞爆上下文
  writeOut({
    savedTo,
    scannedAt: report.scannedAt,
    stats: report.stats,
    graph: {
      packages: report.graph.packages,
      layerDomainCounts: report.graph.layerDomainCounts,
      existingViolations: report.graph.existingViolations,
    },
    convergence: report.convergence,
    topClusters: report.clusters.slice(0, 15),
    suppressedCount: report.suppressed.length,
  });
}

function cmdCheckProposal(argv: readonly string[]): void {
  const packageName = getFlag(argv, '--name');
  const description = getFlag(argv, '--description');
  const consumers = splitCsv(getFlag(argv, '--consumers'));
  const exportedSymbols = splitCsv(getFlag(argv, '--exports'));
  const internalDeps = splitCsv(getFlag(argv, '--internal-deps'));

  if (!packageName || !description) {
    process.stderr.write(
      '用法: check-proposal --name <pkg> --description <desc> --consumers <a,b> --exports <x,y>\n',
    );
    process.exit(2);
  }

  const graph = buildWorkspaceGraph(REPO_ROOT);
  const res = evaluateEssenceProposal(graph, {
    packageName,
    description,
    consumers,
    exportedSymbols,
    targetKind: 'private-lib',
    internalDeps,
  });
  writeOut(res);
  if (!res.passed) process.exit(1);
}

function cmdBeginRound(argv: readonly string[]): void {
  const name = getFlag(argv, '--name');
  const dir = getFlag(argv, '--dir');
  if (!name || !dir) {
    process.stderr.write(
      '用法: begin-round --name <pkg> --dir <packages/x> [--touch <f1,f2>]\n',
    );
    process.exit(2);
  }
  const defaultTouches = [
    'tsconfig.json',
    'packages/create-clis/scripts/template-manifest.ts',
    'README.md',
    'README.zh-CN.md',
    'docs/README.md',
  ].filter((f) => existsSync(join(REPO_ROOT, f)));

  const touches = [
    ...new Set([...defaultTouches, ...splitCsv(getFlag(argv, '--touch'))]),
  ];
  const cp = beginRoundCheckpoint(REPO_ROOT, name, dir, touches);
  writeOut(cp);
}

function cmdBackupFile(argv: readonly string[]): void {
  const roundId = getFlag(argv, '--round');
  const file = getFlag(argv, '--file');
  if (!roundId || !file) {
    process.stderr.write('用法: backup-file --round <id> --file <relPath>\n');
    process.exit(2);
  }
  const cp = loadCheckpoint(REPO_ROOT, roundId);
  recordFileBackup(cp, file);
  writeOut({ ok: true, roundId, file });
}

function cmdVerifyRound(argv: readonly string[]): void {
  const dir = getFlag(argv, '--dir');
  if (!dir) {
    process.stderr.write('用法: verify-round --dir <packages/x> [--skip-ci]\n');
    process.exit(2);
  }
  const graph = buildWorkspaceGraph(REPO_ROOT);
  const pkgLint = lintExtractedPackage(REPO_ROOT, graph, dir);
  if (!pkgLint.passed) {
    writeOut({
      ok: false,
      phase: 'essence-lint',
      violations: pkgLint.violations,
    });
    process.exit(1);
  }

  if (hasFlag(argv, '--skip-ci')) {
    writeOut({ ok: true, phase: 'essence-lint-only' });
    return;
  }

  const ci = spawnSync('bun', ['scripts/ci.ts', '--verify'], {
    cwd: REPO_ROOT,
    stdio: 'inherit',
  });
  if (ci.status !== 0) {
    process.stderr.write(
      `\nverify-round: scripts/ci.ts --verify 退出码 ${ci.status ?? 1}\n`,
    );
    process.exit(ci.status ?? 1);
  }
  writeOut({ ok: true, phase: 'full-ci-verify', dir });
}

function cmdCommitRound(argv: readonly string[]): void {
  const fingerprint = getFlag(argv, '--fingerprint');
  const name = getFlag(argv, '--name');
  const reason = getFlag(argv, '--reason');
  if (!fingerprint || !name || !reason) {
    process.stderr.write(
      '用法: commit-round --fingerprint <fp> --name <pkg> --reason <text>\n',
    );
    process.exit(2);
  }
  const updated = upsertLedgerRecord(
    REPO_ROOT,
    {
      fingerprint,
      status: 'accepted',
      packageName: name,
      reason,
      memberDigests: {},
      distinctDomains: 0,
      recordedAt: new Date().toISOString(),
    },
    true,
  );
  writeOut({ ok: true, roundsExecuted: updated.roundsExecuted });
}

function cmdReject(argv: readonly string[]): void {
  const fingerprint = getFlag(argv, '--fingerprint');
  const reason = getFlag(argv, '--reason');
  const statusRaw = getFlag(argv, '--status') ?? 'rejected';
  if (!fingerprint || !reason) {
    process.stderr.write(
      '用法: reject --fingerprint <fp> --reason <text> [--status rejected|deferred]\n',
    );
    process.exit(2);
  }
  const status = statusRaw === 'deferred' ? 'deferred' : 'rejected';
  const ledger = loadLedger(REPO_ROOT);
  const report = scanWorkspace(REPO_ROOT, ledger);
  const match =
    report.clusters.find((c) => c.fingerprint === fingerprint) ??
    report.suppressed.find((c) => c.fingerprint === fingerprint);

  const memberDigests: Record<string, string> = {};
  if (match !== undefined) {
    for (const m of match.members) {
      memberDigests[`${m.file}#${m.symbolName}`] = m.rawDigest;
    }
  }

  const updated = upsertLedgerRecord(
    REPO_ROOT,
    {
      fingerprint,
      status,
      reason,
      memberDigests,
      distinctDomains: match?.distinctDomainCount ?? 0,
      recordedAt: new Date().toISOString(),
    },
    false,
  );
  writeOut({ ok: true, suppressedCount: updated.records.length });
}

function cmdRollbackRound(argv: readonly string[]): void {
  const roundId = getFlag(argv, '--round');
  if (!roundId) {
    process.stderr.write('用法: rollback-round --round <id>\n');
    process.exit(2);
  }
  const res = rollbackRoundCheckpoint(REPO_ROOT, roundId);
  writeOut({ ok: true, ...res });
}

function main(): void {
  const argv = process.argv.slice(2);
  const cmd = argv[0];
  const rest = argv.slice(1);
  if (cmd === 'scan') cmdScan(rest);
  else if (cmd === 'check-proposal') cmdCheckProposal(rest);
  else if (cmd === 'begin-round') cmdBeginRound(rest);
  else if (cmd === 'backup-file') cmdBackupFile(rest);
  else if (cmd === 'verify-round') cmdVerifyRound(rest);
  else if (cmd === 'commit-round') cmdCommitRound(rest);
  else if (cmd === 'reject') cmdReject(rest);
  else if (cmd === 'rollback-round') cmdRollbackRound(rest);
  else {
    process.stderr.write(
      '可用命令: scan | check-proposal | begin-round | backup-file | verify-round | commit-round | reject | rollback-round\n',
    );
    process.exit(2);
  }
}

if (import.meta.main) main();
