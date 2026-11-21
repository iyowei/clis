/**
 * 配置迁移 CLI 编排: 上游供 `cli.ts` (`sweep migrate` 显式调用与主流程自动探测) 共用,
 * 下游调用 `@iyowei/sweep` (`detectMigration` / `applyMigration`) 与 `config-summary.ts` (设计见 ADR 0024)。
 * 红线: 写盘前强制创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份; 仅做 100% 无损等价升版 (不自动开启新预设);
 * 落盘后仅渲染结构化摘要或 `[info]` 日志 (严禁输出原始 JSON 全文); 非无损返回 `error` 由调用方退 1。
 */
import { lstat } from 'node:fs/promises';

import {
  type Config,
  type ResolvedConfigPath,
  applyMigration,
  detectMigration,
  loadResolvedConfig,
  sanitizeLine,
} from '@iyowei/sweep';

import { renderConfigSummary } from './config-summary.ts';
import { type InitIO, createReadlineIO } from './init-io.ts';
import { bannerLine, neutralLine, shortenHome } from './render.ts';

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
  /** true = 显式 `sweep migrate` 子命令; false = 主清理流程自动触发 */
  explicit: boolean;
  interactive: boolean;
  colors: { stdout: boolean; stderr: boolean };
  home: string;
  platform?: NodeJS.Platform;
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

/**
 * 执行配置迁移检测与落盘流转:
 * - `none`: 自动探测静默放行; 显式 `migrate` 时若显式路径缺失返 `error`, 否则告知无需迁移;
 * - `unsupported`: 经 `warn` 报错并返 `{ state: 'error' }` (调用方映射退出码 1);
 * - `migratable` (`lossless: true`): TTY 请用户确认后备份落盘并渲染结构化摘要;
 *   非 TTY 自动备份落盘 (`explicit` 渲染结构化摘要, 自动探测走 `notice` 输出 `[info]` 日志)。
 *
 * ### 数据流转示例
 * ```text
 * Input  : resolved = { path: '~/.config/sweep/config.json', source: 'platform-default' }, explicit = false, interactive = false
 * 步骤 1 : detectMigration 探测到旧路径 ~/.config/sweep-node-modules/config.json (v1) -> { state: 'migratable', lossless: true }
 * 步骤 2 : 非 TTY 无损放行 -> applyMigration 先写 config.json.YYYYMMDD_HHMMSS.modified 备份, 再落盘 v2 (仅启用 node 预设)
 * 步骤 3 : explicit=false 走 notice 输出两行 [info] (备份路径与新增可用预设提示, 不吐原始 JSON)
 * Output : { state: 'migrated', config, excludeExplicit, backupPath }
 * ```
 */
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

  const detected = await detectMigration(resolved, {
    homedir: home,
    platform,
  });

  if (detected.state === 'none') {
    if (!explicit) return { state: 'none' };
    const exists = await targetExists(resolved.path);
    if (!exists && resolved.source !== 'platform-default') {
      warn(`配置不存在 (${resolved.path}), 请检查路径`);
      return { state: 'error' };
    }
    if (exists) {
      // 显式 migrate 必须复核当前文件确为合法 v2 配置, 避免损坏/非法 JSON 误报「已是最新版 v2」并退 0
      try {
        const loaded = await loadResolvedConfig(resolved, { homedir: home });
        if (loaded.state !== 'ok') {
          warn(`配置文件无法加载 (${resolved.path})`);
          return { state: 'error' };
        }
      } catch (error) {
        warn(error instanceof Error ? error.message : String(error));
        return { state: 'error' };
      }
    }
    print(bannerLine('配置迁移', colors.stdout));
    print(
      neutralLine(
        exists
          ? `当前配置已是最新版 v2, 无需迁移 (${sanitizeLine(shortenHome(resolved.path, home))})`
          : '未发现旧版配置, 无需迁移 (可运行 sweep init 或 sweep init --default 生成配置)',
        colors.stdout,
      ),
    );
    return { state: 'none' };
  }

  if (detected.state === 'unsupported') {
    warn(`配置无法自动迁移 (${detected.sourcePath}): ${detected.reason}`);
    return { state: 'error' };
  }

  // 以下 detected.state === 'migratable' (lossless === true)
  if (interactive) {
    const io = (options.createIO ?? createReadlineIO)(colors.stdout);
    try {
      io.print(bannerLine('配置迁移', colors.stdout));
      io.print(
        neutralLine(
          '检测到旧版配置, 可 100% 无损等价升版到 v2:',
          colors.stdout,
        ),
      );
      if (detected.fromLegacyPath) {
        io.print(
          neutralLine(
            `迁移来源: ${sanitizeLine(shortenHome(detected.sourcePath, home))}`,
            colors.stdout,
          ),
        );
        io.print(
          neutralLine(
            `目标路径: ${sanitizeLine(shortenHome(detected.targetPath, home))}`,
            colors.stdout,
          ),
        );
      } else {
        io.print(
          neutralLine(
            `配置路径: ${sanitizeLine(shortenHome(detected.targetPath, home))}`,
            colors.stdout,
          ),
        );
      }
      io.print(
        neutralLine(
          '写前备份: 将在源配置目录自动创建 config.json.YYYYMMDD_HHMMSS.modified',
          colors.stdout,
        ),
      );
      io.print(
        neutralLine(
          '等价映射: 仅启用 node 预设, 严禁替用户自动激活新版新增预设',
          colors.stdout,
        ),
      );

      const confirmed = await io.confirm('确认执行配置迁移?', true);
      if (!confirmed) {
        io.print('已取消, 未迁移配置');
        return { state: 'cancelled' };
      }

      const applied = await applyMigration(detected, { now: options.now });
      const summaryLines = renderConfigSummary({
        configPath: applied.targetPath,
        config: applied.config,
        excludeExplicit: applied.excludeExplicit,
        heading: '配置已迁移',
        backupPath: applied.backupPath,
        newAvailablePresets: applied.newAvailablePresets,
        home,
        platform,
        color: colors.stdout,
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

  // 非 TTY 且 100% 无损: 自动备份落盘 (explicit 输出结构化摘要, 自动探测走 notice 输出 [info] 日志)
  const applied = await applyMigration(detected, { now: options.now });
  if (explicit) {
    print(bannerLine('配置迁移', colors.stdout));
    const summaryLines = renderConfigSummary({
      configPath: applied.targetPath,
      config: applied.config,
      excludeExplicit: applied.excludeExplicit,
      heading: '配置已迁移',
      backupPath: applied.backupPath,
      newAvailablePresets: applied.newAvailablePresets,
      home,
      platform,
      color: colors.stdout,
    });
    for (const line of summaryLines) print(line);
  } else {
    notice(
      `[info] 已自动无损迁移配置到 v2 (${shortenHome(applied.targetPath, home)}); 原配置已备份至 ${shortenHome(applied.backupPath, home)}`,
    );
    notice(
      `[info] 新增可用预设: ${applied.newAvailablePresets.join(' · ')} (未自动激活, 可手动编辑配置按需启用)`,
    );
  }
  return {
    state: 'migrated',
    config: applied.config,
    excludeExplicit: applied.excludeExplicit,
    backupPath: applied.backupPath,
  };
}
