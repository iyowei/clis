/**
 * 交互式 MongoDB 部署配置向导主编排 (4 步引导 + --dry-run 跳过落盘 + 覆写确认 + 自动建父目录)。
 */
import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';

import {
  type AppInput,
  ConfigError,
  DNS_LABEL_RE,
  type DeployManifest,
  type DeployMode,
  computeSizing,
} from '@iyowei/codd';

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

/** 校验待保存 JSON 清单路径合法性 (要求有非空主名并以 .json 结尾, 拒绝 .json 无主名) */
export const validateManifestFileName = (raw: string): string | null => {
  const trimmed = raw.trim();
  if (!trimmed || /[\\:*?"<>|]/.test(trimmed)) {
    return '文件名须以 .json 结尾且不含非法路径字符 (例如 deploy.json 或 deploy-prod.json)';
  }
  const base = basename(trimmed);
  if (!base.endsWith('.json')) {
    return '文件名须以 .json 结尾 (例如 deploy.json 或 deploy-prod.json)';
  }
  const stem = base.slice(0, -'.json'.length).trim();
  if (stem.length === 0 || stem === '.' || stem === '..') {
    return '文件名必须包含有效主名, 不能仅为 .json (例如 deploy.json)';
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
      '--dry-run 预览模式: 已跳过保存 JSON 配置清单 (不会写入磁盘)',
    );
    return;
  }

  const saveManifest = await askConfirm({
    label: '要把刚才选好的配置保存成 JSON 清单文件吗?',
    summaryLabel: '保存配置清单',
    hint: '保存后可在同一目录并存多份配置, 日后运行 codd <文件名> 即可一键重新生成、增库或升配',
    yesLabel: '保存以便日后修改',
    noLabel: '只生成一次不保存',
    defaultYes: true,
  });
  if (!saveManifest) return;

  if (targetManifestPath !== undefined) {
    const pathErr = validateManifestFileName(targetManifestPath);
    if (pathErr) {
      throw new ConfigError(
        `目标清单路径「${targetManifestPath}」不合法: ${pathErr}`,
      );
    }
  }

  const saveFile =
    targetManifestPath ??
    (await askText({
      label: '保存为哪个 JSON 文件名?',
      summaryLabel: '配置文件路径',
      hint: '可并存多份不同环境的清单 (如 deploy-dev.json, configs/prod.json), 按 Tab 可基于默认名修改',
      defaultVal:
        manifest.name === 'app'
          ? 'deploy.json'
          : `deploy-${manifest.name}.json`,
      validate: validateManifestFileName,
    }));
  const fullSavePath = resolve(workDir, saveFile);
  if (existsSync(fullSavePath)) {
    const overwrite = await askConfirm({
      label: `目标文件 ${saveFile} 已存在, 是否覆盖?`,
      summaryLabel: '覆盖已有清单',
      yesLabel: '覆盖',
      noLabel: '保留原文件',
      defaultYes: false,
    });
    if (!overwrite) {
      printAlert('warn', `已保留既有文件 ${fullSavePath}, 跳过写入清单`);
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
        `目标清单路径「${targetManifestPath}」不合法: ${pathErr}`,
      );
    }
  }

  try {
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
      hint: '合规 DNS 标签: 小写英文字母、数字和中间短横线 - (首尾不能是 -, 例如 app 或 my-shop)',
      defaultVal: 'app',
      validate: (v) =>
        DNS_LABEL_RE.test(v) && v.length <= 32
          ? null
          : '须为合规 DNS 标签: 小写字母、数字和中间短横线 -, 长度 <= 32 (正确示例: app 或 my-shop)',
    });

    const port = Number(
      await askText({
        label: '数据库监听哪个端口?',
        summaryLabel: '服务端口',
        hint: '默认 27117 避开扫描器常扫的 27017, 一般直接回车即可',
        defaultVal: '27117',
        validate: (v) =>
          Number.isInteger(Number(v)) && Number(v) >= 1024 && Number(v) <= 65535
            ? null
            : '请输入 1024 到 65535 之间的整数端口号 (推荐使用默认的 27117)',
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
      hint: '写法是「数据库名:账号名」, 直接回车创建 app:app; 多个库用英文逗号隔开, 比如 orders:orderapp,users:userapp',
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
        ? '填写 Kubernetes 部署位置'
        : '填写目标服务器信息',
      mode.startsWith('k8s')
        ? '指定部署到集群中的哪个命名空间与存储类型'
        : '填好目标服务器的系统与备份存放目录, 系统会自动在目录名后附带唯一指纹防止重名冲突',
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
