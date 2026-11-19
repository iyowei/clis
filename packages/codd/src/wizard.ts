/**
 * 交互式 MongoDB 部署配置向导 (4 步引导完成拓扑、硬件、业务库与节点装配)。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { userInfo } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import {
  type HardwareSpec,
  type WorkloadType,
  computeSizing,
} from './formulas.ts';
import { parseSshInput } from './ssh.ts';
import type {
  AppInput,
  DeployManifest,
  DeployMode,
  NodeInput,
} from './types.ts';
import { askConfirm, selectOption } from './ui/prompts.ts';
import { askText } from './ui/text-input.ts';
import {
  printFormulaCard,
  printHeader,
  printSection,
  printSubGroup,
} from './ui/widgets.ts';
import { IPV4_RE } from './validate.ts';

const RESERVED_SYS_DBS = new Set(['admin', 'local', 'config']);

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

const validateAppsInput = (v: string): string | null => {
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
    if (seen.has(p[0]!))
      return `数据库名「${p[0]}」重复出现了两次, 每个库名需唯一`;
    seen.add(p[0]!);
  }
  return null;
};

const collectHardware = async (): Promise<HardwareSpec> => {
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
        hint: '填 1 到 256 之间的数字 (2 核及以上会自动开启高压缩比的 zstd 省硬盘空间)',
        defaultVal: '4',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 && n <= 256
            ? null
            : '请输入 1 到 256 之间的数字 (例如 2、4 或 8)';
        },
      }),
    );
    memoryGb = Number(
      await askText({
        label: '最多允许数据库用多少 GB 内存?',
        summaryLabel: '内存上限',
        hint: '如果服务器还跑了别的网站程序, 请扣掉它们的内存再填 (建议至少留给数据库 2 GB)',
        defaultVal: '8',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 1 && n <= 1024
            ? null
            : '请输入 1 到 1024 之间的数字 (单位 GB, 例如 4 或 8)';
        },
      }),
    );
    diskGb = Number(
      await askText({
        label: '准备了多大的数据硬盘 (GB)?',
        summaryLabel: '硬盘容量',
        hint: '用来按比例划分数据同步日志池的大小, 填服务器剩余可用硬盘的大致 GB 数即可 (至少 10 GB)',
        defaultVal: '100',
        validate: (v) => {
          const n = Number(v);
          return Number.isFinite(n) && n >= 10 && n <= 65536
            ? null
            : '请输入 10 到 65536 之间的数字 (单位 GB, 例如 50 或 100)';
        },
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

const collectPodmanNodes = async (
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
          : '云公网机器推荐回车用 127.0.0.1 (Compass 勾内置 SSH 隧道即可免命令直连); 若是家里路由器后的内网主机想在局域网或 WireGuard 下让代码和 Compass 免隧道直连, 可填 0.0.0.0',
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
          ? `填【目标 Mac 服务器】上的路径 (必须在 /Users/ 或 /private/ 下)。按 Tab 可修改默认路径; 文件夹不存在会自动建好, 并自动加上 /mongo-${name}-<指纹> 绝不重名`
          : `填【目标 Linux 服务器】上的绝对路径。按 Tab 可修改默认路径; 文件夹不存在会自动建好, 并自动加上 /mongo-${name}-<指纹> 绝不重名`,
      defaultVal: defBackup,
      validate: (v) => {
        if (!v.startsWith('/') || v.includes('CHANGE_ME')) {
          return '请填写以斜杠 / 开头的完整绝对路径 (例如 /home/ops/srv/backups)';
        }
        if (
          nodeOs === 'macos' &&
          !v.startsWith('/Users/') &&
          !v.startsWith('/private/')
        ) {
          return 'Mac 上的路径必须以 /Users/ 或 /private/ 开头, 否则 Podman 虚拟机无法把备份写到宿主机上';
        }
        return null;
      },
    });

    const sshRaw = await askText({
      label: '服务器的 SSH 目标地址或命令 (选填, 可直接回车跳过)',
      summaryLabel: `${defName} SSH 地址`,
      hint: '支持填 root@192.168.1.10、~/.ssh/config 主机名, 或直接粘贴 ssh myserver 命令 (会自动提取目标并过滤多余参数)。仅用于拼好最后的 rsync 上传命令, 不会现在连服务器',
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

export const runWizard = async (
  workDir: string,
  targetManifestPath?: string,
  dryRun = false,
): Promise<DeployManifest> => {
  printHeader(
    'MongoDB 部署配置向导',
    '按提示回答 4 组简单问题, 自动为你生成调优好的数据库安装包 (无需背诵复杂参数)。',
  );

  printSection(
    '1 / 4',
    '选择部署方式与项目名称',
    '决定把数据库装在单台服务器、三台服务器还是 Kubernetes 集群里',
  );

  const mode = await selectOption<DeployMode>({
    label: '你准备怎样部署这套 MongoDB?',
    summaryLabel: '部署方式',
    options: [
      {
        label: '单机部署 (Podman)',
        badge: '新手推荐',
        hint: '只需 1 台 Linux 或 Mac 服务器, 已自动开启多表事务与定时备份, 适合绝大多数中小型项目',
        value: 'single',
      },
      {
        label: '三机高可用集群 (Podman)',
        hint: '装在 3 台独立服务器上 (1 主 2 从实时同步), 坏掉 1 台机器业务也不会中断',
        value: 'replica-set',
      },
      {
        label: 'Kubernetes 单节点 (Helm)',
        hint: '部署到现有的 K8s 集群中 (1 个数据库 Pod + 云盘持久化), 适合测试或轻量服务',
        value: 'k8s-single',
      },
      {
        label: 'Kubernetes 三节点高可用 (Helm)',
        hint: '在 K8s 集群中启动 1 主 2 从共 3 个副本, 节点故障时自动切换主库不断线',
        value: 'k8s-rs',
      },
    ],
  });

  const name = await askText({
    label: '给这套数据库起个简短的项目名',
    summaryLabel: '实例名称',
    hint: '用来区分不同项目的安装包, 只能用小写英文字母、数字和短横线 - (例如填 app、shop 或 crm)',
    defaultVal: 'app',
    validate: (v) =>
      /^[a-z0-9-]+$/.test(v) && v.length <= 32
        ? null
        : '只能用小写字母、数字和短横线 -, 长度不超过 32 个字符 (正确示例: app 或 my-shop)',
  });

  const port = Number(
    await askText({
      label: '数据库监听哪个端口?',
      summaryLabel: '服务端口',
      hint: '后端程序连数据库时填的端口号。默认改成 27117 是为了避开网上机器人常扫的 27017, 一般直接回车即可',
      defaultVal: '27117',
      validate: (v) => {
        const n = Number(v);
        return Number.isInteger(n) && n >= 1024 && n <= 65535
          ? null
          : '请输入 1024 到 65535 之间的整数端口号 (推荐使用默认的 27117)';
      },
    }),
  );

  printSection(
    '2 / 4',
    '选择服务器硬件规格',
    '告诉向导目标机器大概有多大, 系统会自动算出最稳妥的缓存大小与连接上限, 避免内存爆满',
  );
  const hardware = await collectHardware();
  const preview = computeSizing(hardware);
  printFormulaCard(preview.hardwareSummary, preview.steps);
  console.log('');

  printSection(
    '3 / 4',
    '创建业务数据库与专属账号',
    '每个业务库拥有独立账号 (互不越权), 24 位高强度随机密码会自动生成并保存在本地文件中',
  );
  const appsRaw = await askText({
    label: '要创建哪些数据库和登录账号?',
    summaryLabel: '业务库与账号',
    hint: '写法是「数据库名:账号名」, 直接回车就创建名为 app 的库和账号; 如有多个库用英文逗号隔开, 比如 orders:orderapp,users:userapp',
    defaultVal: 'app:app',
    validate: validateAppsInput,
  });
  const apps: AppInput[] = appsRaw
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean)
    .map((e) => {
      const [db, user] = e.split(':') as [string, string];
      return { db, user };
    });

  printSection(
    '4 / 4',
    mode.startsWith('k8s') ? '填写 Kubernetes 部署位置' : '填写目标服务器信息',
    mode.startsWith('k8s')
      ? '指定部署到集群中的哪个命名空间与存储类型'
      : '填好目标服务器的系统与备份存放目录, 系统会自动在目录名后附带唯一指纹防止重名冲突',
  );

  const manifest: DeployManifest = {
    mode,
    name,
    port,
    hardware,
    apps,
  };

  if (mode === 'single' || mode === 'replica-set') {
    manifest.nodes = await collectPodmanNodes(mode, name);
  } else {
    const namespace = await askText({
      label: '部署到 Kubernetes 的哪个命名空间 (Namespace)?',
      summaryLabel: 'K8s 命名空间',
      hint: '相当于 K8s 里的项目隔离文件夹, 如果集群里还没有这个名字会自动创建, 一般直接回车用 data 即可',
      defaultVal: 'data',
      validate: (v) =>
        /^[a-z0-9-]+$/.test(v)
          ? null
          : '命名空间只能包含小写字母、数字和短横线 - (例如 data 或 prod-db)',
    });
    const storageClass = await askText({
      label: '指定云盘存储类型 StorageClass (选填, 不清楚请直接回车)',
      summaryLabel: '存储类 StorageClass',
      hint: '直接按回车留空就会自动使用你们 K8s 集群里设好的默认持久化云盘',
      placeholder: '留空使用集群默认云盘, 直接按 Enter',
      defaultVal: '',
      emptySummary: '自动使用集群默认存储类',
    });
    manifest.k8s = {
      namespace,
      ...(storageClass ? { storageClass } : {}),
      podAntiAffinity: mode === 'k8s-rs' ? 'hard' : 'soft',
    };
  }

  console.log('');
  const saveManifest = await askConfirm({
    label: '要把刚才选好的配置保存成 JSON 清单文件吗?',
    summaryLabel: '保存配置清单',
    hint: '保存后可在同一目录并存多份配置, 日后运行 codd <文件名> 即可一键重新生成、增库或升配',
    yesLabel: '保存以便日后修改',
    noLabel: '只生成一次不保存',
    defaultYes: true,
  });

  if (saveManifest && !dryRun) {
    const saveFile =
      targetManifestPath ??
      (await askText({
        label: '保存为哪个 JSON 文件名?',
        summaryLabel: '配置文件路径',
        hint: '可并存多份不同环境的清单 (如 deploy-dev.json, deploy-prod.json), 按 Tab 可基于默认名修改',
        defaultVal: name === 'app' ? 'deploy.json' : `deploy-${name}.json`,
        validate: (v) =>
          v.endsWith('.json') && !/[\\:*?"<>|]/.test(v)
            ? null
            : '文件名须以 .json 结尾 (例如 deploy.json 或 deploy-prod.json)',
      }));
    const fullSavePath = resolve(workDir, saveFile);
    if (existsSync(join(dirname(fullSavePath), 'deploy.schema.json'))) {
      manifest.$schema = './deploy.schema.json';
    }
    writeFileSync(
      fullSavePath,
      `${JSON.stringify(manifest, null, 2)}\n`,
      'utf8',
    );
  }
  return manifest;
};
