/**
 * 初始化向导 (`sweep init`) 与一键默认配置 (`sweep init --default`, 支持中英双语):
 * 红线: 写盘前后严查目录与符号链接锚点; 写盘后仅输出结构化摘要, 严禁输出原始 JSON 全文。
 */
import { homedir } from 'node:os';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  CONFIG_VERSION,
  type Config,
  DEFAULT_EXCLUDE,
  PRESET_NAMES,
  type PresetsMap,
  type StoredConfigV2,
  createDefaultConfig,
  createDefaultPresets,
  resolveDefaultRoot,
} from '@iyowei/sweep';

import { renderConfigSummary } from './config-summary.ts';
import type { InitIO } from './init-io.ts';
import {
  checkRoots,
  checkTargetWritable,
  parseNameList,
  parsePathList,
  parsePresetList,
  splitAnswer,
} from './init-parse.ts';
import {
  bannerLine,
  inferPathStyle,
  neutralLine,
  paint,
  sanitizeLine,
  shortenHome,
} from './render.ts';

export { type InitIO, createReadlineIO } from './init-io.ts';
export { parseNameList, parsePathList, parsePresetList };

export interface InitDeps {
  configPath: string;
  configExists(path: string): Promise<boolean>;
  configIsDirectory?(path: string): Promise<boolean>;
  rootIsDirectory(path: string): Promise<boolean>;
  rootExists?(path: string): Promise<boolean>;
  firstSymlinkOnRoot(root: string): Promise<string | null>;
  firstSymlinkOnTarget(target: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  home?: string;
  platform?: NodeJS.Platform;
  locale?: Locale;
  io: InitIO;
}

export interface InitDefaultDeps {
  configPath: string;
  configExists(path: string): Promise<boolean>;
  configIsDirectory?(path: string): Promise<boolean>;
  firstSymlinkOnTarget(target: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  home?: string;
  platform?: NodeJS.Platform;
  locale?: Locale;
  interactive: boolean;
  color: boolean;
  print(line: string): void;
  warn(line: string): void;
  confirmOverwrite?: (configPath: string) => Promise<boolean>;
}

export interface InitResult {
  state: 'written' | 'cancelled' | 'declined-overwrite' | 'conflict';
  config?: Config;
  stored?: StoredConfigV2;
  excludeExplicit?: boolean;
}

const hasPathSeparator = (name: string): boolean =>
  name.includes('/') || name.includes('\\');

export async function runInitDefault(
  deps: InitDefaultDeps,
): Promise<InitResult> {
  const { configPath, configExists, writeFile, color, print, warn } = deps;
  const locale = deps.locale ?? 'zh';
  const home = deps.home ?? homedir();

  const targetOk = await checkTargetWritable(
    configPath,
    deps.configIsDirectory,
    deps.firstSymlinkOnTarget,
    warn,
    locale,
  );
  if (!targetOk) return { state: 'conflict' };

  if (await configExists(configPath)) {
    if (!deps.interactive || deps.confirmOverwrite === undefined) {
      warn(
        t(
          locale,
          `配置已存在 (${configPath}), 非交互模式下拒绝静默覆盖; 请先备份移除或用 --config 指定新路径`,
          `Configuration already exists (${configPath}); refusing to overwrite in non-interactive mode`,
        ),
      );
      return { state: 'conflict' };
    }
    const overwrite = await deps.confirmOverwrite(configPath);
    if (!overwrite) return { state: 'declined-overwrite' };
  }

  const stored = createDefaultConfig({ homedir: home });
  const config: Config = {
    version: CONFIG_VERSION,
    roots: [...stored.roots],
    exclude: [...DEFAULT_EXCLUDE],
    include: [],
    presets: stored.presets,
    rules: [],
  };

  await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`);
  print(bannerLine(t(locale, '初始化配置', 'Initialize Config'), color));
  for (const line of renderConfigSummary({
    configPath,
    config,
    excludeExplicit: false,
    heading: t(locale, '配置已写入', 'Configuration saved'),
    home,
    platform: deps.platform,
    color,
    locale,
  })) {
    print(line);
  }
  return { state: 'written', config, stored, excludeExplicit: false };
}

async function promptValidRoots(
  deps: InitDeps,
  home: string,
  locale: Locale,
): Promise<string[] | null> {
  const { io } = deps;
  const { color } = io;
  const defaultRoot = createDefaultConfig({ homedir: home }).roots[0] ?? home;
  const style = inferPathStyle(home ?? defaultRoot, deps.platform);
  const defaultRootLabel =
    resolveDefaultRoot(home) === defaultRoot
      ? '~'
      : sanitizeLine(shortenHome(defaultRoot, home, style));

  for (;;) {
    const rootsAnswer = await io.ask(
      t(
        locale,
        '扫描根 (逗号或空白分隔多个)',
        'Scan roots (comma or space separated)',
      ),
      t(locale, `默认: ${defaultRootLabel}`, `default: ${defaultRootLabel}`),
    );
    if (rootsAnswer === null) return null;
    const roots = parsePathList(rootsAnswer, [defaultRoot], home);

    const { missing, notDir, symlinked } = await checkRoots(roots, deps);
    if (missing.length === 0 && notDir.length === 0 && symlinked.length === 0) {
      return roots;
    }
    for (const path of missing) {
      io.print(
        `  ${paint('✗', '31', color)} ${t(locale, `根不存在: ${sanitizeLine(path)}`, `Root does not exist: ${sanitizeLine(path)}`)}`,
      );
    }
    for (const path of notDir) {
      io.print(
        `  ${paint('✗', '31', color)} ${t(locale, `根不是目录: ${sanitizeLine(path)}`, `Root is not a directory: ${sanitizeLine(path)}`)}`,
      );
    }
    for (const item of symlinked) {
      io.print(
        `  ${paint('✗', '31', color)} ${t(
          locale,
          `根锚点链上有符号链接: ${sanitizeLine(item.link)} (根: ${sanitizeLine(item.root)}); 删除侧要求真实路径, 请改写为不含符号链接的形态`,
          `Root contains symlink on anchor chain: ${sanitizeLine(item.link)} (root: ${sanitizeLine(item.root)}); use a real directory path`,
        )}`,
      );
    }
  }
}

async function promptValidPresets(
  io: InitIO,
  locale: Locale,
): Promise<PresetsMap | null> {
  const { color } = io;
  for (;;) {
    const presetsAnswer = await io.ask(
      t(
        locale,
        '激活预设 (逗号或空白分隔)',
        'Active presets (comma or space separated)',
      ),
      t(
        locale,
        `默认: ${PRESET_NAMES.join(', ')}`,
        `default: ${PRESET_NAMES.join(', ')}`,
      ),
    );
    if (presetsAnswer === null) return null;
    const parsedPresets = parsePresetList(
      presetsAnswer,
      createDefaultPresets(),
    );
    if (parsedPresets.ok) return parsedPresets.presets;
    io.print(
      `  ${paint('✗', '31', color)} ${t(
        locale,
        `未知预设: ${parsedPresets.invalid.map(sanitizeLine).join(', ')} (可选: ${PRESET_NAMES.join(', ')})`,
        `Unknown preset(s): ${parsedPresets.invalid.map(sanitizeLine).join(', ')} (available: ${PRESET_NAMES.join(', ')})`,
      )}`,
    );
  }
}

export async function runInit(deps: InitDeps): Promise<InitResult> {
  const { configPath, configExists, firstSymlinkOnTarget, writeFile, io } =
    deps;
  const { color } = io;
  const locale = deps.locale ?? 'zh';
  const home = deps.home ?? homedir();

  const cancelled = (): InitResult => {
    io.print(
      t(
        locale,
        '已取消, 未写入配置',
        'Cancelled; configuration was not written',
      ),
    );
    return { state: 'cancelled' };
  };

  const checkTarget = (): Promise<boolean> =>
    checkTargetWritable(
      configPath,
      deps.configIsDirectory,
      firstSymlinkOnTarget,
      (msg) => io.print(`  ${paint('✗', '31', color)} ${msg}`),
      locale,
    );

  try {
    io.print(bannerLine(t(locale, '初始化向导', 'Setup Wizard'), color));
    if (!(await checkTarget())) return cancelled();

    if (await configExists(configPath)) {
      const overwrite = await io.confirm(
        t(
          locale,
          `配置已存在 (${sanitizeLine(configPath)}), 是否覆盖?`,
          `Config already exists (${sanitizeLine(configPath)}). Overwrite?`,
        ),
        false,
      );
      if (!overwrite) return { state: 'declined-overwrite' };
    }

    io.print(
      neutralLine(
        t(
          locale,
          '首次使用, 先确定扫描范围与清理预设',
          'Configure scan roots and active cleanup presets',
        ),
        color,
      ),
    );

    const roots = await promptValidRoots(deps, home, locale);
    if (roots === null) return cancelled();

    const presets = await promptValidPresets(io, locale);
    if (presets === null) return cancelled();

    const excludeAnswer = await io.ask(
      t(locale, '排除名单 (目录名)', 'Exclude directory names'),
      t(
        locale,
        `回车采用内置安全护栏 (${DEFAULT_EXCLUDE.length} 条)`,
        `Enter for ${DEFAULT_EXCLUDE.length} built-in guardrails`,
      ),
    );
    if (excludeAnswer === null) return cancelled();
    const customExclude = splitAnswer(excludeAnswer);
    const excludeExplicit = customExclude.length > 0;
    const exclude = excludeExplicit ? customExclude : [...DEFAULT_EXCLUDE];
    for (const bad of exclude.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} ${t(
          locale,
          `排除名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
          `Exclude entry contains path separator and will never match (use bare dir name): ${sanitizeLine(bad)}`,
        )}`,
      );
    }

    const includeAnswer = await io.ask(
      t(
        locale,
        '包含名单 (目录名, 可留空)',
        'Include directory names (optional)',
      ),
      t(locale, '回车跳过', 'Enter to skip'),
    );
    if (includeAnswer === null) return cancelled();
    const include = parseNameList(includeAnswer, []);
    for (const bad of include.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} ${t(
          locale,
          `包含名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
          `Include entry contains path separator and will never match (use bare dir name): ${sanitizeLine(bad)}`,
        )}`,
      );
    }

    const presetCount = Object.keys(presets).length;
    io.print(
      neutralLine(
        t(
          locale,
          `将写入 ${roots.length} 个扫描根 · ${presetCount} 个预设 · 排除 ${exclude.length} 条 · 包含 ${include.length} 条`,
          `Ready: ${roots.length} root(s) · ${presetCount} preset(s) · ${exclude.length} excludes · ${include.length} includes`,
        ),
        color,
      ),
    );

    let confirmDefault = true;
    for (;;) {
      if (
        !(await io.confirm(
          t(locale, '确认写入?', 'Save configuration?'),
          confirmDefault,
        ))
      ) {
        return cancelled();
      }
      if (await checkTarget()) break;
      confirmDefault = false;
    }

    const stored = createDefaultConfig({
      roots,
      presets,
      ...(excludeExplicit ? { exclude } : {}),
      ...(include.length > 0 ? { include } : {}),
      rules: [],
    });
    const config: Config = {
      version: CONFIG_VERSION,
      roots: [...stored.roots],
      exclude: [...exclude],
      include: [...include],
      presets: stored.presets,
      rules: [],
    };
    await writeFile(configPath, `${JSON.stringify(stored, null, 2)}\n`);

    for (const line of renderConfigSummary({
      configPath,
      config,
      excludeExplicit,
      heading: t(locale, '配置已写入', 'Configuration saved'),
      home,
      platform: deps.platform,
      color,
      locale,
    })) {
      io.print(line);
    }
    return { state: 'written', config, stored, excludeExplicit };
  } finally {
    io.close?.();
  }
}
