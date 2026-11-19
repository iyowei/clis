/**
 * CLI 参数解析 (纯函数, 零 IO): 独立成模块以供单测直接导入, 不触发 cli.ts 的顶层执行。
 * 支持 `--yes` / `--force` / `--exclude <name>` / `--include <name>` / `--config <path>` /
 * `--version` (`-V`) / `--help` (`-h`) 与 `init` / `config` 子命令, 带值旗标同时支持 `--flag=value` 赋值。
 */

export interface CliOptions {
  /** 子命令: 缺省为清理流程, init 只跑向导, config 只报告配置 */
  command: 'sweep' | 'init' | 'config';
  /** 执行删除 (缺省为预览) */
  yes: boolean;
  /** 连同疑似安装树一并纳入删除批 (缺省跳过; 只影响批次构造, 不放宽安全闸的不变量) */
  force: boolean;
  /** `--exclude` 可重复, 与配置名单合并 */
  exclude: string[];
  /** `--include` 可重复, 与配置名单合并 */
  include: string[];
  /** `--config` 旗标值 (配置路径的最高优先级来源, 不可重复指定) */
  config?: string;
  help: boolean;
  version: boolean;
}

export type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

/** 带值旗标名 */
type ValueFlag = '--exclude' | '--include' | '--config';

const VALUE_FLAGS: ReadonlySet<string> = new Set<ValueFlag>([
  '--exclude',
  '--include',
  '--config',
]);

/** 应用一个带值旗标; 重复 `--config` 返回错误消息, 成功返回 null */
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

/** 拆解 `--flag=value` 形态; 非带值旗标赋值形式返回 null */
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
 * 解析命令行参数。未知参数、旗标缺值、重复 `--config`、子命令互斥旗标、多余位置参数一律判错
 * (调用方落退出码 1)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   argv = ['--exclude=my-kits', '--include', 'self', '--yes']
 *
 * 步骤 1：逐项识别
 *   --exclude 收值 'my-kits'; --include 收值 'self'; --yes 置位; 无位置参数
 *
 * Output（数据契约）
 *   return { ok: true, options: { command: 'sweep', yes: true, force: false, exclude: ['my-kits'], include: ['self'], help: false, version: false } }
 * ```
 */
export function parseArgs(argv: string[]): ParseOutcome {
  const options: CliOptions = {
    command: 'sweep',
    yes: false,
    force: false,
    exclude: [],
    include: [],
    help: false,
    version: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // 索引由循环条件保证在界内, 此判仅为 noUncheckedIndexedAccess 的类型收窄
    if (arg === undefined) continue;
    if (arg === '--yes') {
      options.yes = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
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
  if (
    positionals.length > 1 ||
    (only !== undefined && only !== 'init' && only !== 'config')
  ) {
    return { ok: false, message: `未知参数: ${positionals.join(' ')}` };
  }
  if (only === 'init' || only === 'config') {
    options.command = only;
    // init / config 子命令仅允许 --config / --help (及 --version), 清理专属旗标一律判互斥错误
    const disallowed: string[] = [];
    if (options.yes) disallowed.push('--yes');
    if (options.force) disallowed.push('--force');
    if (options.exclude.length > 0) disallowed.push('--exclude');
    if (options.include.length > 0) disallowed.push('--include');
    if (disallowed.length > 0) {
      return {
        ok: false,
        message: `子命令 ${options.command} 不支持参数: ${disallowed.join(', ')}`,
      };
    }
  }
  return { ok: true, options };
}
