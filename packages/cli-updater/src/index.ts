/**
 * `@iyowei/cli-updater` 公开入口: 跨包管理器 CLI 自更新共享引擎。
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
