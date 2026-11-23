/**
 * 五变量收集、校验与旗标解析: `argv` -> `CliOptions`, 选项 + 环境 -> 词汇表 (`Vocabulary`)。
 *
 * 上游供 `cli.ts` 与 `prompt.ts` 消费, 下游产出 `render.ts` 同源的 `Vocabulary` (不碰占位符拼写)。
 * 默认值与校验口径见 `docs/designs/scaffold-contract.md`: `name` 必填 kebab-case, `scope` 缺省空串,
 * `binName` 由 `name` 派生短形态, `owner` 缺省取 git 全局 `user.name`, `repoUrl` 合成自 `owner`/`name`。
 * 除 `readGitUserName` 外全为纯函数, 便于单元测试注入 `Environment`。
 */
import { spawnSync } from 'node:child_process';
import { basename, resolve } from 'node:path';

import { type Vocabulary } from './render.ts';
import { type Tier } from './tier.ts';

/** 旗标解析结果: 五个变量全部可选 (缺省在 resolveVocabulary 派生), 开关、帮助/版本与目标目录 */
export interface CliOptions {
  /** 显式 --name 指定的项目名 */
  name?: string;
  /** 由位置参数目录 basename 推导的项目名默认值 (交互态非法时忽略重问; --yes 时照常校验) */
  suggestedName?: string;
  /** npm scope (如 @me); 缺省空串 (裸包名) */
  scope?: string;
  /** 主 bin 名; 缺省由 name 派生 */
  bin?: string;
  /** 仓库所有者; 缺省取 git 全局 user.name */
  owner?: string;
  /** 仓库地址; 缺省由 owner 与 name 合成 */
  repo?: string;
  /** 装备档位; 缺省 DEFAULT_TIER */
  tier?: Tier;
  /** 收尾是否执行 git init */
  git: boolean;
  /** 收尾是否安装依赖 */
  install: boolean;
  /** 全部取默认值, 零交互 */
  yes: boolean;
  /** 显示帮助 (-h / --help) */
  help?: boolean;
  /** 显示版本号 (-V / --version) */
  version?: boolean;
  /** 目标目录 (位置参数原样; 缺省由生成流程按项目名落到当前目录下) */
  dir?: string;
}

/** 环境面: 默认值的外部依赖, 由调用方 (CLI 入口) 读入后注入; 测试不读真实环境 */
export interface Environment {
  /** git 全局 user.name; 读不到为 null */
  gitUserName: string | null;
}

/** 默认档位 (scaffold-contract.md「档位」) */
export const DEFAULT_TIER: Tier = 'standard';

/** kebab-case: 小写字母 / 数字分段, 段间单个连字符 (不居首尾, 不连写) */
const KEBAB_NAME = /^[a-z0-9]+(-[a-z0-9]+)*$/;

/** URL 段 / 命令名的公共形态: 字母数字起止, 中段可含 . _ - (bin 名与 owner 共用同一字符集) */
const SLUG_LIKE = /^[a-zA-Z0-9](?:[a-zA-Z0-9._-]*[a-zA-Z0-9])?$/;

/** npm scope: @ 开头的小写包名形态 */
const SCOPE = /^@[a-z0-9][a-z0-9._-]*$/;

/**
 * 仓库地址: scheme://host/path。
 * path 段是硬要求 —— 替换引擎 (render.ts 的 parseRepoSlug) 要从路径段解出裸 slug 形态。
 */
const REPO_URL = /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+\/[^\s]+$/i;

/**
 * 校验项目名 (kebab-case 且可作目录名 / 包名); 合法返回 null, 非法返回原因。
 */
export function validateName(name: string): string | null {
  if (name.length === 0) return '项目名不能为空';
  if (!KEBAB_NAME.test(name)) {
    return `项目名 ${JSON.stringify(name)} 不是 kebab-case (只允许小写字母 / 数字, 以 - 分隔, 如 my-tool)`;
  }
  return null;
}

/**
 * 校验 bin 名在命令行上可用: 字母 / 数字起止, 中段可含 . _ -;
 * 空白 / 路径分隔符 / shell 元字符一律拒绝 (它们会让命令不可直接调用)。
 */
export function validateBinName(bin: string): string | null {
  if (bin.length === 0) return 'bin 名不能为空';
  if (!SLUG_LIKE.test(bin)) {
    return `bin 名 ${JSON.stringify(bin)} 不可用作命令 (需字母 / 数字起止, 中间可含 . _ -, 不得含空白 / 路径分隔符 / shell 元字符)`;
  }
  return null;
}

/** 校验 npm scope: 空串 (裸包名) 合法; 非空须为 @ 开头的小写名 */
export function validateScope(scope: string): string | null {
  if (scope.length === 0) return null;
  if (!SCOPE.test(scope)) {
    return `scope ${JSON.stringify(scope)} 不是合法 npm scope (需 @ 开头的小写名, 如 @me)`;
  }
  return null;
}

/** 校验 owner: 会拼进仓库地址与裸 slug, 只接受 URL 段可用字符 */
export function validateOwner(owner: string): string | null {
  if (owner.length === 0) return 'owner 不能为空';
  if (!SLUG_LIKE.test(owner)) {
    return `owner ${JSON.stringify(owner)} 含不可用于仓库地址的字符 (只接受字母 / 数字 / . _ -)`;
  }
  return null;
}

/** 归一化仓库地址: 剥除末尾连续 `/`、末尾 `.git` (不区分大小写) 及残余末尾 `/` */
export function normalizeRepoUrl(url: string): string {
  return url
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '')
    .replace(/\/+$/, '');
}

/** 校验仓库地址 (scheme://host/path 形态, 且归一化剥除尾斜杠与 `.git` 后仍具非空路径段) */
export function validateRepoUrl(url: string): string | null {
  if (url.length === 0) return '仓库地址不能为空';
  const normalized = normalizeRepoUrl(url);
  if (!REPO_URL.test(url) || !REPO_URL.test(normalized)) {
    return `仓库地址 ${JSON.stringify(url)} 不是合法 URL (需 scheme://host/path, 如 https://github.com/me/my-tool)`;
  }
  return null;
}

/**
 * 空串视同未提供 (旗标允许 `--name=` 这类写法, 但语义上等于没给)。
 */
export function provided(value: string | undefined): string | undefined {
  return value !== undefined && value.length > 0 ? value : undefined;
}

/**
 * 由项目名派生 bin 短形态: 三段及以上取「首段 + 其余段首字母」(如 `sweep-node-modules` -> `sweep-nm`);
 * 一段 / 两段名本身已是短形态, 原样保留 (如 `my-tool` 缩写为 `my-t` 失去辨识度)。
 * 只做派生, 合法性由 `validateBinName` 兜底; 用户可用 `--bin` 覆盖。
 *
 * ### 数据流转示例
 * ```text
 * Input:  name = 'sweep-node-modules' (两段名如 'my-tool' 直接原样返回)
 * Step 1: 按 '-' 切段并过滤空段 -> segments = ['sweep', 'node', 'modules'] (长度 >= 3)
 * Step 2: 取首段 'sweep' + 其余各段首字母 'n' + 'm'
 * Output: 'sweep-nm'
 * ```
 */
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

/** 值旗标 → CliOptions 字段 (开关与 --tier 单独处理) */
const VALUE_FLAGS: Readonly<
  Record<string, 'name' | 'scope' | 'bin' | 'owner' | 'repo'>
> = {
  '--name': 'name',
  '--scope': 'scope',
  '--bin': 'bin',
  '--owner': 'owner',
  '--repo': 'repo',
};

/** 合法档位集合 */
const TIERS: ReadonlySet<string> = new Set(['core', 'standard', 'full']);

function isTier(value: string): value is Tier {
  return TIERS.has(value);
}

/**
 * 取下一 token 作旗标值: 缺失或呈旗标形态 (- 起头) 时返回 undefined (调用方报缺值)。
 * 防 `--name --scope @me` 把 `--scope` 吞成 name 的值, 该旗标从此不被解析。
 */
function valueTokenAt(argv: string[], index: number): string | undefined {
  const next = argv[index + 1];
  if (next === undefined || next.startsWith('-')) return undefined;
  return next;
}

/**
 * 解析命令行旗标 (`argv` 为脚本名之后的参数段; 仅 `update` 子命令由 `cli.ts` 先行拦截)。
 *
 * 约定:
 * - 支持 `-h`/`--help`、`-V`/`--version` (命中即置位并提前返回) 与 `--` 终止选项解析
 *   (其后 token 均视作位置参数 `dir`, 可逃逸以 `-` 开头或名为 `update` 的目录);
 * - 位置参数是目标目录 `[dir]`; 未给 `--name` 时由目录 basename 推导 `suggestedName`
 *   (`.` / `..` 回退 `resolve(dir)` 的 basename), 交互模式对其非法值丢弃重问、`--yes` 模式照常校验;
 * - 值旗标支持 `--name x` 与 `--name=x`, 重复后者胜; 本函数只判语法形态与 `--tier` 枚举,
 *   字段值语义校验统一交 `resolveVocabulary` / `askAll`。
 *
 * ### 数据流转示例
 * ```text
 * Input:  argv = ['./pkgs/my-tool', '--scope=@me', '--no-git', '--tier', 'full']
 * Step 1: 逐 token 消费 -> dir='./pkgs/my-tool', scope='@me', git=false, tier='full'
 * Step 2: options.name 未给 -> 由 dir basename 派生 suggestedName = 'my-tool' (不写死 name)
 * Output: { dir: './pkgs/my-tool', suggestedName: 'my-tool', scope: '@me', tier: 'full',
 *           git: false, install: true, yes: false }
 * ```
 */
export function parseFlags(argv: string[]): CliOptions | { error: string } {
  const options: CliOptions = { git: true, install: true, yes: false };
  let afterDashDash = false;
  let unescapedUpdateDir = false;

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!afterDashDash && token === '--') {
      afterDashDash = true;
      continue;
    }

    if (afterDashDash || !token.startsWith('-')) {
      if (options.dir !== undefined) {
        return {
          error: `只接受一个目标目录位置参数, 多余的: ${JSON.stringify(token)}`,
        };
      }
      if (!afterDashDash && token === 'update') {
        unescapedUpdateDir = true;
      }
      options.dir = token;
      continue;
    }

    if (token === '-h') {
      options.help = true;
      return options;
    }
    if (token === '-V') {
      options.version = true;
      return options;
    }

    if (!token.startsWith('--')) {
      return { error: `未知旗标 ${JSON.stringify(token)}` };
    }

    const inlineIndex = token.indexOf('=');
    const flag = inlineIndex === -1 ? token : token.slice(0, inlineIndex);
    const inline =
      inlineIndex === -1 ? undefined : token.slice(inlineIndex + 1);

    if (flag === '--help' || flag === '--version') {
      if (inline !== undefined) return { error: `开关旗标 ${flag} 不接受值` };
      if (flag === '--help') options.help = true;
      else options.version = true;
      return options;
    }

    if (flag === '--yes' || flag === '--no-git' || flag === '--no-install') {
      if (inline !== undefined) return { error: `开关旗标 ${flag} 不接受值` };
      if (flag === '--yes') options.yes = true;
      else if (flag === '--no-git') options.git = false;
      else options.install = false;
      continue;
    }

    if (flag === '--tier') {
      const value = inline ?? valueTokenAt(argv, index);
      if (value === undefined) {
        return { error: '旗标 --tier 缺少值 (core | standard | full)' };
      }
      if (inline === undefined) index += 1;
      if (!isTier(value)) {
        return {
          error: `旗标 --tier 只接受 core / standard / full, 收到 ${JSON.stringify(value)}`,
        };
      }
      options.tier = value;
      continue;
    }

    const target = VALUE_FLAGS[flag];
    if (target === undefined) {
      return { error: `未知旗标 ${JSON.stringify(flag)}` };
    }
    const value = inline ?? valueTokenAt(argv, index);
    if (value === undefined) return { error: `旗标 ${flag} 缺少值` };
    if (inline === undefined) index += 1;
    options[target] = value;
  }

  if (unescapedUpdateDir && options.name !== 'update') {
    return {
      error:
        'update 子命令须位于首个参数 (用法: create-clis update [--check] [--pm <pm>] [--registry <url>] [--force] [--verbose]; 若确需创建 ./update 目录请传 --name update 或使用 create-clis -- update)',
    };
  }

  if (options.name === undefined && options.dir !== undefined) {
    // `.` / `..` 的 basename 是自身而非目录名 (`create-clis . --yes` 会拿 `.` 当项目名, 报出
    // 费解的 kebab-case 错误): 特判回退到 resolve 后的 basename (当前 / 上级目录名)。
    // 写入 suggestedName 而非 name, 以便交互模式在非 kebab-case 目录中放弃默认值照常提问。
    const derived = basename(options.dir);
    const fallback =
      derived === '.' || derived === '..'
        ? basename(resolve(options.dir))
        : derived;
    if (fallback.length > 0) options.suggestedName = fallback;
  }

  return options;
}

/**
 * 选项 + 环境 -> 五变量词汇表 (`Vocabulary`, 字段一一对齐)。
 *
 * 缺省派生: `name` 取 `opts.name ?? opts.suggestedName`; `scope` 缺省空串 (裸包名);
 * `binName` 由 `name` 派生; `owner` 缺省取 `env.gitUserName`; `repoUrl` 合成自 `owner`/`name`;
 * 空串旗标视同未提供。任一字段缺失或校验不过即返回 `{ error }`。
 *
 * ### 数据流转示例
 * ```text
 * Input:  opts = { suggestedName: 'my-tool', git: true, install: true, yes: true }
 *         env  = { gitUserName: 'iyowei' }
 * Step 1: 逐字段解析回退并校验 -> name='my-tool', scope='', binName=deriveBinName('my-tool')='my-tool',
 *         owner='iyowei', repoUrl='https://github.com/iyowei/my-tool'
 * Output: { name: 'my-tool', scope: '', binName: 'my-tool', owner: 'iyowei',
 *           repoUrl: 'https://github.com/iyowei/my-tool' }
 * ```
 */
export function resolveVocabulary(
  opts: CliOptions,
  env: Environment,
): Vocabulary | { error: string } {
  const name = provided(opts.name) ?? provided(opts.suggestedName);
  if (name === undefined) {
    return {
      error: '缺少项目名: 用位置参数或 --name 提供 (kebab-case, 如 my-tool)',
    };
  }
  const nameError = validateName(name);
  if (nameError !== null) return { error: nameError };

  const scope = provided(opts.scope) ?? '';
  const scopeError = validateScope(scope);
  if (scopeError !== null) return { error: scopeError };

  const binName = provided(opts.bin) ?? deriveBinName(name);
  const binError = validateBinName(binName);
  if (binError !== null) return { error: binError };

  const owner = provided(opts.owner) ?? provided(env.gitUserName ?? undefined);
  if (owner === undefined) {
    return {
      error: '缺少仓库所有者: --owner 未给出, 且读不到 git 全局 user.name',
    };
  }
  const ownerError = validateOwner(owner);
  if (ownerError !== null) return { error: ownerError };

  const rawRepoUrl =
    provided(opts.repo) ?? `https://github.com/${owner}/${name}`;
  const repoError = validateRepoUrl(rawRepoUrl);
  if (repoError !== null) return { error: repoError };
  const repoUrl = normalizeRepoUrl(rawRepoUrl);

  return { name, scope, binName, owner, repoUrl };
}

/**
 * 读 git 全局 user.name (owner 默认值的环境入口); 未配置或 git 不可用时返回 null。
 * 外部副作用: 启动一次 git 子进程。
 * 本模块唯一的环境适配出口, 其余函数是纯函数; 测试注入 Environment 即可完全绕开它。
 */
export function readGitUserName(): string | null {
  const result = spawnSync('git', ['config', '--global', 'user.name'], {
    encoding: 'utf8',
  });
  if (result.status !== 0) return null;
  const value = result.stdout.trim();
  return value.length > 0 ? value : null;
}
