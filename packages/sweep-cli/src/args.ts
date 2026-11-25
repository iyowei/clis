/**
 * CLI 参数解析 (纯函数, 零 IO, 支持中英双语错误提示): 供 `cli.ts` 主入口与单测直接导入。
 * 支持 `--yes` / `--force` / `--default` / `--exclude` / `--include` / `--config` / `--lang` /
 * `-V` (`--version`) / `-h` (`--help`) 与 `init` / `config` / `migrate` / `lang` / `update` 子命令。
 */
import {
  type LangPreference,
  type Locale,
  parseLangPreference,
  t,
} from '@iyowei/cli-i18n';

export type CliCommand =
  'sweep' | 'init' | 'config' | 'migrate' | 'lang' | 'update';

export interface CliOptions {
  /** 子命令: 缺省为清理流程, init 初始化, config 查看配置, migrate 迁移, lang 语言偏好, update 自更新 */
  command: CliCommand;
  /** 执行清理 (缺省为预览) */
  yes: boolean;
  /** 连同疑似安装树一并纳入清理批 */
  force: boolean;
  /** `init --default`: 直接生成包含完整最佳实践的默认 v2 配置 */
  defaultConfig: boolean;
  /** `--exclude` 可重复, 与配置名单合并 */
  exclude: string[];
  /** `--include` 可重复, 与配置名单合并 */
  include: string[];
  /** `--config` 旗标值 (配置路径的最高优先级来源, 不可重复指定) */
  config?: string;
  /** `--lang` 单次语言覆盖 */
  lang?: LangPreference;
  /** `lang` 子命令参数 */
  langArgs?: string[];
  /** `update` 子命令透传参数 (由 @iyowei/cli-updater 统一解析) */
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

export type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

type ValueFlag = '--exclude' | '--include' | '--config' | '--lang';

const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  '--exclude',
  '--include',
  '--config',
  '--lang',
]);

const SUBCOMMANDS: ReadonlySet<string> = new Set(['init', 'config', 'migrate']);

function applyValueFlag(
  options: CliOptions,
  flag: ValueFlag,
  value: string,
  locale: Locale,
): string | null {
  if (flag === '--exclude') {
    options.exclude.push(value);
    return null;
  }
  if (flag === '--include') {
    options.include.push(value);
    return null;
  }
  if (flag === '--lang') {
    const parsed = parseLangPreference(value);
    if (parsed === null) {
      return t(
        locale,
        `参数 --lang 不支持 "${value}" (可选值: system | en | zh)`,
        `Invalid --lang value "${value}" (expected: system | en | zh)`,
      );
    }
    options.lang = parsed;
    return null;
  }
  if (options.config !== undefined) {
    return t(
      locale,
      '参数 --config 不能重复指定',
      'Option --config cannot be specified multiple times',
    );
  }
  options.config = value;
  return null;
}

function splitEqualsFlag(
  arg: string,
): { flag: ValueFlag; value: string } | null {
  const eqIndex = arg.indexOf('=');
  if (eqIndex <= 0) return null;
  const flag = arg.slice(0, eqIndex);
  if (!VALUE_FLAGS.has(flag)) return null;
  return { flag: flag as ValueFlag, value: arg.slice(eqIndex + 1) };
}

function validateSubcommandFlags(
  options: CliOptions,
  locale: Locale,
): string | null {
  if (options.command === 'sweep') {
    if (options.defaultConfig) {
      return t(
        locale,
        '参数 --default 仅适用于 init 子命令 (用法: sweep init --default)',
        "Option --default is only valid with 'init' (usage: sweep init --default)",
      );
    }
    return null;
  }
  const disallowed: string[] = [];
  if (options.yes) disallowed.push('--yes');
  if (options.force) disallowed.push('--force');
  if (options.exclude.length > 0) disallowed.push('--exclude');
  if (options.include.length > 0) disallowed.push('--include');
  if (options.command !== 'init' && options.defaultConfig) {
    disallowed.push('--default');
  }
  if (disallowed.length > 0) {
    return t(
      locale,
      `子命令 ${options.command} 不支持参数: ${disallowed.join(', ')}`,
      `Subcommand '${options.command}' does not accept: ${disallowed.join(', ')}`,
    );
  }
  return null;
}

export function parseArgs(argv: string[], locale: Locale = 'zh'): ParseOutcome {
  if (argv[0] === 'update') {
    return {
      ok: true,
      options: {
        command: 'update',
        yes: false,
        force: false,
        defaultConfig: false,
        exclude: [],
        include: [],
        updateArgs: argv.slice(1),
        help: false,
        version: false,
      },
    };
  }
  if (argv[0] === 'lang') {
    return {
      ok: true,
      options: {
        command: 'lang',
        yes: false,
        force: false,
        defaultConfig: false,
        exclude: [],
        include: [],
        langArgs: argv.slice(1),
        help: false,
        version: false,
      },
    };
  }

  const options: CliOptions = {
    command: 'sweep',
    yes: false,
    force: false,
    defaultConfig: false,
    exclude: [],
    include: [],
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === undefined) continue;
    if (arg === '--yes') {
      options.yes = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--default') {
      options.defaultConfig = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--version' || arg === '-V') {
      options.version = true;
      continue;
    }
    if (VALUE_FLAGS.has(arg)) {
      const value = argv[index + 1];
      if (value === undefined || value === '' || value.startsWith('-')) {
        return {
          ok: false,
          message: t(
            locale,
            `参数 ${arg} 缺少取值`,
            `Option ${arg} requires a value`,
          ),
        };
      }
      const err = applyValueFlag(options, arg as ValueFlag, value, locale);
      if (err !== null) return { ok: false, message: err };
      index += 1;
      continue;
    }
    const eq = splitEqualsFlag(arg);
    if (eq !== null) {
      if (eq.value === '') {
        return {
          ok: false,
          message: t(
            locale,
            `参数 ${eq.flag} 缺少取值`,
            `Option ${eq.flag} requires a value`,
          ),
        };
      }
      const err = applyValueFlag(options, eq.flag, eq.value, locale);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    if (arg.startsWith('-')) {
      return {
        ok: false,
        message: t(locale, `未知参数: ${arg}`, `Unknown option: ${arg}`),
      };
    }
    positionals.push(arg);
  }

  const [only] = positionals;
  if (positionals.includes('update')) {
    return {
      ok: false,
      message: t(
        locale,
        '子命令 update 必须位于参数首位 (用法: sweep update [选项])',
        "Subcommand 'update' must come first (usage: sweep update [options])",
      ),
    };
  }
  if (positionals.includes('lang')) {
    return {
      ok: false,
      message: t(
        locale,
        '子命令 lang 必须位于参数首位 (用法: sweep lang [system|en|zh])',
        "Subcommand 'lang' must come first (usage: sweep lang [system|en|zh])",
      ),
    };
  }
  if (
    positionals.length > 1 ||
    (only !== undefined && !SUBCOMMANDS.has(only))
  ) {
    return {
      ok: false,
      message: t(
        locale,
        `未知参数: ${positionals.join(' ')}`,
        `Unknown argument: ${positionals.join(' ')}`,
      ),
    };
  }
  if (only !== undefined) {
    options.command = only as CliCommand;
  }
  const flagError = validateSubcommandFlags(options, locale);
  if (flagError !== null) return { ok: false, message: flagError };
  return { ok: true, options };
}
