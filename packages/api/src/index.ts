/**
 * API 包入口 (结构迁移版): 现装能力的原样导出面。
 *
 * 本文件当前是「现状能力」的搬运面, 供 CLI 薄壳包与既有测试消化迁移期所需;
 * 正式的公开面 (域类型、错误码、进度与取消、编排层等) 按 docs/designs/api-surface.md
 * 在后续实现工序中定稿, 届时本文件导出集与设计文档对齐。
 */
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
export { type RemovalResult, type TrustRoot, removeTargets } from './delete.ts';
export {
  type CrossDeviceKind,
  type PathStyle,
  POSIX_STYLE,
  WIN32_STYLE,
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
export type { RenderEntry, ScanHit, ScanResult, SizeResult } from './types.ts';
