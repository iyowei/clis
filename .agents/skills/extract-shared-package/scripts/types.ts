/**
 * extract-shared-package 确定性工程分析与双向自均衡闭环核心类型契约。
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
  /** 是否视同公开库层级 (public-lib 或存在同源 CLI 配对的待首发双包 API 主包) */
  isPublicTierLib?: boolean;
  /** 内部工作区包全部依赖 (dependencies + devDependencies + peerDependencies + optionalDependencies) */
  internalDeps: string[];
  /** 内部工作区包运行期依赖 (dependencies + peerDependencies + optionalDependencies) */
  runtimeInternalDeps?: string[];
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
  /** 动态类型与 Rust 借用/类型系统障碍列表 */
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
  isInfra: boolean;
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
  isInfra: boolean;
  sloc: number;
  builtins: string[];
  externalDeps: string[];
  relativeImports: string[];
  internalClosureCount: number;
  symbolCount: number;
  exportedSymbolCount: number;
  fileShingles: string[];
  fileNormalizedDigest: string;
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
  isInfra: boolean;
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
    | 'file-structural-clone'
    | 'capability-cluster'
    | 'filename-aligned'
    | 'migration-residue';
  /** 结构/能力相似度 (0..1) */
  similarity: number;
  /** 综合优先级分数 */
  priorityScore: number;
  isInfraOnly: boolean;
  distinctPackageCount: number;
  distinctDomainCount: number;
  sharedLayers: PackageLayer[];
  commonBuiltins: string[];
  members: ClusterMember[];
  /** 是否被否决/暂缓台账抑制 (源码或消费域未变化时不重复推荐) */
  suppressed: boolean;
  suppressReason?: string;
}

/** 既有共享库退化度检出项 (防止拆包泛滥或僵尸遗留, 含冷静期状态) */
export interface DegeneratedLibFinding {
  fingerprint: string;
  pkgName: string;
  pkgDir: string;
  kind: 'private-lib' | 'public-lib';
  /** 直接依赖该库的包名 */
  directConsumers: string[];
  /** 顺着依赖链传递可达的独立业务产品域 (CLI/API) 列表 */
  transitiveConsumerDomains: string[];
  /** 可达业务消费包清单 */
  transitiveBusinessConsumers: string[];
  sloc: number;
  fileCount: number;
  /** cooling-down: 处于冷静观察期暂不回收; reabsorb-candidate: 已过冷静期待内联; dead-unused: 0消费; orphaned-public-lib: 已发npm禁删 */
  status:
    | 'cooling-down'
    | 'reabsorb-candidate'
    | 'dead-unused'
    | 'orphaned-public-lib';
  /** 首次观察到退化 (单域/零域) 的 ISO 时间戳 */
  firstObservedAt?: string;
  /** 已持续处于退化状态的天数 (保留两位小数) */
  elapsedDays?: number;
  /** 生效的冷却窗口天数 */
  cooldownDays?: number;
  /** 距离自动转为建议回收的剩余天数 */
  remainingDays?: number;
  suppressed: boolean;
  suppressReason?: string;
  reason: string;
}

/** 扫描完成后推荐 AI 下一步唯一路由动作 */
export interface ScanNextAction {
  kind:
    | 'stop'
    | 'fix-graph-violations'
    | 'reabsorb'
    | 'cleanup-unused'
    | 'cleanup-residue'
    | 'extract-or-triage';
  targetPkgName?: string;
  targetDir?: string;
  targetFingerprint?: string;
  suggestedCommand?: string;
  reason: string;
}

/** 扫描控制选项 (供单测时间推进与 CLI 参数覆盖) */
export interface ScanOptions {
  /** 参考当前时间 (默认 new Date()) */
  now?: Date;
  /** 单消费域退化冷静期天数 (默认 14; 0 表示立即转回收候选) */
  cooldownDays?: number;
  /** 零消费私库冷静期天数 (默认 7; 0 表示立即清理) */
  deadCooldownDays?: number;
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
    migrationResidueCount: number;
    degeneratedLibCount: number;
    coolingDownLibCount: number;
    reabsorbableLibCount: number;
  };
  /** 活跃候选抽离簇 (按 priorityScore 降序) */
  clusters: SimilarityCluster[];
  /** 待清理迁移残余 (新包已存在但某消费方仍残留同构旧代码) */
  migrationResidues: SimilarityCluster[];
  /** 退化/闲置共享库清单 (先减法回收再加法抽包) */
  degeneratedLibs: DegeneratedLibFinding[];
  /** 被否决台账抑制的候选簇 */
  suppressed: SimilarityCluster[];
  /** 文件级切割代价与 Rust 画像明细 */
  files: FileProfile[];
  /** 推荐下一步确定性动作路由 */
  nextAction: ScanNextAction;
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
  /** 可选传入接口参数/字段签名文本以执行参数级去领域词检测 */
  apiSignatures?: string[];
}

/** 四道本质闸门检查结果 */
export interface EssenceGateResult {
  passed: boolean;
  violations: string[];
  warnings: string[];
  metrics: {
    distinctConsumers: number;
    distinctDomains: number;
    businessConsumerDomains: number;
    consumerLayers: PackageLayer[];
    minRequiredDomains: number;
    layerCoverageLabel: string;
  };
}

/** 否决/采纳/回收台账记录 */
export interface LedgerRecord {
  fingerprint: string;
  status: 'accepted' | 'rejected' | 'deferred' | 'reabsorbed';
  packageName?: string;
  reason: string;
  /** 成员内容哈希与消费域快照: 一旦对应源码或消费域变更, 抑制自动失效 */
  memberDigests: Record<string, string>;
  distinctDomains: number;
  recordedAt: string;
}

/** 退化共享库冷却计时记录 */
export interface DegenerationWatch {
  pkgName: string;
  fingerprint: string;
  watchKind: 'single-domain' | 'zero-consumer';
  firstObservedAt: string;
  consumerSignature: string;
}

/** 持久台账文件形状 */
export interface ExtractLedger {
  schemaVersion: number;
  roundsExecuted: number;
  activeRoundId?: string;
  records: LedgerRecord[];
  degenerationWatches?: Record<string, DegenerationWatch>;
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
  mode: 'extract' | 'reabsorb' | 'residue';
  roundNumber: number;
  candidatePkgName: string;
  candidateDir: string;
  reabsorbInto?: string;
  reabsorbIntoPreExisted?: boolean;
  committed?: boolean;
  rolledBack?: boolean;
  startedAt: string;
  repoRoot: string;
  snapshotDir: string;
  baselineFiles: string[];
  backups: RoundBackupEntry[];
}
