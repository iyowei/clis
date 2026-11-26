/**
 * `@iyowei/wake-cli` 参数解析器: 支持目标名、直发参数、只读子命令 (`list` / `doctor`)、配置向导 (`init`)、`lang` 与 `update`。
 */
import { type LangPreference, type Locale, t } from '@iyowei/cli-i18n';
import {
  normalizeMacList,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from '@iyowei/wake';

export type WakeSubcommand =
  'wake' | 'list' | 'init' | 'doctor' | 'lang' | 'update';

export interface CliOptions {
  command: WakeSubcommand;
  target?: string;
  configPath?: string;
  macs: string[];
  host?: string;
  port?: number;
  broadcast: string[];
  relays: string[];
  wait: boolean;
  waitTimeoutMs?: number;
  localOnly: boolean;
  noLocalFallback: boolean;
  force: boolean;
  json: boolean;
  name?: string;
  setDefault: boolean;
  yes: boolean;
  lang?: LangPreference;
  langArgs?: string[];
  updateArgs?: string[];
  help: boolean;
  version: boolean;
}

export type ParseResult =
  { ok: true; options: CliOptions } | { ok: false; message: string };

/** 供 `stripLangArgs` 预先识别携带参数值的选项 */
export const VALUE_FLAGS: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '-m',
  '--mac',
  '-H',
  '--host',
  '-p',
  '--port',
  '-b',
  '--broadcast',
  '-r',
  '--relay',
  '-t',
  '--timeout',
  '--name',
  '--lang',
]);

const VALUE_OPT_NAMES: ReadonlySet<string> = new Set([
  '-c',
  '--config',
  '-m',
  '--mac',
  '-H',
  '--host',
  '-p',
  '--port',
  '-b',
  '--broadcast',
  '-r',
  '--relay',
  '-t',
  '--timeout',
  '--name',
]);

const SUBCOMMANDS: ReadonlySet<string> = new Set([
  'list',
  'init',
  'doctor',
  'lang',
  'update',
]);

interface MutableParseState {
  command?: WakeSubcommand;
  target?: string;
  configPath?: string;
  macs: string[];
  host?: string;
  port?: number;
  broadcast: string[];
  relays: string[];
  wait: boolean;
  waitTimeoutMs?: number;
  localOnly: boolean;
  noLocalFallback: boolean;
  force: boolean;
  json: boolean;
  name?: string;
  setDefault: boolean;
  yes: boolean;
  help: boolean;
  version: boolean;
}

function readOptionValue(
  argv: readonly string[],
  index: number,
  flag: string,
  inlineValue: string | undefined,
  locale: Locale,
):
  | { ok: true; value: string; nextIdx: number }
  | { ok: false; message: string } {
  if (inlineValue !== undefined) {
    if (inlineValue.trim() === '') {
      return {
        ok: false,
        message: t(
          locale,
          `选项 ${flag} 需要非空参数值`,
          `Option ${flag} requires a non-empty value`,
        ),
      };
    }
    return { ok: true, value: inlineValue, nextIdx: index };
  }
  const next = argv[index + 1];
  if (next === undefined || next === '' || next.startsWith('-')) {
    return {
      ok: false,
      message: t(
        locale,
        `选项 ${flag} 需要参数值`,
        `Option ${flag} requires a value`,
      ),
    };
  }
  return { ok: true, value: next, nextIdx: index + 1 };
}

function parseTimeoutMs(raw: string, locale: Locale): number | string {
  const sec = Number(raw.trim());
  if (!Number.isFinite(sec) || sec <= 0 || sec > 600) {
    return t(
      locale,
      `无效的等待超时秒数: ${raw} (期望 1-600 之间正数)`,
      `Invalid timeout in seconds: ${raw} (expected 1-600)`,
    );
  }
  return Math.max(1_000, Math.round(sec * 1_000));
}

function parseEarlyPassthrough(argv: readonly string[]): ParseResult | null {
  if (argv[0] !== 'update' && argv[0] !== 'lang') return null;
  const isUpdate = argv[0] === 'update';
  return {
    ok: true,
    options: {
      command: argv[0],
      macs: [],
      broadcast: [],
      relays: [],
      wait: true,
      localOnly: false,
      noLocalFallback: false,
      force: false,
      json: false,
      setDefault: false,
      yes: false,
      help: false,
      version: false,
      ...(isUpdate
        ? { updateArgs: argv.slice(1) }
        : { langArgs: argv.slice(1) }),
    },
  };
}

function splitEqualsFlag(token: string): {
  flag: string;
  inlineValue?: string;
} {
  if (!token.startsWith('--')) return { flag: token };
  const eqIdx = token.indexOf('=');
  if (eqIdx === -1) return { flag: token };
  return {
    flag: token.slice(0, eqIdx),
    inlineValue: token.slice(eqIdx + 1),
  };
}

function applyBooleanFlag(state: MutableParseState, flag: string): boolean {
  switch (flag) {
    case '-h':
    case '--help':
      state.help = true;
      return true;
    case '-V':
    case '--version':
      state.version = true;
      return true;
    case '--json':
      state.json = true;
      return true;
    case '--no-wait':
      state.wait = false;
      return true;
    case '--local-only':
      state.localOnly = true;
      return true;
    case '--no-local-fallback':
      state.noLocalFallback = true;
      return true;
    case '--force':
      state.force = true;
      return true;
    case '--default':
      state.setDefault = true;
      return true;
    case '--yes':
    case '-y':
      state.yes = true;
      return true;
    default:
      return false;
  }
}

function applyValueFlag(
  state: MutableParseState,
  flag: string,
  value: string,
  locale: Locale,
): string | null {
  try {
    if (flag === '-c' || flag === '--config') {
      state.configPath = value.trim();
      return null;
    }
    if (flag === '-m' || flag === '--mac') {
      for (const part of value.split(',')) {
        const trimmed = part.trim();
        if (trimmed !== '') state.macs.push(trimmed);
      }
      return null;
    }
    if (flag === '-H' || flag === '--host') {
      state.host = validateSafeHost(value);
      return null;
    }
    if (flag === '-p' || flag === '--port') {
      state.port = validatePort(value);
      return null;
    }
    if (flag === '-b' || flag === '--broadcast') {
      state.broadcast.push(validateBroadcastIpv4(value));
      return null;
    }
    if (flag === '-r' || flag === '--relay') {
      state.relays.push(validateSafeRelay(value));
      return null;
    }
    if (flag === '-t' || flag === '--timeout') {
      const ms = parseTimeoutMs(value, locale);
      if (typeof ms === 'string') return ms;
      state.waitTimeoutMs = ms;
      return null;
    }
    state.name = validateTargetName(value);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function consumePositional(
  state: MutableParseState,
  rawArg: string,
  afterDoubleDash: boolean,
  locale: Locale,
): string | null {
  if (
    state.command === undefined &&
    !afterDoubleDash &&
    SUBCOMMANDS.has(rawArg)
  ) {
    state.command = rawArg as WakeSubcommand;
    return null;
  }
  if (state.target !== undefined) {
    return t(locale, `多余的参数: ${rawArg}`, `Unexpected argument: ${rawArg}`);
  }
  if (state.command === undefined) state.command = 'wake';
  try {
    state.target = validateTargetName(rawArg);
    return null;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

function validateCommandFlags(
  options: CliOptions,
  locale: Locale,
): string | null {
  if (options.localOnly && options.noLocalFallback) {
    return t(
      locale,
      '--local-only 与 --no-local-fallback 不能同时使用',
      '--local-only cannot be combined with --no-local-fallback',
    );
  }
  if (options.command === 'list') {
    const forbidden =
      options.target !== undefined ||
      options.macs.length > 0 ||
      options.host !== undefined ||
      options.port !== undefined ||
      options.broadcast.length > 0 ||
      options.relays.length > 0;
    if (forbidden) {
      return t(
        locale,
        'list 子命令仅接受 --config / --json',
        "'list' only accepts --config and --json",
      );
    }
  }
  if (options.command === 'doctor') {
    if (options.macs.length > 0 || options.host !== undefined) {
      return t(
        locale,
        'doctor 子命令仅诊断配置与中继环境, 不接受 --mac 或 --host',
        "'doctor' inspects saved config and relays and does not accept --mac or --host",
      );
    }
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

  const state: MutableParseState = {
    macs: [],
    broadcast: [],
    relays: [],
    wait: true,
    localOnly: false,
    noLocalFallback: false,
    force: false,
    json: false,
    setDefault: false,
    yes: false,
    help: false,
    version: false,
  };

  let afterDoubleDash = false;
  for (let i = 0; i < argv.length; i += 1) {
    const rawArg = argv[i]!;
    if (rawArg === '--' && !afterDoubleDash) {
      afterDoubleDash = true;
      continue;
    }

    if (!afterDoubleDash && rawArg.startsWith('-')) {
      const { flag, inlineValue } = splitEqualsFlag(rawArg);
      if (applyBooleanFlag(state, flag)) continue;
      if (!VALUE_OPT_NAMES.has(flag)) {
        return {
          ok: false,
          message: t(
            locale,
            `未知选项: ${rawArg}`,
            `Unknown option: ${rawArg}`,
          ),
        };
      }
      const read = readOptionValue(argv, i, flag, inlineValue, locale);
      if (!read.ok) return read;
      i = read.nextIdx;
      const err = applyValueFlag(state, flag, read.value, locale);
      if (err !== null) return { ok: false, message: err };
      continue;
    }

    const posErr = consumePositional(state, rawArg, afterDoubleDash, locale);
    if (posErr !== null) return { ok: false, message: posErr };
  }

  let normalizedMacs: string[] = [];
  if (state.macs.length > 0) {
    try {
      normalizedMacs = normalizeMacList(state.macs);
    } catch (error) {
      return {
        ok: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
  }

  const options: CliOptions = {
    command: state.command ?? 'wake',
    ...(state.target !== undefined ? { target: state.target } : {}),
    ...(state.configPath !== undefined ? { configPath: state.configPath } : {}),
    macs: normalizedMacs,
    ...(state.host !== undefined ? { host: state.host } : {}),
    ...(state.port !== undefined ? { port: state.port } : {}),
    broadcast: state.broadcast,
    relays: state.relays,
    wait: state.wait,
    ...(state.waitTimeoutMs !== undefined
      ? { waitTimeoutMs: state.waitTimeoutMs }
      : {}),
    localOnly: state.localOnly,
    noLocalFallback: state.noLocalFallback,
    force: state.force,
    json: state.json,
    ...(state.name !== undefined ? { name: state.name } : {}),
    setDefault: state.setDefault,
    yes: state.yes,
    help: state.help,
    version: state.version,
  };

  if (!state.help && !state.version) {
    const err = validateCommandFlags(options, locale);
    if (err !== null) return { ok: false, message: err };
  }

  return { ok: true, options };
}
