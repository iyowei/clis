/**
 * 交互式 MongoDB 部署配置向导主编排器 (支持中英双语): 4 步顺序采集配置并实时预览硬件推导卡片。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';

import {
  type AppInput,
  ConfigError,
  DNS_LABEL_RE,
  type DeployManifest,
  type DeployMode,
  computeSizing,
  digitalRoot,
  recommendSafePort,
} from '@iyowei/codd';

import { ct } from './i18n.ts';
import {
  askConfirm,
  askText,
  closeSharedLineReader,
  printAlert,
  printFormulaCard,
  printHeader,
  printSection,
  selectOption,
} from './ui/index.ts';
import {
  collectHardware,
  collectK8sConfig,
  collectPodmanNodes,
  validateAppsInput,
} from './wizard-steps.ts';

const WIN_DRIVE_PREFIX_RE = /^[A-Za-z]:[\\/]/;
const INVALID_PATH_SEGMENT_RE = /[:*?"<>|]/;

export const validateManifestFileName = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed) {
    return ct(
      '文件名须以 .json 结尾且不含非法路径字符 (例如 deploy.json 或 deploy-prod.json)',
      'File name must end with .json and contain no illegal path characters (e.g. deploy.json)',
    );
  }
  const body = trimmed.replace(WIN_DRIVE_PREFIX_RE, '');
  const segments = body.split(/[\\/]/);
  if (
    segments.some(
      (seg) => INVALID_PATH_SEGMENT_RE.test(seg) || seg.includes('\0'),
    )
  ) {
    return ct(
      '文件名须以 .json 结尾且不含非法路径字符 (例如 deploy.json 或 deploy-prod.json)',
      'File name must end with .json and contain no illegal path characters (e.g. deploy.json)',
    );
  }
  const base = segments.at(-1) ?? '';
  if (!base.endsWith('.json')) {
    return ct(
      '文件名须以 .json 结尾 (例如 deploy.json 或 deploy-prod.json)',
      'File name must end with .json (e.g. deploy.json or deploy-prod.json)',
    );
  }
  const stem = base.slice(0, -'.json'.length).trim();
  if (stem.length === 0 || stem === '.' || stem === '..') {
    return ct(
      '文件名必须包含有效主名, 不能仅为 .json (例如 deploy.json)',
      'File name must have a valid stem before .json (e.g. deploy.json)',
    );
  }
  return null;
};

const maybeSaveManifest = async (
  manifest: DeployManifest,
  workDir: string,
  targetManifestPath: string | undefined,
  dryRun: boolean,
): Promise<void> => {
  console.log('');
  if (dryRun) {
    printAlert(
      'warn',
      ct(
        '--dry-run 预览模式: 已跳过保存 JSON 配置清单 (不会写入磁盘)',
        '--dry-run preview: skipped saving JSON manifest (no files written)',
      ),
    );
    return;
  }

  const saveManifest = await askConfirm({
    label: ct(
      '要把刚才选好的配置保存成 JSON 清单文件吗?',
      'Save these settings as a reusable JSON manifest?',
    ),
    summaryLabel: ct('保存配置清单', 'Save Manifest'),
    hint: ct(
      '保存后可在同一目录并存多份配置, 日后运行 codd <文件名> 即可一键重新生成、增库或升配',
      'Allows one-command regeneration, credential rotation, or hardware scaling via codd <file>',
    ),
    yesLabel: ct('保存以便日后修改', 'Save Manifest'),
    noLabel: ct('只生成一次不保存', 'One-off Only'),
    defaultYes: true,
  });
  if (!saveManifest) return;

  if (targetManifestPath !== undefined) {
    const pathErr = validateManifestFileName(targetManifestPath);
    if (pathErr) {
      throw new ConfigError(
        ct(
          `目标清单路径「${targetManifestPath}」不合法: ${pathErr}`,
          `Invalid manifest path '${targetManifestPath}': ${pathErr}`,
        ),
      );
    }
  }

  const saveFile =
    targetManifestPath ??
    (await askText({
      label: ct('保存为哪个 JSON 文件名?', 'Manifest JSON file name?'),
      summaryLabel: ct('配置文件路径', 'Manifest Path'),
      hint: ct(
        '可并存多份不同环境的清单 (如 deploy-dev.json, configs/prod.json), 按 Tab 可基于默认名修改',
        'Supports multiple environments (e.g. deploy-dev.json, configs/prod.json); press Tab to edit default',
      ),
      defaultVal:
        manifest.name === 'app'
          ? 'deploy.json'
          : `deploy-${manifest.name}.json`,
      validate: validateManifestFileName,
    }));
  const fullSavePath = resolve(workDir, saveFile);
  if (existsSync(fullSavePath)) {
    const overwrite = await askConfirm({
      label: ct(
        `目标文件 ${saveFile} 已存在, 是否覆盖?`,
        `File ${saveFile} already exists. Overwrite?`,
      ),
      summaryLabel: ct('覆盖已有清单', 'Overwrite Manifest'),
      yesLabel: ct('覆盖', 'Overwrite'),
      noLabel: ct('保留原文件', 'Keep Existing'),
      defaultYes: false,
    });
    if (!overwrite) {
      printAlert(
        'warn',
        ct(
          `已保留既有文件 ${fullSavePath}, 跳过写入清单`,
          `Kept existing file ${fullSavePath}; skipped writing manifest`,
        ),
      );
      return;
    }
  }
  const parentDir = dirname(fullSavePath);
  mkdirSync(parentDir, { recursive: true });
  if (existsSync(join(parentDir, 'deploy.schema.json'))) {
    manifest.$schema = './deploy.schema.json';
  }
  writeFileSync(fullSavePath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
};

export const runWizard = async (
  workDir: string,
  targetManifestPath?: string,
  dryRun = false,
): Promise<DeployManifest> => {
  if (targetManifestPath !== undefined) {
    const pathErr = validateManifestFileName(targetManifestPath);
    if (pathErr) {
      throw new ConfigError(
        ct(
          `目标清单路径「${targetManifestPath}」不合法: ${pathErr}`,
          `Invalid manifest path '${targetManifestPath}': ${pathErr}`,
        ),
      );
    }
  }

  try {
    printHeader(
      ct('MongoDB 部署配置向导', 'MongoDB Provisioning Wizard'),
      ct(
        '按提示回答 4 组简单问题, 自动为你生成调优好的数据库安装包 (无需背诵复杂参数)。',
        'Answer 4 guided steps to generate a production-tuned MongoDB 9.0 deployment bundle.',
      ),
    );

    printSection(
      '1 / 4',
      ct('选择部署方式与项目名称', 'Deployment Topology & Instance Name'),
      ct(
        '决定把数据库装在单台服务器、三台服务器还是 Kubernetes 集群里',
        'Choose single-host Podman, 3-node replica set, or Kubernetes Helm deployment',
      ),
    );

    const mode = await selectOption<DeployMode>({
      label: ct(
        '你准备怎样部署这套 MongoDB?',
        'How will this MongoDB instance be deployed?',
      ),
      summaryLabel: ct('部署方式', 'Topology'),
      options: [
        {
          label: ct('单机部署 (Podman)', 'Single Host (Podman)'),
          badge: ct('新手推荐', 'Recommended'),
          hint: ct(
            '只需 1 台 Linux 或 Mac 服务器, 已自动开启多表事务与定时备份, 适合绝大多数中小型项目',
            '1 Linux or macOS server with single-node replica set transactions & scheduled backups',
          ),
          value: 'single',
        },
        {
          label: ct(
            '三机高可用集群 (Podman)',
            '3-Node High Availability (Podman)',
          ),
          hint: ct(
            '装在 3 台独立服务器上 (1 主 2 从实时同步), 坏掉 1 台机器业务也不会中断',
            '3 dedicated hosts (1 primary + 2 secondaries) with automatic failover',
          ),
          value: 'replica-set',
        },
        {
          label: ct(
            'Kubernetes 单节点 (Helm)',
            'Kubernetes Single Node (Helm)',
          ),
          hint: ct(
            '部署到现有的 K8s 集群中 (1 个数据库 Pod + 云盘持久化), 适合测试或轻量服务',
            '1 StatefulSet pod with persistent volume claim on an existing K8s cluster',
          ),
          value: 'k8s-single',
        },
        {
          label: ct(
            'Kubernetes 三节点高可用 (Helm)',
            'Kubernetes 3-Node HA (Helm)',
          ),
          hint: ct(
            '在 K8s 集群中启动 1 主 2 从共 3 个副本, 节点故障时自动切换主库不断线',
            '3 StatefulSet replicas with anti-affinity and automatic primary election',
          ),
          value: 'k8s-rs',
        },
      ],
    });

    const name = await askText({
      label: ct('给这套数据库起个简短的项目名', 'Short instance name?'),
      summaryLabel: ct('实例名称', 'Instance Name'),
      hint: ct(
        '合规 DNS 标签: 小写英文字母、数字和中间短横线 - (首尾不能是 -, 例如 app 或 my-shop)',
        'DNS label: lowercase letters, digits, and interior hyphens (e.g. app or my-shop)',
      ),
      defaultVal: 'app',
      validate: (v) =>
        DNS_LABEL_RE.test(v) && v.length <= 32
          ? null
          : ct(
              '须为合规 DNS 标签: 小写字母、数字和中间短横线 -, 长度 <= 32 (正确示例: app 或 my-shop)',
              'Must be a valid DNS label (lowercase alphanumeric & interior hyphens, <= 32 chars)',
            ),
    });

    const recommendedPort = recommendSafePort();
    const recommendedPortRoot = digitalRoot(recommendedPort);
    const port = Number(
      await askText({
        label: ct('数据库监听哪个端口?', 'MongoDB listen port?'),
        summaryLabel: ct('服务端口', 'Listen Port'),
        hint: ct(
          `已随机推荐数根 ${recommendedPortRoot} 的 5 位安全端口 ${recommendedPort} (直接回车采纳; 常规默认端口 27117, 避开扫描器常扫的 27017)`,
          `Recommended safe 5-digit port ${recommendedPort} (digital root ${recommendedPortRoot}, avoids scanned 27017)`,
        ),
        defaultVal: String(recommendedPort),
        validate: (v) =>
          Number.isInteger(Number(v)) && Number(v) >= 1024 && Number(v) <= 65535
            ? null
            : ct(
                '请输入 1024 到 65535 之间的整数端口号 (可直接回车采纳推荐端口, 或填常规默认 27117)',
                'Enter an integer port between 1024 and 65535 (e.g. 27117)',
              ),
      }),
    );

    printSection(
      '2 / 4',
      ct('选择服务器硬件规格', 'Server Hardware Sizing'),
      ct(
        '告诉向导目标机器大概有多大, 系统会自动算出最稳妥的缓存大小与连接上限, 避免内存爆满',
        'Automatically derives safe WiredTiger cache, connection ceiling, and compression settings',
      ),
    );
    const hardware = await collectHardware();
    const preview = computeSizing(hardware);
    printFormulaCard(preview.hardwareSummary, preview.steps);
    console.log('');

    printSection(
      '3 / 4',
      ct('创建业务数据库与专属账号', 'Application Databases & Accounts'),
      ct(
        '每个业务库拥有独立账号 (互不越权), 24 位高强度随机密码会自动生成并保存在本地文件中',
        'Each database gets an isolated user with a generated 24-character random password',
      ),
    );
    const appsRaw = await askText({
      label: ct(
        '要创建哪些数据库和登录账号?',
        'Databases and users to provision?',
      ),
      summaryLabel: ct('业务库与账号', 'Databases'),
      hint: ct(
        '写法是「数据库名:账号名」, 直接回车创建 app:app; 多个库用英文逗号隔开, 比如 orders:orderapp,users:userapp',
        'Format: db:user (comma-separated for multiple, e.g. orders:orderapp,users:userapp)',
      ),
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
      mode.startsWith('k8s')
        ? ct('填写 Kubernetes 部署位置', 'Kubernetes Placement')
        : ct('填写目标服务器信息', 'Target Server Details'),
      mode.startsWith('k8s')
        ? ct(
            '指定部署到集群中的哪个命名空间与存储类型',
            'Select target namespace and persistent volume StorageClass',
          )
        : ct(
            '填好目标服务器的系统与备份存放目录, 系统会自动在目录名后附带唯一指纹防止重名冲突',
            'Configure target OS, bind IP, and collision-free fingerprinted backup path',
          ),
    );

    const manifest: DeployManifest = { mode, name, port, hardware, apps };
    if (mode === 'single' || mode === 'replica-set') {
      manifest.nodes = await collectPodmanNodes(mode, name);
    } else {
      manifest.k8s = await collectK8sConfig(mode);
    }

    await maybeSaveManifest(manifest, workDir, targetManifestPath, dryRun);
    return manifest;
  } finally {
    closeSharedLineReader();
  }
};
