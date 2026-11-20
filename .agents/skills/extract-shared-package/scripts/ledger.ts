/**
 * 持久化抽取台账与 ~/tmp 隔离的单轮原子备份回滚引擎。
 *
 * 安全设计:
 * - 绝不使用 git reset --hard / git checkout -- . 等破坏性回退, 以免误伤用户已有未提交更改;
 * - 每轮修改已有文件前, 必须将原文件内容备份到 ~/tmp/extract-shared-package/<repo-hash>/snapshots/<roundId>/;
 * - 验证失败或触发熔断时, 按备份精准还原原文件并清理本轮新建的目录/文件。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import type { ExtractLedger, LedgerRecord, RoundCheckpoint } from './types.ts';

const LEDGER_REL = '.agents/skills/extract-shared-package/state/ledger.json';

function resolveHomeTmpBase(repoRoot: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('无法定位用户 HOME 目录 (禁止使用系统级 /tmp)');
  }
  const repoHash = createHash('sha256')
    .update(resolve(repoRoot))
    .digest('hex')
    .slice(0, 10);
  return join(home, 'tmp', 'extract-shared-package', repoHash);
}

export function getLedgerPath(repoRoot: string): string {
  return join(repoRoot, LEDGER_REL);
}

export function loadLedger(repoRoot: string): ExtractLedger {
  const path = getLedgerPath(repoRoot);
  if (!existsSync(path)) {
    return { schemaVersion: 1, roundsExecuted: 0, records: [] };
  }
  return JSON.parse(readFileSync(path, 'utf8')) as ExtractLedger;
}

export function saveLedger(repoRoot: string, ledger: ExtractLedger): void {
  const path = getLedgerPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

export function upsertLedgerRecord(
  repoRoot: string,
  record: LedgerRecord,
  incrementRound: boolean,
): ExtractLedger {
  const ledger = loadLedger(repoRoot);
  const nextRecords = ledger.records.filter(
    (r) => r.fingerprint !== record.fingerprint,
  );
  nextRecords.push(record);
  const updated: ExtractLedger = {
    schemaVersion: 1,
    roundsExecuted: incrementRound
      ? ledger.roundsExecuted + 1
      : ledger.roundsExecuted,
    records: nextRecords,
  };
  saveLedger(repoRoot, updated);
  return updated;
}

function checkpointFilePath(repoRoot: string, roundId: string): string {
  return join(resolveHomeTmpBase(repoRoot), 'rounds', `${roundId}.json`);
}

export function beginRoundCheckpoint(
  repoRoot: string,
  candidatePkgName: string,
  candidateDir: string,
  preBackupRelPaths: readonly string[],
): RoundCheckpoint {
  const ledger = loadLedger(repoRoot);
  const roundNumber = ledger.roundsExecuted + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const roundId = `r${roundNumber}-${stamp}`;
  const base = resolveHomeTmpBase(repoRoot);
  const snapshotDir = join(base, 'snapshots', roundId);
  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(join(base, 'rounds'), { recursive: true });

  const checkpoint: RoundCheckpoint = {
    roundId,
    roundNumber,
    candidatePkgName,
    candidateDir,
    startedAt: new Date().toISOString(),
    repoRoot: resolve(repoRoot),
    snapshotDir,
    baselineFiles: [...preBackupRelPaths],
    backups: [],
  };

  for (const relPath of preBackupRelPaths) {
    recordFileBackup(checkpoint, relPath);
  }
  writeFileSync(
    checkpointFilePath(repoRoot, roundId),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
  return checkpoint;
}

/** 在修改已有文件前或追踪新增文件前登记到本轮检查点 (幂等) */
export function recordFileBackup(
  checkpoint: RoundCheckpoint,
  relPath: string,
): void {
  const normalized = relPath.replaceAll('\\', '/');
  if (checkpoint.backups.some((b) => b.relPath === normalized)) return;

  const abs = join(checkpoint.repoRoot, normalized);
  if (!existsSync(abs)) {
    checkpoint.backups.push({ relPath: normalized, existed: false });
    saveCheckpoint(checkpoint);
    return;
  }

  const backupAbsPath = join(checkpoint.snapshotDir, normalized);
  mkdirSync(dirname(backupAbsPath), { recursive: true });
  copyFileSync(abs, backupAbsPath);
  checkpoint.backups.push({
    relPath: normalized,
    existed: true,
    backupAbsPath,
  });
  saveCheckpoint(checkpoint);
}

export function loadCheckpoint(
  repoRoot: string,
  roundId: string,
): RoundCheckpoint {
  const p = checkpointFilePath(repoRoot, roundId);
  if (!existsSync(p)) {
    throw new Error(`未找到轮次检查点: ${roundId}`);
  }
  return JSON.parse(readFileSync(p, 'utf8')) as RoundCheckpoint;
}

function saveCheckpoint(checkpoint: RoundCheckpoint): void {
  writeFileSync(
    checkpointFilePath(checkpoint.repoRoot, checkpoint.roundId),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

/** 精确回滚单轮所有修改并删除本轮新建包目录 (零误伤用户原有未提交修改) */
export function rollbackRoundCheckpoint(
  repoRoot: string,
  roundId: string,
): { restoredFiles: string[]; removedCandidateDir: string } {
  const checkpoint = loadCheckpoint(repoRoot, roundId);
  const restoredFiles: string[] = [];

  for (const entry of checkpoint.backups) {
    const targetAbs = join(checkpoint.repoRoot, entry.relPath);
    if (entry.existed && entry.backupAbsPath !== undefined) {
      mkdirSync(dirname(targetAbs), { recursive: true });
      copyFileSync(entry.backupAbsPath, targetAbs);
      restoredFiles.push(entry.relPath);
    } else if (!entry.existed && existsSync(targetAbs)) {
      rmSync(targetAbs, { force: true });
      restoredFiles.push(`(removed) ${entry.relPath}`);
    }
  }

  const candidateAbs = join(checkpoint.repoRoot, checkpoint.candidateDir);
  if (existsSync(candidateAbs)) {
    rmSync(candidateAbs, { recursive: true, force: true });
  }

  return { restoredFiles, removedCandidateDir: checkpoint.candidateDir };
}
