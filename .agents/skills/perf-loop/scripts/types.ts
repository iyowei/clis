/**
 * perf-loop 确定性引擎的共享契约与数据结构。
 */

export const BENCH_JSON_SCHEMA_VERSION = 1;

export type PerfDimension = 'arch' | 'impl' | 'gc' | 'interp' | 'io';

export type PriorityTier = 'P0' | 'P1' | 'P2';

export type RuntimeKind = 'bun' | 'node';

export type BenchSuiteKind = 'quick' | 'full';

export type BenchCaseRole = 'primary' | 'reference';

export type FailureReason =
  | 'NO_GAIN'
  | 'REGRESSION'
  | 'CORRECTNESS_FAIL'
  | 'CROSS_RUNTIME_REGRESSION'
  | 'NOISE_INCONCLUSIVE'
  | 'POLICY_VIOLATION';

export type StoppingDecisionKind =
  | 'CONTINUE'
  | 'PIVOT_REQUIRED'
  | 'STOP_DIMINISHING_RETURNS'
  | 'STOP_STREAK_EXHAUSTED';

/** 单条基准用例的标准化测量输出 */
export interface BenchCaseSample {
  name: string;
  /** primary 参与净收益判定; reference 仅作历史对照组展示与一致性校验 */
  role?: BenchCaseRole;
  iterations: number;
  samplesMs: number[];
  minMs: number;
  medianMs: number;
  p95Ms: number;
  heapDeltaMB?: number;
  peakRssMB?: number;
  cpuUserMs?: number;
  cpuSysMs?: number;
  size?: number;
  unit?: string;
  /** 输出一致性校验摘要 (防优化破坏语义) */
  digest?: string;
}

/** 各包 bench/run.ts --json 的标准输出契约 */
export interface BenchJsonReport {
  schemaVersion: number;
  package: string;
  runtime: RuntimeKind;
  runtimeVersion: string;
  suite: BenchSuiteKind;
  cases: BenchCaseSample[];
}

/** 失败尝试的环境全景指纹 (用于后续条件解封判定) */
export interface EnvFingerprint {
  /** 目标包 src/ 文件的 SHA-256 哈希映射 */
  sourceHashes: Record<string, string>;
  /** 目标包 bench/ 目录组合哈希 */
  benchHash: string;
  runtimeVersions: {
    bun: string | null;
    node: string | null;
  };
  /** 尝试发生时该包已累积的 KEEP 数量 */
  acceptedCountAtAttempt: number;
  /** 尝试发生时该包已累积的 P0/P1 高收益 KEEP 数量 (防无关 P2 误解封) */
  highImpactAcceptedCountAtAttempt?: number;
}

/** 单用例 A/B 对比统计结果 */
export interface CaseDeltaSummary {
  caseName: string;
  role: BenchCaseRole;
  runtime: RuntimeKind;
  baselineMedianMs: number;
  candidateMedianMs: number;
  gainPct: number;
  pValue: number;
  statisticallySignificant: boolean;
  baselinePeakRssMB: number | null;
  candidatePeakRssMB: number | null;
  rssGainPct: number | null;
  cpuRatio: number | null;
  digestMatch: boolean;
}

/** 单次优化尝试记录 (写入 accepted.jsonl 或 rejected.jsonl) */
export interface ExperimentRecord {
  id: string;
  ts: number;
  package: string;
  proposal: string;
  rationale: string;
  dimension: PerfDimension;
  expectedTier: PriorityTier;
  verdict: 'KEEP' | 'REVERT';
  measuredTier: PriorityTier | null;
  failureReason: FailureReason | null;
  touchedFiles: string[];
  metrics: CaseDeltaSummary[];
  overallGainPct: number;
  overallRssGainPct: number | null;
  nodeRegressionPct: number | null;
  fingerprint: EnvFingerprint;
  docActionRequired: boolean;
  docNotes: string | null;
}

/** 失效队列的重评状态 */
export interface RejectedEvaluation {
  record: ExperimentRecord;
  status: 'LOCKED' | 'REELIGIBLE';
  reasons: string[];
}

/** 停止收敛判据输出 */
export interface StoppingEvaluation {
  decision: StoppingDecisionKind;
  totalExperiments: number;
  windowSize: number;
  keptInWindow: number;
  highImpactInWindow: number;
  consecutiveReverts: number;
  consecutiveWithoutHighImpact: number;
  reason: string;
}

/** 描述性统计指标 */
export interface SampleStats {
  count: number;
  min: number;
  median: number;
  mean: number;
  p95: number;
  iqr: number;
  cvPct: number;
}

/** Mann-Whitney U 检验结果 */
export interface MannWhitneyResult {
  u: number;
  z: number;
  pValue: number;
}

/** A/B 双运行时总裁定结果 */
export interface SuiteVerdict {
  verdict: 'KEEP' | 'REVERT';
  measuredTier: PriorityTier | null;
  failureReason: FailureReason | null;
  overallGainPct: number;
  overallRssGainPct: number | null;
  nodeRegressionPct: number | null;
  caseSummaries: CaseDeltaSummary[];
  reason: string;
}

/** 包探测信息 */
export interface DiscoveredPackage {
  name: string;
  dir: string;
  kind: 'cli' | 'public-lib' | 'private-lib';
  hasBenchScript: boolean;
  hasBenchEntry: boolean;
  supportsJsonBench: boolean;
  isStubBench: boolean;
}

/** 源码文件摘要 */
export interface SourceFileSummary {
  file: string;
  lines: number;
  exports: string[];
}

/** 剖析摘要 (从 CPU / Heap Profile 提炼的紧凑视图) */
export interface ProfileDigest {
  /** 已剥离测试 fixture/bench 搭建函数后的真实业务热点 */
  targetHotFunctions: string[];
  /** fixture 或框架自身热点 (供参照, 不作为调优目标) */
  setupHotFunctions: string[];
  heapTopTypes: string[];
  cpuRatio: number | null;
  userCpuShare: number | null;
  ioDominatedHint: boolean;
}

/** 文档沉淀确定性辅助信息 */
export interface DocDistillationHints {
  nextGlobalAdrNumber: string;
  pkgDesignsDir: string | null;
  existingDesigns: string[];
  pkgAdrsDir: string | null;
  pkgDocsReadme: string | null;
  repoDesignsDir: string;
}
