/**
 * `@iyowei/fan-cli` 顶层入口编排 (支持中英双语、操作系统语言自动探测与独立 `lang` 偏好持久化):
 * 参数解析 -> `-V`/`-h` 短路 -> `lang` 语言设置 -> `update` 自更新 -> `persist` 守护管理 -> `@iyowei/fan` 控制与实时追踪渲染。
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
  type FanController,
  type FanStateStore,
  type FanStatusReport,
  type FanTransport,
  type PersistDaemonStatus,
  type PersistDaemonSyncResult,
  createAppleSmcTransport,
  createFanController,
  createMacOsFanStateStore,
  ensurePersistDaemon,
  getPersistDaemonStatus,
  installPersistDaemon,
  uninstallPersistDaemon,
} from '@iyowei/fan';

import { type CliOptions, parseArgs } from './args.ts';
import {
  getActionTitle,
  getPersistTitle,
  localizeFanError,
  renderWithLiveSettle,
  runWatchLoop,
} from './cli-helpers.ts';
import { helpText } from './help.ts';
import { paint, renderPersistStatus, renderReport } from './render.ts';

export interface PersistDaemonOps {
  getStatus: () => PersistDaemonStatus;
  install: () => PersistDaemonStatus;
  uninstall: () => PersistDaemonStatus;
  ensure?: () => PersistDaemonSyncResult;
}

export interface CliDeps {
  transport?: FanTransport;
  stateStore?: FanStateStore;
  persistOps?: PersistDaemonOps;
  stdoutColor?: boolean;
  stderrColor?: boolean;
  out?: (line: string) => void;
  rawWrite?: (chunk: string) => void;
  err?: (line: string) => void;
  version?: string;
  locale?: Locale;
  env?: Record<string, string | undefined>;
  homedir?: string;
  platform?: NodeJS.Platform;
  /** 是否在调速命令后原地刷新追踪实际转速爬升 (默认仅在真 TTY 交互执行时开启) */
  liveSettle?: boolean;
  settleIntervalMs?: number;
  settleMaxMs?: number;
}

function defaultColors(env: Record<string, string | undefined>): {
  stdout: boolean;
  stderr: boolean;
} {
  const allowed = !env.NO_COLOR && env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

function readCliVersion(): string {
  try {
    const raw = readFileSync(
      new URL('../package.json', import.meta.url),
      'utf8',
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : 'unknown';
  } catch {
    return 'unknown';
  }
}

function runPersistAction(
  persistOps: PersistDaemonOps,
  action: 'status' | 'install' | 'uninstall',
): PersistDaemonStatus {
  if (action === 'install') return persistOps.install();
  if (action === 'uninstall') return persistOps.uninstall();
  return persistOps.getStatus();
}

function resolveFanLocale(
  deps: CliDeps,
  env: Record<string, string | undefined>,
  flag?: 'system' | 'en' | 'zh',
): Locale {
  if (deps.locale !== undefined) return deps.locale;
  return resolveCliLocale({
    toolName: 'fan',
    flag,
    env,
    homedir: deps.homedir,
    platform: deps.platform,
  }).locale;
}

function executeControllerAction(
  controller: FanController,
  options: CliOptions,
): FanStatusReport {
  const fanOpts = { fanIndex: options.fanIndex, persist: !options.once };
  if (options.command === 'status') {
    return controller.status({ fanIndex: options.fanIndex });
  }
  if (options.command === 'set') {
    return controller.set({
      speed: options.speed!,
      fixed: options.fixed,
      ...fanOpts,
    });
  }
  if (options.command === 'max') return controller.max(fanOpts);
  if (options.command === 'min') {
    return controller.min({ fixed: options.fixed, ...fanOpts });
  }
  if (options.command === 'auto') return controller.auto(fanOpts);
  return controller.apply();
}

function handleLangSubcommand(ctx: {
  options: CliOptions;
  locale: Locale;
  deps: CliDeps;
  env: Record<string, string | undefined>;
  color: { stdout: boolean; stderr: boolean };
  out: (line: string) => void;
  err: (line: string) => void;
}): Promise<number> | number {
  const { options, locale, deps, env, color, out, err } = ctx;
  const langStripped = stripLangArgs(options.langArgs ?? [], {
    fallbackLocale: locale,
  });
  if (langStripped.error !== undefined) {
    err(langStripped.error);
    return 1;
  }
  return runLangCommand({
    toolName: 'fan',
    binName: 'fan',
    argv: langStripped.argv,
    flag: langStripped.lang,
    color,
    env,
    homedir: deps.homedir,
    platform: deps.platform,
    out,
    err,
  });
}

/** 执行单次 CLI 调用 (可注入 `transport` / `stateStore` / `persistOps` / `locale` 供单测直测) */
export async function runCli(
  argv: readonly string[],
  deps: CliDeps = {},
): Promise<number> {
  const env = deps.env ?? process.env;
  const colors = defaultColors(env);
  const stdoutColor = deps.stdoutColor ?? colors.stdout;
  const stderrColor = deps.stderrColor ?? colors.stderr;
  const out = deps.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err =
    deps.err ??
    ((line: string) =>
      process.stderr.write(
        stderrColor ? `${paint('✗', '31', true)} ${line}\n` : `${line}\n`,
      ));

  const baseLocale = resolveFanLocale(deps, env);
  const peeked = stripLangArgs(argv, {
    fallbackLocale: baseLocale,
    valueFlags: new Set(['--fan']),
  });
  const preLocale =
    peeked.lang !== undefined
      ? resolveFanLocale(deps, env, peeked.lang)
      : baseLocale;

  const parsed = parseArgs(argv, preLocale);
  if (!parsed.ok) {
    err(
      t(
        preLocale,
        `参数错误: ${parsed.message} (用 --help 查看用法)`,
        `Invalid argument: ${parsed.message} (run 'fan --help' for usage)`,
      ),
    );
    return 1;
  }

  const { options } = parsed;
  const locale = resolveFanLocale(deps, env, options.lang);

  if (options.command === 'lang') {
    return handleLangSubcommand({
      options,
      locale,
      deps,
      env,
      color: { stdout: stdoutColor, stderr: stderrColor },
      out,
      err,
    });
  }

  if (options.version) {
    out(deps.version ?? readCliVersion());
    return 0;
  }
  if (options.help) {
    out(helpText(stdoutColor, locale));
    return 0;
  }

  const hostPlatform = deps.platform ?? process.platform;
  const daemonPaths = {
    platform: hostPlatform,
    env,
    ...(deps.stateStore !== undefined
      ? { statePath: deps.stateStore.path }
      : {}),
  };
  const persistOps: PersistDaemonOps = deps.persistOps ?? {
    getStatus: () => getPersistDaemonStatus(daemonPaths),
    install: () => installPersistDaemon(daemonPaths),
    uninstall: () => uninstallPersistDaemon(daemonPaths),
    ensure: () => ensurePersistDaemon(daemonPaths),
  };

  const ensureFromOps = (): PersistDaemonSyncResult => {
    if (persistOps.ensure !== undefined) return persistOps.ensure();
    const cur = persistOps.getStatus();
    if (cur.installed && cur.running) {
      return { status: cur, action: 'unchanged' };
    }
    const existed = cur.installed;
    const next = persistOps.install();
    return { status: next, action: existed ? 'updated' : 'installed' };
  };

  try {
    if (options.command === 'update') {
      return await runSelfUpdate({
        binName: 'fan',
        toolName: 'fan',
        entryMetaUrl: import.meta.url,
        argv: options.updateArgs ?? [],
        color: { stdout: stdoutColor, stderr: stderrColor },
        deps: {
          env: env as NodeJS.ProcessEnv,
          homeDir: deps.homedir,
          platform: hostPlatform,
        },
      });
    }

    if (options.command === 'persist') {
      const action = options.persistAction ?? 'status';
      const daemonStatus = runPersistAction(persistOps, action);
      out(
        renderPersistStatus(daemonStatus, {
          color: stdoutColor,
          json: options.json,
          title: getPersistTitle(action, locale),
          locale,
        }),
      );
      return 0;
    }

    const isDarwinHost = hostPlatform === 'darwin';
    const shouldManageDaemon =
      deps.persistOps !== undefined ||
      (deps.transport === undefined && isDarwinHost);
    const resolvedTransport =
      deps.transport ?? createAppleSmcTransport({ platform: hostPlatform });
    const resolvedStateStore =
      deps.stateStore ??
      (deps.transport === undefined && isDarwinHost
        ? createMacOsFanStateStore({ platform: hostPlatform, env })
        : undefined);
    const controller = createFanController({
      transport: resolvedTransport,
      stateStore: resolvedStateStore,
      ensureDaemon: shouldManageDaemon ? ensureFromOps : false,
      platform: hostPlatform,
    });

    if (options.command === 'status' && options.watchSeconds !== undefined) {
      return await runWatchLoop({
        controller,
        fanIndex: options.fanIndex,
        intervalSec: options.watchSeconds,
        color: stdoutColor,
        locale,
        out,
      });
    }

    const report = executeControllerAction(controller, options);
    const title = getActionTitle(options.command, locale, {
      fixed: options.fixed,
      once: options.once,
    });
    const isMutatingTuneCmd =
      options.command === 'set' ||
      options.command === 'max' ||
      options.command === 'min' ||
      options.command === 'auto' ||
      options.command === 'apply';
    const shouldLiveSettle =
      !options.json &&
      isMutatingTuneCmd &&
      (deps.liveSettle ?? (deps.out === undefined && stdoutColor));

    if (shouldLiveSettle) {
      const writeRaw =
        deps.rawWrite ??
        (deps.out !== undefined
          ? (chunk: string) =>
              deps.out!(chunk.endsWith('\n') ? chunk.slice(0, -1) : chunk)
          : (chunk: string) => process.stdout.write(chunk));
      const columns =
        deps.rawWrite === undefined &&
        deps.out === undefined &&
        process.stdout.isTTY === true
          ? process.stdout.columns
          : undefined;
      await renderWithLiveSettle({
        initialReport: report,
        controller,
        fanIndex: options.fanIndex,
        color: stdoutColor,
        locale,
        title,
        writeRaw,
        intervalMs: deps.settleIntervalMs ?? 80,
        maxMs: deps.settleMaxMs,
        columns,
      });
      return 0;
    }

    out(
      renderReport(report, {
        color: stdoutColor,
        json: options.json,
        title,
        locale,
      }),
    );
    return 0;
  } catch (error) {
    err(localizeFanError(error, locale, hostPlatform));
    return 1;
  }
}

if (import.meta.main) {
  process.exitCode = await runCli(process.argv.slice(2));
}
