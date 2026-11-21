/**
 * 持久化抽取/回收/残余清理台账与 ~/tmp 隔离的单轮事务备份回滚引擎:
 * - 按仓库路径哈希彻底隔离存储 `ledger.json` 与 `last-scan.json`;
 * - `assertInsideRepo` 严格封死任意 `../` 仓外路径穿越删改风险;
 * - 损坏 JSON 明确报人话诊断 (禁止裸抛栈混淆问题), 提交与回滚严格绑定轮次生命周期。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';

import { sha256Short } from './fingerprint.ts';
import { assertInsideRepo } from './fs-utils.ts';
import type {
  DegeneratedLibFinding,
  DegenerationWatch,
  ExtractLedger,
  LedgerRecord,
  RoundCheckpoint,
} from './types.ts';

export function resolveHomeTmpBase(repoRoot: string): string {
  const home = process.env.HOME ?? process.env.USERPROFILE;
  if (!home) {
    throw new Error('无法定位用户 HOME 目录 (禁止使用系统级 /tmp)');
  }
  const repoHash = sha256Short(resolve(repoRoot), 10);
  return join(home, 'tmp', 'extract-shared-package', repoHash);
}

export function getLedgerPath(repoRoot: string): string {
  const override = process.env.EXTRACT_LEDGER_PATH;
  if (override !== undefined && override.trim() !== '') {
    return override.trim();
  }
  return join(resolveHomeTmpBase(repoRoot), 'ledger.json');
}

export function getLastScanPath(repoRoot: string): string {
  return join(resolveHomeTmpBase(repoRoot), 'last-scan.json');
}

export function loadLedger(repoRoot: string): ExtractLedger {
  const path = getLedgerPath(repoRoot);
  if (!existsSync(path)) {
    return { schemaVersion: 1, roundsExecuted: 0, records: [] };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    throw new Error(
      `台账文件损坏 (${path}): ${err instanceof Error ? err.message : String(err)}, 请检查修复或删除该临时台账重建`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as ExtractLedger).records) ||
    typeof (parsed as ExtractLedger).roundsExecuted !== 'number'
  ) {
    throw new Error(
      `台账格式异常 (${path}): 缺少合法的 records 或 roundsExecuted 字段`,
    );
  }
  return parsed as ExtractLedger;
}

export function saveLedger(repoRoot: string, ledger: ExtractLedger): void {
  const path = getLedgerPath(repoRoot);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8');
}

function checkpointFilePath(repoRoot: string, roundId: string): string {
  return join(resolveHomeTmpBase(repoRoot), 'rounds', `${roundId}.json`);
}

export function loadCheckpoint(
  repoRoot: string,
  roundId: string,
): RoundCheckpoint {
  const p = checkpointFilePath(repoRoot, roundId);
  if (!existsSync(p)) {
    throw new Error(`未找到轮次检查点: ${roundId}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(p, 'utf8'));
  } catch (err) {
    throw new Error(
      `轮次检查点文件损坏 (${p}): ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  if (
    parsed === null ||
    typeof parsed !== 'object' ||
    !Array.isArray((parsed as RoundCheckpoint).backups) ||
    typeof (parsed as RoundCheckpoint).mode !== 'string'
  ) {
    throw new Error(`轮次检查点结构异常 (${p})`);
  }
  return parsed as RoundCheckpoint;
}

function saveCheckpoint(checkpoint: RoundCheckpoint): void {
  writeFileSync(
    checkpointFilePath(checkpoint.repoRoot, checkpoint.roundId),
    `${JSON.stringify(checkpoint, null, 2)}\n`,
    'utf8',
  );
}

/** 写入台账记录: 严密保留既有冷静期 watches, 并在提交完成时校验/核销活跃轮次状态 */
export function upsertLedgerRecord(
  repoRoot: string,
  record: LedgerRecord,
  incrementRound: boolean,
  closeRoundId?: string,
): ExtractLedger {
  const ledger = loadLedger(repoRoot);
  let nextActiveRoundId = ledger.activeRoundId;

  if (incrementRound) {
    const targetCloseId = closeRoundId ?? ledger.activeRoundId;
    if (targetCloseId !== undefined) {
      const cp = loadCheckpoint(repoRoot, targetCloseId);
      if (cp.committed === true) {
        throw new Error(`轮次 ${targetCloseId} 已提交完成, 不可重复提交`);
      }
      if (cp.rolledBack === true) {
        throw new Error(`轮次 ${targetCloseId} 已回滚作废, 禁止再行提交`);
      }
      cp.committed = true;
      saveCheckpoint(cp);
      if (nextActiveRoundId === targetCloseId) nextActiveRoundId = undefined;
    }
  }

  const nextRecords = ledger.records.filter(
    (r) => r.fingerprint !== record.fingerprint,
  );
  nextRecords.push(record);

  const updated: ExtractLedger = {
    schemaVersion: 1,
    roundsExecuted: incrementRound
      ? ledger.roundsExecuted + 1
      : ledger.roundsExecuted,
    activeRoundId: nextActiveRoundId,
    records: nextRecords,
    degenerationWatches: ledger.degenerationWatches,
  };
  saveLedger(repoRoot, updated);
  return updated;
}

/** 同步退化观察计时器: 恢复 >=2 产品域时自动清除 watch 与其过时豁免 */
export function syncDegenerationWatches(
  repoRoot: string,
  findings: readonly DegeneratedLibFinding[],
): { added: number; cleared: number; activeWatches: number } {
  const ledger = loadLedger(repoRoot);
  const prev = ledger.degenerationWatches ?? {};
  const next: Record<string, DegenerationWatch> = {};

  for (const finding of findings) {
    if (finding.kind !== 'private-lib') continue;
    next[finding.pkgName] = {
      pkgName: finding.pkgName,
      fingerprint: finding.fingerprint,
      watchKind:
        finding.transitiveConsumerDomains.length === 0
          ? 'zero-consumer'
          : 'single-domain',
      firstObservedAt: finding.firstObservedAt ?? new Date().toISOString(),
      consumerSignature: finding.transitiveBusinessConsumers.join(','),
    };
  }

  let added = 0;
  let cleared = 0;
  const clearedFps = new Set<string>();
  for (const k of Object.keys(next)) {
    if (prev[k] === undefined) added += 1;
  }
  for (const [k, w] of Object.entries(prev)) {
    if (next[k] === undefined) {
      cleared += 1;
      clearedFps.add(w.fingerprint);
    }
  }

  const nextRecords =
    clearedFps.size > 0
      ? ledger.records.filter(
          (r) => !(r.status === 'deferred' && clearedFps.has(r.fingerprint)),
        )
      : ledger.records;

  if (
    JSON.stringify(prev) !== JSON.stringify(next) ||
    nextRecords.length !== ledger.records.length
  ) {
    saveLedger(repoRoot, {
      ...ledger,
      records: nextRecords,
      degenerationWatches: next,
    });
  }
  return { added, cleared, activeWatches: Object.keys(next).length };
}

function collectDirFiles(repoRoot: string, dirRel: string): string[] {
  const safeRel = assertInsideRepo(repoRoot, dirRel, 'collectDirFiles');
  const absDir = join(repoRoot, safeRel);
  if (!existsSync(absDir)) return [];
  const out: string[] = [];
  const walk = (cur: string): void => {
    for (const entry of readdirSync(cur, { withFileTypes: true })) {
      if (entry.name === 'node_modules' || entry.name === 'dist') continue;
      const abs = join(cur, entry.name);
      if (entry.isDirectory()) walk(abs);
      else out.push(relative(repoRoot, abs).replaceAll('\\', '/'));
    }
  };
  walk(absDir);
  return out.sort();
}

export function beginRoundCheckpoint(
  repoRoot: string,
  candidatePkgName: string,
  candidateDir: string,
  preBackupRelPaths: readonly string[],
  mode: 'extract' | 'reabsorb' | 'residue' = 'extract',
  reabsorbInto?: string,
): RoundCheckpoint {
  const safeCandidateDir = assertInsideRepo(repoRoot, candidateDir, '--dir');
  let safeInto: string | undefined;
  if (reabsorbInto !== undefined && reabsorbInto.trim() !== '') {
    safeInto = assertInsideRepo(repoRoot, reabsorbInto, '--into');
  }
  const safeTouches = preBackupRelPaths.map((p) =>
    assertInsideRepo(repoRoot, p, '--touch'),
  );

  const ledger = loadLedger(repoRoot);
  if (ledger.activeRoundId !== undefined) {
    const activePath = checkpointFilePath(repoRoot, ledger.activeRoundId);
    if (existsSync(activePath)) {
      const existing = loadCheckpoint(repoRoot, ledger.activeRoundId);
      if (!existing.committed && !existing.rolledBack) {
        throw new Error(
          `存在尚未提交或回滚的活跃轮次 (${ledger.activeRoundId}), 请先 commit-round 或 rollback-round`,
        );
      }
    }
  }

  const roundNumber = ledger.roundsExecuted + 1;
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const roundId = `r${roundNumber}-${mode}-${stamp}`;
  const base = resolveHomeTmpBase(repoRoot);
  const snapshotDir = join(base, 'snapshots', roundId);
  mkdirSync(snapshotDir, { recursive: true });
  mkdirSync(join(base, 'rounds'), { recursive: true });

  const extraReabsorbFiles =
    mode === 'reabsorb' ? collectDirFiles(repoRoot, safeCandidateDir) : [];
  const allTargets = [...new Set([...safeTouches, ...extraReabsorbFiles])];

  const intoPreExisted =
    safeInto !== undefined ? existsSync(join(repoRoot, safeInto)) : false;

  const checkpoint: RoundCheckpoint = {
    roundId,
    mode,
    roundNumber,
    candidatePkgName,
    candidateDir: safeCandidateDir,
    reabsorbInto: safeInto,
    reabsorbIntoPreExisted: intoPreExisted,
    startedAt: new Date().toISOString(),
    repoRoot: resolve(repoRoot),
    snapshotDir,
    baselineFiles: allTargets,
    backups: [],
  };

  for (const relPath of allTargets) {
    recordFileBackup(checkpoint, relPath);
  }
  saveCheckpoint(checkpoint);
  saveLedger(repoRoot, { ...ledger, activeRoundId: roundId });
  return checkpoint;
}

/** 在修改已有文件前或追踪新增文件前登记到本轮检查点 (幂等且强制路径在仓内) */
export function recordFileBackup(
  checkpoint: RoundCheckpoint,
  relPath: string,
): void {
  const normalized = assertInsideRepo(
    checkpoint.repoRoot,
    relPath,
    'backup-file',
  );
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

/** 精确回滚单轮所有修改 (extract 清新建包; reabsorb 还原旧库并清理消费包内新建目标) */
export function rollbackRoundCheckpoint(
  repoRoot: string,
  roundId: string,
): {
  restoredFiles: string[];
  removedCandidateDir: string;
  removedReabsorbInto: string;
} {
  const checkpoint = loadCheckpoint(repoRoot, roundId);
  if (checkpoint.committed === true) {
    throw new Error(`轮次 ${roundId} 已提交完成, 禁止再回滚`);
  }

  const restoredFiles: string[] = [];
  for (const entry of checkpoint.backups) {
    const safeRel = assertInsideRepo(
      checkpoint.repoRoot,
      entry.relPath,
      'rollback-entry',
    );
    const targetAbs = join(checkpoint.repoRoot, safeRel);
    if (entry.existed && entry.backupAbsPath !== undefined) {
      mkdirSync(dirname(targetAbs), { recursive: true });
      copyFileSync(entry.backupAbsPath, targetAbs);
      restoredFiles.push(safeRel);
    } else if (!entry.existed && existsSync(targetAbs)) {
      rmSync(targetAbs, { force: true });
      restoredFiles.push(`(removed) ${safeRel}`);
    }
  }

  let removedDir = '';
  if (checkpoint.mode === 'extract') {
    const safeCandidate = assertInsideRepo(
      checkpoint.repoRoot,
      checkpoint.candidateDir,
      'rollback-candidateDir',
    );
    const candidateAbs = join(checkpoint.repoRoot, safeCandidate);
    if (existsSync(candidateAbs)) {
      rmSync(candidateAbs, { recursive: true, force: true });
      removedDir = safeCandidate;
    }
  }

  let removedReabsorbInto = '';
  if (
    checkpoint.mode === 'reabsorb' &&
    checkpoint.reabsorbInto !== undefined &&
    checkpoint.reabsorbInto !== '' &&
    checkpoint.reabsorbIntoPreExisted === false
  ) {
    const safeInto = assertInsideRepo(
      checkpoint.repoRoot,
      checkpoint.reabsorbInto,
      'rollback-reabsorbInto',
    );
    const intoAbs = join(checkpoint.repoRoot, safeInto);
    if (existsSync(intoAbs)) {
      rmSync(intoAbs, { recursive: true, force: true });
      removedReabsorbInto = safeInto;
    }
    if (safeInto.endsWith('.ts')) {
      const testAbs = join(
        checkpoint.repoRoot,
        safeInto.replace(/\.ts$/, '.test.ts'),
      );
      if (existsSync(testAbs)) rmSync(testAbs, { force: true });
    }
  }

  checkpoint.rolledBack = true;
  saveCheckpoint(checkpoint);

  const ledger = loadLedger(repoRoot);
  if (ledger.activeRoundId === roundId) {
    saveLedger(repoRoot, { ...ledger, activeRoundId: undefined });
  }

  return {
    restoredFiles,
    removedCandidateDir: removedDir,
    removedReabsorbInto,
  };
}
