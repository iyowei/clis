/**
 * 初始化向导 (`sweep init`) 与一键默认配置 (`sweep init --default`):
 * 上游由 `cli-commands.ts` (`handleInitCommand` / `runWizard`) 注入 FS 与 `InitIO` 调用,
 * 下游依赖 `@iyowei/sweep` 配置原语与 `config-summary.ts` 结构化摘要渲染 (权威: ADR 0004 & ADR 0024)。
 * 红线: 写盘前后严查目录与符号链接锚点; 写盘后仅输出结构化摘要, 严禁输出原始 JSON 全文。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  CONFIG_VERSION,
  type Config,
  DEFAULT_EXCLUDE,
  PRESET_NAMES,
  type PresetsMap,
  type StoredConfigV2,
  createDefaultConfig,
  createDefaultPresets,
  isPresetName,
} from '@iyowei/sweep';

import { renderConfigSummary } from './config-summary.ts';
import type { InitIO } from './init-io.ts';
import {
  bannerLine,
  neutralLine,
  paint,
  sanitizeLine,
  shortenHome,
} from './render.ts';

export { type InitIO, createReadlineIO } from './init-io.ts';

/** 运行依赖: 文件系统与 IO 全部注入, 本模块不直接碰 stdin / fs */
export interface InitDeps {
  /** 配置文件目标路径 */
  configPath: string;
  /** 配置文件是否已存在 (lstat 语义: 悬空符号链接也算已存在, 触发覆盖保护) */
  configExists(path: string): Promise<boolean>;
  /** 可选: 配置目标路径是否为既有目录 (前置与落盘前拦截 EISDIR) */
  configIsDirectory?(path: string): Promise<boolean>;
  /** 扫描根是否为真实目录 (lstat + isDirectory: 不存在、普通文件与符号链接均返 false) */
  rootIsDirectory(path: string): Promise<boolean>;
  /** 可选: 扫描根路径是否存在 (lstat 语义) */
  rootExists?(path: string): Promise<boolean>;
  /** 根锚点链上首个符号链接的路径 (null 即全链为真目录) */
  firstSymlinkOnRoot(root: string): Promise<string | null>;
  /** 配置路径 (落盘目标) 锚点链上首个符号链接的路径 */
  firstSymlinkOnTarget(target: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  /** 家目录 (默认根、~ 展开与回显缩写用); 缺省 os.homedir() */
  home?: string;
  /** 目标平台 (用于生成平台快捷查看/编辑指令); 缺省 process.platform */
  platform?: NodeJS.Platform;
  io: InitIO;
}

/** `sweep init --default` 的运行依赖 */
export interface InitDefaultDeps {
  configPath: string;
  configExists(path: string): Promise<boolean>;
  configIsDirectory?(path: string): Promise<boolean>;
  firstSymlinkOnTarget(target: string): Promise<string | null>;
  writeFile(path: string, text: string): Promise<void>;
  home?: string;
  platform?: NodeJS.Platform;
  /** 是否允许交互确认覆盖; 非交互且目标已存在时拒绝静默覆盖 */
  interactive: boolean;
  color: boolean;
  print(line: string): void;
  warn(line: string): void;
  confirmOverwrite?: (configPath: string) => Promise<boolean>;
}

export interface InitResult {
  /**
   * 终态:
   * - `written`: 配置已写盘并渲染结构化摘要;
   * - `declined-overwrite`: 目标已存在且用户拒绝覆盖;
   * - `cancelled`: `runInit` 中取消 (含前置目标不可写 / Ctrl+C / EOF / 末步拒写);
   * - `conflict`: `runInitDefault` 中目标为目录、锚点链含软链或非交互下目标已存在。
   */
  state: 'written' | 'cancelled' | 'declined-overwrite' | 'conflict';
  /** 仅 state 为 written 时存在: 归一化后的 v2 配置 */
  config?: Config;
  /** 仅 state 为 written 时存在: 实际落盘的 JSON 对象 */
  stored?: StoredConfigV2;
  /** 是否显式写出了 exclude (false 表示采用内置默认护栏) */
  excludeExplicit?: boolean;
}

const WHITESPACE = /\s/;

function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/') || token.startsWith('~\\'))
    return join(home, token.slice(2));
  return token;
}

function splitAnswer(answer: string): string[] {
  const items: string[] = [];
  let current = '';
  let openQuote: string | null = null;

  for (let index = 0; index < answer.length; index += 1) {
    const char = answer[index]!;

    if (openQuote !== null) {
      if (char === openQuote) {
        openQuote = null;
        continue;
      }
      current += char;
      continue;
    }

    if (char === '"' || char === "'") {
      if (answer.indexOf(char, index + 1) !== -1) {
        openQuote = char;
        continue;
      }
      current += char;
      continue;
    }

    if (char === ',' || char === '，' || WHITESPACE.test(char)) {
      if (current.length > 0) items.push(current);
      current = '';
      continue;
    }

    current += char;
  }

  if (current.length > 0) items.push(current);
  return items;
}

/** 路径列表解析 (用于扫描根 roots): 切分 → 家目录展开 → resolve 去重; 空答案回落 fallback */
export function parsePathList(
  answer: string | null,
  fallback: string[],
  home: string = homedir(),
): string[] {
  if (answer === null) return [...fallback];
  const items = [
    ...new Set(
      splitAnswer(answer).map((token) => resolve(expandHome(token, home))),
    ),
  ];
  return items.length > 0 ? items : [...fallback];
}

/** 目录名列表解析 (用于 exclude / include): 仅切分不做 ~ 展开; 空答案回落 fallback */
export function parseNameList(
  answer: string | null,
  fallback: string[],
): string[] {
  if (answer === null) return [...fallback];
  const items = splitAnswer(answer);
  return items.length > 0 ? items : [...fallback];
}

/** 预设列表解析: 切分并转小写归一, 空答案回落推荐全集; 逐项校验是否全为合法内置预设名 */
export function parsePresetList(
  answer: string | null,
  fallback: PresetsMap = createDefaultPresets(),
): { ok: true; presets: PresetsMap } | { ok: false; invalid: string[] } {
  if (answer === null) return { ok: true, presets: { ...fallback } };
  const items = splitAnswer(answer).map((item) => item.toLowerCase());
  if (items.length === 0) return { ok: true, presets: { ...fallback } };

  const invalid: string[] = [];
  const presets: PresetsMap = {};
  for (const item of items) {
    if (!isPresetName(item)) {
      invalid.push(item);
      continue;
    }
    presets[item] = {};
  }
  if (invalid.length > 0) return { ok: false, invalid };
  return { ok: true, presets };
}

const hasPathSeparator = (name: string): boolean =>
  name.includes('/') || name.includes('\\');

interface RootCheckResult {
  missing: string[];
  notDir: string[];
  symlinked: { root: string; link: string }[];
}

async function checkRoots(
  roots: readonly string[],
  deps: Pick<InitDeps, 'rootExists' | 'rootIsDirectory' | 'firstSymlinkOnRoot'>,
): Promise<RootCheckResult> {
  const missing: string[] = [];
  const notDir: string[] = [];
  const symlinked: { root: string; link: string }[] = [];

  for (const root of roots) {
    if (deps.rootExists !== undefined && !(await deps.rootExists(root))) {
      missing.push(root);
      continue;
    }
    const link = await deps.firstSymlinkOnRoot(root);
    if (link !== null) {
      symlinked.push({ root, link });
      continue;
    }
    if (!(await deps.rootIsDirectory(root))) {
      if (deps.rootExists !== undefined) notDir.push(root);
      else missing.push(root);
    }
  }
  return { missing, notDir, symlinked };
}

async function checkTargetWritable(
  configPath: string,
  configIsDirectory: ((path: string) => Promise<boolean>) | undefined,
  firstSymlinkOnTarget: (target: string) => Promise<string | null>,
  reportError: (line: string) => void,
): Promise<boolean> {
  if (
    configIsDirectory !== undefined &&
    (await configIsDirectory(configPath))
  ) {
    reportError(
      `配置路径是既有目录, 无法写入文件: ${sanitizeLine(configPath)}; 请用 --config 指定文件路径或先移走该目录`,
    );
    return false;
  }
  const link = await firstSymlinkOnTarget(configPath);
  if (link !== null) {
    reportError(
      `配置路径锚点链上有符号链接: ${sanitizeLine(link)} (配置: ${sanitizeLine(configPath)}); 写入会跟随符号链接改写其目标, 请改写为不含符号链接的真实路径`,
    );
    return false;
  }
  return true;
}

/**
 * `sweep init --default`: 一键生成包含完整最佳实践的默认 v2 配置 (6 大预设含 `os-junk` + 32 条内置安全护栏),
 * 写盘后以 `renderConfigSummary` 输出结构化摘要与平台快捷指令 (严禁输出原始 JSON 全文)。
 *
 * ### 数据流转示例
 * ```text
 * Input  : configPath = '~/.config/sweep/config.json', interactive = false, configExists = false
 * 步骤 1 : checkTargetWritable 校验非目录且锚点链无软链 -> 通过
 * 步骤 2 : configExists 为 false (若存在: 非交互直接返回 conflict, 交互经 confirmOverwrite 确认)
 * 步骤 3 : createDefaultConfig 生成 v2 stored -> writeFile 落盘 -> bannerLine + renderConfigSummary 输出
 * Output : { state: 'written', config, stored, excludeExplicit: false }
 * ```
 */
export async function runInitDefault(
  deps: InitDefaultDeps,
): Promise<InitResult> {
  const { configPath, configExists, writeFile, color, print, warn } = deps;
  const home = deps.home ?? homedir();

  const targetOk = await checkTargetWritable(
    configPath,
    deps.configIsDirectory,
    deps.firstSymlinkOnTarget,
    warn,
  );
  if (!targetOk) return { state: 'conflict' };

  if (await configExists(configPath)) {
    if (!deps.interactive || deps.confirmOverwrite === undefined) {
      warn(
        `配置已存在 (${configPath}), 非交互模式下拒绝静默覆盖; 请先备份移除或用 --config 指定新路径`,
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
  print(bannerLine('初始化配置', color));
  for (const line of renderConfigSummary({
    configPath,
    config,
    excludeExplicit: false,
    heading: '配置已写入',
    home,
    platform: deps.platform,
    color,
  })) {
    print(line);
  }
  return { state: 'written', config, stored, excludeExplicit: false };
}

/**
 * 交互式初始化向导 (`sweep init`):
 * 四问 (扫描根 / 激活预设 / 排除名单 / 包含名单) + 覆盖保护 + 双阶段锚点检查 (进入前置 + 落盘前复核) + 结构化摘要展示。
 * 写盘后严禁向终端输出原始 JSON 全文, `finally` 恒调 `io.close?.()` 释放终端句柄。
 *
 * ### 数据流转示例
 * ```text
 * Input  : configPath = '~/.config/sweep/config.json', io.ask 依次输入 '~/dev' / 'node, rust' / '' / ''
 * 步骤 1 : 前置 checkTarget -> configExists 覆盖确认 (若已存在)
 * 步骤 2 : 四问采集并校验: 扫描根真实目录且无软链 -> 预设名合法 -> 排除为空取 32 条内置护栏 (excludeExplicit=false) -> 包含为空
 * 步骤 3 : 预览计数 -> 二次确认并复核 checkTarget -> writeFile 落盘 v2 JSON -> renderConfigSummary 输出摘要
 * Output : { state: 'written', config, stored, excludeExplicit: false }
 * ```
 */
export async function runInit(deps: InitDeps): Promise<InitResult> {
  const { configPath, configExists, firstSymlinkOnTarget, writeFile, io } =
    deps;
  const { color } = io;
  const home = deps.home ?? homedir();

  function cancelled(): InitResult {
    io.print('已取消, 未写入配置');
    return { state: 'cancelled' };
  }

  const checkTarget = (): Promise<boolean> =>
    checkTargetWritable(
      configPath,
      deps.configIsDirectory,
      firstSymlinkOnTarget,
      (msg) => io.print(`  ${paint('✗', '31', color)} ${msg}`),
    );

  try {
    io.print(bannerLine('初始化向导', color));
    if (!(await checkTarget())) return cancelled();

    if (await configExists(configPath)) {
      const overwrite = await io.confirm(
        `配置已存在 (${sanitizeLine(configPath)}), 是否覆盖?`,
        false,
      );
      if (!overwrite) return { state: 'declined-overwrite' };
    }

    io.print(neutralLine('首次使用, 先确定扫描范围与清理预设', color));

    let roots: string[] = [];
    for (;;) {
      const rootsAnswer = await io.ask(
        '扫描根 (逗号或空白分隔多个)',
        `默认: ${sanitizeLine(shortenHome(home, home))}`,
      );
      if (rootsAnswer === null) return cancelled();
      roots = parsePathList(rootsAnswer, [home], home);

      const { missing, notDir, symlinked } = await checkRoots(roots, deps);
      if (missing.length === 0 && notDir.length === 0 && symlinked.length === 0)
        break;
      for (const path of missing)
        io.print(
          `  ${paint('✗', '31', color)} 根不存在: ${sanitizeLine(path)}`,
        );
      for (const path of notDir)
        io.print(
          `  ${paint('✗', '31', color)} 根不是目录: ${sanitizeLine(path)}`,
        );
      for (const item of symlinked)
        io.print(
          `  ${paint('✗', '31', color)} 根锚点链上有符号链接: ${sanitizeLine(item.link)} (根: ${sanitizeLine(item.root)}); 删除侧要求真实路径, 请改写为不含符号链接的形态`,
        );
    }

    let presets: PresetsMap = createDefaultPresets();
    for (;;) {
      const presetsAnswer = await io.ask(
        '激活预设 (逗号或空白分隔)',
        `默认: ${PRESET_NAMES.join(', ')}`,
      );
      if (presetsAnswer === null) return cancelled();
      const parsedPresets = parsePresetList(presetsAnswer);
      if (parsedPresets.ok) {
        presets = parsedPresets.presets;
        break;
      }
      io.print(
        `  ${paint('✗', '31', color)} 未知预设: ${parsedPresets.invalid.map(sanitizeLine).join(', ')} (可选: ${PRESET_NAMES.join(', ')})`,
      );
    }

    const excludeAnswer = await io.ask(
      '排除名单 (目录名)',
      `回车采用内置安全护栏 (${DEFAULT_EXCLUDE.length} 条)`,
    );
    if (excludeAnswer === null) return cancelled();
    const customExclude = splitAnswer(excludeAnswer);
    const excludeExplicit = customExclude.length > 0;
    const exclude = excludeExplicit ? customExclude : [...DEFAULT_EXCLUDE];
    for (const bad of exclude.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} 排除名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
      );
    }

    const includeAnswer = await io.ask('包含名单 (目录名, 可留空)', '回车跳过');
    if (includeAnswer === null) return cancelled();
    const include = parseNameList(includeAnswer, []);
    for (const bad of include.filter(hasPathSeparator)) {
      io.print(
        `  ${paint('!', '33', color)} 包含名含路径分隔符, 不会命中任何目录 (请填写单级目录名): ${sanitizeLine(bad)}`,
      );
    }

    const presetCount = Object.keys(presets).length;
    io.print(
      neutralLine(
        `将写入 ${roots.length} 个扫描根 · ${presetCount} 个预设 · 排除 ${exclude.length} 条 · 包含 ${include.length} 条`,
        color,
      ),
    );

    let confirmDefault = true;
    for (;;) {
      if (!(await io.confirm('确认写入?', confirmDefault))) return cancelled();
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
    const text = `${JSON.stringify(stored, null, 2)}\n`;
    await writeFile(configPath, text);

    for (const line of renderConfigSummary({
      configPath,
      config,
      excludeExplicit,
      heading: '配置已写入',
      home,
      platform: deps.platform,
      color,
    })) {
      io.print(line);
    }
    return { state: 'written', config, stored, excludeExplicit };
  } finally {
    io.close?.();
  }
}
