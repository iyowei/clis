/**
 * CLI 子命令与运行期配置解析/名单命中回执辅助 (`init` / `init --default` / `config`, 支持中英双语)。
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type Config,
  type ConfigSource,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  type ScanResult,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  loadResolvedConfig,
} from '@iyowei/sweep';

import {
  type InitResult,
  createReadlineIO,
  runInit,
  runInitDefault,
} from './init.ts';
import { runMigrationFlow } from './migrate-cli.ts';
import { bannerLine, neutralLine, sanitizeLine } from './render.ts';

export interface ColorChannels {
  stdout: boolean;
  stderr: boolean;
}

export async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export async function rootIsDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

export async function writeConfigFile(
  path: string,
  text: string,
): Promise<void> {
  await mkdir(dirname(path), { recursive: true });
  await writeFile(path, text, 'utf8');
}

export function runWizard(
  configPath: string,
  stdoutColor: boolean,
  home: string,
  locale: Locale = 'zh',
): Promise<InitResult> {
  return runInit({
    configPath,
    configExists: pathExists,
    configIsDirectory: rootIsDirectory,
    rootExists: pathExists,
    rootIsDirectory,
    firstSymlinkOnRoot,
    firstSymlinkOnTarget,
    writeFile: writeConfigFile,
    home,
    locale,
    io: createReadlineIO(stdoutColor),
  });
}

const SOURCE_LABELS_ZH: Record<ConfigSource, string> = {
  flag: '--config 指定',
  env: '环境变量 SWEEP_CONFIG',
  'platform-default': '平台默认',
};

const SOURCE_LABELS_EN: Record<ConfigSource, string> = {
  flag: '--config flag',
  env: 'SWEEP_CONFIG env',
  'platform-default': 'platform default',
};

export async function reportConfig(
  resolved: ResolvedConfigPath,
  stdoutColor: boolean,
  print: (line: string) => void,
  locale: Locale = 'zh',
): Promise<number> {
  const exists = await pathExists(resolved.path);
  const srcLabel =
    locale === 'en'
      ? SOURCE_LABELS_EN[resolved.source]
      : SOURCE_LABELS_ZH[resolved.source];
  print(
    bannerLine(
      t(
        locale,
        `配置 · 来源: ${srcLabel}`,
        `Configuration · Source: ${srcLabel}`,
      ),
      stdoutColor,
    ),
  );
  print(
    neutralLine(
      t(
        locale,
        `配置路径: ${sanitizeLine(resolved.path)}`,
        `Config path: ${sanitizeLine(resolved.path)}`,
      ),
      stdoutColor,
    ),
  );
  print(
    neutralLine(
      t(
        locale,
        `文件状态: ${exists ? '存在' : '不存在'}`,
        `File status: ${exists ? 'exists' : 'not found'}`,
      ),
      stdoutColor,
    ),
  );
  return 0;
}

export async function handleInitCommand(params: {
  configPath: string;
  defaultConfig: boolean;
  interactive: boolean;
  colors: ColorChannels;
  home: string;
  locale?: Locale;
  print: (line: string) => void;
  warn: (line: string) => void;
}): Promise<number> {
  const { configPath, defaultConfig, interactive, colors, home, print, warn } =
    params;
  const locale = params.locale ?? 'zh';

  if (defaultConfig) {
    const result = await runInitDefault({
      configPath,
      configExists: pathExists,
      configIsDirectory: rootIsDirectory,
      firstSymlinkOnTarget,
      writeFile: writeConfigFile,
      home,
      locale,
      interactive,
      color: colors.stdout,
      print,
      warn,
      confirmOverwrite: interactive
        ? async (path) => {
            const io = createReadlineIO(colors.stdout);
            try {
              return await io.confirm(
                t(
                  locale,
                  `配置已存在 (${sanitizeLine(path)}), 是否覆盖?`,
                  `Config already exists (${sanitizeLine(path)}). Overwrite?`,
                ),
                false,
              );
            } finally {
              io.close?.();
            }
          }
        : undefined,
    });
    if (result.state === 'conflict') return 1;
    if (result.state === 'written') {
      print(
        neutralLine(
          t(locale, '运行 sweep 查看预览', "Run 'sweep' to preview targets"),
          colors.stdout,
        ),
      );
    } else if (result.state === 'declined-overwrite') {
      print(t(locale, '配置未变更', 'Configuration unchanged'));
    }
    return 0;
  }

  if (!interactive) {
    warn(
      t(
        locale,
        'init 需要交互终端 (请在终端直接运行, 或改用 sweep init --default 生成默认配置)',
        "'sweep init' requires an interactive terminal (or run 'sweep init --default')",
      ),
    );
    return 1;
  }
  const result = await runWizard(configPath, colors.stdout, home, locale);
  if (result.state === 'written') {
    print(
      neutralLine(
        t(locale, '运行 sweep 查看预览', "Run 'sweep' to preview targets"),
        colors.stdout,
      ),
    );
  } else if (result.state === 'declined-overwrite') {
    print(t(locale, '配置未变更', 'Configuration unchanged'));
  }
  return 0;
}

export type ResolveOutcome =
  | {
      state: 'ready';
      config: Config;
      excludeExplicit: boolean;
      source: 'file' | 'wizard' | 'migrated';
    }
  | { state: 'abort'; exitCode: number };

export async function resolveActiveConfig(params: {
  resolved: ResolvedConfigPath;
  colors: ColorChannels;
  home: string;
  locale: Locale;
  interactive: boolean;
  print: (line: string) => void;
  warn: (line: string) => void;
  notice: (line: string) => void;
}): Promise<ResolveOutcome> {
  const { resolved, colors, home, locale, interactive, print, warn, notice } =
    params;
  const migration = await runMigrationFlow({
    resolved,
    explicit: false,
    interactive,
    colors,
    home,
    locale,
    print,
    warn,
    notice,
  });

  if (migration.state === 'error') return { state: 'abort', exitCode: 1 };
  if (migration.state === 'cancelled') return { state: 'abort', exitCode: 0 };
  if (migration.state === 'migrated') {
    return {
      state: 'ready',
      config: migration.config,
      excludeExplicit: migration.excludeExplicit,
      source: 'migrated',
    };
  }

  const loaded = await loadResolvedConfig(resolved, { homedir: home });
  if (loaded.state === 'ok') {
    return {
      state: 'ready',
      config: loaded.config,
      excludeExplicit: loaded.excludeExplicit,
      source: 'file',
    };
  }

  if (!interactive) {
    warn(
      t(
        locale,
        `未找到配置文件 (${resolved.path}), 非交互模式下拒绝盲扫; 请先运行 sweep init 或 sweep init --default, 或用 --config 指定配置文件`,
        `Configuration not found (${resolved.path}); refusing to scan blindly in non-interactive mode. Run 'sweep init', 'sweep init --default', or pass --config`,
      ),
    );
    return { state: 'abort', exitCode: 1 };
  }

  const result = await runWizard(resolved.path, colors.stdout, home, locale);
  if (result.state === 'written' && result.config !== undefined) {
    return {
      state: 'ready',
      config: result.config,
      excludeExplicit: result.excludeExplicit ?? false,
      source: 'wizard',
    };
  }

  print(
    t(
      locale,
      '配置未写入, 本次未执行清理',
      'Configuration was not saved; no cleanup performed',
    ),
  );
  return { state: 'abort', exitCode: 0 };
}

type NameMatches = NonNullable<ScanResult['excludeMatches']>;
const BUILTIN_EXCLUDE_NAMES = new Set(DEFAULT_EXCLUDE);

export function collectNameNotes(
  excludeMatches: NameMatches | undefined,
  includeMatches: NameMatches | undefined,
  warn: (line: string) => void,
  tty: boolean,
  locale: Locale,
): string[] {
  const notes: string[] = [];

  for (const item of excludeMatches ?? []) {
    if (item.hits === 0) {
      if (BUILTIN_EXCLUDE_NAMES.has(item.name)) continue;
      warn(
        t(
          locale,
          `排除名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
          `Exclude name matched 0 scanned directories: ${item.name} (exact directory name match)`,
        ),
      );
    } else if (tty) {
      notes.push(
        t(
          locale,
          `排除生效: ${item.name} (${item.hits} 处)`,
          `Excluded: ${item.name} (${item.hits} hit${item.hits === 1 ? '' : 's'})`,
        ),
      );
    }
  }

  const includes = includeMatches ?? [];
  for (const item of includes) {
    if (item.hits === 0) {
      warn(
        t(
          locale,
          `包含名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
          `Include name matched 0 scanned directories: ${item.name} (exact directory name match)`,
        ),
      );
    } else if (tty) {
      notes.push(
        t(
          locale,
          `包含命中: ${item.name} (${item.hits} 处)`,
          `Included: ${item.name} (${item.hits} hit${item.hits === 1 ? '' : 's'})`,
        ),
      );
    }
  }
  if (includes.length > 0 && includes.every((item) => item.hits === 0)) {
    warn(
      t(
        locale,
        '包含名单无一条命中, 本次扫描必为空结果 (请核对名字与大小写; 若名字位于被排除的目录之下则属预期)',
        'None of the --include names matched any directory; scan result will be empty (case-sensitive)',
      ),
    );
  }

  return notes;
}
