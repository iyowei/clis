/**
 * 确定性统计学与 A/B 对比裁判模块 (零外部依赖)。
 *
 * 原则:
 * 1. 分离 primary (主路径) 与 reference (对照) 用例, 杜绝被无关对照组中位数淹没真 P0;
 * 2. Mann-Whitney U 双样本非参数检验 (带 tie 修正与正态双尾近似);
 * 3. 双运行时守卫 (主路径有显著净收益 + 所有主路径用例无显著劣化 + Node 副路径不退化);
 * 4. 客观事后 P0 / P1 / P2 定级 (防主观通胀)。
 */
import type {
  BenchCaseRole,
  BenchCaseSample,
  BenchJsonReport,
  CaseDeltaSummary,
  FailureReason,
  MannWhitneyResult,
  PriorityTier,
  SampleStats,
  SuiteVerdict,
} from './types.ts';

export const DEFAULT_NOISE_FLOOR_PCT = 2.0;
export const DEFAULT_NODE_REGRESSION_LIMIT_PCT = 3.0;
export const DEFAULT_P_VALUE_ALPHA = 0.05;

/** 线性插值分位数 (input 须已升序排列) */
function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  if (sorted.length === 1) return sorted[0]!;
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const weight = pos - low;
  return sorted[low]! + (sorted[high]! - sorted[low]!) * weight;
}

/** 算数组描述性统计量 */
export function describeSamples(samples: readonly number[]): SampleStats {
  if (samples.length === 0) {
    return { count: 0, min: 0, median: 0, mean: 0, p95: 0, iqr: 0, cvPct: 0 };
  }
  const sorted = [...samples].sort((a, b) => a - b);
  let sum = 0;
  for (const val of sorted) sum += val;
  const mean = sum / sorted.length;
  let sqDiff = 0;
  for (const val of sorted) {
    const diff = val - mean;
    sqDiff += diff * diff;
  }
  const std = sorted.length > 1 ? Math.sqrt(sqDiff / (sorted.length - 1)) : 0;
  const q25 = percentileSorted(sorted, 0.25);
  const q75 = percentileSorted(sorted, 0.75);
  return {
    count: sorted.length,
    min: sorted[0]!,
    median: percentileSorted(sorted, 0.5),
    mean,
    p95: percentileSorted(sorted, 0.95),
    iqr: q75 - q25,
    cvPct: mean > 0 ? (std / mean) * 100 : 0,
  };
}

/** 互补误差函数 erfc(x) 的高精度有理近似 (Abramowitz & Stegun 7.1.26) */
function erfcApprox(x: number): number {
  const absX = Math.abs(x);
  const t = 1 / (1 + 0.3275911 * absX);
  const poly =
    t *
    (0.254829592 +
      t *
        (-0.284496736 +
          t * (1.421413741 + t * (-1.453152027 + t * 1.061405429))));
  const res = poly * Math.exp(-absX * absX);
  return x >= 0 ? res : 2 - res;
}

/** 标准正态分布双尾 p 值 */
function twoTailedNormalP(z: number): number {
  const p = erfcApprox(Math.abs(z) / Math.SQRT2);
  return Math.min(1, Math.max(0, p));
}

/**
 * Mann-Whitney U 双样本非参数检验 (带 tie 修正与连续性修正)。
 */
export function mannWhitneyU(
  baseline: readonly number[],
  candidate: readonly number[],
): MannWhitneyResult {
  const n1 = baseline.length;
  const n2 = candidate.length;
  if (n1 === 0 || n2 === 0) {
    return { u: 0, z: 0, pValue: 1 };
  }

  const combined: { value: number; isBaseline: boolean }[] = [];
  for (const val of baseline) combined.push({ value: val, isBaseline: true });
  for (const val of candidate) combined.push({ value: val, isBaseline: false });
  combined.sort((a, b) => a.value - b.value);

  const n = combined.length;
  let rankSumBaseline = 0;
  let tieCorrectionSum = 0;
  let idx = 0;

  while (idx < n) {
    let end = idx + 1;
    while (end < n && combined[end]!.value === combined[idx]!.value) {
      end += 1;
    }
    const tieCount = end - idx;
    const avgRank = (idx + 1 + end) / 2;
    for (let k = idx; k < end; k += 1) {
      if (combined[k]!.isBaseline) rankSumBaseline += avgRank;
    }
    if (tieCount > 1) {
      tieCorrectionSum += tieCount * tieCount * tieCount - tieCount;
    }
    idx = end;
  }

  const u1 = rankSumBaseline - (n1 * (n1 + 1)) / 2;
  const u2 = n1 * n2 - u1;
  const u = Math.min(u1, u2);
  const mu = (n1 * n2) / 2;
  const denom = n * (n - 1);
  const varianceFactor = denom > 0 ? n + 1 - tieCorrectionSum / denom : n + 1;
  const sigma = Math.sqrt(Math.max(0, ((n1 * n2) / 12) * varianceFactor));

  if (sigma === 0) {
    return { u, z: 0, pValue: 1 };
  }
  const absDiff = Math.abs(u - mu);
  const corrected = Math.max(0, absDiff - 0.5);
  const z = (u >= mu ? 1 : -1) * (corrected / sigma);
  return { u, z, pValue: twoTailedNormalP(z) };
}

/** 相对改善百分比 (正值代表 candidate 更快/更省) */
export function computeGainPct(baseline: number, candidate: number): number {
  if (baseline <= 0) return 0;
  return ((baseline - candidate) / baseline) * 100;
}

interface CaseBucket {
  role: BenchCaseRole;
  samplesMs: number[];
  peakRssValues: number[];
  cpuRatios: number[];
  digests: Set<string>;
}

/** 汇总同包报告集合里的每个 case 原始样本与元信息 */
function aggregateReportsByCase(
  reports: readonly BenchJsonReport[],
): Map<string, CaseBucket> {
  const map = new Map<string, CaseBucket>();

  for (const report of reports) {
    for (const c of report.cases) {
      let bucket = map.get(c.name);
      if (bucket === undefined) {
        bucket = {
          role: c.role ?? 'primary',
          samplesMs: [],
          peakRssValues: [],
          cpuRatios: [],
          digests: new Set(),
        };
        map.set(c.name, bucket);
      }
      for (const s of c.samplesMs) bucket.samplesMs.push(s);
      if (c.peakRssMB !== undefined) bucket.peakRssValues.push(c.peakRssMB);
      if (
        c.cpuUserMs !== undefined &&
        c.cpuSysMs !== undefined &&
        c.medianMs > 0 &&
        c.iterations > 0
      ) {
        const totalWall = c.medianMs * c.iterations;
        if (totalWall > 0) {
          bucket.cpuRatios.push((c.cpuUserMs + c.cpuSysMs) / totalWall);
        }
      }
      if (c.digest !== undefined) bucket.digests.add(c.digest);
    }
  }
  return map;
}

/** 比较单组运行时下 A/B 多轮样本 */
export function compareRuntimeReports(
  runtime: 'bun' | 'node',
  baselineReports: readonly BenchJsonReport[],
  candidateReports: readonly BenchJsonReport[],
  alpha: number = DEFAULT_P_VALUE_ALPHA,
): CaseDeltaSummary[] {
  const baseAgg = aggregateReportsByCase(baselineReports);
  const candAgg = aggregateReportsByCase(candidateReports);
  const summaries: CaseDeltaSummary[] = [];

  for (const [caseName, base] of baseAgg.entries()) {
    const cand = candAgg.get(caseName);
    if (cand === undefined) continue;
    const baseStats = describeSamples(base.samplesMs);
    const candStats = describeSamples(cand.samplesMs);
    const mw = mannWhitneyU(base.samplesMs, cand.samplesMs);
    const gainPct = computeGainPct(baseStats.median, candStats.median);

    const baseRss =
      base.peakRssValues.length > 0
        ? describeSamples(base.peakRssValues).median
        : null;
    const candRss =
      cand.peakRssValues.length > 0
        ? describeSamples(cand.peakRssValues).median
        : null;
    const rssGainPct =
      baseRss !== null && candRss !== null
        ? computeGainPct(baseRss, candRss)
        : null;

    const cpuRatio =
      base.cpuRatios.length > 0 ? describeSamples(base.cpuRatios).median : null;

    const digestMatch =
      base.digests.size <= 1 &&
      cand.digests.size <= 1 &&
      (base.digests.size === 0 ||
        cand.digests.size === 0 ||
        [...base.digests][0] === [...cand.digests][0]);

    summaries.push({
      caseName,
      role: base.role,
      runtime,
      baselineMedianMs: round2(baseStats.median),
      candidateMedianMs: round2(candStats.median),
      gainPct: round2(gainPct),
      pValue: round4(mw.pValue),
      statisticallySignificant: mw.pValue <= alpha,
      baselinePeakRssMB: baseRss === null ? null : round2(baseRss),
      candidatePeakRssMB: candRss === null ? null : round2(candRss),
      rssGainPct: rssGainPct === null ? null : round2(rssGainPct),
      cpuRatio: cpuRatio === null ? null : round3(cpuRatio),
      digestMatch,
    });
  }
  return summaries;
}

/** 基于实测提升比例做客观事后优先级定级 */
export function assignMeasuredTier(
  overallGainPct: number,
  overallRssGainPct: number | null,
  noiseFloorPct: number = DEFAULT_NOISE_FLOOR_PCT,
): PriorityTier | null {
  const rss = overallRssGainPct ?? 0;
  if (overallGainPct >= 25 || rss >= 40) return 'P0';
  if (overallGainPct >= 8 || rss >= 20) return 'P1';
  if (overallGainPct >= noiseFloorPct || rss >= 10) return 'P2';
  return null;
}

/**
 * 辩证聚合 primary 主路径用例收益:
 * 1. 计算所有 primary 用例加权总耗时降幅 (weightedGainPct);
 * 2. 计算所有统计显著正收益 primary 用例的最大定向涨幅 (bestSignificantPrimaryGainPct);
 * 3. 当没有任何 primary 用例劣化时, 取两者较高值作为真实改善标尺, 彻底消除"单热点猛提却被其余未改动用例中位数压成 0%"问题。
 */
function summarizePrimaryGain(
  summaries: readonly CaseDeltaSummary[],
  noiseFloorPct: number,
): {
  overallGainPct: number;
  overallRssGainPct: number | null;
  hasSignificantWin: boolean;
} {
  const primary = summaries.filter((s) => s.role === 'primary');
  const pool = primary.length > 0 ? primary : summaries;
  if (pool.length === 0) {
    return {
      overallGainPct: 0,
      overallRssGainPct: null,
      hasSignificantWin: false,
    };
  }

  let baseSum = 0;
  let candSum = 0;
  let bestSignificantGain = 0;
  let hasSignificantWin = false;
  const rssGains: number[] = [];

  for (const s of pool) {
    baseSum += s.baselineMedianMs;
    candSum += s.candidateMedianMs;
    if (s.rssGainPct !== null) rssGains.push(s.rssGainPct);
    const timeWin = s.gainPct >= noiseFloorPct && s.statisticallySignificant;
    const rssWin = s.rssGainPct !== null && s.rssGainPct >= 10;
    if (timeWin || rssWin) {
      hasSignificantWin = true;
      if (s.gainPct > bestSignificantGain) bestSignificantGain = s.gainPct;
    }
  }

  const weightedGain = baseSum > 0 ? ((baseSum - candSum) / baseSum) * 100 : 0;
  const overallGainPct = round2(
    hasSignificantWin
      ? Math.max(weightedGain, bestSignificantGain)
      : weightedGain,
  );
  const overallRssGainPct =
    rssGains.length > 0 ? round2(Math.max(...rssGains)) : null;

  return { overallGainPct, overallRssGainPct, hasSignificantWin };
}

/** 检查是否存在明确回归或一致性断裂 */
function detectHardFailure(
  bunSummaries: readonly CaseDeltaSummary[],
  nodeSummaries: readonly CaseDeltaSummary[],
  noiseFloorPct: number,
  nodeRegressionLimitPct: number,
): { reason: FailureReason; detail: string } | null {
  for (const s of [...bunSummaries, ...nodeSummaries]) {
    if (!s.digestMatch) {
      return {
        reason: 'CORRECTNESS_FAIL',
        detail: `${s.runtime}:${s.caseName} 输出校验摘要不一致, 涉嫌破坏语义`,
      };
    }
  }
  const bunPrimary = bunSummaries.filter((s) => s.role === 'primary');
  for (const s of bunPrimary.length > 0 ? bunPrimary : bunSummaries) {
    if (s.gainPct <= -noiseFloorPct && s.statisticallySignificant) {
      return {
        reason: 'REGRESSION',
        detail: `Bun 主路径用例 ${s.caseName} 显著劣化 ${s.gainPct.toFixed(1)}% (p=${s.pValue})`,
      };
    }
  }
  const nodePrimary = nodeSummaries.filter((s) => s.role === 'primary');
  for (const s of nodePrimary.length > 0 ? nodePrimary : nodeSummaries) {
    if (s.gainPct <= -nodeRegressionLimitPct && s.statisticallySignificant) {
      return {
        reason: 'CROSS_RUNTIME_REGRESSION',
        detail: `Node 主路径用例 ${s.caseName} 显著劣化 ${s.gainPct.toFixed(1)}% (p=${s.pValue}), 触发双运行时守卫回退`,
      };
    }
  }
  return null;
}

/** 综合 Bun 主路径与 Node 副路径数据给出 KEEP / REVERT 裁定 */
export function judgeSuiteEvaluation(
  bunBaseline: readonly BenchJsonReport[],
  bunCandidate: readonly BenchJsonReport[],
  nodeBaseline: readonly BenchJsonReport[] = [],
  nodeCandidate: readonly BenchJsonReport[] = [],
  options: {
    noiseFloorPct?: number;
    nodeRegressionLimitPct?: number;
    alpha?: number;
  } = {},
): SuiteVerdict {
  const noiseFloorPct = options.noiseFloorPct ?? DEFAULT_NOISE_FLOOR_PCT;
  const nodeLimit =
    options.nodeRegressionLimitPct ?? DEFAULT_NODE_REGRESSION_LIMIT_PCT;
  const alpha = options.alpha ?? DEFAULT_P_VALUE_ALPHA;

  const bunSummaries = compareRuntimeReports(
    'bun',
    bunBaseline,
    bunCandidate,
    alpha,
  );
  const nodeSummaries =
    nodeBaseline.length > 0 && nodeCandidate.length > 0
      ? compareRuntimeReports('node', nodeBaseline, nodeCandidate, alpha)
      : [];

  const allSummaries = [...bunSummaries, ...nodeSummaries];
  const { overallGainPct, overallRssGainPct, hasSignificantWin } =
    summarizePrimaryGain(bunSummaries, noiseFloorPct);
  const nodePrimary = nodeSummaries.filter((s) => s.role === 'primary');
  const nodePool = nodePrimary.length > 0 ? nodePrimary : nodeSummaries;
  const nodeRegressionPct =
    nodePool.length > 0
      ? round2(Math.min(...nodePool.map((s) => s.gainPct)))
      : null;

  if (bunSummaries.length === 0) {
    return {
      verdict: 'REVERT',
      measuredTier: null,
      failureReason: 'NOISE_INCONCLUSIVE',
      overallGainPct: 0,
      overallRssGainPct: null,
      nodeRegressionPct,
      caseSummaries: allSummaries,
      reason: '未收集到有效的 Bun A/B 用例对, 无法判定',
    };
  }

  const hardFailure = detectHardFailure(
    bunSummaries,
    nodeSummaries,
    noiseFloorPct,
    nodeLimit,
  );
  if (hardFailure !== null) {
    return {
      verdict: 'REVERT',
      measuredTier: null,
      failureReason: hardFailure.reason,
      overallGainPct,
      overallRssGainPct,
      nodeRegressionPct,
      caseSummaries: allSummaries,
      reason: hardFailure.detail,
    };
  }

  const tier = assignMeasuredTier(
    overallGainPct,
    overallRssGainPct,
    noiseFloorPct,
  );

  if (tier === null) {
    return {
      verdict: 'REVERT',
      measuredTier: null,
      failureReason: 'NO_GAIN',
      overallGainPct,
      overallRssGainPct,
      nodeRegressionPct,
      caseSummaries: allSummaries,
      reason: `主路径收益 ${overallGainPct.toFixed(2)}% 未跨过噪声门槛 (${noiseFloorPct}%)`,
    };
  }

  if (!hasSignificantWin) {
    return {
      verdict: 'REVERT',
      measuredTier: null,
      failureReason: 'NOISE_INCONCLUSIVE',
      overallGainPct,
      overallRssGainPct,
      nodeRegressionPct,
      caseSummaries: allSummaries,
      reason: `表面提升 ${overallGainPct.toFixed(2)}% 但未通过显著性检验 (p <= ${alpha}), 判定为噪声波动`,
    };
  }

  return {
    verdict: 'KEEP',
    measuredTier: tier,
    failureReason: null,
    overallGainPct,
    overallRssGainPct,
    nodeRegressionPct,
    caseSummaries: allSummaries,
    reason: `实测净收益 +${overallGainPct.toFixed(2)}% (客观定级 ${tier}), 双运行时安全通过`,
  };
}

/** 供测试与报告辅助的直出样本校验接口 */
export function buildSampleDigestForCase(sample: BenchCaseSample): string {
  return sample.digest ?? `${sample.name}:${sample.size ?? 0}`;
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function round3(n: number): number {
  return Math.round(n * 1000) / 1000;
}

function round4(n: number): number {
  return Math.round(n * 10000) / 10000;
}
