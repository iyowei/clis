/**
 * `@iyowei/wake` 可编程 API 唯一公开导出入口。
 * 供 `@iyowei/wake-cli` 与外部自动化脚本调用, 内部模块 `relay.ts` 严禁经此暴露。
 */
export {
  DEFAULT_RELAY_TIMEOUT_MS,
  DEFAULT_WAIT_TIMEOUT_MS,
  loadWakeConfig,
  resolveDefaultWakeConfigPath,
  resolveTargetFromConfig,
  resolveWakeConfigPath,
  tryLoadWakeConfig,
  validateWakeConfig,
} from './config.ts';
export {
  removeWakeTarget,
  saveWakeConfig,
  upsertWakeTarget,
} from './config-write.ts';
export { sanitizeLine } from './display.ts';
export { type DiagnoseWakeOptions, diagnoseWake } from './doctor.ts';
export { type WakeErrorCode, WakeError, isWakeError } from './errors.ts';
export {
  buildMagicPacket,
  computeBroadcastIpv4,
  macToBytes,
  normalizeMac,
  normalizeMacList,
  parseIpv4NetmaskOctets,
  parseIpv4Octets,
  sameIpv4Subnet,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from './magic.ts';
export {
  discoverArpNeighbors,
  listLocalLanInterfaces,
  parseArpTableOutput,
  probeTcpPort,
  resolveBroadcastTargets,
  sendUdpMagicBurst,
} from './network.ts';
export { wakeTarget } from './wake.ts';
export type {
  ArpNeighborEntry,
  LoadedWakeConfig,
  LocalLanInterface,
  RelayAttempt,
  TcpProbeResult,
  UdpBurstResult,
  WakeClockDeps,
  WakeConfig,
  WakeDeps,
  WakeDoctorRelayResult,
  WakeDoctorReport,
  WakeNetworkDeps,
  WakePathContext,
  WakeProgressEvent,
  WakeRelayDeps,
  WakeReport,
  WakeTargetConfig,
  WakeTargetOptions,
  WakeWarning,
} from './types.ts';
