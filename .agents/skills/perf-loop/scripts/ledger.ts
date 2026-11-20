/**
 * 双队列 (accepted / rejected) 账本管理、精准指纹解封与复合停止收敛引擎。
 *
 * 存储坐标: packages/<pkg>/bench/ledger/accepted.jsonl 与 rejected.jsonl
 * - 按包严格独立隔离记账;
 * - 精准重评解封: 仅当直接源码哈希改变、bench 变动、运行时升级、上次因噪声未定论,
 *   或同包落了新的 P0/P1 高收益架构/实现优化 (不因无关 P2 全盘误解封) 时才激活 REELIGIBLE;
 * - 停止判据: 20 提案滑动窗口 (有效 <= 3 且最高仅 P2) + 连败熔断 + 长期零高收益早停 + 强制升维 PIVOT。
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import type {
  EnvFingerprint,
  ExperimentRecord,
  RejectedEvaluation,
  StoppingEvaluation,
} from './types.ts';

export const DEFAULT_WINDOW_SIZE = 20;
export const DEFAULT_MAX_KEPT_IN_WINDOW = 3;
export const DEFAULT_PIVOT_STREAK = 5;
export const DEFAULT_EXHAUST_STREAK = 8;
export const DEFAULT_DRY_HIGH_IMPACT_STREAK = 12;

export interface LedgerPaths {
  dir: string;
  acceptedFile: string;
  rejectedFile: string;
}

export function resolveLedgerPaths(
  repoRoot: string,
  pkgDir: string,
): LedgerPaths {
  const dir = join(repoRoot, pkgDir, 'bench', 'ledger');
  return {
    dir,
    acceptedFile: join(dir, 'accepted.jsonl'),
    rejectedFile: join(dir, 'rejected.jsonl'),
  };
}

/** 读取指定 JSONL 文件中的实验记录 */
export function readJsonlRecords(filePath: string): ExperimentRecord[] {
  if (!existsSync(filePath)) return [];
  const raw = readFileSync(filePath, 'utf8');
  const records: ExperimentRecord[] = [];
  for (const line of raw.split('\n')) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    records.push(JSON.parse(trimmed) as ExperimentRecord);
  }
  return records;
}

/** 计算 P0/P1 高收益保留数量 */
export function countHighImpactAccepted(
  accepted: readonly ExperimentRecord[],
): number {
  let count = 0;
  for (const r of accepted) {
    if (r.measuredTier === 'P0' || r.measuredTier === 'P1') count += 1;
  }
  return count;
}

/** 读取目标包双队列 */
export function loadPackageLedger(
  repoRoot: string,
  pkgDir: string,
): {
  accepted: ExperimentRecord[];
  rejected: ExperimentRecord[];
  highImpactCount: number;
  paths: LedgerPaths;
} {
  const paths = resolveLedgerPaths(repoRoot, pkgDir);
  const accepted = readJsonlRecords(paths.acceptedFile);
  return {
    accepted,
    rejected: readJsonlRecords(paths.rejectedFile),
    highImpactCount: countHighImpactAccepted(accepted),
    paths,
  };
}

/** 将一条实验结果按 verdict 追加入对应队列 */
export function appendExperimentRecord(
  repoRoot: string,
  pkgDir: string,
  record: ExperimentRecord,
): string {
  const paths = resolveLedgerPaths(repoRoot, pkgDir);
  mkdirSync(paths.dir, { recursive: true });
  const target =
    record.verdict === 'KEEP' ? paths.acceptedFile : paths.rejectedFile;
  appendFileSync(target, `${JSON.stringify(record)}\n`, 'utf8');
  return target;
}

/** 判断单条失效记录当前是 LOCKED (冷却锁定) 还是 REELIGIBLE (变量改变可重评) */
export function evaluateRejectedEntry(
  record: ExperimentRecord,
  currentEnv: EnvFingerprint,
  currentHighImpactCount: number,
): RejectedEvaluation {
  const reasons: string[] = [];

  if (record.failureReason === 'NOISE_INCONCLUSIVE') {
    reasons.push('上次因采样噪声未能定论, 可重测');
  }

  if (currentEnv.benchHash !== record.fingerprint.benchHash) {
    reasons.push('基准测试负载或口径已变更');
  }

  if (
    currentEnv.runtimeVersions.bun !== record.fingerprint.runtimeVersions.bun ||
    currentEnv.runtimeVersions.node !== record.fingerprint.runtimeVersions.node
  ) {
    reasons.push('Bun 或 Node 运行时版本已变化');
  }

  // 只有期间落地了 P0 / P1 (而非微小 P2), 才认定全局瓶颈转移而解封全量队列
  const prevHigh = record.fingerprint.highImpactAcceptedCountAtAttempt;
  if (prevHigh !== undefined && currentHighImpactCount > prevHigh) {
    const delta = currentHighImpactCount - prevHigh;
    reasons.push(`此后同包已落地 ${delta} 项 P0/P1 优化, 主瓶颈结构已改变`);
  }

  const touched =
    record.touchedFiles.length > 0
      ? record.touchedFiles
      : Object.keys(record.fingerprint.sourceHashes);
  const changedFiles: string[] = [];
  for (const file of touched) {
    const prevHash = record.fingerprint.sourceHashes[file];
    const currHash = currentEnv.sourceHashes[file];
    if (prevHash !== currHash) changedFiles.push(file);
  }
  if (changedFiles.length > 0) {
    reasons.push(`直接关联源码已变动: ${changedFiles.slice(0, 3).join(', ')}`);
  }

  return {
    record,
    status: reasons.length > 0 ? 'REELIGIBLE' : 'LOCKED',
    reasons,
  };
}

/** 批量计算目标包全部历史失败提案的当前重评状态 */
export function classifyRejectedQueue(
  rejected: readonly ExperimentRecord[],
  currentEnv: EnvFingerprint,
  currentHighImpactCount: number,
): {
  locked: RejectedEvaluation[];
  reeligible: RejectedEvaluation[];
} {
  const locked: RejectedEvaluation[] = [];
  const reeligible: RejectedEvaluation[] = [];
  for (const record of rejected) {
    const evaluated = evaluateRejectedEntry(
      record,
      currentEnv,
      currentHighImpactCount,
    );
    if (evaluated.status === 'LOCKED') locked.push(evaluated);
    else reeligible.push(evaluated);
  }
  return { locked, reeligible };
}

function mergeOrderedHistory(
  accepted: readonly ExperimentRecord[],
  rejected: readonly ExperimentRecord[],
): ExperimentRecord[] {
  return [...accepted, ...rejected].sort((a, b) => a.ts - b.ts);
}

/** 计算尾部连续失败次数、连续无中高收益次数与该段内的 P2 数量 */
function computeStreaks(history: readonly ExperimentRecord[]): {
  consecutiveReverts: number;
  consecutiveWithoutHighImpact: number;
  p2InDryStreak: number;
} {
  let consecutiveReverts = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    if (history[i]!.verdict === 'REVERT') consecutiveReverts += 1;
    else break;
  }

  let consecutiveWithoutHighImpact = 0;
  let p2InDryStreak = 0;
  for (let i = history.length - 1; i >= 0; i -= 1) {
    const r = history[i]!;
    const isHigh =
      r.verdict === 'KEEP' &&
      (r.measuredTier === 'P0' || r.measuredTier === 'P1');
    if (isHigh) break;
    consecutiveWithoutHighImpact += 1;
    if (r.verdict === 'KEEP' && r.measuredTier === 'P2') {
      p2InDryStreak += 1;
    }
  }

  return { consecutiveReverts, consecutiveWithoutHighImpact, p2InDryStreak };
}

/**
 * 基于按包独立的双队列计算是否停止或需要升维。
 */
export function evaluateStopping(
  accepted: readonly ExperimentRecord[],
  rejected: readonly ExperimentRecord[],
  options: {
    windowSize?: number;
    maxKeptInWindow?: number;
    pivotStreak?: number;
    exhaustStreak?: number;
    dryHighImpactStreak?: number;
  } = {},
): StoppingEvaluation {
  const windowSize = options.windowSize ?? DEFAULT_WINDOW_SIZE;
  const maxKept = options.maxKeptInWindow ?? DEFAULT_MAX_KEPT_IN_WINDOW;
  const pivotStreak = options.pivotStreak ?? DEFAULT_PIVOT_STREAK;
  const exhaustStreak = options.exhaustStreak ?? DEFAULT_EXHAUST_STREAK;
  const dryStreak =
    options.dryHighImpactStreak ?? DEFAULT_DRY_HIGH_IMPACT_STREAK;

  const history = mergeOrderedHistory(accepted, rejected);
  const recent = history.slice(-windowSize);
  const keptInWindow = recent.filter((r) => r.verdict === 'KEEP');
  const highImpactInWindow = keptInWindow.filter(
    (r) => r.measuredTier === 'P0' || r.measuredTier === 'P1',
  ).length;
  const { consecutiveReverts, consecutiveWithoutHighImpact, p2InDryStreak } =
    computeStreaks(history);

  const base = {
    totalExperiments: history.length,
    windowSize,
    keptInWindow: keptInWindow.length,
    highImpactInWindow,
    consecutiveReverts,
    consecutiveWithoutHighImpact,
  };

  if (
    history.length >= windowSize &&
    keptInWindow.length <= maxKept &&
    highImpactInWindow === 0
  ) {
    return {
      ...base,
      decision: 'STOP_DIMINISHING_RETURNS',
      reason: `最近 ${windowSize} 个提案中仅 ${keptInWindow.length} 个产生效益且均为 P2 级 (P0/P1 为 0), 边际收益已枯竭`,
    };
  }

  if (consecutiveReverts >= exhaustStreak) {
    return {
      ...base,
      decision: 'STOP_STREAK_EXHAUSTED',
      reason: `已连续 ${consecutiveReverts} 轮尝试无任何保留收益 (达熔断阈值 ${exhaustStreak}), 自动收口`,
    };
  }

  if (consecutiveWithoutHighImpact >= dryStreak && p2InDryStreak <= 1) {
    return {
      ...base,
      decision: 'STOP_DIMINISHING_RETURNS',
      reason: `已连续 ${consecutiveWithoutHighImpact} 轮未出 P0/P1 且期间仅有 ${p2InDryStreak} 个微弱 P2, 收口避免零星微调无限空转`,
    };
  }

  if (
    consecutiveWithoutHighImpact > 0 &&
    consecutiveWithoutHighImpact % pivotStreak === 0
  ) {
    return {
      ...base,
      decision: 'PIVOT_REQUIRED',
      reason: `已连续 ${consecutiveWithoutHighImpact} 轮未打出 P0/P1 级别突破, 本轮强制升维: 禁止微调局部实现/GC, 必须从架构/算法/数据流/I-O 边界重新建模`,
    };
  }

  return {
    ...base,
    decision: 'CONTINUE',
    reason: `窗口近 ${recent.length} 次内保留 ${keptInWindow.length} 次 (含 P0/P1 ${highImpactInWindow} 次), 仍有探索空间`,
  };
}
