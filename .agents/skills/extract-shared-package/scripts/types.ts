/**
 * extract-shared-package 确定性工程分析与闭环状态机核心类型契约。
 */

/** 包分类 (与仓库包分类与发布协议同构) */
export type PackageKind = 'cli' | 'public-lib' | 'private-lib';

/** 同构职责层 (用于解决异构包全量复用判据失真) */
export type PackageLayer = 'cli' | 'api' | 'shared-lib';

/** 代码单元宿主副作用标签 */
export type SideEffectTag =
  'pure' | 'fs' | 'process' | 'tty' | 'env' | 'network';

/** 支持的工作区语言适配器标识 (首期 ts-bun; 预留 rust-cargo 扩展位) */
export type WorkspaceLanguageKind = 'ts-bun' | 'rust-cargo';

/** 工作区包节点画像 */
export interface WorkspacePackageNode {
  name: string;
  dir: string;
  language: WorkspaceLanguageKind;
  kind: PackageKind;
  layer: PackageLayer;
  /** 独立产品域 ID: 对称双包 (如 pkg + pkg-cli) 共用同一个 domainId */
  domainId: string;
  isPrivate: boolean;
  hasBin: boolean;
  /** 内部工作区包依赖 */
  internalDeps: string[];
  /** 外部第三方依赖 */
  externalDeps: string[];
}

/** 包间有向边 */
export interface WorkspaceEdge {
  from: string;
  to: string;
}

/** 全仓工作区拓扑图 */
export interface WorkspaceGraph {
  repoRoot: string;
  packages: WorkspacePackageNode[];
  edges: WorkspaceEdge[];
  /** 同一职责层下的独立产品域统计 */
  layerDomainCounts: Record<PackageLayer, number>;
  /** 现有包间依赖违规列表 */
  existingViolations: string[];
}

/** Rust 可转写就绪度画像 (评估 TS 代码向 Rust 确定性转写的难易程度) */
export interface RustReadinessProfile {
  score: number;
  grade: 'high' | 'medium' | 'low';
  /** 动态类型 / 运行时魔法陷阱 (any / Proxy / eval / dynamic import) */
  hazards: string[];
  /** 是否把纯计算与多项宿主 I/O 混杂在同一单元 */
  ioBoundaryMixed: boolean;
  recommendation: string;
}

/** 确定性提取的单个函数/符号画像 */
export interface SymbolUnit {
  id: string;
  pkgName: string;
  pkgDir: string;
  domainId: string;
  layer: PackageLayer;
  file: string;
  name: string;
  symbolKind: 'function' | 'class' | 'const' | 'type';
  exported: boolean;
  startLine: number;
  endLine: number;
  sloc: number;
  paramCount: number;
  hasExplicitReturnType: boolean;
  rawDigest: string;
  normalizedDigest: string;
  shingles: string[];
  sideEffects: SideEffectTag[];
  builtins: string[];
  relativeImports: string[];
  internalTypeImports: string[];
  rustReadiness: RustReadinessProfile;
}

/** 单个文件级依赖与剥离切割代价摘要 */
export interface FileProfile {
  pkgName: string;
  pkgDir: string;
  domainId: string;
  layer: PackageLayer;
  file: string;
  sloc: number;
  builtins: string[];
  externalDeps: string[];
  relativeImports: string[];
  internalClosureCount: number;
  symbolCount: number;
  exportedSymbolCount: number;
  sideEffects: SideEffectTag[];
  /** 剥离切割代价 (0 表示零内部耦合可独立移出; 值越高越粘连原包) */
  cutCost: number;
  rustReadiness: RustReadinessProfile;
}

/** 跨包克隆或同构模式候选成员 */
export interface ClusterMember {
  pkgName: string;
  pkgDir: string;
  domainId: string;
  layer: PackageLayer;
  file: string;
  symbolName: string;
  startLine: number;
  endLine: number;
  sloc: number;
  rawDigest: string;
  cutCost: number;
  rustReadinessScore: number;
  sideEffects: SideEffectTag[];
  builtins: string[];
}

/** 候选跨包复用簇 */
export interface SimilarityCluster {
  fingerprint: string;
  kind:
    | 'exact-clone'
    | 'structural-clone'
    | 'capability-cluster'
    | 'filename-aligned';
  /** 结构/能力相似度 (0..1) */
  similarity: number;
  /** 综合优先级分数 (考虑复用域数、代码净规模、低切割代价与 Rust 可转写度) */
  priorityScore: number;
  distinctPackageCount: number;
  distinctDomainCount: number;
  sharedLayers: PackageLayer[];
  commonBuiltins: string[];
  members: ClusterMember[];
  /** 是否被否决/暂缓台账抑制 (源码或消费域未变化时不重复推荐) */
  suppressed: boolean;
  suppressReason?: string;
}

/** 扫仓总报告 */
export interface ScanReport {
  schemaVersion: number;
  scannedAt: string;
  repoRoot: string;
  graph: WorkspaceGraph;
  stats: {
    totalPackages: number;
    totalFiles: number;
    totalSymbols: number;
    activeClusters: number;
    suppressedClusters: number;
  };
  /** 活跃候选簇 (按 priorityScore 降序) */
  clusters: SimilarityCluster[];
  /** 被否决台账抑制的候选簇 */
  suppressed: SimilarityCluster[];
  /** 高切割代价提示 / 低 Rust 可转写度提示 */
  files: FileProfile[];
  /** 收敛判据信号 */
  convergence: {
    shouldStop: boolean;
    reason: string;
    activeRoundsExecuted: number;
    maxRoundsAllowed: number;
  };
}

/** 提案四道本质闸门检查输入 */
export interface ProposalCheckInput {
  packageName: string;
  description: string;
  consumers: string[];
  exportedSymbols: string[];
  targetKind?: 'private-lib' | 'public-lib';
  internalDeps?: string[];
}

/** 四道本质闸门检查结果 */
export interface EssenceGateResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
  metrics: {
    distinctConsumers: number;
    distinctDomains: number;
    consumerLayers: PackageLayer[];
    minRequiredDomains: number;
    layerCoverageLabel: string;
  };
}

/** 否决/采纳台账记录 */
export interface LedgerRecord {
  fingerprint: string;
  status: 'accepted' | 'rejected' | 'deferred';
  packageName?: string;
  reason: string;
  /** 成员内容哈希与消费域快照: 一旦对应源码或消费域变更, 抑制自动失效 */
  memberDigests: Record<string, string>;
  distinctDomains: number;
  recordedAt: string;
}

/** 持久台账文件形状 */
export interface ExtractLedger {
  schemaVersion: number;
  roundsExecuted: number;
  records: LedgerRecord[];
}

/** 单轮运行备份快照 (落 ~/tmp/extract-shared-package/, 不污染仓库) */
export interface RoundBackupEntry {
  relPath: string;
  existed: boolean;
  backupAbsPath?: string;
}

/** 单轮运行时检查点 */
export interface RoundCheckpoint {
  roundId: string;
  roundNumber: number;
  candidatePkgName: string;
  candidateDir: string;
  startedAt: string;
  repoRoot: string;
  snapshotDir: string;
  baselineFiles: string[];
  backups: RoundBackupEntry[];
}
