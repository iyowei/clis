/**
 * `sweep init` 输入解析与路径/目录锚点前置校验原语 (中英双语)。
 */
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type PresetsMap,
  createDefaultPresets,
  isPresetName,
} from '@iyowei/sweep';

import { sanitizeLine } from './render.ts';

const WHITESPACE = /\s/;

function expandHome(token: string, home: string): string {
  if (token === '~') return home;
  if (token.startsWith('~/') || token.startsWith('~\\'))
    return join(home, token.slice(2));
  return token;
}

export function splitAnswer(answer: string): string[] {
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

export function parseNameList(
  answer: string | null,
  fallback: string[],
): string[] {
  if (answer === null) return [...fallback];
  const items = splitAnswer(answer);
  return items.length > 0 ? items : [...fallback];
}

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

export interface RootCheckResult {
  missing: string[];
  notDir: string[];
  symlinked: { root: string; link: string }[];
}

export async function checkRoots(
  roots: readonly string[],
  deps: {
    rootExists?: (path: string) => Promise<boolean>;
    rootIsDirectory: (path: string) => Promise<boolean>;
    firstSymlinkOnRoot: (root: string) => Promise<string | null>;
  },
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

export async function checkTargetWritable(
  configPath: string,
  configIsDirectory: ((path: string) => Promise<boolean>) | undefined,
  firstSymlinkOnTarget: (target: string) => Promise<string | null>,
  reportError: (line: string) => void,
  locale: Locale,
): Promise<boolean> {
  if (
    configIsDirectory !== undefined &&
    (await configIsDirectory(configPath))
  ) {
    reportError(
      t(
        locale,
        `配置路径是既有目录, 无法写入文件: ${sanitizeLine(configPath)}; 请用 --config 指定文件路径或先移走该目录`,
        `Config path is an existing directory: ${sanitizeLine(configPath)}; pass --config <file> or move the directory`,
      ),
    );
    return false;
  }
  const link = await firstSymlinkOnTarget(configPath);
  if (link !== null) {
    reportError(
      t(
        locale,
        `配置路径锚点链上有符号链接: ${sanitizeLine(link)} (配置: ${sanitizeLine(configPath)}); 写入会跟随符号链接改写其目标, 请改写为不含符号链接的真实路径`,
        `Config path contains a symlink on its anchor chain: ${sanitizeLine(link)} (config: ${sanitizeLine(configPath)}); use a real path`,
      ),
    );
    return false;
  }
  return true;
}
