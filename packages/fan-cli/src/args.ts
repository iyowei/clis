/**
 * `@iyowei/fan-cli` 纯参数解析模块 (零 IO):
 * 支持 `status` / `set <speed>` / `max` / `min` / `auto` / `apply` / `persist [status|install|uninstall]` / `update` 子命令,
 * `--fan <index>` / `--once, --no-save` / `--json` / `-w, --watch [seconds]` 与 `-V, --version` / `-h, --help`。
 */
export type FanSubcommand =
  'status' | 'set' | 'max' | 'min' | 'auto' | 'apply' | 'persist' | 'update';

export type PersistAction = 'status' | 'install' | 'uninstall';

export interface CliOptions {
  command: FanSubcommand;
  speed?: string;
  persistAction?: PersistAction;
  fanIndex?: number;
  once: boolean;
  json: boolean;
  watchSeconds?: number;
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

export type ParseResult =
  { ok: true; options: CliOptions } | { ok: false; message: string };

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  'status',
  'set',
  'max',
  'min',
  'auto',
  'apply',
  'persist',
]);

const PERSIST_ACTIONS: ReadonlySet<string> = new Set([
  'status',
  'install',
  'uninstall',
]);

const MUTATING_COMMANDS: ReadonlySet<FanSubcommand> = new Set([
  'set',
  'max',
  'min',
  'auto',
]);

function parseFanIndex(raw: string): number | null {
  const trimmed = raw.trim();
  if (!/^\d+$/.test(trimmed)) return null;
  const val = Number(trimmed);
  return Number.isSafeInteger(val) && val >= 0 ? val : null;
}

function parseWatchInterval(raw: string): number | null {
  const num = Number(raw);
  if (!Number.isFinite(num) || num <= 0) return null;
  return num;
}

function isFlagToken(token: string): boolean {
  return (
    token === '-h' ||
    token === '--help' ||
    token === '-V' ||
    token === '--version' ||
    token === '--once' ||
    token === '--no-save' ||
    token === '--json' ||
    token === '--fan' ||
    token.startsWith('--fan=') ||
    token === '-w' ||
    token === '--watch' ||
    token.startsWith('--watch=')
  );
}

/** 解析命令行参数为强类型 `CliOptions` */
export function parseArgs(argv: readonly string[]): ParseResult {
  if (argv[0] === 'update') {
    return {
      ok: true,
      options: {
        command: 'update',
        once: false,
        json: false,
        updateArgs: argv.slice(1),
        help: false,
        version: false,
      },
    };
  }

  let command: FanSubcommand | undefined;
  let speed: string | undefined;
  let persistAction: PersistAction | undefined;
  let fanIndex: number | undefined;
  let once = false;
  let json = false;
  let watchSeconds: number | undefined;
  let help = false;
  let version = false;

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '-h' || arg === '--help') {
      help = true;
    } else if (arg === '-V' || arg === '--version') {
      version = true;
    } else if (arg === '--once' || arg === '--no-save') {
      once = true;
    } else if (arg === '--json') {
      json = true;
    } else if (arg === '--fan') {
      const next = argv[i + 1];
      if (next === undefined) {
        return { ok: false, message: '参数 --fan 缺少风扇编号 (例如 --fan 0)' };
      }
      const parsed = parseFanIndex(next);
      if (parsed === null) {
        return { ok: false, message: `无效的风扇编号: ${next}` };
      }
      fanIndex = parsed;
      i += 2;
      continue;
    } else if (arg.startsWith('--fan=')) {
      const raw = arg.slice('--fan='.length);
      const parsed = parseFanIndex(raw);
      if (parsed === null) {
        return { ok: false, message: `无效的风扇编号: ${raw}` };
      }
      fanIndex = parsed;
    } else if (arg === '-w' || arg === '--watch') {
      const next = argv[i + 1];
      if (
        next !== undefined &&
        !next.startsWith('-') &&
        !SUBCOMMANDS.has(next) &&
        !isFlagToken(next) &&
        parseWatchInterval(next) !== null
      ) {
        watchSeconds = parseWatchInterval(next)!;
        i += 2;
        continue;
      }
      watchSeconds = 1.0;
    } else if (arg.startsWith('--watch=')) {
      const raw = arg.slice('--watch='.length);
      const parsed = parseWatchInterval(raw);
      if (parsed === null) {
        return { ok: false, message: `无效的轮询间隔: ${raw}` };
      }
      watchSeconds = parsed;
    } else if (arg === 'update') {
      if (help) {
        i += 1;
        continue;
      }
      return {
        ok: false,
        message: 'update 必须作为首个子命令使用 (用法: fan update [--check])',
      };
    } else if (command === undefined && SUBCOMMANDS.has(arg)) {
      command = arg as FanSubcommand;
    } else if (
      command === 'set' &&
      speed === undefined &&
      !arg.startsWith('-')
    ) {
      speed = arg;
    } else if (
      command === 'persist' &&
      persistAction === undefined &&
      !arg.startsWith('-')
    ) {
      if (!PERSIST_ACTIONS.has(arg)) {
        return {
          ok: false,
          message: `persist 子命令不支持动作 ${arg} (可选: status / install / uninstall)`,
        };
      }
      persistAction = arg as PersistAction;
    } else if (arg.startsWith('-')) {
      return { ok: false, message: `未知选项: ${arg}` };
    } else if (command === undefined) {
      return { ok: false, message: `未知子命令: ${arg}` };
    } else {
      return { ok: false, message: `多余的参数: ${arg}` };
    }
    i += 1;
  }

  const resolvedCommand = command ?? 'status';
  if (resolvedCommand === 'persist' && persistAction === undefined) {
    persistAction = 'status';
  }

  if (!help && !version) {
    if (resolvedCommand === 'set' && speed === undefined) {
      return {
        ok: false,
        message: 'set 子命令缺少目标转速 (例如 fan set 4000 或 fan set 60%)',
      };
    }
    if (watchSeconds !== undefined && resolvedCommand !== 'status') {
      return {
        ok: false,
        message: '--watch 仅支持与 status 配合使用',
      };
    }
    if (once && !MUTATING_COMMANDS.has(resolvedCommand)) {
      return {
        ok: false,
        message: '--once / --no-save 仅支持用于 set / max / min / auto',
      };
    }
    if (
      fanIndex !== undefined &&
      (resolvedCommand === 'apply' || resolvedCommand === 'persist')
    ) {
      return {
        ok: false,
        message: `--fan 不适用于 ${resolvedCommand} 子命令`,
      };
    }
  }

  return {
    ok: true,
    options: {
      command: resolvedCommand,
      speed,
      persistAction,
      fanIndex,
      once,
      json,
      watchSeconds,
      help,
      version,
    },
  };
}
