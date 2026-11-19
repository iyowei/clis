/**
 * 交互式向导子步骤收集器: 硬件配额、业务库校验、Podman 节点与 Kubernetes 配置。
 */
import { userInfo } from 'node:os';

import {
  DNS_LABEL_RE,
  DNS_SUBDOMAIN_RE,
  type DeployManifest,
  type DeployMode,
  type HardwareSpec,
  IPV4_RE,
  type NodeInput,
  type WorkloadType,
  parseSshInput,
} from '@iyowei/codd';

import { askText, printSubGroup, selectOption } from './ui/index.ts';

const RESERVED_SYS_DBS = new Set(['admin', 'local', 'config']);
const SAFE_ABS_PATH_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;

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
  if (entries.length === 0) return '至少需要填写 1 个业务数据库 (例如 app:app)';
  const seen = new Set<string>();
  for (const e of entries) {
    const p = e.split(':');
    if (
      p.length !== 2 ||
      !/^[A-Za-z0-9_-]+$/.test(p[0]!) ||
      !/^[A-Za-z0-9]+$/.test(p[1]!)
    ) {
      return `「${e}」写法不对: 中间用英文冒号连接, 且账号名只能用字母和数字 (正确示例: app:appuser)`;
    }
    if (RESERVED_SYS_DBS.has(p[0]!)) {
      return `「${p[0]}」是 MongoDB 内部系统保留名字, 请换一个业务名字 (例如 myapp:${p[1]})`;
    }
    if (seen.has(p[0]!)) {
      return `数据库名「${p[0]}」重复出现了两次, 每个库名需唯一`;
    }
    seen.add(p[0]!);
  }
  return null;
};

const validateBackupPath = (
  v: string,
  nodeOs: 'linux' | 'macos',
): string | null => {
  if (
    !SAFE_ABS_PATH_RE.test(v) ||
    v.split('/').includes('..') ||
    v.includes('CHANGE_ME')
  ) {
    return '请填写以 / 开头的安全绝对路径 (不含 ..、空格、引号或 Shell 元字符, 例如 /home/ops/srv/backups)';
  }
  if (
    nodeOs === 'macos' &&
    !v.startsWith('/Users/') &&
    !v.startsWith('/private/')
  ) {
    return 'Mac 上的路径必须以 /Users/ 或 /private/ 开头, 否则 Podman 虚拟机无法把备份写到宿主机上';
  }
  return null;
};

export const collectHardware = async (): Promise<HardwareSpec> => {
  const hwPreset = await selectOption<'2c2g' | '4c8g' | '8c16g' | 'custom'>({
    label: '留给这个数据库的服务器配置有多大?',
    summaryLabel: '硬件规格',
    options: [
      {
        label: '2 核 CPU · 2 GB 内存 · 32 GB 硬盘',
        badge: '轻量起步',
        hint: '适合入门级云服务器、个人项目或开发测试环境, 严格控制内存不卡死',
        value: '2c2g',
      },
      {
        label: '4 核 CPU · 8 GB 内存 · 100 GB 硬盘',
        badge: '主流生产',
        hint: '适合大多数正式上线的业务系统, 兼顾内存缓存命中率与数百个并发连接',
        value: '4c8g',
      },
      {
        label: '8 核 CPU · 16 GB 内存 · 250 GB 硬盘',
        hint: '适合高并发核心业务或数据量较大的系统, 大内存能显著加速查询响应',
        value: '8c16g',
      },
      {
        label: '手动输入其他 CPU / 内存 / 硬盘大小...',
        hint: '如果你的机器是其他规格 (比如 4 核 16G 或 16 核 32G), 选这项自己填数字',
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
        label: '分配几核 CPU?',
        summaryLabel: 'CPU 核数',
        hint: '填 1 到 256 之间的数字 (2 核及以上自动开启 zstd 省硬盘空间)',
        defaultVal: '4',
        validate: (v) =>
          Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 256
            ? null
            : '请输入 1 到 256 之间的数字 (例如 2、4 或 8)',
      }),
    );
    memoryGb = Number(
      await askText({
        label: '最多允许数据库用多少 GB 内存?',
        summaryLabel: '内存上限',
        hint: '请扣除同机其他服务的内存再填 (建议至少留给数据库 2 GB)',
        defaultVal: '8',
        validate: (v) =>
          Number.isFinite(Number(v)) && Number(v) >= 1 && Number(v) <= 1024
            ? null
            : '请输入 1 到 1024 之间的数字 (单位 GB, 例如 4 或 8)',
      }),
    );
    diskGb = Number(
      await askText({
        label: '准备了多大的数据硬盘 (GB)?',
        summaryLabel: '硬盘容量',
        hint: '用来按比例推算 oplog 大小, 填可用数据盘容量即可 (至少 10 GB)',
        defaultVal: '100',
        validate: (v) =>
          Number.isFinite(Number(v)) && Number(v) >= 10 && Number(v) <= 65536
            ? null
            : '请输入 10 到 65536 之间的数字 (单位 GB, 例如 50 或 100)',
      }),
    );
  }

  const workload = await selectOption<WorkloadType>({
    label: '你的业务平时哪种数据库操作更多?',
    summaryLabel: '业务读写特征',
    options: [
      {
        label: '读写差不多 (均衡型)',
        badge: '默认选它',
        hint: '拿不准的时候选这项最稳妥, 适合常见的后台管理、商城、SaaS 等综合业务',
        value: 'balanced',
      },
      {
        label: '写入特别频繁 (高频写)',
        hint: '比如每秒都在大量插入埋点日志、聊天记录、传感器流水或订单变动',
        value: 'write-heavy',
      },
      {
        label: '查询远多于修改 (高频读)',
        hint: '比如内容展示网站、文章库、商品目录等绝大部分时间都在查数据的场景',
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
  const macBackupDefault = detectMacDefaultBackupRoot();

  for (let i = 0; i < count; i += 1) {
    const defName = mode === 'single' ? 'main' : `node${i + 1}`;
    if (count > 1) {
      const roleNote = i === 0 ? '主引导服务器' : '从同步服务器';
      printSubGroup(
        `第 ${i + 1} / ${count} 台服务器 · ${defName} (${roleNote})`,
        i > 0,
      );
    }

    const nodeOs = await selectOption<'linux' | 'macos'>({
      label:
        count > 1
          ? `${defName} 这台服务器是什么系统?`
          : '目标服务器是什么操作系统?',
      summaryLabel: `${defName} 操作系统`,
      options: [
        {
          label: 'Linux 服务器 (Ubuntu / Debian / CentOS / Rocky 等)',
          badge: '常见云主机',
          hint: '阿里云、腾讯云、AWS 或机房 Linux 主机都选这项, 会附带内核加速脚本',
          value: 'linux',
        },
        {
          label: 'macOS 电脑或 Mac mini 服务器',
          hint: '在 Mac 上通过 Podman 运行, 会自动生成每日凌晨 03:30 定时备份任务文件 (.plist)',
          value: 'macos',
        },
      ],
    });

    const defIp = mode === 'single' ? '127.0.0.1' : `10.8.0.1${i + 1}`;
    const bindIp = await askText({
      label:
        mode === 'replica-set'
          ? `${defName} 服务器的内网 IP 是多少?`
          : '允许从哪个网卡 IP 访问数据库?',
      summaryLabel: `${defName} 绑定 IP`,
      hint:
        mode === 'replica-set'
          ? '三台服务器之间需要互相访问, 请填这台机器的内网或 WireGuard IP (如 10.8.0.11, 不能填 127.0.0.1)'
          : '云公网机器推荐回车用 127.0.0.1 (Compass 勾内置 SSH 隧道即可免命令直连); 若是内网主机想免隧道直连, 可填 0.0.0.0',
      defaultVal: defIp,
      validate: (v) => {
        if (!IPV4_RE.test(v)) {
          return '请输入四段数字格式的 IPv4 地址 (例如 127.0.0.1 或 192.168.1.10)';
        }
        if (mode === 'replica-set' && (v === '127.0.0.1' || v === '0.0.0.0')) {
          return '三台服务器组集群不能填 127.0.0.1 或 0.0.0.0, 请填写这台机器真实的内网 IP (例如 10.8.0.11)';
        }
        return null;
      },
    });

    const defBackup =
      nodeOs === 'macos' ? macBackupDefault : '/home/ops/srv/backups';
    const backupDir = await askText({
      label: '服务器上的数据库备份存放在哪个文件夹?',
      summaryLabel: `${defName} 备份根目录`,
      hint:
        nodeOs === 'macos'
          ? `填【目标 Mac 服务器】上的路径 (必须在 /Users/ 或 /private/ 下)。按 Tab 可修改默认路径; 自动加上 /mongo-${name}-<指纹> 防重名`
          : `填【目标 Linux 服务器】上的绝对路径。按 Tab 可修改默认路径; 自动加上 /mongo-${name}-<指纹> 防重名`,
      defaultVal: defBackup,
      validate: (v) => validateBackupPath(v, nodeOs),
    });

    const sshRaw = await askText({
      label: '服务器的 SSH 目标地址或命令 (选填, 可直接回车跳过)',
      summaryLabel: `${defName} SSH 地址`,
      hint: '支持填 root@192.168.1.10、~/.ssh/config 主机名, 或粘贴 ssh myserver 命令。仅用于拼好 rsync 上传命令, 不会现在连服务器',
      placeholder: '填 账号@IP、主机别名或 ssh 命令, 不填按 Enter 跳过',
      defaultVal: '',
      emptySummary: '未填 (生成通用上传命令)',
      validate: (v) => {
        if (!v) return null;
        try {
          parseSshInput(v, 'SSH 地址');
          return null;
        } catch (err) {
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

export const collectK8sConfig = async (
  mode: DeployMode,
): Promise<NonNullable<DeployManifest['k8s']>> => {
  const namespace = await askText({
    label: '部署到 Kubernetes 的哪个命名空间 (Namespace)?',
    summaryLabel: 'K8s 命名空间',
    hint: '相当于 K8s 里的项目隔离文件夹, 如果集群里还没有这个名字会自动创建, 一般直接回车用 data 即可',
    defaultVal: 'data',
    validate: (v) =>
      DNS_LABEL_RE.test(v) && v.length <= 63
        ? null
        : '命名空间须为合规 DNS 标签 (小写字母、数字与中间短横线, <= 63 字符, 例如 data 或 prod-db)',
  });
  const storageClass = await askText({
    label: '指定云盘存储类型 StorageClass (选填, 不清楚请直接回车)',
    summaryLabel: '存储类 StorageClass',
    hint: '直接按回车留空就会自动使用你们 K8s 集群里设好的默认持久化云盘',
    placeholder: '留空使用集群默认云盘, 直接按 Enter',
    defaultVal: '',
    emptySummary: '自动使用集群默认存储类',
    validate: (v) => {
      if (!v) return null;
      return DNS_SUBDOMAIN_RE.test(v) && v.length <= 253
        ? null
        : 'StorageClass 须为合规 Kubernetes 资源名 (小写字母、数字、点或连字符)';
    },
  });
  return {
    namespace,
    ...(storageClass ? { storageClass } : {}),
    podAntiAffinity: mode === 'k8s-rs' ? 'hard' : 'soft',
  };
};
