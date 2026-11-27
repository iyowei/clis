/**
 * `@iyowei/fan` 公共领域类型、持久化契约与传输抽象 (纯类型声明, 零运行时副作用)。
 */
export type FanMode = 'auto' | 'manual';

/** 手动转速控制策略: `'floor'` 表示保底下限 (高温时允许守护自动提速), `'fixed'` 表示锁死固定转速 */
export type ManualControlStrategy = 'floor' | 'fixed';

/** 单把风扇的实时状态快照 */
export interface FanInfo {
  index: number;
  actualRpm: number;
  targetRpm: number;
  minRpm: number;
  maxRpm: number;
  mode: FanMode;
  percent: number;
}

/** 持久化存储中单把风扇的目标配置 */
export type PersistedFanEntry =
  | { mode: 'auto' }
  | {
      mode: 'manual';
      kind: 'rpm' | 'percent';
      value: number;
      /** 缺省视为 `'floor'` (保底下限 + 高温自动升速) */
      strategy?: ManualControlStrategy;
    };

/** 持久化状态文件格式 (`state.json` v1) */
export interface FanPersistedState {
  version: 1;
  updatedAt: string;
  fans: Record<string, PersistedFanEntry>;
}

/** 告警条目 (结构化判别码 + 人类可读提示) */
export interface FanWarning {
  code:
    | 'FAN_CLAMPED'
    | 'MACS_FAN_CONTROL_RUNNING'
    | 'STATE_CORRUPT'
    | 'EXTERNAL_AUTO_OVERRIDE';
  message: string;
  fanIndex?: number;
}

/** 转速设定目标 (绝对 RPM 或 `[min, max]` 区间百分比) */
export type SpeedSpec =
  { kind: 'rpm'; rpm: number } | { kind: 'percent'; percent: number };

/** 面向单次操作的风扇筛选参数 */
export interface TargetFanOptions {
  fanIndex?: number;
  /** 是否自动记住到持久化配置 (默认 true; 传 false 表示仅本次生效) */
  persist?: boolean;
}

/** 支持切换保底下限或锁定恒定转速的参数 */
export interface MinFanOptions extends TargetFanOptions {
  /** 是否锁定为固定转速而不随高温自动提速 (默认 false, 即保底下限模式) */
  fixed?: boolean;
}

/** 手动设置指定转速的参数 */
export interface SetSpeedOptions extends MinFanOptions {
  speed: string | SpeedSpec;
}

/** 守护同步动作结果 */
export type PersistDaemonAction = 'unchanged' | 'installed' | 'updated';

/** 确保守护服务已安装且脚本为最新版的返回结果 */
export interface PersistDaemonSyncResult {
  status: PersistDaemonStatus;
  action: PersistDaemonAction;
}

/** 查询或变更操作后的统一返回结构 */
export interface FanStatusReport {
  fans: FanInfo[];
  macsFanControlRunning: boolean;
  warnings: FanWarning[];
  persisted?: FanPersistedState | null;
  didPersist?: boolean;
  daemonAction?: PersistDaemonAction;
}

/** 单次写入动作 (用于批处理底层 AppleSMC 调用) */
export type FanWriteRequest =
  | { kind: 'manual'; fanIndex: number; targetRpm: number }
  | { kind: 'auto'; fanIndex: number };

/** 可注入的底层硬件传输接口 (供 macOS AppleSMC 真机实现与测试桩共享) */
export interface FanTransport {
  readFans(): FanInfo[];
  applyWrites(requests: readonly FanWriteRequest[]): FanInfo[];
  isMacsFanControlRunning(): boolean;
}

/** 可注入的持久化状态存储接口 */
export interface FanStateStore {
  readonly path: string;
  read(): FanPersistedState | null;
  write(state: FanPersistedState): void;
}

/** 开机与唤醒持久化守护服务状态 */
export interface PersistDaemonStatus {
  installed: boolean;
  running: boolean;
  label: string;
  plistPath: string;
  daemonScriptPath: string;
  statePath: string;
  logPath: string;
  state: FanPersistedState | null;
  /** 读取持久化状态失败时的错误说明 (文件损坏或遇符号链接) */
  stateError?: string;
}

/** 控制器构造选项 */
export interface FanControllerOptions {
  transport?: FanTransport;
  stateStore?: FanStateStore;
  /** 持久化手动设定转速 (set/max/min 且 persist !== false) 时自动确保后台守护就绪并同步至最新脚本 (传 false 禁用) */
  ensureDaemon?: (() => PersistDaemonSyncResult) | false;
  /** 宿主平台覆盖 (供跨平台测试注入, 默认取 `process.platform`) */
  platform?: NodeJS.Platform;
}

/** 编排层风扇控制器接口 */
export interface FanController {
  status(options?: TargetFanOptions): FanStatusReport;
  set(options: SetSpeedOptions): FanStatusReport;
  max(options?: TargetFanOptions): FanStatusReport;
  min(options?: MinFanOptions): FanStatusReport;
  auto(options?: TargetFanOptions): FanStatusReport;
  apply(): FanStatusReport;
}
