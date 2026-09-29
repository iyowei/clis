/**
 * API 包入口。导出面分两部分, 均以 docs/designs/api-surface.md 为契约基准:
 * - 公开面新增: 错误模型 (SweepError / code 体系) 与域类型 (编排层 / 跳过集册 / 诊断),
 *   按设计文档 §3 / §5 / §7 落地;
 * - 现状能力搬运: 原语层函数与既有类型, 随实现工序逐刀对齐设计 (编排层 createSweeper
 *   与进度取消见设计 §2.7 / §4)。
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
export { classifyTarget } from './classify.ts';
export {
  type Config,
  type ConfigSource,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
} from './config.ts';
export {
  type BatchOutcome,
  type RemoveBatchOptions,
  type RemovalProgressEvent,
  type RemovalResult,
  type TargetFailure,
  type TrustRoot,
  removeBatch,
  removeTargets,
  toTrustRoots,
} from './delete.ts';
export { SweepError, type SweepErrorDetails, isSweepError } from './errors.ts';
export {
  type CrossDeviceEntry,
  type CrossDeviceKind,
  type PathMapping,
  type PathStyle,
  type RejectedTarget,
  type RejectionDetails,
  POSIX_STYLE,
  WIN32_STYLE,
  crossDeviceIndex,
  findCrossDeviceTargets,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  nativeStyle,
  validateTargets,
} from './guard.ts';
export { runtimeLabel, writeTextFile } from './runtime.ts';
export { createScanner } from './scan.ts';
export { createSizer } from './size.ts';
export { collectSkips, crossDeviceNote, deletionBatch } from './skip.ts';
export type {
  EntryOutcome,
  EntryOutcomeKind,
  NameMatch,
  RenderEntry,
  ResolvedSweepOptions,
  ScanHit,
  ScanResult,
  SizeResult,
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
} from './types.ts';
