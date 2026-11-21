/**
 * CLI 参数解析 (纯函数, 零 IO): 供 `cli.ts` 主入口与单测直接导入, 不触发顶层执行。
 * 支持 `--yes` / `--force` / `--default` / `--exclude` / `--include` / `--config` /
 * `-V` (`--version`) / `-h` (`--help`) 与 `init` / `config` / `migrate` / `update` 子命令。
 * 红线: `update` 必须位于参数首位且后续参数原样透传给 `@iyowei/cli-updater`; 其余子命令与旗标严格互斥。
 */

export type CliCommand = 'sweep' | 'init' | 'config' | 'migrate' | 'update';

export interface CliOptions {
  /** 子命令: 缺省为清理流程, init 初始化配置, config 报告生效配置, migrate 迁移旧配置, update 自更新 */
  command: CliCommand;
  /** 执行清理 (缺省为预览) */
  yes: boolean;
  /** 连同疑似安装树一并纳入清理批 (缺省跳过; 只影响批次构造, 不放宽安全闸不变量) */
  force: boolean;
  /** `init --default`: 直接生成包含完整最佳实践的默认 v2 配置 */
  defaultConfig: boolean;
  /** `--exclude` 可重复, 与配置名单合并 */
  exclude: string[];
  /** `--include` 可重复, 与配置名单合并 */
  include: string[];
  /** `--config` 旗标值 (配置路径的最高优先级来源, 不可重复指定) */
  config?: string;
  /** `update` 子命令透传参数 (由 @iyowei/cli-updater 统一解析) */
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

export type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

type ValueFlag = '--exclude' | '--include' | '--config';

const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  '--exclude',
  '--include',
  '--config',
]);

const SUBCOMMANDS: ReadonlySet<string> = new Set(['init', 'config', 'migrate']);

function applyValueFlag(
  options: CliOptions,
  flag: ValueFlag,
  value: string,
): string | null {
  if (flag === '--exclude') {
    options.exclude.push(value);
    return null;
  }
  if (flag === '--include') {
    options.include.push(value);
    return null;
  }
  if (options.config !== undefined) return '参数 --config 不能重复指定';
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

/**
 * 校验子命令与旗标的互斥规则:
 * - `sweep`: 禁 `--default`;
 * - `init`: 禁 `--yes` / `--force` / `--exclude` / `--include` (允许 `--default` / `--config`);
 * - `config` / `migrate`: 另禁 `--default` (仅允许 `--config` 与 `-h`/`-V`)。
 */
function validateSubcommandFlags(options: CliOptions): string | null {
  if (options.command === 'sweep') {
    if (options.defaultConfig) {
      return '参数 --default 仅适用于 init 子命令 (用法: sweep init --default)';
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
    return `子命令 ${options.command} 不支持参数: ${disallowed.join(', ')}`;
  }
  return null;
}

/**
 * 解析命令行参数 (`process.argv.slice(2)`):
 * - 首位为 `update` 时立即短路, 其余参数原样装入 `updateArgs` 交更新器解析;
 * - 其余路径逐项解析布尔旗标、带值旗标 (`--flag value` / `--flag=value`) 与至多 1 个子命令位置参数;
 * - 未知参数、缺值、重复 `--config`、非首位 `update` 或子命令旗标冲突一律返回 `{ ok: false, message }`。
 *
 * ### 数据流转示例
 * ```text
 * Case A (主清理):
 *   Input  : ['--yes', '--exclude', 'my-kits', '--config=/tmp/c.json']
 *   步骤 1 : 识别布尔旗标 yes=true, 带值旗标 exclude=['my-kits'], config='/tmp/c.json'
 *   步骤 2 : 位置参数为空 -> command='sweep', 通过互斥校验
 *   Output : { ok: true, options: { command: 'sweep', yes: true, exclude: ['my-kits'], config: '/tmp/c.json', ... } }
 *
 * Case B (子命令透传):
 *   Input  : ['update', '--check', '--channel=next']
 *   步骤 1 : 命中 argv[0] === 'update' 短路, 跳过本模块旗标校验
 *   Output : { ok: true, options: { command: 'update', updateArgs: ['--check', '--channel=next'], ... } }
 * ```
 */
export function parseArgs(argv: string[]): ParseOutcome {
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
        return { ok: false, message: `参数 ${arg} 缺少取值` };
      }
      const err = applyValueFlag(options, arg as ValueFlag, value);
      if (err !== null) return { ok: false, message: err };
      index += 1;
      continue;
    }
    const eq = splitEqualsFlag(arg);
    if (eq !== null) {
      if (eq.value === '') {
        return { ok: false, message: `参数 ${eq.flag} 缺少取值` };
      }
      const err = applyValueFlag(options, eq.flag, eq.value);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, message: `未知参数: ${arg}` };
    positionals.push(arg);
  }

  const [only] = positionals;
  if (positionals.includes('update')) {
    return {
      ok: false,
      message: '子命令 update 必须位于参数首位 (用法: sweep update [选项])',
    };
  }
  if (
    positionals.length > 1 ||
    (only !== undefined && !SUBCOMMANDS.has(only))
  ) {
    return { ok: false, message: `未知参数: ${positionals.join(' ')}` };
  }
  if (only !== undefined) {
    options.command = only as CliCommand;
  }
  const flagError = validateSubcommandFlags(options);
  if (flagError !== null) return { ok: false, message: flagError };
  return { ok: true, options };
}
