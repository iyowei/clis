/**
 * `@iyowei/wake-cli` 顶层 CLI 入口与双语调度主干 (`@iyowei/wake` 领域薄壳)。
 * 先于参数解析剥离 `--lang`, 统一处理 `-V`/`-h`/`lang`/`update`/`list`/`doctor`/`init` 及核心唤醒流程。
 */
import { readFileSync } from 'node:fs';

import {
  type Locale,
  resolveCliLocale,
  runLangCommand,
  stripLangArgs,
  t,
} from '@iyowei/cli-i18n';
import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type WakeDeps,
  diagnoseWake,
  resolveWakeConfigPath,
  tryLoadWakeConfig,
  wakeTarget,
} from '@iyowei/wake';

import { VALUE_FLAGS, parseArgs } from './args.ts';
import { helpText } from './help.ts';
import { runInitCommand } from './init.ts';
import { paint, sanitizeOutputLine } from './render-primitives.ts';
import {
  localizeWakeError,
  renderDoctorReport,
  renderListReport,
  renderProgressLine,
  renderWakeReport,
} from './render.ts';

export interface WakeCliRuntimeHooks {
  deps?: WakeDeps;
  out?: (line: string) => void;
  err?: (line: string) => void;
  stderrWrite?: (chunk: string) => void;
  isInteractive?: () => boolean;
  colorChannels?: () => { stdout: boolean; stderr: boolean };
  version?: string;
}

function defaultColorChannels(): { stdout: boolean; stderr: boolean } {
  const allowed =
    !process.env.NO_COLOR && process.env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

function readPackageVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : '0.0.0';
  } catch {
    return '0.0.0';
  }
}

function printErr(
  message: string,
  stderrColor: boolean,
  err: (line: string) => void,
): void {
  const clean = sanitizeOutputLine(message);
  err(stderrColor ? `${paint('✗', '31', stderrColor)} ${clean}` : clean);
}

/** 运行 `wake` CLI 并返回标准退出码 (`0` / `1`) */
export async function runWakeCli(
  rawArgv: readonly string[],
  hooks: WakeCliRuntimeHooks = {},
): Promise<number> {
  const out =
    hooks.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err =
    hooks.err ?? ((line: string) => process.stderr.write(`${line}\n`));
  const stderrWrite =
    hooks.stderrWrite ?? ((chunk: string) => process.stderr.write(chunk));
  const colors = hooks.colorChannels?.() ?? defaultColorChannels();
  const interactive =
    hooks.isInteractive ??
    (() => process.stdin.isTTY === true && process.stdout.isTTY === true);
  const version = hooks.version ?? readPackageVersion();

  const preLocale = resolveCliLocale({ toolName: 'wake' });
  const stripped = stripLangArgs(rawArgv, {
    fallbackLocale: preLocale.locale,
    valueFlags: VALUE_FLAGS,
  });
  if (stripped.error !== undefined) {
    printErr(stripped.error, colors.stderr, err);
    return 1;
  }

  const resolvedLocale = resolveCliLocale({
    toolName: 'wake',
    flag: stripped.lang,
  });
  const locale: Locale = resolvedLocale.locale;

  const parsed = parseArgs(stripped.argv, locale);
  if (!parsed.ok) {
    printErr(parsed.message, colors.stderr, err);
    return 1;
  }

  const opts = parsed.options;

  if (opts.version) {
    out(version);
    return 0;
  }
  if (opts.help) {
    out(helpText(version, colors.stdout, locale));
    return 0;
  }

  if (opts.command === 'lang') {
    return runLangCommand({
      toolName: 'wake',
      binName: 'wake',
      argv: opts.langArgs ?? [],
      flag: stripped.lang,
      color: colors,
      out,
      err,
    });
  }

  if (opts.command === 'update') {
    return await runSelfUpdate({
      binName: 'wake',
      toolName: 'wake',
      entryMetaUrl: import.meta.url,
      argv: opts.updateArgs ?? [],
      locale,
      io: { out, err },
      color: colors,
    });
  }

  try {
    if (opts.command === 'list') {
      const cfgPath = resolveWakeConfigPath({ configPath: opts.configPath });
      const maybe = tryLoadWakeConfig(cfgPath);
      out(
        renderListReport(cfgPath, maybe.exists ? maybe.loaded.config : null, {
          color: colors.stdout,
          json: opts.json,
          locale,
        }),
      );
      return 0;
    }

    if (opts.command === 'doctor') {
      const report = await diagnoseWake(
        {
          ...(opts.target !== undefined ? { target: opts.target } : {}),
          ...(opts.configPath !== undefined
            ? { configPath: opts.configPath }
            : {}),
        },
        hooks.deps,
      );
      out(
        renderDoctorReport(report, {
          color: colors.stdout,
          json: opts.json,
          locale,
        }),
      );
      return 0;
    }

    if (opts.command === 'init') {
      return await runInitCommand({
        cli: opts,
        locale,
        color: colors.stdout,
        interactive: interactive(),
        out,
        err,
        ...(hooks.deps?.network?.discoverNeighbors !== undefined
          ? { discoverNeighbors: hooks.deps.network.discoverNeighbors }
          : {}),
      });
    }

    const showLiveProgress = !opts.json && colors.stderr;
    let tick = 0;
    let wroteProgress = false;

    const report = await wakeTarget(
      {
        ...(opts.target !== undefined ? { target: opts.target } : {}),
        ...(opts.configPath !== undefined
          ? { configPath: opts.configPath }
          : {}),
        ...(opts.macs.length > 0 ? { macs: opts.macs } : {}),
        ...(opts.host !== undefined ? { host: opts.host } : {}),
        ...(opts.port !== undefined ? { port: opts.port } : {}),
        ...(opts.broadcast.length > 0 ? { broadcast: opts.broadcast } : {}),
        ...(opts.relays.length > 0 ? { relays: opts.relays } : {}),
        wait: opts.wait,
        ...(opts.waitTimeoutMs !== undefined
          ? { waitTimeoutMs: opts.waitTimeoutMs }
          : {}),
        localOnly: opts.localOnly,
        noLocalFallback: opts.noLocalFallback,
        force: opts.force,
        onProgress: showLiveProgress
          ? (event) => {
              tick += 1;
              wroteProgress = true;
              stderrWrite(
                `\r\u001B[2K${renderProgressLine(event, tick, colors.stderr, locale)}`,
              );
            }
          : undefined,
      },
      hooks.deps,
    );

    if (wroteProgress) {
      stderrWrite('\r\u001B[2K');
    }

    out(
      renderWakeReport(report, {
        color: colors.stdout,
        json: opts.json,
        locale,
      }),
    );

    if (report.status === 'timeout') {
      if (!opts.json) {
        printErr(
          t(
            locale,
            '已发送魔术包但目标在超时窗口内未响应 TCP 就绪探测',
            'Magic packet dispatched but target did not become reachable before timeout',
          ),
          colors.stderr,
          err,
        );
      }
      return 1;
    }
    return 0;
  } catch (error) {
    printErr(localizeWakeError(error, locale), colors.stderr, err);
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runWakeCli(process.argv.slice(2));
}
