/**
 * 独立脚本安装 (`standalone` origin) 自更新执行流程:
 * 查询 tarball 元数据 -> 下载并校验 SRI/SHA-1 -> 沙箱临时目录安全解包 ->
 * 补装声明的运行时 dependencies (如 create-clis 的 prettier) -> 写回安装标记 -> 原子替换回滚。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { type Locale, t } from '@iyowei/cli-i18n';

import { type UpdateOptions } from './args.ts';
import {
  type InstallOrigin,
  STANDALONE_MARKER_FILE,
  type StandaloneInstallMarker,
  isWithinDir,
  joinForPath,
} from './detect.ts';
import {
  type SpawnLike,
  buildIsolatedEnv,
  defaultIsFile,
  resolveExecutableInPath,
  resolvePmInvocation,
} from './exec-core.ts';
import {
  DEFAULT_REGISTRY,
  normalizeRegistryUrl,
  resolveRegistryAuthToken,
} from './registry.ts';
import { type UpdateSpinner } from './spinner.ts';
import {
  readExtractedPackageJson,
  removeDirBestEffort,
  renameWithRetry,
} from './standalone-marker.ts';
import {
  downloadAndVerifyTarball,
  extractNpmTarball,
  fetchTarballMetadata,
  verifyExtractedCliBundle,
} from './tarball.ts';
import {
  type ColorChannels,
  type UpdateUi,
  extractRegistryHost,
  formatElapsedMs,
  paint,
  sanitizeMultilineTail,
} from './ui.ts';
import { type UpgradeFlowDeps } from './update-flow.ts';
import {
  type PackageMetaRef,
  type UpdateIORef,
  formatVersionLabel,
  sanitize,
} from './update-helpers.ts';

export interface PerformStandaloneUpgradeContext {
  binName: string;
  meta: PackageMetaRef;
  origin: Extract<InstallOrigin, { kind: 'standalone' }>;
  targetVersion: string;
  registry: string;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
  locale: Locale;
}

function resolveDependencyInstaller(input: {
  origin: Extract<InstallOrigin, { kind: 'standalone' }>;
  explicitRegistry?: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  isFile: (path: string) => boolean;
}): {
  label: 'bun' | 'npm';
  command: string;
  args: string[];
  windowsVerbatimArguments?: boolean;
} | null {
  const regFlag =
    input.explicitRegistry !== undefined
      ? [`--registry=${normalizeRegistryUrl(input.explicitRegistry)}`]
      : [];
  const bunArgs = [
    'install',
    '--production',
    '--ignore-scripts',
    '--no-save',
    '--no-cache',
    ...regFlag,
  ];
  const bunExe = input.platform === 'win32' ? 'bun.exe' : 'bun';
  const isolatedBun = joinForPath(input.origin.runtimeDir, bunExe);
  if (input.isFile(isolatedBun)) {
    return { label: 'bun', command: isolatedBun, args: bunArgs };
  }

  const pathBun = resolveExecutableInPath(
    'bun',
    input.platform,
    input.env,
    input.isFile,
  );
  if (pathBun !== null) {
    return { label: 'bun', command: pathBun.path, args: bunArgs };
  }

  const npmInv = resolvePmInvocation(
    'npm',
    [
      'install',
      '--omit=dev',
      '--ignore-scripts',
      '--no-audit',
      '--no-fund',
      ...regFlag,
    ],
    input.platform,
    input.env,
    input.isFile,
  );
  if (npmInv !== null) {
    return {
      label: 'npm',
      command: npmInv.command,
      args: npmInv.args,
      windowsVerbatimArguments: npmInv.windowsVerbatimArguments,
    };
  }
  return null;
}

function installStagingDependencies(input: {
  stagingDir: string;
  origin: Extract<InstallOrigin, { kind: 'standalone' }>;
  registry: string;
  opts: UpdateOptions;
  deps: UpgradeFlowDeps;
  io: UpdateIORef;
  ui: UpdateUi;
  locale: Locale;
}): boolean {
  const platform = input.deps.platform ?? process.platform;
  const env = input.deps.env ?? process.env;
  const isFile = input.deps.isFile ?? defaultIsFile;
  const normalizedReg = normalizeRegistryUrl(input.registry);
  const effectiveRegistry =
    input.opts.registry ??
    (normalizedReg !== DEFAULT_REGISTRY ? normalizedReg : undefined);
  const plan = resolveDependencyInstaller({
    origin: input.origin,
    explicitRegistry: effectiveRegistry,
    platform,
    env,
    isFile,
  });

  if (plan === null) {
    input.io.err(
      input.ui.error(
        t(
          input.locale,
          '新版本包含运行时依赖, 但未找到隔离 Bun、系统 Bun 或 npm 来安装依赖',
          'The new version declares runtime dependencies, but neither Bun nor npm was found to install them',
        ),
      ),
    );
    return false;
  }

  const spawnFn: SpawnLike =
    input.deps.spawnFn ??
    ((cmd, args, opts) =>
      spawnSync(cmd, args, {
        ...opts,
        encoding: 'utf8',
      }));
  const child = spawnFn(plan.command, plan.args, {
    cwd: input.stagingDir,
    env: buildIsolatedEnv(env),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    timeout: 60_000,
    windowsVerbatimArguments: plan.windowsVerbatimArguments,
  });

  if (child.error !== undefined || child.status !== 0) {
    const errMsg =
      child.error !== undefined
        ? child.error.message
        : `exit status ${child.status ?? 'unknown'}`;
    input.io.err(
      input.ui.error(
        t(
          input.locale,
          `安装新版本运行时依赖失败 (${plan.label}: ${sanitize(errMsg)})`,
          `Failed to install runtime dependencies (${plan.label}: ${sanitize(errMsg)})`,
        ),
      ),
    );
    const combined = `${child.stdout ?? ''}\n${child.stderr ?? ''}`.trim();
    if (combined !== '') {
      const tail = sanitizeMultilineTail(combined);
      for (const line of tail.lines) {
        input.io.err(input.ui.errorLogLine(line));
      }
    }
    return false;
  }
  return true;
}

/** 执行独立脚本安装方式的原生 tarball 在线升级并原子切换目录 */
export async function performStandaloneUpgrade(
  ctx: PerformStandaloneUpgradeContext,
): Promise<number> {
  const {
    meta,
    origin,
    targetVersion,
    registry,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
    locale,
  } = ctx;
  const startedAt = Date.now();
  const targetLabel = formatVersionLabel(sanitize(targetVersion));
  const regHost = extractRegistryHost(registry);
  const authToken = resolveRegistryAuthToken({
    packageName: meta.name,
    registry,
    env: deps.env,
    homeDir: deps.homeDir,
    readText: deps.readText,
  });

  spinner.start(
    t(
      locale,
      `正在下载 ${sanitize(meta.name)} ${targetLabel}`,
      `Downloading ${sanitize(meta.name)} ${targetLabel}`,
    ),
    regHost,
  );

  let stagingDir: string | undefined;
  let backupDir: string | undefined;
  try {
    const metaRes = await fetchTarballMetadata({
      packageName: meta.name,
      targetSpec: targetVersion,
      registry,
      authToken,
      fetchFn: deps.fetchFn,
      locale,
    });
    if (!metaRes.ok) {
      spinner.stop();
      io.err(ui.error(sanitize(metaRes.message)));
      return 1;
    }

    const dlRes = await downloadAndVerifyTarball({
      tarballUrl: metaRes.tarballUrl,
      integrity: metaRes.integrity,
      shasum: metaRes.shasum,
      authToken,
      expectedRegistryBase: metaRes.registry,
      fetchFn: deps.fetchFn,
      locale,
    });
    if (!dlRes.ok) {
      spinner.stop();
      io.err(ui.error(sanitize(dlRes.message)));
      return 1;
    }

    const parentDir = dirname(meta.packageRoot);
    stagingDir = mkdtempSync(join(parentDir, `.clis-staging-${origin.tool}-`));
    extractNpmTarball(dlRes.bytes, stagingDir);

    const extractedPkg = readExtractedPackageJson(stagingDir);
    const bundleCheck =
      extractedPkg !== null && extractedPkg.name === meta.name
        ? verifyExtractedCliBundle(stagingDir, meta.name, extractedPkg.bin)
        : { ok: false as const, reason: 'package.json name mismatch' };
    if (!bundleCheck.ok) {
      spinner.stop();
      io.err(
        ui.error(
          t(
            locale,
            `下载的安装包结构或产物清单校验失败 (${sanitize(bundleCheck.reason)})`,
            `Downloaded package archive failed verification (${sanitize(bundleCheck.reason)})`,
          ),
        ),
      );
      return 1;
    }

    if (extractedPkg !== null && extractedPkg.dependencies !== undefined) {
      spinner.update(
        t(locale, '正在安装运行时依赖', 'Installing runtime dependencies'),
      );
      const depOk = installStagingDependencies({
        stagingDir,
        origin,
        registry: metaRes.registry,
        opts,
        deps,
        io,
        ui,
        locale,
      });
      if (!depOk) {
        spinner.stop();
        return 1;
      }
    }

    const nextMarker: StandaloneInstallMarker = {
      schemaVersion: 1,
      method: 'script',
      tool: origin.tool,
      packageName: origin.packageName,
      dataDir: origin.dataDir,
      appDir: origin.appDir,
      runtimeDir: origin.runtimeDir,
      binPath: origin.binPath,
      version: extractedPkg?.version ?? metaRes.version,
      updatedAt: new Date().toISOString(),
    };
    writeFileSync(
      join(stagingDir, STANDALONE_MARKER_FILE),
      `${JSON.stringify(nextMarker, null, 2)}\n`,
      'utf8',
    );

    if (isWithinDir(process.cwd(), meta.packageRoot)) {
      try {
        process.chdir(tmpdir());
      } catch {
        // 忽略无权限切换目录的极端场景
      }
    }

    backupDir = join(
      parentDir,
      `.clis-backup-${origin.tool}-${process.pid}-${Date.now()}`,
    );
    renameWithRetry(meta.packageRoot, backupDir);
    try {
      renameWithRetry(stagingDir, meta.packageRoot);
    } catch (swapError) {
      try {
        renameWithRetry(backupDir, meta.packageRoot);
      } catch {
        // 回滚失败交由外层错误信息暴露
      }
      throw swapError;
    }
    removeDirBestEffort(backupDir);
    spinner.stop();

    const finalVer = extractedPkg?.version ?? metaRes.version;
    const elapsed = formatElapsedMs(Date.now() - startedAt);
    io.out(
      ui.success(
        t(
          locale,
          `升级完成: ${sanitize(meta.name)} 已切换至 ${paint(formatVersionLabel(sanitize(finalVer)), '1;32', color.stdout)} ${paint('(独立脚本安装)', '2', color.stdout)}`,
          `Upgraded ${sanitize(meta.name)} to ${paint(formatVersionLabel(sanitize(finalVer)), '1;32', color.stdout)} ${paint('(standalone)', '2', color.stdout)}`,
        ),
        elapsed,
      ),
    );
    return 0;
  } catch (error) {
    spinner.stop();
    const msg = error instanceof Error ? error.message : String(error);
    io.err(
      ui.error(
        t(
          locale,
          `独立安装更新失败: ${sanitize(msg)}`,
          `Standalone upgrade failed: ${sanitize(msg)}`,
        ),
      ),
    );
    if ((deps.platform ?? process.platform) === 'win32') {
      io.err(
        ui.errorHint(
          t(
            locale,
            `Windows 提示: 若应用目录被其他正在运行的 ${sanitize(ctx.binName)} 终端或安全软件占用 (EBUSY / EPERM), 请关闭其他占用终端后重试或重新运行一键安装脚本。`,
            `Windows note: If the app directory is locked (EBUSY / EPERM) by another running '${sanitize(ctx.binName)}' process, close active terminals and retry or re-run the install script.`,
          ),
        ),
      );
    }
    return 1;
  } finally {
    if (stagingDir !== undefined && existsSync(stagingDir)) {
      removeDirBestEffort(stagingDir);
    }
  }
}
