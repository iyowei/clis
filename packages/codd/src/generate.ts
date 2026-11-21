/**
 * `@iyowei/codd` 部署包生成主编排器: 上游供 `@iyowei/codd-cli` 与编程式调用,
 * 下游依次编排 `validate.ts` -> `formulas.ts` -> `state.ts` -> `emit-podman.ts` / `emit-k8s.ts`。
 *
 * 路径与写盘约束: 内置模板相对包根解析 (`assets/template/`), 而清单、`dist/` 与 `.codd-state/`
 * 相对 `workDir` 解析; 缺省 `hardware` 回退 2C/2G/32G 并记告警; `dryRun` 不加锁不写盘,
 * 正式生成在 `withStateLock` 排他锁内执行并以 `0600` 原子写状态与凭证文件。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { resolveTemplateRoot } from './assets.ts';
import { emitK8sBundle } from './emit-k8s.ts';
import { emitPodmanBundles } from './emit-podman.ts';
import { type HardwareSpec, computeSizing } from './formulas.ts';
import { resolveServerBackupDir } from './ssh.ts';
import {
  loadOrUpdateState,
  prepareStateDir,
  withStateLock,
  writeSecretFile,
} from './state.ts';
import {
  ConfigError,
  type DeployManifest,
  type GenerateOptions,
  type GenerateResult,
  type GenerateState,
  type RotateMode,
} from './types.ts';
import { validateManifest } from './validate.ts';

const DEFAULT_HARDWARE: HardwareSpec = {
  cpuCores: 2,
  memoryGb: 2,
  diskGb: 32,
  workload: 'balanced',
};

const loadManifestInput = (
  workDir: string,
  options: GenerateOptions,
): DeployManifest => {
  if (options.manifest) {
    return options.manifest;
  }
  const manifestPath = resolve(workDir, options.manifestPath ?? 'deploy.json');
  if (!existsSync(manifestPath)) {
    throw new ConfigError(
      `找不到清单文件 ${manifestPath}, 请运行 codd wizard 打开交互式向导、执行 codd init 导出模板, 或通过 manifest 选项直接传入清单对象`,
    );
  }
  try {
    return JSON.parse(readFileSync(manifestPath, 'utf8')) as DeployManifest;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `解析 JSON 清单文件失败 (${manifestPath}): ${detail}`,
    );
  }
};

const buildBackupDirs = (
  manifest: DeployManifest,
  stackPrefix: string,
  fingerprint: string,
): string[] => {
  const backupDirs: string[] = [];
  if (manifest.mode !== 'single' && manifest.mode !== 'replica-set') {
    return backupDirs;
  }
  const nodes = manifest.nodes!;
  for (let i = 0; i < nodes.length; i += 1) {
    const n = nodes[i]!;
    const fallbackName = manifest.mode === 'single' ? 'main' : `node${i + 1}`;
    const nodeName = n.name || fallbackName;
    const nodeSuffix = manifest.mode === 'replica-set' ? nodeName : undefined;
    backupDirs.push(
      resolveServerBackupDir(
        n.backupDir,
        stackPrefix,
        manifest.name,
        fingerprint,
        nodeSuffix,
      ),
    );
  }
  return backupDirs;
};

const buildBaseCredLines = (
  deployId: string,
  port: number,
  sizing: ReturnType<typeof computeSizing>,
  manifest: DeployManifest,
  state: GenerateState,
): string[] => [
  `# Codd 生成凭证 (${deployId})`,
  `HARDWARE=${sizing.hardwareSummary}`,
  `FORMULAS=${sizing.formulaSummary}`,
  `FINGERPRINT=${state.fingerprint}`,
  `PORT=${port}`,
  `ROOT_USER=${state.rootUsername}`,
  `ROOT_PASSWORD=${state.rootPassword}`,
  `BACKUP_USER=${state.backupUsername}`,
  `BACKUP_PASSWORD=${state.backupPassword}`,
  '',
  '# 各业务库账号与密码:',
  ...manifest.apps.map(
    (a) => `- ${a.db}: user=${a.user} password=${state.appPasswords[a.db]}`,
  ),
  '',
];

/**
 * 执行完整部署包生成 (或 `--dry-run` 校验与公式测算), 返回汇总结果 `GenerateResult`。
 *
 * ### 数据流转示例
 * ```text
 * Input:  options = { workDir: '/work', manifestPath: 'deploy.json', outDir: 'dist', rotate: 'none' }
 * Step 1: 解析模板根 -> 读取 deploy.json -> validateManifest 校验 -> computeSizing 推导硬件参数
 * Step 2: 若 dryRun=true, 纯内存合并状态并返回预览结果 (bundleDirs=[], 不写盘不加锁)
 * Step 3: prepareStateDir(.codd-state, 0700) -> withStateLock 加锁 -> loadOrUpdateState 合并指纹与凭证
 * Step 4: 按 mode 分流 emitPodmanBundles 或 emitK8sBundle -> 0600 原子写 state.json 与 credentials.txt
 * Output: GenerateResult { deployId, mode, fingerprint, sizing, bundleDirs, backupDirs, stateFile, credentialsFile, warnings, nextSteps }
 * ```
 */
export const generateBundle = (
  options: GenerateOptions = {},
): GenerateResult => {
  const workDir = resolve(options.workDir ?? options.rootDir ?? process.cwd());
  const resolvedTemplateOverride = options.templateDir
    ? resolve(workDir, options.templateDir)
    : undefined;
  const templateRoot = resolveTemplateRoot(resolvedTemplateOverride);
  const podmanTplDir = join(templateRoot, 'podman');

  const outDir = resolve(workDir, options.outDir ?? 'dist');
  const stateDir = resolve(workDir, options.stateDir ?? '.codd-state');
  const rotate: RotateMode = options.rotate ?? 'none';

  const manifest = loadManifestInput(workDir, options);
  const warnings = validateManifest(manifest);
  const hw = manifest.hardware ?? DEFAULT_HARDWARE;
  if (!manifest.hardware) {
    warnings.push(
      '未显式指定 hardware, 已采用通用 2C / 2G / 32G 起步基线推导参数',
    );
  }
  const sizing = computeSizing(hw);
  warnings.push(...sizing.warnings);

  const deployId = `${manifest.mode}-${manifest.name}`;
  const stateFile = join(stateDir, `${deployId}.state.json`);
  const credentialsFile = join(stateDir, `${deployId}.credentials.txt`);
  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const port = manifest.port ?? 27117;

  if (options.dryRun) {
    const hadPrevState = existsSync(stateFile);
    if (rotate === 'all' && hadPrevState) {
      warnings.push(
        '已启用 --rotate-all 重置管理员 root 密码与 keyFile, 若目标服务器已有运行中的数据库卷, 请勿直接重启覆盖, 应先在旧集群内完成改密或仅用于全新部署',
      );
    }
    const state = loadOrUpdateState(
      stateFile,
      manifest,
      rotate,
      Boolean(options.newFingerprint),
    );
    return {
      deployId,
      mode: manifest.mode,
      fingerprint: state.fingerprint,
      sizing,
      bundleDirs: [],
      backupDirs: buildBackupDirs(manifest, stackPrefix, state.fingerprint),
      stateFile,
      credentialsFile,
      warnings,
      nextSteps: ['--dry-run 校验与公式测算通过, 未写出文件'],
    };
  }

  mkdirSync(outDir, { recursive: true });
  prepareStateDir(stateDir);

  return withStateLock(stateFile, () => {
    const hadPrevState = existsSync(stateFile);
    if (rotate === 'all' && hadPrevState) {
      warnings.push(
        '已启用 --rotate-all 重置管理员 root 密码与 keyFile, 若目标服务器已有运行中的数据库卷, 请勿直接重启覆盖, 应先在旧集群内完成改密或仅用于全新部署',
      );
    }
    const state = loadOrUpdateState(
      stateFile,
      manifest,
      rotate,
      Boolean(options.newFingerprint),
    );
    const bundleDirs: string[] = [];
    const backupDirs = buildBackupDirs(
      manifest,
      stackPrefix,
      state.fingerprint,
    );
    const nextSteps: string[] = [];
    const credLines = buildBaseCredLines(
      deployId,
      port,
      sizing,
      manifest,
      state,
    );

    if (manifest.mode === 'single' || manifest.mode === 'replica-set') {
      emitPodmanBundles({
        podmanTplDir,
        outDir,
        deployId,
        manifest,
        hw,
        sizing,
        state,
        backupDirs,
        bundleDirs,
        credLines,
        nextSteps,
        warnings,
      });
    } else {
      emitK8sBundle({
        helmTplDir: join(templateRoot, 'helm'),
        outDir,
        deployId,
        manifest,
        sizing,
        state,
        bundleDirs,
        credLines,
        nextSteps,
      });
    }

    credLines.push(
      '',
      '# 传输压缩 (可选): 服务端已启用 snappy,zstd,zlib; 默认连接串省略 compressors 以兼容 Compass 与零依赖驱动',
      '# 如需开启压缩, 可在连接串末尾追加 &compressors=zlib (Compass/各语言原生内置) 或安装 @mongodb-js/zstd 后追加 &compressors=zstd',
    );
    writeSecretFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
    writeSecretFile(credentialsFile, `${credLines.join('\n')}\n`, 0o600);

    if (process.platform === 'win32') {
      warnings.push(
        '当前在 Windows 环境写出敏感凭证文件 (.env / .codd-state / create-secret.sh), POSIX 0600/0700 权限不会在 NTFS 上强制生效, 请通过 icacls 核查目录 ACL 仅限当前用户访问',
      );
    }

    return {
      deployId,
      mode: manifest.mode,
      fingerprint: state.fingerprint,
      sizing,
      bundleDirs,
      backupDirs,
      stateFile,
      credentialsFile,
      warnings,
      nextSteps,
    };
  });
};
