/**
 * 按工具独立的语言配置读写、四层优先级决策、`--lang` 参数剥离与终端混排列宽工具。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { dirname, posix, win32 } from 'node:path';

import { detectSystemLocale, parseLangPreference } from './detect.ts';
import type {
  LangPreference,
  Locale,
  ResolveLocaleOptions,
  ResolvedLocale,
} from './types.ts';

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
);

/** 由工具名派生专属语言环境变量名 (`fan` -> `FAN_LANG`, `create-clis` -> `CREATE_CLIS_LANG`) */
export function defaultToolLangEnvVar(toolName: string): string {
  const prefix = toolName
    .trim()
    .replace(/[^A-Za-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .toUpperCase();
  return `${prefix}_LANG`;
}

/** 计算单个 CLI 工具独立的持久化语言配置文件路径 (`~/.config/<tool>/lang.json` 或 `%APPDATA%\<tool>\lang.json`) */
export function resolveLangConfigPath(options: {
  toolName: string;
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: Record<string, string | undefined>;
}): string {
  const platform = options.platform ?? process.platform;
  const env = options.env ?? process.env;
  const home = options.homedir ?? env.HOME ?? osHomedir();
  if (platform === 'win32') {
    const appData = env.APPDATA;
    if (appData !== undefined && appData !== '') {
      return win32.join(appData, options.toolName, 'lang.json');
    }
    const base =
      env.USERPROFILE !== undefined && env.USERPROFILE !== ''
        ? env.USERPROFILE
        : home;
    return win32.join(
      base,
      'AppData',
      'Roaming',
      options.toolName,
      'lang.json',
    );
  }
  return posix.join(home, '.config', options.toolName, 'lang.json');
}

/** 读取已保存的语言偏好; 文件不存在或损坏时安全返回 `null` (视为默认 `'system'`) */
export function readPersistedLang(configPath: string): LangPreference | null {
  if (!existsSync(configPath)) return null;
  try {
    const raw = readFileSync(configPath, 'utf8');
    const parsed = JSON.parse(raw) as { lang?: unknown };
    if (typeof parsed?.lang !== 'string') return null;
    return parseLangPreference(parsed.lang);
  } catch {
    return null;
  }
}

/** 写入单个工具的语言偏好配置 (`system` | `en` | `zh`) */
export function writePersistedLang(
  configPath: string,
  lang: LangPreference,
): void {
  mkdirSync(dirname(configPath), { recursive: true });
  writeFileSync(configPath, `${JSON.stringify({ lang }, null, 2)}\n`, 'utf8');
}

/**
 * 按四层确定性优先级解析当前 CLI 生效语言:
 * `--lang` 旗标 > `<TOOL>_LANG` 环境变量 > `CLIS_LANG` 环境变量 > 工具独立 `lang.json` (默认 `system`)。
 */
export function resolveCliLocale(
  options: ResolveLocaleOptions,
): ResolvedLocale {
  const env = options.env ?? process.env;
  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? env.HOME ?? osHomedir();
  const envVarName =
    options.envVarName ?? defaultToolLangEnvVar(options.toolName);
  const configPath =
    options.configPath ??
    resolveLangConfigPath({
      toolName: options.toolName,
      platform,
      homedir: home,
      env,
    });
  const system =
    options.detectSystem?.() ??
    detectSystemLocale({ platform, homedir: home, env });

  const finalize = (
    preference: LangPreference,
    source: ResolvedLocale['source'],
  ): ResolvedLocale => ({
    locale: preference === 'system' ? system.locale : preference,
    preference,
    source,
    envVarName,
    configPath,
    system,
  });

  if (options.flag !== undefined && options.flag.trim() !== '') {
    const fromFlag = parseLangPreference(options.flag);
    if (fromFlag !== null) return finalize(fromFlag, 'flag');
  }

  const toolEnvVal = env[envVarName];
  if (toolEnvVal !== undefined && toolEnvVal.trim() !== '') {
    const fromToolEnv = parseLangPreference(toolEnvVal);
    if (fromToolEnv !== null) return finalize(fromToolEnv, 'tool-env');
  }

  const suiteEnvVal = env.CLIS_LANG;
  if (suiteEnvVal !== undefined && suiteEnvVal.trim() !== '') {
    const fromSuiteEnv = parseLangPreference(suiteEnvVal);
    if (fromSuiteEnv !== null) return finalize(fromSuiteEnv, 'suite-env');
  }

  const testRealHome = process.env.CLIS_TEST_REAL_HOME;
  const isUnisolatedTestHome =
    testRealHome !== undefined &&
    testRealHome !== '' &&
    options.configPath === undefined &&
    options.homedir === undefined &&
    home === testRealHome;

  if (!isUnisolatedTestHome) {
    const persisted = readPersistedLang(configPath);
    if (persisted !== null) {
      return finalize(persisted, 'config');
    }
  }

  return finalize('system', 'default');
}

export interface StripLangResult {
  /** 剥离 `--lang` 后的剩余参数列表 (严格保留 `--` 及其后全部位置参数) */
  argv: string[];
  /** 解析出的 `--lang` 偏好值 (未传则为 `undefined`) */
  lang?: LangPreference;
  /** `--lang` 缺值或非法时的已本地化错误消息 */
  error?: string;
}

function formatInvalidLangError(
  raw: string | null,
  fallbackLocale: Locale,
): string {
  if (raw === null) {
    return fallbackLocale === 'zh'
      ? '参数 --lang 缺少取值 (可选值: system | en | zh)'
      : 'Option --lang requires a value (expected: system | en | zh)';
  }
  return fallbackLocale === 'zh'
    ? `参数 --lang 不支持 "${raw}" (可选值: system | en | zh)`
    : `Invalid --lang value "${raw}" (expected: system | en | zh)`;
}

/**
 * 在进入各工具自身参数解析前统一提取并剥离 `--lang <system|en|zh>` / `--lang=<val>`:
 * - 遇到 `--` 终止符立即停止剥离, 其后原样保留;
 * - 支持传入 `valueFlags` 跳过携带独立取值的旗标 (如 `--exclude --lang` 不会误判为语言旗标);
 * - 若 `--lang` 非法, 按当前系统/已保存语言返回本地化错误消息。
 */
export function stripLangArgs(
  argv: readonly string[],
  options: {
    fallbackLocale?: Locale;
    valueFlags?: ReadonlySet<string>;
  } = {},
): StripLangResult {
  const fallbackLocale = options.fallbackLocale ?? 'en';
  const valueFlags = options.valueFlags;
  const rest: string[] = [];
  let lang: LangPreference | undefined;
  let afterDash = false;

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (afterDash) {
      rest.push(arg);
      continue;
    }
    if (arg === '--') {
      afterDash = true;
      rest.push(arg);
      continue;
    }
    if (arg === '--lang') {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) {
        return {
          argv: [...argv],
          error: formatInvalidLangError(null, fallbackLocale),
        };
      }
      const parsed = parseLangPreference(next);
      if (parsed === null) {
        return {
          argv: [...argv],
          error: formatInvalidLangError(next, fallbackLocale),
        };
      }
      lang = parsed;
      i += 1;
      continue;
    }
    if (arg.startsWith('--lang=')) {
      const raw = arg.slice('--lang='.length);
      if (raw.trim() === '') {
        return {
          argv: [...argv],
          error: formatInvalidLangError(null, fallbackLocale),
        };
      }
      const parsed = parseLangPreference(raw);
      if (parsed === null) {
        return {
          argv: [...argv],
          error: formatInvalidLangError(raw, fallbackLocale),
        };
      }
      lang = parsed;
      continue;
    }
    rest.push(arg);
    if (valueFlags?.has(arg) && i + 1 < argv.length) {
      const val = argv[i + 1]!;
      if (val !== '--') {
        rest.push(val);
        i += 1;
      }
    }
  }

  return { argv: rest, lang };
}

/** 轻量双语选择器 (`t(locale, '中文', 'English')`) */
export function t<T>(locale: Locale, zh: T, en: T): T {
  return locale === 'zh' ? zh : en;
}

/** 计算剥除 ANSI 转义后的终端显示列宽 (CJK 与常见全角符号计 2 列) */
export function displayWidth(text: string): number {
  const plain = text.replace(ANSI_ESCAPE_RE, '');
  let width = 0;
  for (const ch of plain) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 按终端真实显示列宽右侧补空格 */
export function padEndDisplay(text: string, targetCols: number): string {
  const pad = Math.max(0, targetCols - displayWidth(text));
  return pad > 0 ? `${text}${' '.repeat(pad)}` : text;
}

/** 按终端真实显示列宽左侧补空格 */
export function padStartDisplay(text: string, targetCols: number): string {
  const pad = Math.max(0, targetCols - displayWidth(text));
  return pad > 0 ? `${' '.repeat(pad)}${text}` : text;
}
