/**
 * `@iyowei/wake` 公共领域类型、配置契约与可注入传输接口 (纯类型声明, 零运行时副作用)。
 */

/** 单个可唤醒目标设备配置 */
export interface WakeTargetConfig {
  /** 支持 Wake-on-LAN 的网卡 MAC 列表 (按优先级发送) */
  macs: string[];
  /** 可选目标主机名或 IPv4/IPv6 地址, 用于在线预检、直连补发与就绪轮询 */
  host?: string;
  /** 可选就绪探测 TCP 端口 (缺省 22) */
  port?: number;
  /** 可选显式定向广播 IPv4 列表 */
  broadcast?: string[];
  /** 可选 SSH 中继节点列表 (跨网段时按顺序故障转移调用远端 wake) */
  relays?: string[];
  /** 默认等待上线超时毫秒数 (缺省 90_000) */
  waitTimeoutMs?: number;
  /** 单个 SSH 中继连接与执行超时毫秒数 (缺省 10_000) */
  relayTimeoutMs?: number;
  /** 可选备注说明 */
  note?: string;
}

/** 唤醒配置文件格式 (`config.json` v1) */
export interface WakeConfig {
  version: 1;
  defaultTarget?: string;
  targets: Record<string, WakeTargetConfig>;
}

/** 已解析的配置加载结果 */
export interface LoadedWakeConfig {
  path: string;
  config: WakeConfig;
}

/** 解析配置路径与环境所需的上下文参数 */
export interface WakePathContext {
  configPath?: string;
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: Record<string, string | undefined>;
}

/** 本机 IPv4 网卡摘要 */
export interface LocalLanInterface {
  name: string;
  address: string;
  netmask: string;
  broadcast: string;
  isVirtual: boolean;
}

/** 单次 UDP 魔术包投递结果 */
export interface UdpBurstResult {
  packetsSent: number;
  destinations: string[];
  sourceAddresses: string[];
  warnings: string[];
}

/** TCP 端口在线探测结果 */
export interface TcpProbeResult {
  reachable: boolean;
  latencyMs: number;
  reason?: string;
}

/** ARP 邻接表发现的候选主机 */
export interface ArpNeighborEntry {
  ip: string;
  mac: string;
  iface?: string;
  state?: string;
}

/** 单个 SSH 中继尝试记录 */
export interface RelayAttempt {
  relay: string;
  ok: boolean;
  packetsSent?: number;
  destinations?: string[];
  reason?: string;
}

/** 唤醒警告条目 */
export interface WakeWarning {
  code: 'RELAY_FALLBACK' | 'LOCAL_SUBNET_MISMATCH' | 'ARP_UNAVAILABLE';
  message: string;
}

/** 唤醒状态阶段事件 (供 CLI 进度条实时刷新) */
export type WakeProgressEvent =
  | { phase: 'precheck'; host: string; port: number }
  | { phase: 'relay'; relay: string; index: number; total: number }
  | { phase: 'local-burst'; round: number; destinations: string[] }
  | {
      phase: 'waiting';
      host: string;
      port: number;
      elapsedMs: number;
      timeoutMs: number;
      attempt: number;
    };

/** 唤醒执行入参 */
export interface WakeTargetOptions extends WakePathContext {
  /** 配置文件中的目标名称 (传 `--mac` 且未命名目标时可省略) */
  target?: string;
  /** 覆盖或直接指定的一个或多个 MAC 地址 */
  macs?: readonly string[];
  /** 覆盖目标主机地址 */
  host?: string;
  /** 覆盖探测 TCP 端口 */
  port?: number;
  /** 覆盖广播地址列表 */
  broadcast?: readonly string[];
  /** 覆盖 SSH 中继列表 */
  relays?: readonly string[];
  /** 等待目标端口就绪 (缺省 true; 有 host 时轮询直至上线) */
  wait?: boolean;
  /** 等待上线超时毫秒数 (缺省来自配置或 90_000) */
  waitTimeoutMs?: number;
  /** 单个中继超时毫秒数 (缺省来自配置或 10_000) */
  relayTimeoutMs?: number;
  /** 等待期间轮询间隔毫秒数 (缺省 1_000) */
  pollIntervalMs?: number;
  /** 等待期间补发魔术包间隔毫秒数 (缺省 15_000) */
  reburstIntervalMs?: number;
  /** 仅本机直发广播, 跳过配置的 SSH 中继 */
  localOnly?: boolean;
  /** 全部 SSH 中继失败时不回退本机 UDP 广播 */
  noLocalFallback?: boolean;
  /** 目标已在线时仍强制发送魔术包 */
  force?: boolean;
  /** 每轮每个目的地址发送几份副本 (缺省 2) */
  repeatPerDestination?: number;
  /** 每轮发几遍间隔突刺 (缺省 2) */
  rounds?: number;
  /** 进度回调 */
  onProgress?: (event: WakeProgressEvent) => void;
}

/** 唤醒主流程结果报告 */
export interface WakeReport {
  target: string;
  status: 'already-online' | 'dispatched' | 'woken' | 'timeout';
  method: 'none' | 'relay' | 'local';
  activeRelay?: string;
  macs: string[];
  host?: string;
  port?: number;
  packetsSent: number;
  destinations: string[];
  relayAttempts: RelayAttempt[];
  warnings: WakeWarning[];
  elapsedMs: number;
  /** 是否在本次动作中实际投递过魔术包 */
  dispatched: boolean;
}

/** 诊断单个中继节点状态 */
export interface WakeDoctorRelayResult {
  relay: string;
  reachable: boolean;
  remoteWakeAvailable: boolean;
  remoteWakeVersion?: string;
  reason?: string;
}

/** 诊断报告 */
export interface WakeDoctorReport {
  configPath: string;
  configExists: boolean;
  configError?: string;
  targetName?: string;
  targetFound?: boolean;
  host?: string;
  port?: number;
  targetReachable?: boolean;
  targetLatencyMs?: number;
  interfaces: LocalLanInterface[];
  relays: WakeDoctorRelayResult[];
}

/** 底层网络传输可注入依赖 (供单测与合约测试全隔离替身) */
export interface WakeNetworkDeps {
  listInterfaces?: () => LocalLanInterface[];
  sendUdpBurst?: (options: {
    macs: readonly string[];
    destinations: readonly string[];
    sourceAddresses: readonly string[];
    repeatPerDestination: number;
    rounds: number;
    roundIntervalMs: number;
  }) => Promise<UdpBurstResult>;
  probeTcp?: (
    host: string,
    port: number,
    timeoutMs: number,
  ) => Promise<TcpProbeResult>;
  discoverNeighbors?: () => Promise<ArpNeighborEntry[]>;
}

/** SSH 中继与远程诊断可注入依赖 */
export interface WakeRelayDeps {
  dispatchViaRelay?: (options: {
    relay: string;
    remoteArgs: readonly string[];
    timeoutMs: number;
  }) => Promise<{
    ok: boolean;
    packetsSent?: number;
    destinations?: string[];
    reason?: string;
  }>;
  probeRelay?: (options: {
    relay: string;
    timeoutMs: number;
  }) => Promise<WakeDoctorRelayResult>;
}

/** 时钟与延迟可注入依赖 */
export interface WakeClockDeps {
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** 综合控制器依赖注入项 */
export interface WakeDeps {
  network?: WakeNetworkDeps;
  relay?: WakeRelayDeps;
  clock?: WakeClockDeps;
}
