/**
 * `@iyowei/cli-updater` 公开入口: 跨包管理器 CLI 自更新共享引擎。
 * 消费方: 仓内全部 CLI 包 (`@iyowei/sweep-cli` / `@iyowei/codd-cli` / `create-clis`)。
 * 分层: args (参数) / detect (来源探测) / registry (源与版本) / semver (校验比较) /
 * executor + exec-async (计划与隔离执行) / ui + spinner (终端渲染) / update (主流程编排)。
 */
export {
  type ParseUpdateOutcome,
  type UpdateOptions,
  formatUpdateHelp,
  parseUpdateArgs,
} from './args.ts';
export {
  type DetectOriginInput,
  type EphemeralRunner,
  type GlobalRootMap,
  type InstallOrigin,
  type PackageManager,
  type ProjectPackageManager,
  SUPPORTED_PACKAGE_MANAGERS,
  detectInstallOriginFromPath,
  isWithinDir,
  normalizeSlashes,
  safeRealpath,
} from './detect.ts';
export {
  type ExecuteUpgradeAsyncOptions,
  type ExecuteUpgradeResult,
  MAX_CAPTURE_BYTES,
  type SpawnAsyncLike,
  TailByteBuffer,
  executeUpgradePlanAsync,
} from './exec-async.ts';
export {
  type BuildUpgradePlanInput,
  type CommandSpec,
  type SpawnLike,
  type UpgradePlanOutcome,
  buildIsolatedEnv,
  buildUpgradePlan,
  executeUpgradePlan,
  formatUpgradeDisplayCommand,
  isYarnBerryVersion,
  probeGlobalRoots,
  probeYarnVersion,
  resolveExecutableInPath,
  resolvePmInvocation,
} from './executor.ts';
export {
  type SpinnerTimerHandle,
  type UpdateSpinner,
  type UpdateSpinnerOptions,
  createUpdateSpinner,
} from './spinner.ts';
export {
  BAR_BLOCK,
  type ColorChannels,
  type UpdateUi,
  createUpdateUi,
  detectColorChannels,
  formatElapsedMs,
  paint,
  sanitizeMultilineTail,
  sanitizeText,
  stderrSupportsSpinner,
  stripAnsi,
} from './ui.ts';
export {
  DEFAULT_FETCH_TIMEOUT_MS,
  DEFAULT_REGISTRY,
  type FetchLike,
  type FetchVersionInput,
  type FetchVersionResult,
  type ResolveRegistryInput,
  fetchLatestVersion,
  normalizeRegistryUrl,
  parseRegistryFromBunfig,
  parseRegistryFromNpmrc,
  resolveRegistry,
} from './registry.ts';
export {
  type ParsedSemver,
  compareSemver,
  isNewerVersion,
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
  parseSemver,
} from './semver.ts';
export {
  type PackageMeta,
  type SelfUpdateRunOptions,
  type UpdateIO,
  readPackageMeta,
  runSelfUpdate,
} from './update.ts';
