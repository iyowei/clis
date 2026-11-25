/**
 * 交互式向导子步骤收集器 (支持中英双语): 硬件配额、业务库校验、Podman 节点与 Kubernetes 配置。
 */
import { userInfo } from 'node:os';

import {
  type DeployMode,
  HARDWARE_BOUNDS,
  type HardwareSpec,
  type NodeInput,
  type WorkloadType,
  parseSshInput,
  validateAppInput,
  validateNodeBindIp,
  validateSafeAbsPath,
} from '@iyowei/codd';

import { ct, getCoddLocale } from './i18n.ts';
import { askText, printSubGroup, selectOption } from './ui/index.ts';

const detectMacDefaultBackupRoot = (): string => {
  if (process.platform === 'darwin') {
    try {
      const u = userInfo().username;
      if (u && u !== 'root' && /^[A-Za-z0-9._-]+$/.test(u)) {
        return `/Users/${u}/srv/backups`;
      }
    } catch {
      // ignore and fallback
    }
  }
  return '/Users/ops/srv/backups';
};

export const validateAppsInput = (v: string): string | null => {
  const entries = v
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (entries.length === 0) {
    return ct(
      '至少需要填写 1 个业务数据库 (例如 app:app)',
      'Provide at least 1 database:user pair (e.g. app:app)',
    );
  }
  const seen = new Set<string>();
  for (const e of entries) {
    const p = e.split(':');
    if (p.length !== 2) {
      return ct(
        `「${e}」写法不对: 中间用英文冒号连接「库名:账号名」(正确示例: app:appuser)`,
        `Invalid entry '${e}': use 'db:user' separated by ':' (e.g. app:appuser)`,
      );
    }
    const [db, user] = p as [string, string];
    const err = validateAppInput({ db, user });
    if (err) {
      return getCoddLocale() === 'en'
        ? `Invalid database/account (${db}:${user}): use lowercase letters, digits, _ or -`
        : err;
    }
    if (seen.has(db)) {
      return ct(
        `数据库名「${db}」重复出现了两次, 每个库名需唯一`,
        `Duplicate database name '${db}'; each database must be unique`,
      );
    }
    seen.add(db);
  }
  return null;
};

export const collectHardware = async (): Promise<HardwareSpec> => {
  const { cpuCores: cpuB, memoryGb: memB, diskGb: diskB } = HARDWARE_BOUNDS;
  const hwPreset = await selectOption<'2c2g' | '4c8g' | '8c16g' | 'custom'>({
    label: ct(
      '留给这个数据库的服务器配置有多大?',
      'How much hardware is dedicated to this MongoDB instance?',
    ),
    summaryLabel: ct('硬件规格', 'Hardware Tier'),
    options: [
      {
        label: ct(
          '2 核 CPU · 2 GB 内存 · 32 GB 硬盘',
          '2 vCPU · 2 GB RAM · 32 GB Disk',
        ),
        badge: ct('轻量起步', 'Starter'),
        hint: ct(
          '适合入门级云服务器、个人项目或开发测试环境, 严格控制内存不卡死',
          'Ideal for small cloud VMs, side projects, and dev/staging environments',
        ),
        value: '2c2g',
      },
      {
        label: ct(
          '4 核 CPU · 8 GB 内存 · 100 GB 硬盘',
          '4 vCPU · 8 GB RAM · 100 GB Disk',
        ),
        badge: ct('主流生产', 'Production'),
        hint: ct(
          '适合大多数正式上线的业务系统, 兼顾内存缓存命中率与数百个并发连接',
          'Balanced WiredTiger cache and concurrency for standard production workloads',
        ),
        value: '4c8g',
      },
      {
        label: ct(
          '8 核 CPU · 16 GB 内存 · 250 GB 硬盘',
          '8 vCPU · 16 GB RAM · 250 GB Disk',
        ),
        hint: ct(
          '适合高并发核心业务或数据量较大的系统, 大内存能显著加速查询响应',
          'High-throughput workloads with generous RAM for hot working sets',
        ),
        value: '8c16g',
      },
      {
        label: ct(
          '手动输入其他 CPU / 内存 / 硬盘大小...',
          'Custom CPU / RAM / Disk sizing...',
        ),
        hint: ct(
          '如果你的机器是其他规格 (比如 4 核 16G 或 16 核 32G), 选这项自己填数字',
          'Enter exact CPU cores, memory budget (GB), and data volume size (GB)',
        ),
        value: 'custom',
      },
    ],
  });

  let cpuCores = 2;
  let memoryGb = 2;
  let diskGb = 32;
  if (hwPreset === '4c8g') {
    cpuCores = 4;
    memoryGb = 8;
    diskGb = 100;
  } else if (hwPreset === '8c16g') {
    cpuCores = 8;
    memoryGb = 16;
    diskGb = 250;
  } else if (hwPreset === 'custom') {
    cpuCores = Number(
      await askText({
        label: ct('分配几核 CPU?', 'Allocated CPU cores?'),
        summaryLabel: ct('CPU 核数', 'CPU Cores'),
        hint: ct(
          `填 ${cpuB.min} 到 ${cpuB.max} 之间的数字 (balanced/read-heavy >= 2 核自动用 zstd 省盘, 高频写入自动选 snappy 保吞吐)`,
          `Enter ${cpuB.min}-${cpuB.max} (>= 2 cores uses zstd for balanced/read-heavy; snappy for write-heavy)`,
        ),
        defaultVal: '4',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= cpuB.min && n <= cpuB.max
            ? null
            : ct(
                `请输入 ${cpuB.min} 到 ${cpuB.max} 之间的数字 (例如 2、4 或 8)`,
                `Enter a number between ${cpuB.min} and ${cpuB.max} (e.g. 2, 4, or 8)`,
              );
        },
      }),
    );
    memoryGb = Number(
      await askText({
        label: ct(
          '最多允许数据库用多少 GB 内存?',
          'Maximum RAM budget for MongoDB (GB)?',
        ),
        summaryLabel: ct('内存上限', 'RAM Limit'),
        hint: ct(
          '请扣除同机其他服务的内存再填 (建议至少留给数据库 2 GB)',
          'Subtract co-located services first (at least 2 GB recommended)',
        ),
        defaultVal: '8',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= memB.min && n <= memB.max
            ? null
            : ct(
                `请输入 ${memB.min} 到 ${memB.max} 之间的数字 (单位 GB, 例如 4 或 8)`,
                `Enter a number between ${memB.min} and ${memB.max} GB (e.g. 4 or 8)`,
              );
        },
      }),
    );
    diskGb = Number(
      await askText({
        label: ct('准备了多大的数据硬盘 (GB)?', 'Data volume capacity (GB)?'),
        summaryLabel: ct('硬盘容量', 'Disk Size'),
        hint: ct(
          `用来按比例推算 oplog 大小, 填可用数据盘容量即可 (至少 ${diskB.min} GB)`,
          `Used to size oplog proportionally (minimum ${diskB.min} GB)`,
        ),
        defaultVal: '100',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= diskB.min && n <= diskB.max
            ? null
            : ct(
                `请输入 ${diskB.min} 到 ${diskB.max} 之间的数字 (单位 GB, 例如 50 或 100)`,
                `Enter a number between ${diskB.min} and ${diskB.max} GB (e.g. 50 or 100)`,
              );
        },
      }),
    );
  }

  const workload = await selectOption<WorkloadType>({
    label: ct(
      '你的业务平时哪种数据库操作更多?',
      'What is your primary database workload pattern?',
    ),
    summaryLabel: ct('业务读写特征', 'Workload'),
    options: [
      {
        label: ct('读写差不多 (均衡型)', 'Balanced Read / Write'),
        badge: ct('默认选它', 'Default'),
        hint: ct(
          '拿不准的时候选这项最稳妥, 适合常见的后台管理、商城、SaaS 等综合业务',
          'Best all-around fit for SaaS apps, APIs, e-commerce, and general backends',
        ),
        value: 'balanced',
      },
      {
        label: ct('写入特别频繁 (高频写)', 'Write-Heavy'),
        hint: ct(
          '比如每秒都在大量插入埋点日志、聊天记录、传感器流水或订单变动',
          'Telemetry streams, event logs, IoT ingestion, or high-rate mutations',
        ),
        value: 'write-heavy',
      },
      {
        label: ct('查询远多于修改 (高频读)', 'Read-Heavy'),
        hint: ct(
          '比如内容展示网站、文章库、商品目录等绝大部分时间都在查数据的场景',
          'Content catalogs, feeds, and query-dominant services',
        ),
        value: 'read-heavy',
      },
    ],
  });

  return { cpuCores, memoryGb, diskGb, workload };
};

export const collectPodmanNodes = async (
  mode: DeployMode,
  name: string,
): Promise<NodeInput[]> => {
  const count = mode === 'single' ? 1 : 3;
  const nodes: NodeInput[] = [];
  const usedBindIps = new Set<string>();
  const macBackupDefault = detectMacDefaultBackupRoot();

  for (let i = 0; i < count; i += 1) {
    const defName = mode === 'single' ? 'main' : `node${i + 1}`;
    if (count > 1) {
      const roleNote =
        i === 0
          ? ct('主引导服务器', 'Primary Bootstrap')
          : ct('从同步服务器', 'Secondary Replica');
      printSubGroup(
        ct(
          `第 ${i + 1} / ${count} 台服务器 · ${defName} (${roleNote})`,
          `Host ${i + 1} of ${count} · ${defName} (${roleNote})`,
        ),
        i > 0,
      );
    }

    const nodeOs = await selectOption<'linux' | 'macos'>({
      label:
        count > 1
          ? ct(
              `${defName} 这台服务器是什么系统?`,
              `Operating system on ${defName}?`,
            )
          : ct('目标服务器是什么操作系统?', 'Target host operating system?'),
      summaryLabel: ct(`${defName} 操作系统`, `${defName} OS`),
      options: [
        {
          label: ct(
            'Linux 服务器 (Ubuntu / Debian / CentOS / Rocky 等)',
            'Linux Server (Ubuntu / Debian / Rocky / RHEL)',
          ),
          badge: ct('常见云主机', 'Standard Cloud'),
          hint: ct(
            '阿里云、腾讯云、AWS 或机房 Linux 主机都选这项, 会附带内核加速脚本',
            'Includes sysctl/THP tuning scripts and systemd backup timers',
          ),
          value: 'linux',
        },
        {
          label: ct(
            'macOS 电脑或 Mac mini 服务器',
            'macOS Host or Mac mini Server',
          ),
          hint: ct(
            '在 Mac 上通过 Podman 运行, 会自动生成每日凌晨 03:30 定时备份任务文件 (.plist)',
            'Runs via Podman on macOS with a 03:30 daily launchd backup plist',
          ),
          value: 'macos',
        },
      ],
    });

    const defIp = mode === 'single' ? '127.0.0.1' : `10.8.0.1${i + 1}`;
    const bindIp = await askText({
      label:
        mode === 'replica-set'
          ? ct(
              `${defName} 服务器的内网 IP 是多少?`,
              `Private / WireGuard IP for ${defName}?`,
            )
          : ct('允许从哪个网卡 IP 访问数据库?', 'Network bind IP for MongoDB?'),
      summaryLabel: ct(`${defName} 绑定 IP`, `${defName} Bind IP`),
      hint:
        mode === 'replica-set'
          ? ct(
              '三台服务器之间需要互相访问, 请填这台机器的内网或 WireGuard IP (如 10.8.0.11, 不能填 127.0.0.1 或重复 IP)',
              'Replica set nodes communicate over private/WireGuard IPs (e.g. 10.8.0.11; 127.0.0.1 not allowed)',
            )
          : ct(
              '云公网机器推荐回车用 127.0.0.1 (Compass 勾内置 SSH 隧道即可免命令直连); 若是内网主机想免隧道直连, 可填 0.0.0.0',
              'Use 127.0.0.1 on public VMs (connect via SSH tunnel), or 0.0.0.0 on trusted private LANs',
            ),
      defaultVal: defIp,
      validate: (v) => {
        const err = validateNodeBindIp(v, mode);
        if (err) {
          return getCoddLocale() === 'en'
            ? `Invalid bind IP '${v}' for mode '${mode}'`
            : err;
        }
        if (mode === 'replica-set' && usedBindIps.has(v)) {
          return ct(
            `IP「${v}」已被前一台节点使用, 三机副本集各节点必须填写互不相同的内网/WireGuard IP`,
            `IP '${v}' is already assigned to another replica node; each host needs a unique IP`,
          );
        }
        return null;
      },
    });
    usedBindIps.add(bindIp);

    const defBackup =
      nodeOs === 'macos' ? macBackupDefault : '/home/ops/srv/backups';
    const backupDir = await askText({
      label: ct(
        '服务器上的数据库备份存放在哪个文件夹?',
        'Backup root directory on the target server?',
      ),
      summaryLabel: ct(`${defName} 备份根目录`, `${defName} Backup Dir`),
      hint:
        nodeOs === 'macos'
          ? ct(
              `填【目标 Mac 服务器】上的绝对路径 (如 /Users/... 或外挂盘 /Volumes/..., 避开 /System、/etc 等系统目录)。按 Tab 可修改默认路径; 自动加上 /mongo-${name}-<指纹> 防重名`,
              `Absolute path on the target Mac (e.g. /Users/... or /Volumes/...); appends /mongo-${name}-<fp>`,
            )
          : ct(
              `填【目标 Linux 服务器】上的绝对路径 (避开 /proc、/etc、/usr/bin 等系统目录)。按 Tab 可修改默认路径; 自动加上 /mongo-${name}-<指纹> 防重名`,
              `Absolute path on the target Linux host; automatically appends /mongo-${name}-<fp>`,
            ),
      defaultVal: defBackup,
      validate: (v) => {
        const err = validateSafeAbsPath(v, nodeOs);
        if (err === null) return null;
        return getCoddLocale() === 'en'
          ? `Unsafe or invalid absolute backup path '${v}'`
          : err;
      },
    });

    const sshRaw = await askText({
      label: ct(
        '服务器的 SSH 目标地址或命令 (选填, 可直接回车跳过)',
        'SSH target or command (optional, press Enter to skip)',
      ),
      summaryLabel: ct(`${defName} SSH 地址`, `${defName} SSH Target`),
      hint: ct(
        '支持填 root@192.168.1.10、~/.ssh/config 主机名, 或粘贴 ssh myserver 命令。仅用于拼好 rsync 上传命令, 不会现在连服务器',
        'Accepts user@host, ~/.ssh/config alias, or ssh command; only formats rsync commands locally',
      ),
      placeholder: ct(
        '填 账号@IP、主机别名或 ssh 命令, 不填按 Enter 跳过',
        'user@ip, host alias, or press Enter to skip',
      ),
      defaultVal: '',
      emptySummary: ct(
        '未填 (生成通用上传命令)',
        'Skipped (generic upload command)',
      ),
      validate: (v) => {
        if (!v) return null;
        try {
          parseSshInput(v, ct('SSH 地址', 'SSH target'));
          return null;
        } catch (err) {
          if (getCoddLocale() === 'en') {
            return 'Invalid SSH target format';
          }
          return err instanceof Error ? err.message : 'SSH 地址格式不正确';
        }
      },
    });
    const sshNormalized = sshRaw ? parseSshInput(sshRaw).normalized : '';

    nodes.push({
      name: defName,
      os: nodeOs,
      bindIp,
      host: mode === 'single' ? '127.0.0.1' : defName,
      backupDir,
      ...(sshNormalized ? { sshTarget: sshNormalized } : {}),
    });
  }
  return nodes;
};

export { collectK8sConfig } from './wizard-k8s.ts';
