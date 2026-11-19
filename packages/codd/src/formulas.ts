/**
 * 资源与数据库参数计算引擎:
 * 根据硬件资源 (CPU / 内存 / 磁盘) 与业务负载特征推算最佳 MongoDB 9.0 + 容器/Pod 参数。
 */

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
  logMaxSize: string;
  persistenceSize: string;
  workload: WorkloadType;
  hardwareSummary: string;
  formulaSummary: string;
  steps: FormulaStep[];
  warnings: string[];
}

export class SizingError extends Error {}

const clamp = (n: number, min: number, max: number): number =>
  Math.min(max, Math.max(min, n));

const roundQuarter = (n: number): number => Math.floor(n * 4) / 4;
const floor50 = (n: number): number => Math.floor(n / 50) * 50;
const ceil50 = (n: number): number => Math.ceil(n / 50) * 50;
const round10 = (n: number): number => Math.round(n / 10) * 10;

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
  if (!Number.isFinite(hw.cpuCores) || hw.cpuCores < 1 || hw.cpuCores > 256) {
    throw new SizingError(
      `hardware.cpuCores 须在 1-256 核之间 (当前填了 ${hw.cpuCores}), 请填入正数核数如 2 或 4`,
    );
  }
  if (!Number.isFinite(hw.memoryGb) || hw.memoryGb < 1 || hw.memoryGb > 1024) {
    throw new SizingError(
      `hardware.memoryGb 须在 1-1024 GB 之间 (当前填了 ${hw.memoryGb}), 生产环境建议至少 2 GB`,
    );
  }
  if (!Number.isFinite(hw.diskGb) || hw.diskGb < 10 || hw.diskGb > 65536) {
    throw new SizingError(
      `hardware.diskGb 须在 10-65536 GB 之间 (当前填了 ${hw.diskGb}), 请至少分配 10 GB 数据盘`,
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
  if (!(workload in OPLOG_DISK_RATIO)) {
    throw new SizingError(
      `不支持的 workload 类型 "${String(workload)}", 可选值为 balanced, write-heavy 或 read-heavy`,
    );
  }
  return workload;
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

export const computeSizing = (hw: HardwareSpec): ComputedSizing => {
  const workload = validateHardwareBounds(hw);
  const warnings: string[] = [];
  if (hw.memoryGb < 2) {
    warnings.push(
      `当前仅分配了 ${hw.memoryGb} GB 内存 (低于 2 GB 推荐值): 查询排序或并发稍高时容易因内存不足重启, 建议至少升至 2 GB`,
    );
  }

  const cpuLimit = hw.cpuCores;
  const memGb = hw.memoryGb;

  // 1) 容器软保护与 K8s requests: K8s 内存 requests == limits 防节点内存压力下 OOM 驱逐数据库
  const memResGb =
    memGb <= 2 ? Math.min(memGb, 1) : Math.max(1, roundQuarter(memGb * 0.5));
  const k8sReqCpu =
    cpuLimit <= 2 ? cpuLimit : Math.max(1, roundQuarter(cpuLimit * 0.5));
  const k8sReqMemGb = memGb;

  // 2) WiredTiger Cache: <= 8G 遵循 0.5 * (RAM - 1GB); > 8G 大规格提升至 0.55 * (RAM - 1GB)
  const wtRatio = memGb > 8 ? 0.55 : 0.5;
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

  // 5) 压缩、进程句柄/线程数 ulimit (官方要求 >=64000, 对齐 2^16=65536)、优雅停机窗口与备份并发度
  const blockCompressor: 'zstd' | 'snappy' = cpuLimit >= 2 ? 'zstd' : 'snappy';
  const slowOpThresholdMs = workload === 'write-heavy' ? 80 : 100;
  const nofileUlimit = clamp(maxIncomingConnections * 4, 65536, 262144);
  const nprocUlimit = nofileUlimit;
  const stopGracePeriodSec = clamp(Math.round(memGb * 8), 30, 300);
  const backupConcurrency = clamp(Math.floor(cpuLimit / 2), 1, 8);
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
          ? '小内存保底 1g 软保护线'
          : `软保护 ${memResGb}g / 硬上限 ${memGb}g`,
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
      formula:
        cpuLimit >= 2
          ? 'CPU >= 2 核启用 zstd 块压缩 + 协议压缩'
          : '单核启用低开销 snappy + 协议压缩',
      plainReason:
        cpuLimit >= 2
          ? '自动压缩落盘数据与网络传输包, 节省约 70% 硬盘空间与流量'
          : '单核 CPU 采用轻量 snappy 压缩, 省空间且不卡 CPU',
    },
    {
      key: 'ulimit / grace / slowOp',
      label: '句柄上限与停机保护',
      value: `${nofileUlimit} / ${stopGracePeriodSec}s`,
      formula: `ulimit=max(连接x4, 65536 官方>=64000 对齐 2^16), 停机窗口 ${stopGracePeriodSec}s`,
      plainReason: `满足 MongoDB 官方 >=64000 句柄/线程数要求零告警; 重启最多等 ${stopGracePeriodSec} 秒安全刷盘, 慢查询线 ${slowOpThresholdMs}ms`,
    },
  ];

  return {
    cpuLimit,
    memoryLimitPodman: `${memGb}g`,
    memoryReservationPodman: `${memResGb}g`,
    k8sLimitMemory: `${memGb}Gi`,
    k8sRequestCpu: k8sReqCpu,
    k8sRequestMemory: `${k8sReqMemGb}Gi`,
    wtCacheGb,
    maxIncomingConnections,
    oplogSizeMb,
    blockCompressor,
    slowOpThresholdMs,
    nofileUlimit,
    nprocUlimit,
    stopGracePeriodSec,
    backupConcurrency,
    logMaxSize,
    persistenceSize: `${hw.diskGb}Gi`,
    workload,
    hardwareSummary,
    formulaSummary,
    steps,
    warnings,
  };
};
