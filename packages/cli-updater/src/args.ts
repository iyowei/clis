/**
 * `update` 子命令统一参数解析与帮助渲染 (纯函数, 零 IO)。
 * 调用方: `update.ts` (`runSelfUpdate`), 仓内全部 CLI (`sweep` / `codd` / `create-clis`) 共用同一套语法与错误文案。
 * 支持旗标: `--check` / `--force` / `--verbose` / `--pm <pm>` / `--registry <url>` / `-h, --help`。
 */
import {
  type LangPreference,
  type Locale,
  parseLangPreference,
  t,
} from '@iyowei/cli-i18n';

import { type PackageManager, SUPPORTED_PACKAGE_MANAGERS } from './detect.ts';
import { isValidRegistryUrl } from './semver.ts';
import { BAR_BLOCK, paint, sanitizeText } from './ui.ts';

/** `update` 子命令解析结果 */
export interface UpdateOptions {
  /** 仅检查远端最新版本与当前安装方式, 不执行更新 */
  check: boolean;
  /** 即使远端版本未高于当前版本, 仍强制重新安装最新版 */
  force: boolean;
  /** 实时透传包管理器原始输出 (默认静默捕获并在失败时展开尾部摘要) */
  verbose: boolean;
  /** 手动覆盖自动探测的包管理器 */
  pm?: PackageManager;
  /** 临时指定本次查询与安装使用的 npm registry */
  registry?: string;
  /** 临时指定本次自更新界面语言 */
  lang?: LangPreference;
  /** 打印 update 子命令帮助 */
  help: boolean;
}

export type ParseUpdateOutcome =
  { ok: true; options: UpdateOptions } | { ok: false; message: string };

const PM_SET: ReadonlySet<string> = new Set(SUPPORTED_PACKAGE_MANAGERS);

function isPackageManager(value: string): value is PackageManager {
  return PM_SET.has(value);
}

/** 校验并应用 --pm 取值 */
function applyPm(
  options: UpdateOptions,
  value: string,
  locale: Locale,
): string | null {
  const normalized = value.trim().toLowerCase();
  const list = SUPPORTED_PACKAGE_MANAGERS.join(' | ');
  if (!isPackageManager(normalized)) {
    return t(
      locale,
      `参数 --pm 不支持 "${value}" (可选值: ${list})`,
      `Invalid --pm value "${value}" (expected: ${list})`,
    );
  }
  options.pm = normalized;
  return null;
}

/** 校验并应用 --registry 取值 */
function applyRegistry(
  options: UpdateOptions,
  value: string,
  locale: Locale,
): string | null {
  const trimmed = value.trim();
  if (!isValidRegistryUrl(trimmed)) {
    return t(
      locale,
      `参数 --registry 不是合法的 http(s) URL: "${value}"`,
      `Invalid --registry URL (must be http/https): "${value}"`,
    );
  }
  options.registry = trimmed;
  return null;
}

function applyLang(
  options: UpdateOptions,
  value: string,
  locale: Locale,
): string | null {
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

/** 消费带值旗标的下一个 token (缺失或呈旗标形态时返回 null) */
function nextValueToken(argv: readonly string[], index: number): string | null {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('-')) return null;
  return next;
}

/** 解析 `<cli> update` 之后的全部参数 */
export function parseUpdateArgs(
  argv: readonly string[],
  locale: Locale = 'zh',
): ParseUpdateOutcome {
  const options: UpdateOptions = {
    check: false,
    force: false,
    verbose: false,
    help: false,
  };
  const pmList = SUPPORTED_PACKAGE_MANAGERS.join(' | ');

  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--check') {
      options.check = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--verbose') {
      options.verbose = true;
      continue;
    }
    if (arg === '--pm') {
      const val = nextValueToken(argv, i);
      if (val === null) {
        return {
          ok: false,
          message: t(
            locale,
            `参数 --pm 缺少取值 (可选值: ${pmList})`,
            `Option --pm requires a value (expected: ${pmList})`,
          ),
        };
      }
      const err = applyPm(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      i += 1;
      continue;
    }
    if (arg.startsWith('--pm=')) {
      const val = arg.slice('--pm='.length);
      if (val === '') {
        return {
          ok: false,
          message: t(
            locale,
            `参数 --pm 缺少取值 (可选值: ${pmList})`,
            `Option --pm requires a value (expected: ${pmList})`,
          ),
        };
      }
      const err = applyPm(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    if (arg === '--registry') {
      const val = nextValueToken(argv, i);
      if (val === null) {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --registry 缺少取值',
            'Option --registry requires a URL value',
          ),
        };
      }
      const err = applyRegistry(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      i += 1;
      continue;
    }
    if (arg.startsWith('--registry=')) {
      const val = arg.slice('--registry='.length);
      if (val === '') {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --registry 缺少取值',
            'Option --registry requires a URL value',
          ),
        };
      }
      const err = applyRegistry(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    if (arg === '--lang') {
      const val = nextValueToken(argv, i);
      if (val === null) {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --lang 缺少取值 (可选值: system | en | zh)',
            'Option --lang requires a value (expected: system | en | zh)',
          ),
        };
      }
      const err = applyLang(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      i += 1;
      continue;
    }
    if (arg.startsWith('--lang=')) {
      const val = arg.slice('--lang='.length);
      if (val === '') {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --lang 缺少取值 (可选值: system | en | zh)',
            'Option --lang requires a value (expected: system | en | zh)',
          ),
        };
      }
      const err = applyLang(options, val, locale);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    return {
      ok: false,
      message: t(
        locale,
        `子命令 update 不支持参数: ${arg} (用 update --help 查看用法)`,
        `Unknown option for 'update': ${arg} (run 'update --help' for usage)`,
      ),
    };
  }

  return { ok: true, options };
}

/** 渲染统一的 `update` 子命令帮助文本 (与主视图同源标准 SGR 单色系, color=false 时零 ANSI 逐字等价) */
export function formatUpdateHelp(
  binName: string,
  packageName: string,
  color = false,
  locale: Locale = 'zh',
): string {
  const safeBin = sanitizeText(binName);
  const safePkg = sanitizeText(packageName);
  const badge = paint(
    `${BAR_BLOCK} ${safeBin.toUpperCase()} UPDATE `,
    '1;7',
    color,
  );
  const bold = (s: string): string => paint(s, '1', color);
  const dim = (s: string): string => paint(s, '2', color);
  const section = (s: string): string => paint(s, '1;34', color);
  const token = (s: string): string => paint(s, '36', color);
  const pmList = SUPPORTED_PACKAGE_MANAGERS.join(' | ');

  if (locale === 'en') {
    return [
      '',
      `  ${badge}  ${bold('Self-Update')} ${dim(`(${safePkg})`)}`,
      `  ${dim('Detects your installer (bun / npm / pnpm / yarn / volta) and upgrades in place.')}`,
      `  ${dim('────────────────────────────────────────────────────────────────────────────')}`,
      '',
      `  ${section('Usage')}`,
      `    ${bold(`${safeBin} update`)} ${dim('[options]')}`,
      '',
      `  ${section('Options')}`,
      `    ${token('--check')}               ${dim('Check latest version and install origin without upgrading')}`,
      `    ${token('--pm')} ${dim('<manager>')}        ${dim(`Override package manager (${pmList})`)}`,
      `    ${token('--registry')} ${dim('<url>')}      ${dim('Use a custom npm registry URL for this run')}`,
      `    ${token('--force')}               ${dim('Reinstall latest version even if already up to date')}`,
      `    ${token('--verbose')}             ${dim('Stream raw package manager output (default: quiet spinner)')}`,
      `    ${token('--lang')} ${dim('<lang>')}         ${dim('Display language for this run (system | en | zh)')}`,
      '',
      `    ${token('-h, --help')}            ${dim('Show this help message')}`,
      '',
      `  ${section('Notes')}`,
      `    ${bold('Detection')}    ${dim('Resolved from real package path on disk, runtime-independent')}`,
      `    ${bold('Safety')}       ${dim('Never overwrites npx/bunx/dlx runs, source trees, or local deps')}`,
      `    ${bold('Isolation')}    ${dim('Runs in a clean temp directory with lifecycle env vars stripped')}`,
      `    ${bold('Registry')}     ${dim('Reads ~/.bunfig.toml (bun) or ~/.npmrc; defaults to npmjs.org')}`,
      '',
    ].join('\n');
  }

  return [
    '',
    `  ${badge}  ${bold(`自更新工具`)} ${dim(`(${safePkg})`)}`,
    `  ${dim('自动识别当前安装器 (bun / npm / pnpm / yarn / volta) 并原地升级。')}`,
    `  ${dim('────────────────────────────────────────────────────────────────────────────')}`,
    '',
    `  ${section('用法')}`,
    `    ${bold(`${safeBin} update`)} ${dim('[选项]')}`,
    '',
    `  ${section('选项')}`,
    `    ${token('--check')}              ${dim('仅检查最新版本与当前安装方式, 不执行更新')}`,
    `    ${token('--pm')} ${dim('<管理器>')}        ${dim(`手动指定更新所用的包管理器 (${pmList})`)}`,
    `    ${token('--registry')} ${dim('<url>')}     ${dim('临时指定本次查询与更新所用的 npm registry')}`,
    `    ${token('--force')}              ${dim('即使已是最新版本仍强制重新安装')}`,
    `    ${token('--verbose')}            ${dim('实时显示包管理器原始输出 (默认静默接管进度)')}`,
    `    ${token('--lang')} ${dim('<语言>')}        ${dim('临时指定本次显示语言 (system | en | zh)')}`,
    '',
    `    ${token('-h, --help')}           ${dim('显示本帮助')}`,
    '',
    `  ${section('说明')}`,
    `    ${bold('识别依据')}  ${dim('按当前包在磁盘上的真实落位路径判定, 不受 bun / node 运行时切换影响')}`,
    `    ${bold('安全边界')}  ${dim('npx / bunx / dlx 临时运行、本地源码态或项目本地 node_modules 依赖均不盲目覆盖全局或改写锁文件')}`,
    `    ${bold('环境隔离')}  ${dim('更新子进程在独立临时空目录执行并剥离宿主 npm 生命周期残留变量, 隔绝 cwd 配置干扰')}`,
    `    ${bold('镜像源')}    ${dim('按目标管理器读取家目录源配置 (bun 优先 ~/.bunfig.toml 回退 ~/.npmrc, 其余仅读 ~/.npmrc), 缺省官方源')}`,
    '',
  ].join('\n');
}
