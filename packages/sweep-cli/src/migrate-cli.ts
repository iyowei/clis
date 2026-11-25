/**
 * 配置迁移 CLI 编排 (支持中英双语, 设计见 ADR 0024):
 * 红线: 写盘前强制创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份; 仅做 100% 无损等价升版。
 */
import { lstat } from 'node:fs/promises';
import { posix, win32 } from 'node:path';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type Config,
  type ResolvedConfigPath,
  applyMigration,
  detectMigration,
  loadResolvedConfig,
  sanitizeLine,
} from '@iyowei/sweep';

import { renderConfigSummary } from './config-summary.ts';
import { localizeSweepError } from './i18n-messages.ts';
import { type InitIO, createReadlineIO } from './init-io.ts';
import {
  bannerLine,
  inferPathStyle,
  neutralLine,
  shortenHome,
} from './render.ts';

export type MigrationFlowResult =
  | { state: 'none' }
  | {
      state: 'migrated';
      config: Config;
      excludeExplicit: boolean;
      backupPath: string;
    }
  | { state: 'cancelled' }
  | { state: 'error' };

export interface MigrationFlowOptions {
  resolved: ResolvedConfigPath;
  explicit: boolean;
  interactive: boolean;
  colors: { stdout: boolean; stderr: boolean };
  home: string;
  platform?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
  locale?: Locale;
  print(line: string): void;
  warn(line: string): void;
  notice(line: string): void;
  createIO?: (color: boolean) => InitIO;
  now?: () => Date;
}

async function targetExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

async function handleNoMigrationNeeded(
  options: MigrationFlowOptions,
  locale: Locale,
  style: ReturnType<typeof inferPathStyle>,
  banner: string,
): Promise<MigrationFlowResult> {
  const { resolved, explicit, colors, home, print, warn } = options;
  if (!explicit) return { state: 'none' };
  const exists = await targetExists(resolved.path);
  if (!exists && resolved.source !== 'platform-default') {
    warn(
      t(
        locale,
        `配置不存在 (${resolved.path}), 请检查路径`,
        `Configuration not found (${resolved.path}); please check the path`,
      ),
    );
    return { state: 'error' };
  }
  if (exists) {
    try {
      const loaded = await loadResolvedConfig(resolved, { homedir: home });
      if (loaded.state !== 'ok') {
        warn(
          t(
            locale,
            `配置文件无法加载 (${resolved.path})`,
            `Failed to load configuration (${resolved.path})`,
          ),
        );
        return { state: 'error' };
      }
    } catch (error) {
      warn(localizeSweepError(error, resolved.path, locale));
      return { state: 'error' };
    }
  }
  print(bannerLine(banner, colors.stdout));
  print(
    neutralLine(
      exists
        ? t(
            locale,
            `当前配置已是最新版 v2, 无需迁移 (${sanitizeLine(shortenHome(resolved.path, home, style))})`,
            `Configuration is already at v2 (${sanitizeLine(shortenHome(resolved.path, home, style))})`,
          )
        : t(
            locale,
            '未发现旧版配置, 无需迁移 (可运行 sweep init 或 sweep init --default 生成配置)',
            "No legacy configuration found (run 'sweep init' or 'sweep init --default')",
          ),
      colors.stdout,
    ),
  );
  return { state: 'none' };
}

async function runInteractiveMigration(
  options: MigrationFlowOptions,
  detected: Extract<
    Awaited<ReturnType<typeof detectMigration>>,
    { state: 'migratable' }
  >,
  locale: Locale,
  style: ReturnType<typeof inferPathStyle>,
  banner: string,
  migratedHeading: string,
): Promise<MigrationFlowResult> {
  const { colors, home, platform } = options;
  const io = (options.createIO ?? createReadlineIO)(colors.stdout);
  try {
    io.print(bannerLine(banner, colors.stdout));
    io.print(
      neutralLine(
        t(
          locale,
          '检测到旧版配置, 可 100% 无损等价升版到 v2:',
          'Legacy configuration detected; ready for lossless upgrade to v2:',
        ),
        colors.stdout,
      ),
    );
    if (detected.fromLegacyPath) {
      io.print(
        neutralLine(
          t(
            locale,
            `迁移来源: ${sanitizeLine(shortenHome(detected.sourcePath, home, style))}`,
            `Source: ${sanitizeLine(shortenHome(detected.sourcePath, home, style))}`,
          ),
          colors.stdout,
        ),
      );
      io.print(
        neutralLine(
          t(
            locale,
            `目标路径: ${sanitizeLine(shortenHome(detected.targetPath, home, style))}`,
            `Target: ${sanitizeLine(shortenHome(detected.targetPath, home, style))}`,
          ),
          colors.stdout,
        ),
      );
    } else {
      io.print(
        neutralLine(
          t(
            locale,
            `配置路径: ${sanitizeLine(shortenHome(detected.targetPath, home, style))}`,
            `Config: ${sanitizeLine(shortenHome(detected.targetPath, home, style))}`,
          ),
          colors.stdout,
        ),
      );
    }
    const rawBase =
      detected.sourcePath.includes('\\') ||
      /^[A-Za-z]:/.test(detected.sourcePath)
        ? win32.basename(detected.sourcePath)
        : posix.basename(detected.sourcePath);
    const backupBase = sanitizeLine(rawBase || 'config.json');
    io.print(
      neutralLine(
        t(
          locale,
          `写前备份: 将在源配置目录自动创建 ${backupBase}.YYYYMMDD_HHMMSS.modified`,
          `Backup: Creates ${backupBase}.YYYYMMDD_HHMMSS.modified before writing`,
        ),
        colors.stdout,
      ),
    );
    io.print(
      neutralLine(
        t(
          locale,
          '等价映射: 仅启用 node 预设, 严禁替用户自动激活新版新增预设',
          'Mapping: Enables node preset only; new presets stay opt-in',
        ),
        colors.stdout,
      ),
    );

    const confirmed = await io.confirm(
      t(locale, '确认执行配置迁移?', 'Proceed with migration?'),
      true,
    );
    if (!confirmed) {
      io.print(
        t(
          locale,
          '已取消, 未迁移配置',
          'Cancelled; configuration was not migrated',
        ),
      );
      return { state: 'cancelled' };
    }

    const applied = await applyMigration(detected, { now: options.now });
    const summaryLines = renderConfigSummary({
      configPath: applied.targetPath,
      config: applied.config,
      excludeExplicit: applied.excludeExplicit,
      heading: migratedHeading,
      backupPath: applied.backupPath,
      newAvailablePresets: applied.newAvailablePresets,
      home,
      platform,
      color: colors.stdout,
      locale,
    });
    for (const line of summaryLines) io.print(line);
    return {
      state: 'migrated',
      config: applied.config,
      excludeExplicit: applied.excludeExplicit,
      backupPath: applied.backupPath,
    };
  } finally {
    io.close?.();
  }
}

export async function runMigrationFlow(
  options: MigrationFlowOptions,
): Promise<MigrationFlowResult> {
  const {
    resolved,
    explicit,
    interactive,
    colors,
    home,
    platform,
    print,
    warn,
    notice,
  } = options;
  const locale = options.locale ?? 'zh';
  const style = inferPathStyle(home || resolved.path, platform);

  const detected = await detectMigration(resolved, {
    homedir: home,
    platform,
    env: options.env,
  });

  const banner = t(locale, '配置迁移', 'Config Migration');
  const migratedHeading = t(locale, '配置已迁移', 'Configuration migrated');

  if (detected.state === 'none') {
    return await handleNoMigrationNeeded(options, locale, style, banner);
  }

  if (detected.state === 'unsupported') {
    warn(
      t(
        locale,
        `配置无法自动迁移 (${detected.sourcePath}): ${detected.reason}`,
        `Cannot auto-migrate configuration (${detected.sourcePath}): ${detected.reason}`,
      ),
    );
    return { state: 'error' };
  }

  if (interactive) {
    return await runInteractiveMigration(
      options,
      detected,
      locale,
      style,
      banner,
      migratedHeading,
    );
  }

  const applied = await applyMigration(detected, { now: options.now });
  if (explicit) {
    print(bannerLine(banner, colors.stdout));
    const summaryLines = renderConfigSummary({
      configPath: applied.targetPath,
      config: applied.config,
      excludeExplicit: applied.excludeExplicit,
      heading: migratedHeading,
      backupPath: applied.backupPath,
      newAvailablePresets: applied.newAvailablePresets,
      home,
      platform,
      color: colors.stdout,
      locale,
    });
    for (const line of summaryLines) print(line);
  } else {
    notice(
      t(
        locale,
        `[info] 已自动无损迁移配置到 v2 (${shortenHome(applied.targetPath, home, style)}); 原配置已备份至 ${shortenHome(applied.backupPath, home, style)}`,
        `[info] Losslessly migrated config to v2 (${shortenHome(applied.targetPath, home, style)}); backed up to ${shortenHome(applied.backupPath, home, style)}`,
      ),
    );
    notice(
      t(
        locale,
        `[info] 新增可用预设: ${applied.newAvailablePresets.join(' · ')} (未自动激活, 可手动编辑配置按需启用)`,
        `[info] New presets available: ${applied.newAvailablePresets.join(' · ')} (not auto-enabled; edit config to activate)`,
      ),
    );
  }
  return {
    state: 'migrated',
    config: applied.config,
    excludeExplicit: applied.excludeExplicit,
    backupPath: applied.backupPath,
  };
}
