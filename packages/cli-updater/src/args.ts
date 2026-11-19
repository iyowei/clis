/**
 * `update` 子命令统一参数解析与帮助渲染 (纯函数, 零 IO)。
 * 仓内全部 CLI (sweep-nm / codd / create-clis) 共用同一套参数语法与错误文案。
 */
import { type PackageManager, SUPPORTED_PACKAGE_MANAGERS } from './detect.ts';
import { isValidRegistryUrl } from './semver.ts';

/** `update` 子命令解析结果 */
export interface UpdateOptions {
  /** 仅检查远端最新版本与当前安装方式, 不执行更新 */
  check: boolean;
  /** 即使远端版本未高于当前版本, 仍强制重新安装最新版 */
  force: boolean;
  /** 手动覆盖自动探测的包管理器 */
  pm?: PackageManager;
  /** 临时指定本次查询与安装使用的 npm registry */
  registry?: string;
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
function applyPm(options: UpdateOptions, value: string): string | null {
  const normalized = value.trim().toLowerCase();
  if (!isPackageManager(normalized)) {
    return `参数 --pm 不支持 "${value}" (可选值: ${SUPPORTED_PACKAGE_MANAGERS.join(' | ')})`;
  }
  options.pm = normalized;
  return null;
}

/** 校验并应用 --registry 取值 */
function applyRegistry(options: UpdateOptions, value: string): string | null {
  const trimmed = value.trim();
  if (!isValidRegistryUrl(trimmed)) {
    return `参数 --registry 不是合法的 http(s) URL: "${value}"`;
  }
  options.registry = trimmed;
  return null;
}

/** 消费带值旗标的下一个 token (缺失或呈旗标形态时返回 null) */
function nextValueToken(argv: readonly string[], index: number): string | null {
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('-')) return null;
  return next;
}

/** 解析 `<cli> update` 之后的全部参数 */
export function parseUpdateArgs(argv: readonly string[]): ParseUpdateOutcome {
  const options: UpdateOptions = {
    check: false,
    force: false,
    help: false,
  };

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
    if (arg === '--pm') {
      const val = nextValueToken(argv, i);
      if (val === null) {
        return {
          ok: false,
          message: `参数 --pm 缺少取值 (可选值: ${SUPPORTED_PACKAGE_MANAGERS.join(' | ')})`,
        };
      }
      const err = applyPm(options, val);
      if (err !== null) return { ok: false, message: err };
      i += 1;
      continue;
    }
    if (arg.startsWith('--pm=')) {
      const val = arg.slice('--pm='.length);
      if (val === '') {
        return {
          ok: false,
          message: `参数 --pm 缺少取值 (可选值: ${SUPPORTED_PACKAGE_MANAGERS.join(' | ')})`,
        };
      }
      const err = applyPm(options, val);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    if (arg === '--registry') {
      const val = nextValueToken(argv, i);
      if (val === null)
        return { ok: false, message: '参数 --registry 缺少取值' };
      const err = applyRegistry(options, val);
      if (err !== null) return { ok: false, message: err };
      i += 1;
      continue;
    }
    if (arg.startsWith('--registry=')) {
      const val = arg.slice('--registry='.length);
      if (val === '') return { ok: false, message: '参数 --registry 缺少取值' };
      const err = applyRegistry(options, val);
      if (err !== null) return { ok: false, message: err };
      continue;
    }
    return {
      ok: false,
      message: `子命令 update 不支持参数: ${arg} (用 update --help 查看用法)`,
    };
  }

  return { ok: true, options };
}

/** 渲染统一的 `update` 子命令帮助文本 */
export function formatUpdateHelp(binName: string, packageName: string): string {
  return [
    `${binName} update: 自动识别当前安装方式 (bun / npm / pnpm / yarn / volta) 并更新 ${packageName}`,
    '',
    `用法: ${binName} update [选项]`,
    '',
    '选项:',
    '  --check                  仅检查最新版本与当前安装方式, 不执行更新',
    `  --pm <管理器>            手动指定更新所用的包管理器 (${SUPPORTED_PACKAGE_MANAGERS.join(' | ')})`,
    '  --registry <url>         临时指定本次查询与更新所用的 npm registry',
    '  --force                  即使已是最新版本仍强制重新安装',
    '  -h, --help               显示本帮助',
    '',
    '说明:',
    '  • 安装方式按当前包在磁盘上的真实落位路径判定, 不受运行时的 bun/node 切换影响',
    '  • 通过 npx / bunx / pnpm dlx / yarn dlx 临时运行, 或处于本地源码开发态时不会盲目覆盖全局',
    '  • 更新子进程在独立临时空目录执行, 隔绝当前工作目录的 .npmrc / bunfig.toml / package.json 干扰',
  ].join('\n');
}
