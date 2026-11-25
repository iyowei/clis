/**
 * 跨平台操作系统原生语言探测与语言标签归一化 (`macOS` / `Windows` / `Linux`)。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import { extractMacPreferredLanguage } from './bplist.ts';
import type { DetectedSystemLocale, LangPreference, Locale } from './types.ts';

const ENCODING_OR_MODIFIER_RE = /[.@].*$/;

/** 解析用户输入的语言偏好 (`system` | `en` | `zh`), 非法值返回 `null` */
export function parseLangPreference(raw: string): LangPreference | null {
  const cleaned = raw
    .trim()
    .replace(ENCODING_OR_MODIFIER_RE, '')
    .replaceAll('_', '-')
    .toLowerCase();
  if (
    cleaned === 'system' ||
    cleaned === 'auto' ||
    cleaned === 'os' ||
    cleaned === 'default'
  ) {
    return 'system';
  }
  if (cleaned === 'en' || cleaned === 'english' || cleaned.startsWith('en-')) {
    return 'en';
  }
  if (
    cleaned === 'zh' ||
    cleaned === 'chinese' ||
    cleaned === 'chs' ||
    cleaned === 'cht' ||
    cleaned.startsWith('zh-')
  ) {
    return 'zh';
  }
  return null;
}

/** 将任意操作系统区域/语言标签归类为 `'zh'` 或 `'en'` (`C` / `POSIX` 等中性值返回 `null`) */
export function classifyLocaleTag(raw: string): Locale | null {
  const firstSegment = raw.split(':')[0]?.trim() ?? '';
  if (firstSegment === '') return null;
  const cleaned = firstSegment
    .replace(ENCODING_OR_MODIFIER_RE, '')
    .replaceAll('_', '-')
    .trim()
    .toLowerCase();
  if (
    cleaned === '' ||
    cleaned === 'c' ||
    cleaned === 'posix' ||
    cleaned === 'utf-8' ||
    cleaned === 'utf8'
  ) {
    return null;
  }
  if (
    cleaned === 'zh' ||
    cleaned === 'chinese' ||
    cleaned === 'chs' ||
    cleaned === 'cht' ||
    cleaned.startsWith('zh-')
  ) {
    return 'zh';
  }
  if (/^[a-z]{2,3}(?:-[a-z0-9]+)*$/.test(cleaned)) {
    return 'en';
  }
  return null;
}

function detectFromEnvVars(
  env: Record<string, string | undefined>,
): DetectedSystemLocale | null {
  for (const key of ['LC_ALL', 'LC_MESSAGES', 'LANG', 'LANGUAGE'] as const) {
    const val = env[key];
    if (val === undefined || val.trim() === '') continue;
    const locale = classifyLocaleTag(val);
    if (locale !== null) {
      return { locale, rawTag: val.trim(), method: 'env' };
    }
  }
  return null;
}

function parseLinuxLocaleText(text: string): DetectedSystemLocale | null {
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#')) continue;
    const m = /^(?:LC_ALL|LC_MESSAGES|LANG)\s*=\s*["']?([^"'\s#]+)["']?/.exec(
      line,
    );
    const tag = m?.[1];
    if (tag === undefined) continue;
    const locale = classifyLocaleTag(tag);
    if (locale !== null) {
      return { locale, rawTag: tag, method: 'linux-conf' };
    }
  }
  return null;
}

function detectFromLinuxLocaleConf(
  etcDir = '/etc',
): DetectedSystemLocale | null {
  for (const file of ['locale.conf', 'default/locale']) {
    const target = join(etcDir, file);
    if (!existsSync(target)) continue;
    try {
      const found = parseLinuxLocaleText(readFileSync(target, 'utf8'));
      if (found !== null) return found;
    } catch {
      // 忽略权限或读取异常, 继续回退
    }
  }
  return null;
}

function detectMacOsPreferred(
  home: string,
  allowDefaultsFallback: boolean,
): DetectedSystemLocale | null {
  const plistPath = join(home, 'Library/Preferences/.GlobalPreferences.plist');
  if (existsSync(plistPath)) {
    try {
      const buf = readFileSync(plistPath);
      const tag = extractMacPreferredLanguage(buf);
      if (tag !== null) {
        const locale = classifyLocaleTag(tag);
        if (locale !== null) {
          return { locale, rawTag: tag, method: 'macos-prefs' };
        }
      }
    } catch {
      // 读取失败则继续回退
    }
  }
  if (allowDefaultsFallback && existsSync('/usr/bin/defaults')) {
    try {
      const res = spawnSync(
        '/usr/bin/defaults',
        ['read', '-g', 'AppleLanguages'],
        {
          encoding: 'utf8',
          timeout: 400,
        },
      );
      if (res.status === 0 && typeof res.stdout === 'string') {
        const m = /"([^"]+)"|([A-Za-z]{2,3}(?:-[A-Za-z0-9]+)*)/.exec(
          res.stdout,
        );
        const tag = (m?.[1] ?? m?.[2] ?? '').trim();
        const locale = classifyLocaleTag(tag);
        if (locale !== null) {
          return { locale, rawTag: tag, method: 'macos-prefs' };
        }
      }
    } catch {
      // 忽略子进程失败
    }
  }
  return null;
}

let cachedWindowsSystemLocale: DetectedSystemLocale | null | undefined;

function detectWindowsUiLanguage(): DetectedSystemLocale | null {
  if (cachedWindowsSystemLocale !== undefined) return cachedWindowsSystemLocale;
  const queries: ReadonlyArray<readonly [string, string]> = [
    ['HKCU\\Control Panel\\Desktop', 'PreferredUILanguages'],
    ['HKCU\\Control Panel\\Desktop\\MuiCached', 'MachinePreferredUILanguages'],
    ['HKCU\\Control Panel\\International', 'LocaleName'],
  ];
  for (const [regKey, valueName] of queries) {
    try {
      const res = spawnSync('reg.exe', ['query', regKey, '/v', valueName], {
        encoding: 'utf8',
        timeout: 500,
        windowsHide: true,
      });
      if (res.status !== 0 || typeof res.stdout !== 'string') continue;
      for (const line of res.stdout.split(/\r?\n/)) {
        if (!line.includes(valueName)) continue;
        const parts = line.trim().split(/\s{2,}/);
        const rawVal = parts[parts.length - 1]?.split('\\0')[0]?.trim() ?? '';
        const locale = classifyLocaleTag(rawVal);
        if (locale !== null) {
          cachedWindowsSystemLocale = {
            locale,
            rawTag: rawVal,
            method: 'windows-ui',
          };
          return cachedWindowsSystemLocale;
        }
      }
    } catch {
      // 忽略 reg.exe 异常
    }
  }
  cachedWindowsSystemLocale = null;
  return null;
}

function detectFromIntl(): DetectedSystemLocale | null {
  try {
    const tag = Intl.DateTimeFormat().resolvedOptions().locale;
    const locale = classifyLocaleTag(tag);
    if (locale !== null) {
      return { locale, rawTag: tag, method: 'intl' };
    }
  } catch {
    // 忽略 ICU 缺失异常
  }
  return null;
}

export interface DetectSystemLocaleOptions {
  platform?: NodeJS.Platform;
  homedir?: string;
  env?: Record<string, string | undefined>;
  etcDir?: string;
  allowSubprocess?: boolean;
}

/**
 * 探测操作系统原生首选语言:
 * - macOS 优先读 `.GlobalPreferences.plist` (`AppleLanguages`), 避免终端默认 `LANG=en_US.UTF-8` 误判;
 * - Windows 优先读注册表 UI 语言, 再回退 `Intl` 与环境变量;
 * - Linux 优先读 `LC_ALL` / `LC_MESSAGES` / `LANG`, 遇 `C.UTF-8` 等中性值时回退 `/etc/locale.conf`。
 */
export function detectSystemLocale(
  options: DetectSystemLocaleOptions = {},
): DetectedSystemLocale {
  const env = options.env ?? process.env;
  if (
    env.CLIS_TEST_OS_LOCALE !== undefined &&
    env.CLIS_TEST_OS_LOCALE.trim() !== ''
  ) {
    const locale = classifyLocaleTag(env.CLIS_TEST_OS_LOCALE);
    if (locale !== null) {
      return {
        locale,
        rawTag: env.CLIS_TEST_OS_LOCALE.trim(),
        method: 'test-override',
      };
    }
  }

  const hostTestFallback = (): DetectedSystemLocale | null => {
    if (options.env !== undefined && 'CLIS_TEST_OS_LOCALE' in options.env) {
      return null;
    }
    const raw = process.env.CLIS_TEST_OS_LOCALE;
    if (raw === undefined || raw.trim() === '') return null;
    const locale = classifyLocaleTag(raw);
    return locale !== null
      ? { locale, rawTag: raw.trim(), method: 'test-override' }
      : null;
  };

  const platform = options.platform ?? process.platform;
  const realHome = osHomedir();
  const home = options.homedir ?? realHome;
  const allowSubprocess =
    options.allowSubprocess ?? options.homedir === undefined;

  if (platform === 'darwin') {
    return (
      detectMacOsPreferred(home, allowSubprocess && home === realHome) ??
      detectFromEnvVars(env) ??
      hostTestFallback() ??
      detectFromIntl() ?? { locale: 'en', rawTag: 'en', method: 'fallback' }
    );
  }

  if (platform === 'win32') {
    const winRes = allowSubprocess ? detectWindowsUiLanguage() : null;
    return (
      winRes ??
      detectFromEnvVars(env) ??
      hostTestFallback() ??
      detectFromIntl() ?? {
        locale: 'en',
        rawTag: 'en',
        method: 'fallback',
      }
    );
  }

  return (
    detectFromEnvVars(env) ??
    detectFromLinuxLocaleConf(options.etcDir) ??
    hostTestFallback() ??
    detectFromIntl() ?? { locale: 'en', rawTag: 'en', method: 'fallback' }
  );
}
