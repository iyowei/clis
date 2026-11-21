/**
 * 配置 v2 规格、三端路径定位、32 项默认排除护栏与装载原语 (设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)。
 * 上下游: 调用 config-validate.ts / presets.ts / rules.ts / errors.ts; 供 migrate.ts、sweep.ts 与 sweep-cli 配置装载和 init 消费。
 * 路径契约: 三级覆盖 `--config` > `SWEEP_CONFIG` > 平台默认 (POSIX `~/.config/sweep/config.json`, Windows `%APPDATA%\sweep\config.json`);
 * 旧路径 `resolveLegacyConfigPath` (`sweep-node-modules/config.json`) 仅供自动迁移模块探测使用。
 * 核心红线: 显式来源缺失一律硬抛 CONFIG_ABSENT; 旧版配置抛 CONFIG_NEEDS_MIGRATION; 显式 `roots: []` 硬报错。
 */
import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { parseV2ConfigObject } from './config-validate.ts';
import { SweepError } from './errors.ts';
import { type PresetsMap, createDefaultPresets } from './presets.ts';
import type { CustomRule } from './rules.ts';

/** 当前权威配置版本号 */
export const CONFIG_VERSION = 2;

/** 配置文件覆盖环境变量名 */
export const CONFIG_ENV_VAR = 'SWEEP_CONFIG';

/** 归一化后的 v2 配置对象 */
export interface Config {
  version: 2;
  /** 扫描根 (省略时默认取 [realpath(os.homedir())]; 显式 [] 硬报错拒绝) */
  roots: string[];
  /** 全局排除目录名; 省略时取 DEFAULT_EXCLUDE, 显式写出 (含 []) 则接管默认值 */
  exclude: string[];
  /** 全局白名单目录名; 空数组 = 不过滤 */
  include: string[];
  /** 已激活预设表 (键存在即激活, 严禁 enabled 字段) */
  presets: PresetsMap;
  /** 自定义清理规则 (缺省 action 强制为 'trash') */
  rules: CustomRule[];
}

/** 落盘用的 v2 配置序列化形态 (支持省略 exclude 继承内置默认护栏) */
export interface StoredConfigV2 {
  version: 2;
  roots: string[];
  exclude?: string[];
  include?: string[];
  presets: PresetsMap;
  rules?: CustomRule[];
}

/**
 * 32 项三端家目录默认排除护栏 (单一事实来源, 设计见 ADR 0022):
 * - 包管理器 / 版本管理器 (10): .bun / .npm / .pnpm-store / .yarn / .nvm / nvm / .fnm / .volta / .asdf / .n
 * - 编辑器 / IDE 扩展根 (5): .vscode / .vscode-insiders / .vscode-server / .cursor / .antigravity
 * - 系统 / 应用数据根 (5): Library / .local / .config / .cache / .claude
 * - 三端回收站本体 (3): .Trash / Trash / $Recycle.Bin
 * - Windows 应用根 (2): AppData / scoop
 * - 语言全局工具链与缓存 (7): .cargo / .rustup / .m2 / .gradle / .conda / .pyenv / .uv
 */
export const DEFAULT_EXCLUDE: readonly string[] = Object.freeze([
  // 包管理器 / 版本管理器
  '.bun',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.nvm',
  'nvm',
  '.fnm',
  '.volta',
  '.asdf',
  '.n',
  // 编辑器 / IDE
  '.vscode',
  '.vscode-insiders',
  '.vscode-server',
  '.cursor',
  '.antigravity',
  // 系统 / 应用数据根
  'Library',
  '.local',
  '.config',
  '.cache',
  '.claude',
  // 回收站自身 (macOS / Linux XDG / Windows)
  '.Trash',
  'Trash',
  '$Recycle.Bin',
  // Windows 应用与工具根
  'AppData',
  'scoop',
  // 语言全局工具链与缓存
  '.cargo',
  '.rustup',
  '.m2',
  '.gradle',
  '.conda',
  '.pyenv',
  '.uv',
]);

/** 配置路径来源 (三级覆盖) */
export type ConfigSource = 'flag' | 'env' | 'platform-default';

/** 环境变量查找表 (纯对象, 测试可直接注入) */
export type EnvTable = Record<string, string | undefined>;

export interface ResolveConfigPathOptions {
  /** `--config` 旗标值, 最高优先级 */
  flag?: string;
  /** 目标平台, 缺省 process.platform */
  platform?: string;
  /** 家目录, 缺省 os.homedir() */
  homedir?: string;
  /** 环境变量表, 缺省 process.env */
  env?: EnvTable;
}

export interface ResolvedConfigPath {
  path: string;
  source: ConfigSource;
}

function platformConfigPath(
  dirName: string,
  platform: string,
  home: string,
  env: EnvTable,
): string {
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData !== undefined && appData !== '') {
      return win32.join(appData, dirName, 'config.json');
    }
    const base =
      env.USERPROFILE !== undefined && env.USERPROFILE !== ''
        ? env.USERPROFILE
        : home;
    return win32.join(base, 'AppData', 'Roaming', dirName, 'config.json');
  }
  return posix.join(home, '.config', dirName, 'config.json');
}

/**
 * 解析本次实际生效的配置文件路径 (纯函数, 零 IO)。
 * 优先级: `--config` > `SWEEP_CONFIG` > 平台默认 (`sweep/config.json`)。
 *
 * ### 数据流转示例
 * - `{ flag: '/tmp/a.json' }` -> 直接命中 flag -> `{ path: '/tmp/a.json', source: 'flag' }`
 * - `{ env: { SWEEP_CONFIG: '/etc/sweep.json' } }` -> 命中环境变量 -> `{ path: '/etc/sweep.json', source: 'env' }`
 * - `{ platform: 'darwin', homedir: '/Users/alice', env: {} }` -> 拼接平台默认 -> `{ path: '/Users/alice/.config/sweep/config.json', source: 'platform-default' }`
 */
export function resolveConfigPath(
  options: ResolveConfigPathOptions = {},
): ResolvedConfigPath {
  const flag = options.flag;
  if (flag !== undefined && flag !== '') {
    return { path: flag, source: 'flag' };
  }
  const env = options.env ?? process.env;
  const fromEnv = env[CONFIG_ENV_VAR];
  if (fromEnv !== undefined && fromEnv !== '') {
    return { path: fromEnv, source: 'env' };
  }
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? homedir();
  return {
    path: platformConfigPath('sweep', platform, home, env),
    source: 'platform-default',
  };
}

/** 解析旧版 `sweep-node-modules/config.json` 平台默认路径 (仅供自动迁移探测使用) */
export function resolveLegacyConfigPath(
  options: Omit<ResolveConfigPathOptions, 'flag'> = {},
): string {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? homedir();
  return platformConfigPath('sweep-node-modules', platform, home, env);
}

/** 计算配置省略 `roots` 时的默认根: `[realpath(homedir)]` (不可解析时回退原拼写) */
export function resolveDefaultRoot(home: string = homedir()): string {
  try {
    return realpathSync(home);
  } catch {
    return home;
  }
}

/** 生成包含完整最佳实践的默认 v2 配置 (供 `sweep init` / `sweep init --default` 使用) */
export function createDefaultConfig(options?: {
  roots?: string[];
  homedir?: string;
  presets?: PresetsMap;
  exclude?: string[];
  include?: string[];
  rules?: CustomRule[];
}): StoredConfigV2 {
  const defaultRoot = resolveDefaultRoot(options?.homedir);
  const roots =
    options?.roots !== undefined && options.roots.length > 0
      ? [...options.roots]
      : [defaultRoot];
  const stored: StoredConfigV2 = {
    version: 2,
    roots,
    presets: options?.presets ?? createDefaultPresets(),
    rules: options?.rules ?? [],
  };
  if (options?.exclude !== undefined) {
    stored.exclude = [...options.exclude];
  }
  if (options?.include !== undefined && options.include.length > 0) {
    stored.include = [...options.include];
  }
  return stored;
}

export interface LoadConfigOptions {
  /** 省略 roots 时的默认家目录 (测试可注入) */
  homedir?: string;
}

export type LoadConfigResult =
  | { state: 'ok'; config: Config; excludeExplicit: boolean }
  | { state: 'absent' };

/**
 * 装载并校验 v2 配置文件:
 * - 不存在 (ENOENT) -> `{ state: 'absent' }`;
 * - 旧版配置 (缺 version、version === 1 或小于 2 的整数) -> 抛 `SweepError('CONFIG_NEEDS_MIGRATION')`;
 * - 读失败 / 非法 JSON / 结构非法 / 显式空 roots / 含 enabled 字段 -> 抛对应 `SweepError`。
 *
 * ### 数据流转示例
 * - Input: 文件内容 `{"version":2,"presets":{"node":{}}}` (省略 roots / exclude / rules)
 * - 流程: `readFile` -> `JSON.parse` -> 版本放行 (`version === 2`) -> `parseV2ConfigObject` 补 `[realpath(home)]` 与 32 项 `DEFAULT_EXCLUDE`
 * - Output: `{ state: 'ok', excludeExplicit: false, config: { version: 2, roots: [realHome], exclude: [...32 项], include: [], presets: { node: {} }, rules: [] } }`
 */
export async function loadConfig(
  path: string,
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  let raw: string;
  try {
    raw = await readFile(path, 'utf8');
  } catch (error) {
    const code = (error as { code?: string }).code;
    if (code === 'ENOENT') return { state: 'absent' };
    throw new SweepError(
      'CONFIG_READ_FAILED',
      `配置读取失败 (${path}): ${(error as Error).message}`,
      { path, ...(typeof code === 'string' ? { errno: code } : {}) },
      { cause: error },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(raw);
  } catch (error) {
    throw new SweepError(
      'CONFIG_CORRUPT_JSON',
      `配置损坏 (${path}): 不是合法 JSON (${(error as Error).message})`,
      { path },
      { cause: error },
    );
  }

  if (typeof data === 'object' && data !== null && !Array.isArray(data)) {
    const version = (data as { version?: unknown }).version;
    if (version === undefined || version === 1) {
      throw new SweepError(
        'CONFIG_NEEDS_MIGRATION',
        `配置 (${path}) 为旧版 v1 格式, 需要迁移到 v2 (运行 sweep migrate 或直接运行 sweep 触发自动迁移)`,
        { path, version: 1 },
      );
    }
    if (
      typeof version === 'number' &&
      Number.isInteger(version) &&
      version < 2
    ) {
      throw new SweepError(
        'CONFIG_NEEDS_MIGRATION',
        `配置 (${path}) 版本为 v${version}, 低于当前版本 v2`,
        { path, version },
      );
    }
  }

  const defaultRoot = resolveDefaultRoot(options.homedir);
  const parsed = parseV2ConfigObject(data, defaultRoot, DEFAULT_EXCLUDE);
  if (!parsed.ok) {
    throw new SweepError(
      'CONFIG_CORRUPT_SHAPE',
      `配置损坏 (${path}): ${parsed.failure.message}`,
      { path, field: parsed.failure.field },
    );
  }
  const { excludeExplicit, ...config } = parsed.value;
  return { state: 'ok', config, excludeExplicit };
}

/**
 * 装载已定位的配置: 显式来源 (`--config` / `SWEEP_CONFIG`) 缺失一律硬抛 `CONFIG_ABSENT`;
 * 仅 `platform-default` 保留软缺失 `{ state: 'absent' }`。
 */
export async function loadResolvedConfig(
  resolved: ResolvedConfigPath,
  options: LoadConfigOptions = {},
): Promise<LoadConfigResult> {
  const result = await loadConfig(resolved.path, options);
  if (result.state === 'absent' && resolved.source !== 'platform-default') {
    throw new SweepError(
      'CONFIG_ABSENT',
      `配置不存在 (${resolved.path}), 请检查路径`,
      { path: resolved.path, source: resolved.source },
    );
  }
  return result;
}

/** 扫描恒定跳过的保留目录名 (留在名单里只会造成假未命中告警, 静默剔除) */
const ALWAYS_IGNORED: ReadonlySet<string> = new Set(['.git']);

/** 合并配置与命令行追加名单: 去重保首见序, 静默剔除 `.git` */
export function mergeNames(
  configNames: string[],
  cliNames: string[],
): string[] {
  return [...new Set([...configNames, ...cliNames])].filter(
    (name) => !ALWAYS_IGNORED.has(name),
  );
}
