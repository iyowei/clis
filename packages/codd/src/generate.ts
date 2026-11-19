/**
 * 部署包生成主编排器:
 * 模板从包内资产目录读取 (assets/template/), 而配置文件、dist/ 与 .codd-state/ 相对用户当前工作目录解析。
 */
import { existsSync, mkdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import { readTemplateFile, resolveTemplateRoot } from './assets.ts';
import { emitK8sBundle } from './emit-k8s.ts';
import { emitPodmanBundles } from './emit-podman.ts';
import { type HardwareSpec, computeSizing } from './formulas.ts';
import { resolveServerBackupDir } from './ssh.ts';
import {
  loadOrUpdateState,
  prepareStateDir,
  writeSecretFile,
} from './state.ts';
import {
  ConfigError,
  type DeployManifest,
  type GenerateOptions,
  type GenerateResult,
  type RotateMode,
} from './types.ts';
import { assertBunEngineCompatible, validateManifest } from './validate.ts';

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
      `找不到清单文件 ${manifestPath}, 请运行 codd wizard 打开交互式向导或执行 codd --init-schema 导出模板`,
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

export const generateBundle = (
  options: GenerateOptions = {},
): GenerateResult => {
  const workDir = resolve(options.workDir ?? options.rootDir ?? process.cwd());
  const templateRoot = resolveTemplateRoot(options.templateDir);

  const podmanTplDir = join(templateRoot, 'podman');
  const toolsMeta = JSON.parse(
    readTemplateFile(podmanTplDir, 'tools.package.json'),
  ) as {
    engines?: { bun?: string };
  };
  assertBunEngineCompatible(toolsMeta.engines?.bun);

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

  const state = loadOrUpdateState(
    stateFile,
    manifest,
    rotate,
    Boolean(options.newFingerprint),
  );

  const stackPrefix = manifest.stackPrefix ?? 'mongo';
  const port = manifest.port ?? 27117;
  const bundleDirs: string[] = [];
  const backupDirs: string[] = [];
  const nextSteps: string[] = [];

  const credLines: string[] = [
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

  if (manifest.mode === 'single' || manifest.mode === 'replica-set') {
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
          state.fingerprint,
          nodeSuffix,
        ),
      );
    }
  }

  if (options.dryRun) {
    return {
      deployId,
      mode: manifest.mode,
      fingerprint: state.fingerprint,
      sizing,
      bundleDirs: [],
      backupDirs,
      stateFile,
      credentialsFile,
      warnings,
      nextSteps: ['--dry-run 校验与公式测算通过, 未写出文件'],
    };
  }

  mkdirSync(outDir, { recursive: true });
  prepareStateDir(stateDir);

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

  writeSecretFile(stateFile, `${JSON.stringify(state, null, 2)}\n`, 0o600);
  writeSecretFile(credentialsFile, `${credLines.join('\n')}\n`, 0o600);

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
};
