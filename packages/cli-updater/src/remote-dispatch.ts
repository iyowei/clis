/**
 * `runSelfUpdate` 远端版本查询失败与版本比较分发逻辑 (中英双语)。
 */
import { type Locale, t } from '@iyowei/cli-i18n';

import { type UpdateOptions } from './args.ts';
import { type InstallOrigin, type PackageManager } from './detect.ts';
import { formatUpgradeDisplayCommand } from './executor.ts';
import { type FetchVersionResult } from './registry.ts';
import { compareSemver } from './semver.ts';
import { type UpdateSpinner } from './spinner.ts';
import { type ColorChannels, type UpdateUi, paint } from './ui.ts';
import { type UpgradeFlowDeps, performUpgrade } from './update-flow.ts';
import {
  type PackageMetaRef,
  type UpdateIORef,
  formatVersionLabel,
  sanitize,
} from './update-helpers.ts';

export async function handleFetchFailure(ctx: {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager | undefined;
  registry: string;
  remote: Extract<FetchVersionResult, { ok: false }>;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
  locale: Locale;
}): Promise<number> {
  const {
    binName,
    meta,
    origin,
    targetPm,
    registry,
    remote,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
    locale,
  } = ctx;

  if (opts.force && !opts.check && targetPm !== undefined) {
    io.err(
      ui.error(
        t(
          locale,
          `警示: 远端版本查询失败 (${sanitize(remote.message)})`,
          `Warning: Version check failed (${sanitize(remote.message)})`,
        ),
      ),
    );
    io.out(
      ui.body(
        t(
          locale,
          `强制重装模式 (--force): 跳过远端版本校验, 将直接通过 ${targetPm} 安装 ${sanitize(meta.name)}@latest`,
          `Force mode (--force): Skipping version check and installing ${sanitize(meta.name)}@latest via ${targetPm}`,
        ),
      ),
    );
    return await performUpgrade({
      binName,
      meta,
      origin,
      targetPm,
      targetSpec: 'latest',
      opts,
      io,
      color,
      ui,
      spinner,
      deps,
      locale,
    });
  }

  if (remote.code === 'not-found') {
    const privSuffix = meta.isPrivate
      ? t(locale, ' (当前包标记为 private)', ' (package is marked private)')
      : '';
    io.err(
      ui.error(
        t(
          locale,
          `${sanitize(meta.name)} 尚未在 ${sanitize(registry)} 发布 (HTTP 404), 无法在线更新${privSuffix}`,
          `${sanitize(meta.name)} is not published on ${sanitize(registry)} (HTTP 404)${privSuffix}`,
        ),
      ),
    );
    io.err(
      ui.errorHint(
        t(
          locale,
          '若已发布到私有源, 请加 --registry <url> 后重试',
          'If published to a private registry, pass --registry <url>',
        ),
      ),
    );
    return 1;
  }

  io.err(
    ui.error(
      t(
        locale,
        `检查最新版本失败: ${sanitize(remote.message)}`,
        `Failed to check latest version: ${sanitize(remote.message)}`,
      ),
    ),
  );
  if (remote.code === 'auth') {
    io.err(
      ui.errorHint(
        t(
          locale,
          '请先完成源登录或在 ~/.npmrc / ~/.bunfig.toml 配置同源访问 token, 或加 --force 直接委托包管理器安装',
          'Sign in to your registry, configure a token in ~/.npmrc or ~/.bunfig.toml, or pass --force',
        ),
      ),
    );
  }

  if (targetPm !== undefined) {
    const cmd = formatUpgradeDisplayCommand(
      targetPm,
      meta.name,
      'latest',
      opts.registry,
    );
    io.err(
      ui.errorHint(
        t(
          locale,
          `可稍后重试或手动执行: ${cmd}`,
          `Retry later or run manually: ${cmd}`,
        ),
      ),
    );
  }
  return 1;
}

export async function dispatchRemoteVersion(ctx: {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager | undefined;
  remote: Extract<FetchVersionResult, { ok: true }>;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
  locale: Locale;
}): Promise<number> {
  const {
    binName,
    meta,
    origin,
    targetPm,
    remote,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
    locale,
  } = ctx;

  const cmp = compareSemver(meta.version, remote.version);
  if (cmp === null && !opts.force) {
    io.out(
      ui.body(
        t(
          locale,
          `版本比较: 当前版本 (${sanitize(meta.version)}) 与远端版本 (${sanitize(remote.version)}, 源: ${sanitize(remote.registry)}) 无法按标准 SemVer 比较, 未自动覆盖。`,
          `Version check: Current (${sanitize(meta.version)}) and remote (${sanitize(remote.version)}, ${sanitize(remote.registry)}) cannot be compared as standard SemVer; skipped.`,
        ),
      ),
    );
    io.out(
      ui.hint(
        t(
          locale,
          `  若确认需要安装远端版本, 请加 --force 重试 (例如: ${sanitize(binName)} update --force)`,
          `  Pass --force to install anyway (e.g. ${sanitize(binName)} update --force)`,
        ),
      ),
    );
    return 0;
  }

  const hasUpdate = cmp === -1;
  if (!hasUpdate && !opts.force) {
    const safeVer = sanitize(meta.version);
    const safeRemote = sanitize(remote.version);
    const safeReg = sanitize(remote.registry);
    io.out(
      ui.success(
        t(
          locale,
          `已是最新版本: ${paint(`v${safeVer}`, '1', color.stdout)}`,
          `Already up to date: ${paint(`v${safeVer}`, '1', color.stdout)}`,
        ),
        t(
          locale,
          `(远端最新 v${safeRemote}, 源: ${safeReg})`,
          `(latest v${safeRemote} · ${safeReg})`,
        ),
      ),
    );
    return 0;
  }

  if (hasUpdate) {
    io.out(ui.foundUpdate(meta.version, remote.version, remote.registry));
  } else {
    io.out(
      ui.body(
        t(
          locale,
          `强制重装模式 (--force): 将重新安装 ${paint(formatVersionLabel(sanitize(remote.version)), '1;36', color.stdout)} ${paint(`(源: ${sanitize(remote.registry)})`, '2', color.stdout)}`,
          `Force mode (--force): Reinstalling ${paint(formatVersionLabel(sanitize(remote.version)), '1;36', color.stdout)} ${paint(`(${sanitize(remote.registry)})`, '2', color.stdout)}`,
        ),
      ),
    );
  }

  if (opts.check) {
    if (targetPm !== undefined) {
      const cmd = formatUpgradeDisplayCommand(
        targetPm,
        meta.name,
        remote.version,
        opts.registry,
      );
      io.out(
        ui.hint(
          t(
            locale,
            `运行 ${sanitize(binName)} update 即可升级 (将执行: ${sanitize(cmd)})`,
            `Run '${sanitize(binName)} update' to upgrade (${sanitize(cmd)})`,
          ),
        ),
      );
    } else {
      io.out(
        ui.hint(
          t(
            locale,
            `未能自动识别安装器, 升级请运行: ${sanitize(binName)} update --pm <bun|npm|pnpm|yarn|volta>`,
            `Package manager could not be auto-detected; upgrade with: ${sanitize(binName)} update --pm <bun|npm|pnpm|yarn|volta>`,
          ),
        ),
      );
    }
    return 0;
  }

  if (targetPm === undefined) {
    io.err(
      ui.error(
        t(
          locale,
          '未能自动确认安装本命令的包管理器, 为避免在 PATH 中装出重复版本已停止自动执行',
          'Could not auto-detect the package manager that installed this CLI; aborted to avoid duplicate copies in PATH',
        ),
      ),
    );
    io.err(
      ui.errorHint(
        t(
          locale,
          `请使用 --pm 显式指定你的包管理器后重试, 例如: ${sanitize(binName)} update --pm bun`,
          `Specify your package manager explicitly, e.g.: ${sanitize(binName)} update --pm bun`,
        ),
      ),
    );
    return 1;
  }

  return await performUpgrade({
    binName,
    meta,
    origin,
    targetPm,
    targetSpec: remote.version,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
    locale,
  });
}
