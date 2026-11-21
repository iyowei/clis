/**
 * 硬件资源公式与安全端口推导引擎: 供 `generate.ts` 与 `codd-cli/wizard.ts` 调用。
 * 核心职责: 依 `HardwareSpec` (CPU/内存/磁盘/负载) 确定性推导 WiredTiger 缓存、连接上限、
 * oplog、压缩算法、ulimit、优雅停机窗口与备份配额 (越界抛 `SizingError`); 同时提供
 * 10002-29997 区间内避开扫描与基础设施端口黑名单的 5 位安全端口推荐 (`recommendSafePort`)。
 */
import { randomInt } from 'node:crypto';

export type WorkloadType = 'balanced' | 'write-heavy' | 'read-heavy';

export interface HardwareSpec {
  cpuCores: number;
  memoryGb: number;
  diskGb: number;
  workload?: WorkloadType;
  expectedAppConnections?: number;
}

export interface FormulaStep {
  key: string;
  label: string;
  value: string;
  formula: string;
  plainReason: string;
}

export interface ComputedSizing {
  cpuLimit: number;
  memoryLimitPodman: string;
  memoryReservationPodman: string;
  k8sLimitMemory: string;
  k8sRequestCpu: number;
  k8sRequestMemory: string;
  wtCacheGb: number;
  maxIncomingConnections: number;
  oplogSizeMb: number;
  blockCompressor: 'zstd' | 'snappy';
  slowOpThresholdMs: number;
  nofileUlimit: number;
  nprocUlimit: number;
  stopGracePeriodSec: number;
  backupConcurrency: number;
  backupMinFreeMb: number;
  backupMaxTotalMb: number;
  logMaxSize: string;
  persistenceSize: string;
  workload: WorkloadType;
  hardwareSummary: string;
  formulaSummary: string;
  steps: FormulaStep[];
  warnings: string[];
}

export class SizingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SizingError';
  }
}

export const HARDWARE_BOUNDS = Object.freeze({
  cpuCores: Object.freeze({ min: 1, max: 256 }),
  memoryGb: Object.freeze({ min: 1, max: 1024 }),
  diskGb: Object.freeze({ min: 10, max: 65536 }),
});

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

const roundMilli = (n: number): number => Math.round(n * 1000) / 1000;
const roundQuarter = (n: number): number => Math.floor(n * 4) / 4;
const floor50 = (n: number): number => Math.floor(n / 50) * 50;
const ceil50 = (n: number): number => Math.ceil(n / 50) * 50;
const round10 = (n: number): number => Math.round(n / 10) * 10;

const formatPodmanMem = (gb: number): string =>
  Number.isInteger(gb) ? `${gb}g` : `${Math.round(gb * 1024)}m`;

const formatK8sSize = (gb: number): string =>
  Number.isInteger(gb) ? `${gb}Gi` : `${Math.round(gb * 1024)}Mi`;

const OPLOG_DISK_RATIO: Record<WorkloadType, number> = {
  balanced: 0.03,
  'write-heavy': 0.08,
  'read-heavy': 0.02,
};

const WORKLOAD_ZH: Record<WorkloadType, string> = {
  balanced: '读写均衡',
  'write-heavy': '高频写入',
  'read-heavy': '高频读取',
};

const validateHardwareBounds = (hw: HardwareSpec): WorkloadType => {
  const { cpuCores: cpuB, memoryGb: memB, diskGb: diskB } = HARDWARE_BOUNDS;
  if (
    !Number.isFinite(hw.cpuCores) ||
    hw.cpuCores < cpuB.min ||
    hw.cpuCores > cpuB.max
  ) {
    throw new SizingError(
      `hardware.cpuCores 须在 ${cpuB.min}-${cpuB.max} 核之间 (当前填了 ${hw.cpuCores}), 请填入正数核数如 2 或 4`,
    );
  }
  if (
    !Number.isFinite(hw.memoryGb) ||
    hw.memoryGb < memB.min ||
    hw.memoryGb > memB.max
  ) {
    throw new SizingError(
      `hardware.memoryGb 须在 ${memB.min}-${memB.max} GB 之间 (当前填了 ${hw.memoryGb}), 生产环境建议至少 2 GB`,
    );
  }
  if (
    !Number.isFinite(hw.diskGb) ||
    hw.diskGb < diskB.min ||
    hw.diskGb > diskB.max
  ) {
    throw new SizingError(
      `hardware.diskGb 须在 ${diskB.min}-${diskB.max} GB 之间 (当前填了 ${hw.diskGb}), 请至少分配 ${diskB.min} GB 数据盘`,
    );
  }
  if (
    hw.expectedAppConnections !== undefined &&
    (!Number.isInteger(hw.expectedAppConnections) ||
      hw.expectedAppConnections < 1)
  ) {
    throw new SizingError(
      `hardware.expectedAppConnections 须为 >= 1 的整数 (当前填了 ${String(hw.expectedAppConnections)})`,
    );
  }
  const workload: WorkloadType = hw.workload ?? 'balanced';
  if (
    typeof workload !== 'string' ||
    !Object.hasOwn(OPLOG_DISK_RATIO, workload)
  ) {
    throw new SizingError(
      `不支持的 workload 类型 "${String(workload)}", 可选值为 balanced, write-heavy 或 read-heavy`,
    );
  }
  return workload;
};

const resolveWtRatio = (workload: WorkloadType, memGb: number): number => {
  if (workload === 'write-heavy') return 0.45;
  if (workload === 'read-heavy' && memGb > 8) return 0.55;
  return 0.5;
};

const resolveBlockCompressor = (
  workload: WorkloadType,
  cpuLimit: number,
): 'zstd' | 'snappy' => {
  if (workload === 'write-heavy') return 'snappy';
  return cpuLimit >= 2 ? 'zstd' : 'snappy';
};

const formatCompressorFormula = (
  workload: WorkloadType,
  cpuLimit: number,
): string => {
  if (workload === 'write-heavy') {
    return '高频写入优先低开销 snappy 块压缩 + 协议压缩';
  }
  return cpuLimit >= 2
    ? 'CPU >= 2 核启用 zstd 块压缩 + 协议压缩'
    : '单核启用低开销 snappy + 协议压缩';
};

const formatCompressorPlainReason = (
  workload: WorkloadType,
  cpuLimit: number,
): string => {
  if (workload === 'write-heavy') {
    return '高写入场景选用极速 snappy 减少压缩 CPU 抢占, 保住写入吞吐与低延迟';
  }
  return cpuLimit >= 2
    ? '自动压缩落盘数据与网络传输包, 节省约 70% 硬盘空间与流量'
    : '单核 CPU 采用轻量 snappy 压缩, 省空间且不卡 CPU';
};

const resolveMaxConnections = (
  memGb: number,
  wtCacheGb: number,
  expectedAppConnections: number | undefined,
  warnings: string[],
): number => {
  const nonCacheGb = Math.max(0.5, memGb - wtCacheGb);
  const baseMaxConns = clamp(floor50(nonCacheGb * 80), 100, 5000);
  const hardRamSafeCeiling = clamp(floor50(nonCacheGb * 130), 100, 5000);

  if (expectedAppConnections === undefined) {
    return baseMaxConns;
  }
  const needed = ceil50(expectedAppConnections * 1.25);
  if (needed <= baseMaxConns) {
    return baseMaxConns;
  }
  if (needed <= hardRamSafeCeiling) {
    return needed;
  }
  warnings.push(
    `预期连接数 ${expectedAppConnections} 超出当前 ${memGb}G 内存的承受上限: 已自动保护性限制为 ${hardRamSafeCeiling} 个连接, 如需更高并发请调大 memoryGb 或收紧后端连接池 maxPoolSize`,
  );
  return hardRamSafeCeiling;
};

/**
 * 按硬件规格与负载类型推导 MongoDB 9.0 与 Podman/K8s 全套运行参数, 并返回可展示的 `steps` 与 `warnings`。
 *
 * ### 数据流转示例
 * ```text
 * Input:  hw = { cpuCores: 4, memoryGb: 8, diskGb: 100, workload: 'balanced' }
 * Step 1: validateHardwareBounds 校验边界 (CPU 1-256 / RAM 1-1024G / Disk 10-65536G)
 * Step 2: 容器配额 -> memoryLimitPodman='8g', memoryReservationPodman='4g', k8sRequestCpu=2, k8sRequestMemory='8Gi'
 * Step 3: WT 缓存  -> balanced 取 0.5 x (8-1) = 3.5G (write-heavy 0.45 / read-heavy 大机 0.55)
 * Step 4: 并发/日志 -> nonCache=4.5G -> maxIncomingConnections=350; oplogSizeMb=round10(100*1024*0.03)=3070
 * Step 5: 运维参数 -> blockCompressor='zstd' (write-heavy 选 snappy / 非写重且>=2C 选 zstd), nofileUlimit=65536, stopGracePeriodSec=64, backupConcurrency=2
 * Output: ComputedSizing { wtCacheGb: 3.5, maxIncomingConnections: 350, oplogSizeMb: 3070, ..., steps: [6 项], warnings: [] }
 * ```
 */
export const computeSizing = (hw: HardwareSpec): ComputedSizing => {
  const workload = validateHardwareBounds(hw);
  const warnings: string[] = [];
  if (hw.memoryGb < 2) {
    warnings.push(
      `当前仅分配了 ${hw.memoryGb} GB 内存 (低于 2 GB 推荐值): 查询排序、并发超过 50 连接或执行 make drill 沙箱演练时易因内存不足触发 OOM, 建议至少升至 2 GB`,
    );
  }

  const cpuLimit = roundMilli(hw.cpuCores);
  const memGb = hw.memoryGb;

  // 1) 容器软保护与 K8s requests: K8s 内存 requests == limits 防节点内存压力下 OOM 驱逐数据库
  const memResGb =
    memGb <= 2 ? Math.min(memGb, 1) : Math.max(1, roundQuarter(memGb * 0.5));
  const k8sReqCpu = roundMilli(
    cpuLimit <= 2 ? cpuLimit : Math.max(1, roundQuarter(cpuLimit * 0.5)),
  );
  const k8sReqMemGb = memGb;
  const memoryLimitPodman = formatPodmanMem(memGb);
  const memoryReservationPodman = formatPodmanMem(memResGb);
  const k8sLimitMemory = formatK8sSize(memGb);
  const k8sRequestMemory = formatK8sSize(k8sReqMemGb);
  const persistenceSize = formatK8sSize(hw.diskGb);

  // 2) WiredTiger Cache: 按负载特征分化比例, 为 OS Page Cache、脏页刷盘与 TCMalloc 留足边界
  // - write-heavy: 0.45 x (RAM - 1G), 控制脏页累积并留余量缩短 Checkpoint 阻塞
  // - read-heavy (>8G): 0.55 x (RAM - 1G), 大机多拨 5% 给热数据索引缓存
  // - balanced / read-heavy (<=8G): 遵循官方标准 0.5 x (RAM - 1G)
  const wtRatio = resolveWtRatio(workload, memGb);
  const wtCacheGb = Math.max(0.25, roundQuarter(wtRatio * (memGb - 1)));
  if (wtCacheGb >= memGb * 0.7) {
    warnings.push(
      `WT_CACHE_GB (${wtCacheGb}G) 占总内存 >= 70%, 会挤压连接栈与聚合排序内存`,
    );
  }

  // 3) 最大入站连接: 非缓存富余内存按每 GB 承载 80 个安全连接, 保底 100, 上限 5000
  const maxIncomingConnections = resolveMaxConnections(
    memGb,
    wtCacheGb,
    hw.expectedAppConnections,
    warnings,
  );

  // 4) oplogSizeMB: 磁盘容量 * 负载系数, 保底 990MB (WiredTiger 官方下限), 封顶 51200MB (50GB)
  const ratio = OPLOG_DISK_RATIO[workload];
  const oplogSizeMb = clamp(round10(hw.diskGb * 1024 * ratio), 990, 51200);

  // 5) 压缩 (write-heavy 优先低 CPU 开销 snappy, balanced/read-heavy >=2C 用 zstd)、
  //    进程句柄 ulimit (官方要求 >=64000, 对齐 2^16=65536; nproc 保留参考值不硬写以兼容 rootless Podman)、
  //    优雅停机窗口与备份并发度
  const blockCompressor = resolveBlockCompressor(workload, cpuLimit);
  const slowOpThresholdMs = workload === 'write-heavy' ? 80 : 100;
  const nofileUlimit = clamp(maxIncomingConnections * 4, 65536, 262144);
  const nprocUlimit = nofileUlimit;
  const stopGracePeriodSec = clamp(Math.round(memGb * 8), 30, 300);
  const backupConcurrency = clamp(Math.floor(cpuLimit / 2), 1, 8);
  const backupMinFreeMb = clamp(
    Math.round((hw.diskGb * 1024 * 0.05) / 256) * 256,
    1024,
    10240,
  );
  const backupMaxTotalMb = clamp(
    Math.round((hw.diskGb * 1024 * 1.5) / 1024) * 1024,
    4096,
    524288,
  );
  const logMaxSize = hw.diskGb >= 100 ? '100m' : '50m';

  const hardwareSummary = `${cpuLimit} 核 · ${memGb} GB 内存 · ${hw.diskGb} GB 硬盘 · ${WORKLOAD_ZH[workload]}`;
  const formulaSummary = `WT=${wtCacheGb}G, maxConns=${maxIncomingConnections}, oplog=${oplogSizeMb}MB, codec=${blockCompressor}, ulimit=${nofileUlimit}, grace=${stopGracePeriodSec}s`;

  const steps: FormulaStep[] = [
    {
      key: 'WT_CACHE_GB',
      label: '热数据内存缓存',
      value: `${wtCacheGb} GB`,
      formula: `max(0.25, ${wtRatio} x (${memGb}G - 1G))`,
      plainReason: `留出 ${roundQuarter(memGb - wtCacheGb)} GB 余量给网络连接与查询排序, 防止内存爆满`,
    },
    {
      key: 'MEMORY_RESERVATION',
      label: '容器内存上限',
      value: `${memGb} GB`,
      formula:
        memGb <= 2
          ? `小内存保底 ${memoryReservationPodman} 软保护线`
          : `软保护 ${memoryReservationPodman} / 硬上限 ${memoryLimitPodman}`,
      plainReason: `平时用多少占多少, 最高不超过 ${memGb} GB (保底预留 ${memResGb} GB)`,
    },
    {
      key: 'maxIncomingConnections',
      label: '最大同时连接数',
      value: `${maxIncomingConnections} 个`,
      formula: `clamp(floor50((${memGb} - ${wtCacheGb}) x 80), 100, 5000)`,
      plainReason: '按剩余内存折算的安全并发上限, 避免连接过多拖垮数据库',
    },
    {
      key: 'oplogSizeMB',
      label: '主从同步日志池',
      value: `${oplogSizeMb} MB`,
      formula: `clamp(${hw.diskGb}G x 1024 x ${(ratio * 100).toFixed(0)}%, 990, 51200)`,
      plainReason: '记录最近的数据变更, 支持多表事务与从节点断线重连后自动追平',
    },
    {
      key: 'blockCompressor',
      label: '存储与网络压缩',
      value: `${blockCompressor} 开启`,
      formula: formatCompressorFormula(workload, cpuLimit),
      plainReason: formatCompressorPlainReason(workload, cpuLimit),
    },
    {
      key: 'ulimit / grace / slowOp',
      label: '句柄上限与停机保护',
      value: `${nofileUlimit} / ${stopGracePeriodSec}s`,
      formula: `nofile=max(连接x4, 65536 官方>=64000 对齐 2^16), 停机窗口 ${stopGracePeriodSec}s`,
      plainReason: `容器显式提升文件句柄至 ${nofileUlimit} (>=64000), 进程数继承宿主机合法上限以兼容 rootless Podman; 重启最多等 ${stopGracePeriodSec} 秒安全刷盘, 慢查询线 ${slowOpThresholdMs}ms`,
    },
  ];

  return {
    cpuLimit,
    memoryLimitPodman,
    memoryReservationPodman,
    k8sLimitMemory,
    k8sRequestCpu: k8sReqCpu,
    k8sRequestMemory,
    wtCacheGb,
    maxIncomingConnections,
    oplogSizeMb,
    blockCompressor,
    slowOpThresholdMs,
    nofileUlimit,
    nprocUlimit,
    stopGracePeriodSec,
    backupConcurrency,
    backupMinFreeMb,
    backupMaxTotalMb,
    logMaxSize,
    persistenceSize,
    workload,
    hardwareSummary,
    formulaSummary,
    steps,
    warnings,
  };
};

const MIN_RECOMMENDED_PORT = 10002;
const MAX_RECOMMENDED_PORT = 29997;

/** 推荐安全 5 位端口黑名单: 避开 MongoDB 默认/扫描段与常见基础设施、代理、缓存服务端口 */
const EXCLUDED_RECOMMENDED_PORTS = new Set<number>([
  10050, 10051, 10080, 10250, 10255, 10256, 10257, 10259, 10809, 11211, 11214,
  12345, 15672, 15692, 16379, 18080, 18888, 20000, 21810, 22222, 23333, 25565,
  25672, 26257, 26379, 27000, 27017, 27018, 27019, 27020, 28017, 28080, 28888,
]);

const SAFE_PORT_CANDIDATES: readonly number[] = (() => {
  const list: number[] = [];
  for (let p = MIN_RECOMMENDED_PORT; p <= MAX_RECOMMENDED_PORT; p += 3) {
    if (!EXCLUDED_RECOMMENDED_PORTS.has(p)) {
      list.push(p);
    }
  }
  return list;
})();

/** 计算正整数的十进制数根 (1-9), 如 digitalRoot(27117) === 9 */
export const digitalRoot = (n: number): number => {
  if (!Number.isInteger(n) || n <= 0) {
    throw new RangeError(`digitalRoot 仅支持正整数 (当前收到 ${String(n)})`);
  }
  return 1 + ((n - 1) % 9);
};

/**
 * 随机推荐一个数根为 3 / 6 / 9 的 5 位安全监听端口 (区间 10002-29997):
 * - 数学上正整数数根属于 {3, 6, 9} 等价于能被 3 整除;
 * - 严格低于 30000 以避开 K8s NodePort (30000-32767) 与系统临时端口 (>=32768);
 * - 排除 27017-27019 等 MongoDB 默认扫描段及常见基础设施端口。
 */
export const recommendSafePort = (rng?: () => number): number => {
  if (!rng) {
    return SAFE_PORT_CANDIDATES[randomInt(0, SAFE_PORT_CANDIDATES.length)]!;
  }
  const raw = rng();
  const clamped = Number.isFinite(raw)
    ? Math.min(Math.max(raw, 0), 1 - Number.EPSILON)
    : 0;
  return SAFE_PORT_CANDIDATES[
    Math.floor(clamped * SAFE_PORT_CANDIDATES.length)
  ]!;
};
