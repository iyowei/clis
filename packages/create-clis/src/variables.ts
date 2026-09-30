/**
 * 五变量收集与旗标解析: 旗标 → CliOptions, 选项 + 环境 → 词汇表 (Vocabulary), 以及各字段的
 * 合法性校验。
 *
 * 契约衔接:
 * - 词汇表直接复用 render.ts 的 Vocabulary (字段一一对齐, 不另立形状); 占位符拼写
 *   (TEMPLATE_VOCABULARY) 是下游消费面, 本模块不碰;
 * - 变量默认值与校验以 docs/designs/scaffold-contract.md「变量」为权威: name 必填且 kebab-case;
 *   scope 默认裸包名; binName 默认由 name 派生短形态; owner 默认 git 全局 user.name; repoUrl
 *   默认 https://github.com/<owner>/<name>;
 * - 除 readGitUserName (环境适配出口) 外全为纯函数; 交互收集在 prompt.ts。
 */
import { spawnSync } from 'node:child_process';
import { basename } from 'node:path';

import { type Vocabulary } from './render.ts';
import { type Tier } from './tier.ts';

/** 旗标解析结果: 五个变量全部可选 (缺省在 resolveVocabulary 派生), 三个开关与目标目录 */
export interface CliOptions {
  /** 项目名 (位置参数目录的 basename, 或 --name) */
  name?: string;
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

/** 校验仓库地址 (scheme://host/path 形态) */
export function validateRepoUrl(url: string): string | null {
  if (url.length === 0) return '仓库地址不能为空';
  if (!REPO_URL.test(url)) {
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
 * 由项目名派生 bin 短形态: 三段及以上取「首段 + 其余段首字母」(sweep-node-modules → sweep-nm);
 * 一段 / 两段名本身已是短形态, 原样保留 (my-tool 缩写为 my-t 无可辨识度)。
 * 只做派生, 合法性由 validateBinName 兜底; 用户可用 --bin 覆盖。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   name = 'sweep-node-modules'
 *
 * 步骤 1：按 - 切段
 *   segments = ['sweep', 'node', 'modules']   *(三段, 走缩写分支)*
 *
 * 步骤 2：首段 + 其余段首字母
 *   bin = 'sweep' + '-' + 'n' + 'm'
 *
 * Output（数据契约）
 *   return 'sweep-nm'
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
 * 解析旗标 (argv 为脚本名之后的参数段)。旗标清单见 docs/designs/scaffold-contract.md
 * 「旗标汇总」: 五个值旗标 + --tier + --no-git / --no-install / --yes, 外加一个位置参数。
 *
 * 约定:
 * - 位置参数是目标目录 [dir]; 项目名缺省取该目录 basename (--name 优先), 目录自身的可用性
 *   (存在 / 为空) 由生成流程在落盘前检查, 不属本函数;
 * - 值旗标两种写法 (`--name x` 与 `--name=x`); 重复旗标后者胜;
 * - 解析只做形态判定 (未知旗标 / 缺值 / 档位枚举), 取值合法性交 resolveVocabulary;
 * - `--` 之后的旗标由 npm create 等调用方消费 (生态既有行为), 本函数不重复处理;
 *   `--help` 一类展示面旗标由 CLI 入口先行拦截, 不在此列。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   argv = ['./pkgs/my-tool', '--scope=@me', '--no-git', '--tier', 'full']
 *
 * 步骤 1：逐 token 分类消费
 *   './pkgs/my-tool' → dir (首个位置参数)
 *   '--scope=@me'    → scope = '@me' (内联值形态)
 *   '--no-git'       → git = false
 *   '--tier' 'full'  → tier = 'full' (下一 token 作值, 扫描前进一格)
 *
 * 步骤 2：位置参数回填项目名 (--name 缺席时取 basename)
 *   name = basename('./pkgs/my-tool') = 'my-tool'
 *
 * Output（数据契约）
 *   return { dir: './pkgs/my-tool', name: 'my-tool', scope: '@me', tier: 'full',
 *            git: false, install: true, yes: false }
 * ```
 */
export function parseFlags(argv: string[]): CliOptions | { error: string } {
  const options: CliOptions = { git: true, install: true, yes: false };

  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]!;

    if (!token.startsWith('-')) {
      if (options.dir !== undefined) {
        return {
          error: `只接受一个目标目录位置参数, 多余的: ${JSON.stringify(token)}`,
        };
      }
      options.dir = token;
      continue;
    }

    if (!token.startsWith('--')) {
      return { error: `未知旗标 ${JSON.stringify(token)}` };
    }

    const inlineIndex = token.indexOf('=');
    const flag = inlineIndex === -1 ? token : token.slice(0, inlineIndex);
    const inline =
      inlineIndex === -1 ? undefined : token.slice(inlineIndex + 1);

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

  if (options.name === undefined && options.dir !== undefined) {
    const derived = basename(options.dir);
    if (derived.length > 0) options.name = derived;
  }

  return options;
}

/**
 * 选项 + 环境 → 五变量词汇表 (Vocabulary, 字段一一对齐)。
 *
 * 缺省派生: scope 空串 (裸包名) / binName 由 name 派生 / owner 取 git 全局 user.name /
 * repoUrl 由 owner 与 name 合成; 空串旗标视同未提供。任一变量缺失或非法即返回 { error }
 * (调用方打印并以非零退出码结束)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   opts = { name: 'my-tool', git: true, install: true, yes: false }
 *   env  = { gitUserName: 'iyowei' }
 *
 * 步骤 1：逐字段校验 + 缺省派生 (name 缺失或非法即早退)
 *   name     = 'my-tool' ✓
 *   scope    = ''  (未提供, 裸包名)
 *   binName  = deriveBinName('my-tool') = 'my-tool'
 *   owner    = env.gitUserName = 'iyowei'
 *   repoUrl  = 'https://github.com/iyowei/my-tool'
 *
 * Output（数据契约）
 *   return { name: 'my-tool', scope: '', binName: 'my-tool', owner: 'iyowei',
 *            repoUrl: 'https://github.com/iyowei/my-tool' }
 * ```
 */
export function resolveVocabulary(
  opts: CliOptions,
  env: Environment,
): Vocabulary | { error: string } {
  const name = provided(opts.name);
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

  const repoUrl = provided(opts.repo) ?? `https://github.com/${owner}/${name}`;
  const repoError = validateRepoUrl(repoUrl);
  if (repoError !== null) return { error: repoError };

  return { name, scope, binName, owner, repoUrl };
}

/**
 * 读 git 全局 user.name (owner 默认值的环境入口); 未配置或 git 不可用时返回 null。
 * 外部副作用：启动一次 git 子进程。
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
