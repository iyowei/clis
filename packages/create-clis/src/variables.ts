/**
 * 五变量收集、校验与旗标解析 (支持中英双语错误文案): `argv` -> `CliOptions`, 选项 + 环境 -> `Vocabulary`。
 */
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

import {
  type LangPreference,
  type Locale,
  parseLangPreference,
  t,
} from '@iyowei/cli-i18n';

import { type Vocabulary } from './render.ts';
import { type Tier } from './tier.ts';

export interface CliOptions {
  name?: string;
  suggestedName?: string;
  scope?: string;
  bin?: string;
  owner?: string;
  repo?: string;
  tier?: Tier;
  lang?: LangPreference;
  git: boolean;
  install: boolean;
  yes: boolean;
  help?: boolean;
  version?: boolean;
  dir?: string;
}

export interface Environment {
  gitUserName: string | null;
}

export const DEFAULT_TIER: Tier = 'standard';

const KEBAB_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const SLUG_LIKE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;
const SCOPE = /^@[a-z0-9][a-z0-9._-]*$/;
const REPO_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+\/[^\s]+$/i;

export function validateName(
  name: string,
  locale: Locale = 'zh',
): string | null {
  if (name.length === 0) {
    return t(locale, '项目名不能为空', 'Project name cannot be empty');
  }
  if (!KEBAB_NAME.test(name)) {
    return t(
      locale,
      `项目名 ${JSON.stringify(name)} 不是 kebab-case (只允许小写字母 / 数字, 以 - 分隔, 如 my-tool)`,
      `Project name ${JSON.stringify(name)} must be kebab-case (lowercase letters, digits, and single hyphens, e.g. my-tool)`,
    );
  }
  return null;
}

export function validateBinName(
  bin: string,
  locale: Locale = 'zh',
): string | null {
  if (bin.length === 0) {
    return t(locale, 'bin 名不能为空', 'Binary name cannot be empty');
  }
  if (!SLUG_LIKE.test(bin)) {
    return t(
      locale,
      `bin 名 ${JSON.stringify(bin)} 不可用作命令 (需字母 / 数字起止, 中间可含 . _ -, 不得含空白 / 路径分隔符 / shell 元字符)`,
      `Binary name ${JSON.stringify(bin)} is invalid (must start/end with alphanumeric, allowing . _ - only)`,
    );
  }
  return null;
}

export function validateScope(
  scope: string,
  locale: Locale = 'zh',
): string | null {
  if (scope.length === 0) return null;
  if (!SCOPE.test(scope)) {
    return t(
      locale,
      `scope ${JSON.stringify(scope)} 不是合法 npm scope (需 @ 开头的小写名, 如 @me)`,
      `Scope ${JSON.stringify(scope)} is not a valid npm scope (must start with '@' in lowercase, e.g. @me)`,
    );
  }
  return null;
}

export function validateOwner(
  owner: string,
  locale: Locale = 'zh',
): string | null {
  if (owner.length === 0) {
    return t(locale, 'owner 不能为空', 'Owner cannot be empty');
  }
  if (!SLUG_LIKE.test(owner)) {
    return t(
      locale,
      `owner ${JSON.stringify(owner)} 含不可用于仓库地址的字符 (只接受字母 / 数字 / . _ -)`,
      `Owner ${JSON.stringify(owner)} contains invalid characters (only letters, digits, and . _ - allowed)`,
    );
  }
  return null;
}

export function normalizeRepoUrl(url: string): string {
  return url
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

export function validateRepoUrl(
  url: string,
  locale: Locale = 'zh',
): string | null {
  if (url.length === 0) {
    return t(locale, '仓库地址不能为空', 'Repository URL cannot be empty');
  }
  const normalized = normalizeRepoUrl(url);
  if (!REPO_URL.test(url) || !REPO_URL.test(normalized)) {
    return t(
      locale,
      `仓库地址 ${JSON.stringify(url)} 不是合法 URL (需 scheme://host/path, 如 https://github.com/me/my-tool)`,
      `Repository URL ${JSON.stringify(url)} is invalid (expected scheme://host/path, e.g. https://github.com/me/my-tool)`,
    );
  }
  return null;
}

export function provided(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

export function deriveBinName(name: string): string {
  const segments = name.split('-').filter((segment) => segment.length > 0);
  if (segments.length <= 2) return name;
  const head = segments[0]!;
  const initials = segments
    .slice(1)
    .map((segment) => segment.charAt(0))
    .join('');
  return `${head}-${initials}`;
}

const VALUE_FLAGS: Readonly<
  Record<string, 'name' | 'scope' | 'bin' | 'owner' | 'repo'>
> = {
  '--name': 'name',
  '--scope': 'scope',
  '--bin': 'bin',
  '--owner': 'owner',
  '--repo': 'repo',
};

const TIERS: ReadonlySet<string> = new Set(['core', 'standard', 'full']);

function isTier(value: string): value is Tier {
  return TIERS.has(value);
}

function valueTokenAt(argv: string[], index: number): string | undefined {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return undefined;
  return next;
}

export function parseFlags(
  argv: string[],
  locale: Locale = 'zh',
): CliOptions | { error: string } {
  const options: CliOptions = { git: true, install: true, yes: false };
  let afterDashDash = false;
  let unescapedSubcommandDir: 'update' | 'lang' | undefined;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!afterDashDash && token === '--') {
      afterDashDash = true;
      continue;
    }

    if (afterDashDash || !token.startsWith('-')) {
      if (options.dir !== undefined) {
        return {
          error: t(
            locale,
            `只接受一个目标目录位置参数, 多余的: ${JSON.stringify(token)}`,
            `Only one target directory argument is accepted; unexpected: ${JSON.stringify(token)}`,
          ),
        };
      }
      if (!afterDashDash && (token === 'update' || token === 'lang')) {
        unescapedSubcommandDir = token;
      }
      options.dir = token;
      continue;
    }

    if (token === '-h') {
      options.help = true;
      continue;
    }
    if (token === '-V') {
      options.version = true;
      return options;
    }

    if (!token.startsWith('--')) {
      return {
        error: t(
          locale,
          `未知旗标 ${JSON.stringify(token)}`,
          `Unknown flag ${JSON.stringify(token)}`,
        ),
      };
    }

    const inlineIndex = token.indexOf('=');
    const flag = inlineIndex === -1 ? token : token.slice(0, inlineIndex);
    const inline =
      inlineIndex === -1 ? undefined : token.slice(inlineIndex + 1);

    if (flag === '--help' || flag === '--version') {
      if (inline !== undefined) {
        return {
          error: t(
            locale,
            `开关旗标 ${flag} 不接受值`,
            `Boolean flag ${flag} does not take a value`,
          ),
        };
      }
      if (flag === '--help') {
        options.help = true;
        continue;
      }
      options.version = true;
      return options;
    }

    if (flag === '--yes' || flag === '--no-git' || flag === '--no-install') {
      if (inline !== undefined) {
        return {
          error: t(
            locale,
            `开关旗标 ${flag} 不接受值`,
            `Boolean flag ${flag} does not take a value`,
          ),
        };
      }
      if (flag === '--yes') options.yes = true;
      else if (flag === '--no-git') options.git = false;
      else options.install = false;
      continue;
    }

    if (flag === '--lang') {
      const value = inline ?? valueTokenAt(argv, index);
      if (value === undefined || value === '') {
        return {
          error: t(
            locale,
            '旗标 --lang 缺少值 (system | en | zh)',
            'Flag --lang requires a value (system | en | zh)',
          ),
        };
      }
      if (inline === undefined) index += 1;
      const parsedLang = parseLangPreference(value);
      if (parsedLang === null) {
        return {
          error: t(
            locale,
            `旗标 --lang 只接受 system / en / zh, 收到 ${JSON.stringify(value)}`,
            `Flag --lang expects system, en, or zh; received ${JSON.stringify(value)}`,
          ),
        };
      }
      options.lang = parsedLang;
      continue;
    }

    if (flag === '--tier') {
      const value = inline ?? valueTokenAt(argv, index);
      if (value === undefined) {
        return {
          error: t(
            locale,
            '旗标 --tier 缺少值 (core | standard | full)',
            'Flag --tier requires a value (core | standard | full)',
          ),
        };
      }
      if (inline === undefined) index += 1;
      if (!isTier(value)) {
        return {
          error: t(
            locale,
            `旗标 --tier 只接受 core / standard / full, 收到 ${JSON.stringify(value)}`,
            `Flag --tier expects core, standard, or full; received ${JSON.stringify(value)}`,
          ),
        };
      }
      options.tier = value;
      continue;
    }

    const target = VALUE_FLAGS[flag];
    if (target === undefined) {
      return {
        error: t(
          locale,
          `未知旗标 ${JSON.stringify(flag)}`,
          `Unknown flag ${JSON.stringify(flag)}`,
        ),
      };
    }
    const value = inline ?? valueTokenAt(argv, index);
    if (value === undefined) {
      return {
        error: t(
          locale,
          `旗标 ${flag} 缺少值`,
          `Flag ${flag} requires a value`,
        ),
      };
    }
    if (inline === undefined) index += 1;
    options[target] = value;
  }

  if (options.help) return options;

  if (unescapedSubcommandDir === 'update' && options.name !== 'update') {
    return {
      error: t(
        locale,
        'update 子命令须位于首个参数 (用法: create-clis update [--check] [--pm <pm>] [--registry <url>] [--force] [--verbose]; 若确需创建 ./update 目录请传 --name update 或使用 create-clis -- update)',
        "'update' must be the first argument (usage: create-clis update [--check]; to scaffold './update', pass --name update or create-clis -- update)",
      ),
    };
  }
  if (unescapedSubcommandDir === 'lang' && options.name !== 'lang') {
    return {
      error: t(
        locale,
        'lang 子命令须位于首个参数 (用法: create-clis lang [system|en|zh]; 若确需创建 ./lang 目录请传 --name lang 或使用 create-clis -- lang)',
        "'lang' must be the first argument (usage: create-clis lang [system|en|zh]; to scaffold './lang', pass --name lang or create-clis -- lang)",
      ),
    };
  }

  if (options.name === undefined && options.dir !== undefined) {
    const derived = basename(options.dir);
    const fallback =
      derived === '.' || derived === '..'
        ? basename(resolve(options.dir))
        : derived;
    if (fallback.length > 0) options.suggestedName = fallback;
  }

  return options;
}

export function resolveVocabulary(
  opts: CliOptions,
  env: Environment,
  locale: Locale = 'zh',
): Vocabulary | { error: string } {
  const name = provided(opts.name) ?? provided(opts.suggestedName);
  if (name === undefined) {
    return {
      error: t(
        locale,
        '缺少项目名: 用位置参数或 --name 提供 (kebab-case, 如 my-tool)',
        'Missing project name: provide a target directory or --name (kebab-case, e.g. my-tool)',
      ),
    };
  }
  const nameError = validateName(name, locale);
  if (nameError !== null) return { error: nameError };

  const scope = provided(opts.scope) ?? '';
  const scopeError = validateScope(scope, locale);
  if (scopeError !== null) return { error: scopeError };

  const binName = provided(opts.bin) ?? deriveBinName(name);
  const binError = validateBinName(binName, locale);
  if (binError !== null) return { error: binError };

  const owner = provided(opts.owner) ?? provided(env.gitUserName ?? undefined);
  if (owner === undefined) {
    return {
      error: t(
        locale,
        '缺少 owner: 用 --owner 提供, 或配置 git 全局 user.name',
        'Missing owner: pass --owner or configure git global user.name',
      ),
    };
  }
  const ownerError = validateOwner(owner, locale);
  if (ownerError !== null) return { error: ownerError };

  const rawRepo = provided(opts.repo) ?? `https://github.com/${owner}/${name}`;
  const repoError = validateRepoUrl(rawRepo, locale);
  if (repoError !== null) return { error: repoError };

  return { name, scope, binName, owner, repoUrl: normalizeRepoUrl(rawRepo) };
}

export function readGitUserName(): string | null {
  try {
    const result = spawnSync('git', ['config', '--global', 'user.name'], {
      encoding: 'utf8',
    });
    if (result.status !== 0) return null;
    const trimmed = (result.stdout ?? '').trim();
    return trimmed.length > 0 ? trimmed : null;
  } catch {
    return null;
  }
}
