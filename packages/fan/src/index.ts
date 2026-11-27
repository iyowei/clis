/**
 * `@iyowei/fan` 可编程 API 唯一公开导出入口。
 * 供 `@iyowei/fan-cli` 与外部自动化脚本调用, 内部实现模块 `smc-script` / `daemon-script` 严禁经此暴露。
 */
export { createFanController } from './controller.ts';
export {
  DEFAULT_DAEMON_LOG_PATH,
  DEFAULT_DAEMON_SCRIPT_PATH,
  DEFAULT_PLIST_PATH,
  type DaemonPaths,
  FAN_DAEMON_LABEL,
  MACOS_LAUNCHCTL_BIN,
  buildLaunchDaemonPlist,
  ensurePersistDaemon,
  getPersistDaemonStatus,
  installPersistDaemon,
  uninstallPersistDaemon,
} from './daemon.ts';
export { type FanErrorCode, FanError, isFanError } from './errors.ts';
export {
  type AppleSmcDeps,
  MACOS_PGREP_BIN,
  MACOS_PYTHON3_BIN,
  MACOS_SUDO_BIN,
  createAppleSmcTransport,
} from './smc-apple.ts';
export { computePercent, parseSpeedSpec, resolveTargetRpm } from './speed.ts';
export {
  DEFAULT_FAN_DIR,
  DEFAULT_FAN_STATE_PATH,
  type MacOsStateStoreDeps,
  createMacOsFanStateStore,
  mergePersistedState,
  readPersistedState,
} from './state.ts';
export type {
  FanController,
  FanControllerOptions,
  FanInfo,
  FanMode,
  FanPersistedState,
  FanStateStore,
  FanStatusReport,
  FanTransport,
  FanWarning,
  FanWriteRequest,
  ManualControlStrategy,
  MinFanOptions,
  PersistDaemonAction,
  PersistDaemonStatus,
  PersistDaemonSyncResult,
  PersistedFanEntry,
  SetSpeedOptions,
  SpeedSpec,
  TargetFanOptions,
} from './types.ts';
