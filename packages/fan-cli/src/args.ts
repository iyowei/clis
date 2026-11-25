/**
 * `@iyowei/fan-cli` 纯参数解析模块 (零 IO, 支持中英双语错误文案):
 * 支持 `status` / `set <speed>` / `max` / `min` / `auto` / `apply` / `persist [status|install|uninstall]` /
 * `lang [system|en|zh]` / `update` 子命令, 以及 `--fan` / `--once` / `--json` / `-w` / `--lang` / `-V` / `-h`。
 */
import {
  type LangPreference,
  type Locale,
  parseLangPreference,
  t,
} from '@iyowei/cli-i18n';

export type FanSubcommand =
  | 'status'
  | 'set'
  | 'max'
  | 'min'
  | 'auto'
  | 'apply'
  | 'persist'
  | 'lang'
  | 'update';

export type PersistAction = 'status' | 'install' | 'uninstall';

export interface CliOptions {
  command: FanSubcommand;
  speed?: string;
  persistAction?: PersistAction;
  fanIndex?: number;
  once: boolean;
  json: boolean;
  watchSeconds?: number;
  lang?: LangPreference;
  langArgs?: string[];
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
    token.startsWith('--watch=') ||
    token === '--lang' ||
    token.startsWith('--lang=')
  );
}

function parseLangValue(
  raw: string,
  locale: Locale,
): { ok: true; value: LangPreference } | { ok: false; message: string } {
  const parsed = parseLangPreference(raw);
  if (parsed === null) {
    return {
      ok: false,
      message: t(
        locale,
        `参数 --lang 不支持 "${raw}" (可选值: system | en | zh)`,
        `Invalid --lang value "${raw}" (expected: system | en | zh)`,
      ),
    };
  }
  return { ok: true, value: parsed };
}

function parseFanIndexValue(
  raw: string,
  locale: Locale,
): { ok: true; value: number } | { ok: false; message: string } {
  const parsed = parseFanIndex(raw);
  if (parsed === null) {
    return {
      ok: false,
      message: t(locale, `无效的风扇编号: ${raw}`, `Invalid fan index: ${raw}`),
    };
  }
  return { ok: true, value: parsed };
}

function validateCommandConstraints(input: {
  resolvedCommand: FanSubcommand;
  speed: string | undefined;
  watchSeconds: number | undefined;
  once: boolean;
  fanIndex: number | undefined;
  locale: Locale;
}): string | null {
  const { resolvedCommand, speed, watchSeconds, once, fanIndex, locale } =
    input;
  if (resolvedCommand === 'set' && speed === undefined) {
    return t(
      locale,
      'set 子命令缺少目标转速 (例如 fan set 4000 或 fan set 60%)',
      "Missing target speed for 'set' (e.g. fan set 4000 or fan set 60%)",
    );
  }
  if (watchSeconds !== undefined && resolvedCommand !== 'status') {
    return t(
      locale,
      '--watch 仅支持与 status 配合使用',
      '--watch can only be used with status',
    );
  }
  if (once && !MUTATING_COMMANDS.has(resolvedCommand)) {
    return t(
      locale,
      '--once / --no-save 仅支持用于 set / max / min / auto',
      '--once / --no-save can only be used with set, max, min, or auto',
    );
  }
  if (
    fanIndex !== undefined &&
    (resolvedCommand === 'apply' || resolvedCommand === 'persist')
  ) {
    return t(
      locale,
      `--fan 不适用于 ${resolvedCommand} 子命令`,
      `--fan cannot be used with '${resolvedCommand}'`,
    );
  }
  return null;
}

function unexpectedTokenMessage(
  arg: string,
  command: FanSubcommand | undefined,
  locale: Locale,
): string {
  if (arg.startsWith('-')) {
    return t(locale, `未知选项: ${arg}`, `Unknown option: ${arg}`);
  }
  if (command === undefined) {
    return t(locale, `未知子命令: ${arg}`, `Unknown subcommand: ${arg}`);
  }
  return t(locale, `多余的参数: ${arg}`, `Unexpected argument: ${arg}`);
}

function parseEarlyPassthrough(argv: readonly string[]): ParseResult | null {
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
  if (argv[0] === 'lang') {
    return {
      ok: true,
      options: {
        command: 'lang',
        once: false,
        json: false,
        langArgs: argv.slice(1),
        help: false,
        version: false,
      },
    };
  }
  return null;
}

/** 解析命令行参数为强类型 `CliOptions` */
export function parseArgs(
  argv: readonly string[],
  locale: Locale = 'zh',
): ParseResult {
  const early = parseEarlyPassthrough(argv);
  if (early !== null) return early;

  let command: FanSubcommand | undefined;
  let speed: string | undefined;
  let persistAction: PersistAction | undefined;
  let fanIndex: number | undefined;
  let once = false;
  let json = false;
  let watchSeconds: number | undefined;
  let lang: LangPreference | undefined;
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
    } else if (arg === '--lang') {
      const next = argv[i + 1];
      if (next === undefined || next === '' || next.startsWith('-')) {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --lang 缺少取值 (可选值: system | en | zh)',
            'Option --lang requires a value (expected: system | en | zh)',
          ),
        };
      }
      const res = parseLangValue(next, locale);
      if (!res.ok) return res;
      lang = res.value;
      i += 2;
      continue;
    } else if (arg.startsWith('--lang=')) {
      const res = parseLangValue(arg.slice('--lang='.length), locale);
      if (!res.ok) return res;
      lang = res.value;
    } else if (arg === '--fan') {
      const next = argv[i + 1];
      if (next === undefined) {
        return {
          ok: false,
          message: t(
            locale,
            '参数 --fan 缺少风扇编号 (例如 --fan 0)',
            'Option --fan requires a fan index (e.g. --fan 0)',
          ),
        };
      }
      const res = parseFanIndexValue(next, locale);
      if (!res.ok) return res;
      fanIndex = res.value;
      i += 2;
      continue;
    } else if (arg.startsWith('--fan=')) {
      const res = parseFanIndexValue(arg.slice('--fan='.length), locale);
      if (!res.ok) return res;
      fanIndex = res.value;
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
        return {
          ok: false,
          message: t(
            locale,
            `无效的轮询间隔: ${raw}`,
            `Invalid watch interval: ${raw}`,
          ),
        };
      }
      watchSeconds = parsed;
    } else if (arg === 'update' || arg === 'lang') {
      if (!help) {
        return {
          ok: false,
          message:
            arg === 'update'
              ? t(
                  locale,
                  'update 必须作为首个子命令使用 (用法: fan update [--check])',
                  "'update' must be the first subcommand (usage: fan update [--check])",
                )
              : t(
                  locale,
                  'lang 必须作为首个子命令使用 (用法: fan lang [system|en|zh])',
                  "'lang' must be the first subcommand (usage: fan lang [system|en|zh])",
                ),
        };
      }
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
          message: t(
            locale,
            `persist 子命令不支持动作 ${arg} (可选: status / install / uninstall)`,
            `Unsupported 'persist' action "${arg}" (expected: status | install | uninstall)`,
          ),
        };
      }
      persistAction = arg as PersistAction;
    } else {
      return {
        ok: false,
        message: unexpectedTokenMessage(arg, command, locale),
      };
    }
    i += 1;
  }

  const resolvedCommand = command ?? 'status';
  if (resolvedCommand === 'persist' && persistAction === undefined) {
    persistAction = 'status';
  }

  if (!help && !version) {
    const constraintErr = validateCommandConstraints({
      resolvedCommand,
      speed,
      watchSeconds,
      once,
      fanIndex,
      locale,
    });
    if (constraintErr !== null) return { ok: false, message: constraintErr };
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
      lang,
      help,
      version,
    },
  };
}
