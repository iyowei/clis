/**
 * API 包入口。导出面分两部分, 均以 packages/sweep-node-modules/docs/designs/api-surface.md 为契约基准:
 * - 公开面新增: 错误模型 (SweepError / code 体系) 与域类型 (编排层 / 跳过集册 / 诊断),
 *   按设计文档 §3 / §5 / §7 落地;
 * - 现状能力搬运: 原语层函数与既有类型, 随实现工序逐刀对齐设计 (编排层 createSweeper
 *   见 sweep.ts, 结果缝合层见 summary.ts, 展示辅助见 display.ts; 设计 §2.6 / §2.7 / §4 / §7.8)。
 */
export {
  type AbortCode,
  type GuardCode,
  type RemoveFailureCode,
  type ScanWarningCode,
  type SizeBasis,
  type SizeWarningCode,
  type SkipReason,
  type SweepErrorCode,
  type SweepPhase,
  type SweepWarningCode,
  type UnmeasuredCode,
} from './codes.ts';
export {
  type Classification,
  type ClassifyOptions,
  type TargetKind,
  classifyTarget,
} from './classify.ts';
export {
  type Config,
  type ConfigSource,
  type EnvTable,
  type LoadConfigResult,
  type ResolveConfigPathOptions,
  type ResolvedConfigPath,
  DEFAULT_EXCLUDE,
  loadConfig,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
} from './config.ts';
export {
  type AbortedBatch,
  type BatchOutcome,
  type RemoveBatchOptions,
  type RemovalOptions,
  type RemovalProgressEvent,
  type RemovalResult,
  type TargetFailure,
  type TrustRoot,
  removeBatch,
  removeTargets,
  toTrustRoots,
} from './delete.ts';
export { formatBytes, sanitizeLine, sanitizeOutputLine } from './display.ts';
export { SweepError, type SweepErrorDetails, isSweepError } from './errors.ts';
export {
  type AnchorLink,
  type CrossDeviceEntry,
  type CrossDeviceKind,
  type CrossDeviceOptions,
  type DeviceProbe,
  type PathMapping,
  type PathOps,
  type PathStyle,
  type RejectedTarget,
  type RejectionDetails,
  type ValidateOptions,
  type ValidationResult,
  POSIX_STYLE,
  WIN32_STYLE,
  anchorChainPaths,
  crossDeviceIndex,
  dedupeKey,
  findCrossDeviceTargets,
  firstSymlinkOnAnchor,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  fsDeviceProbe,
  hasNodeModulesLeaf,
  insideAnyRoot,
  isFilesystemRootBody,
  isHomeBody,
  nativeStyle,
  validateTargets,
} from './guard.ts';
export { createScanner } from './scan.ts';
export { createSizer } from './size.ts';
export {
  collectSkips,
  crossDeviceNote,
  deletionBatch,
  skipReasonOf,
  skipsBatch,
  toSkipCandidates,
} from './skip.ts';
export { isSuccessOutcome, summarizeReport } from './summary.ts';
export { createSweeper } from './sweep.ts';
export type {
  EntryOutcome,
  EntryOutcomeKind,
  MeasureOptions,
  MeasureProgressEvent,
  NameMatch,
  ResolvedSweepOptions,
  ScanHit,
  ScanOptions,
  ScanProgressEvent,
  ScanResult,
  Scanner,
  SizeEntry,
  SizeResult,
  Sizer,
  SkipBook,
  SkipCandidate,
  SkippedTarget,
  SweepDrift,
  SweepEntry,
  SweepOptions,
  SweepOutcomeEntry,
  SweepPlan,
  SweepPlanOptions,
  SweepPolicy,
  SweepProgressEvent,
  SweepReport,
  SweepRunOptions,
  SweepRunStatus,
  SweepSummary,
  Sweeper,
  SweepWarning,
  UnmeasuredEntry,
} from './types.ts';
