/**
 * CLI 顶层入口编排 (支持中英双语、操作系统语言自动探测与独立 `lang` 偏好持久化):
 * 红线: 向导刚写入配置的当轮强制预览 (即使带 `--yes`); 非 TTY 缺配置拒盲扫退 1;
 * 异常统一收口至 stderr 并返回退出码 1 (权威: `cli-surface.md` 与 ADR 0024)。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  type Locale,
  resolveCliLocale,
  runLangCommand,
  stripLangArgs,
  t,
} from '@iyowei/cli-i18n';
import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type Config,
  type SweepPlan,
  type SweepProgressEvent,
  createSweeper,
  mergeNames,
  resolveConfigPath,
  summarizeReport,
} from '@iyowei/sweep';

import { type CliOptions, parseArgs } from './args.ts';
import {
  type ColorChannels,
  collectNameNotes,
  handleInitCommand,
  reportConfig,
  resolveActiveConfig,
} from './cli-commands.ts';
import { helpText } from './help.ts';
import {
  localizePlanTrailer,
  localizeSweepError,
  localizeSweepWarningText,
} from './i18n-messages.ts';
import { runMigrationFlow } from './migrate-cli.ts';
import {
  abortedUnattemptedCount,
  toExecuteEntry,
  toRenderEntry,
} from './outcome.ts';
import { createSweepProgress } from './progress.ts';
import { paint, render, sanitizeOutputLine } from './render.ts';

const RUNTIME_NAME = typeof Bun === 'undefined' ? 'node' : 'bun';
const runtimeLabel = `${RUNTIME_NAME} ${
  (process.versions as Record<string, string | undefined>)[RUNTIME_NAME] ??
  'unknown'
}`;

function colorChannels(): ColorChannels {
  const allowed =
    !process.env.NO_COLOR && process.env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

function warn(line: string, stderrColor: boolean): void {
  const text = sanitizeOutputLine(line);
  process.stderr.write(
    stderrColor ? `${paint('✗', '31', stderrColor)} ${text}\n` : `${text}\n`,
  );
}

function notice(line: string): void {
  process.stderr.write(`${sanitizeOutputLine(line)}\n`);
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

async function sweep(
  config: Config,
  excludeExplicit: boolean,
  options: CliOptions,
  colors: ColorChannels,
  home: string,
  locale: Locale,
): Promise<number> {
  const sweeper = createSweeper({
    roots: config.roots,
    exclude: mergeNames(config.exclude, options.exclude),
    include: mergeNames(config.include, options.include),
    excludeExplicit: excludeExplicit || options.exclude.includes('.gradle'),
    presets: config.presets,
    rules: config.rules,
    home,
    policy: { releaseSuspects: options.force },
  });

  const runtime = process.stdout.isTTY === true ? runtimeLabel : undefined;
  const progress = createSweepProgress({
    enabled:
      process.stderr.isTTY === true &&
      process.env.TERM?.toLowerCase() !== 'dumb',
    color: colors.stderr,
    rootCount: config.roots.length,
    locale,
  });

  const onProgress = (event: SweepProgressEvent): void => {
    if (event.kind === 'warning') {
      progress.suspend();
      warn(
        localizeSweepWarningText(event.warning.message, locale),
        colors.stderr,
      );
      progress.resume();
      return;
    }
    progress.update(event);
  };

  const nameNotesOf = (plan: SweepPlan): string[] =>
    collectNameNotes(
      plan.nameMatches.exclude,
      plan.nameMatches.include,
      (line) => warn(line, colors.stderr),
      process.stdout.isTTY === true,
      locale,
    );

  if (!options.yes) {
    progress.start();
    let plan: SweepPlan;
    try {
      plan = await sweeper.plan({ onProgress });
    } finally {
      progress.stop();
    }
    print(
      render({
        mode: 'preview',
        roots: plan.roots,
        entries: plan.entries.map((e) => toRenderEntry(e, locale)),
        color: colors.stdout,
        home,
        notes: nameNotesOf(plan),
        runtime,
        trailer: localizePlanTrailer(plan.trailer, locale),
        locale,
      }),
    );
    return 0;
  }

  progress.start();
  let report: Awaited<ReturnType<typeof sweeper.run>>;
  try {
    report = await sweeper.run({ onProgress });
  } finally {
    progress.stop();
  }

  if (report.status === 'rejected') {
    const rejected = report.validation?.rejected ?? [];
    warn(
      t(
        locale,
        `整批拒绝: ${rejected.length} 个目标未通过安全闸, 未执行任何删除`,
        `Batch rejected: ${rejected.length} target(s) failed safety guard; nothing was deleted`,
      ),
      colors.stderr,
    );
    for (const item of rejected) notice(`  ${item.target} (${item.message})`);
    return 1;
  }

  print(
    render({
      mode: 'execute',
      roots: report.plan.roots,
      entries: report.entries.map((e) => toExecuteEntry(e, locale)),
      color: colors.stdout,
      home,
      releasedBytes: report.releasedBytes,
      notes: nameNotesOf(report.plan),
      runtime,
      trailer: localizePlanTrailer(report.plan.trailer, locale),
      locale,
    }),
  );

  const summary = summarizeReport(report);
  if (report.removal?.aborted !== undefined) {
    const unattempted = abortedUnattemptedCount(report, summary);
    warn(
      t(
        locale,
        `整批中止: ${report.removal.aborted.message}`,
        `Batch aborted: ${report.removal.aborted.message}`,
      ),
      colors.stderr,
    );
    notice(
      t(
        locale,
        `  本轮未执行删除: ${unattempted} 处`,
        `  Targets left untouched: ${unattempted}`,
      ),
    );
  }

  return summary.failed === 0 && summary.unprocessed === 0 && !summary.aborted
    ? 0
    : 1;
}

async function main(): Promise<number> {
  const colors = colorChannels();
  const rawArgv = process.argv.slice(2);
  const home = homedir();

  const baseLocale = resolveCliLocale({
    toolName: 'sweep',
    homedir: home,
  }).locale;
  const peeked = stripLangArgs(rawArgv, {
    fallbackLocale: baseLocale,
    valueFlags: new Set(['--exclude', '--include', '--config']),
  });
  const preLocale =
    peeked.lang !== undefined
      ? resolveCliLocale({
          toolName: 'sweep',
          flag: peeked.lang,
          homedir: home,
        }).locale
      : baseLocale;

  const parsed = parseArgs(rawArgv, preLocale);
  if (!parsed.ok) {
    warn(
      t(
        preLocale,
        `参数错误: ${parsed.message} (用 --help 查看用法)`,
        `Invalid argument: ${parsed.message} (run 'sweep --help' for usage)`,
      ),
      colors.stderr,
    );
    return 1;
  }

  const { options } = parsed;
  const locale = resolveCliLocale({
    toolName: 'sweep',
    flag: options.lang,
    homedir: home,
  }).locale;

  if (options.command === 'lang') {
    const stripped = stripLangArgs(options.langArgs ?? [], {
      fallbackLocale: locale,
    });
    if (stripped.error !== undefined) {
      warn(stripped.error, colors.stderr);
      return 1;
    }
    return runLangCommand({
      toolName: 'sweep',
      binName: 'sweep',
      argv: stripped.argv,
      flag: stripped.lang,
      color: colors,
      homedir: home,
      out: print,
      err: (line) => warn(line, colors.stderr),
    });
  }

  if (options.version) {
    print(readCliVersion());
    return 0;
  }
  if (options.help) {
    print(helpText(colors.stdout, locale));
    return 0;
  }

  let activeConfigPath: string | undefined;

  try {
    if (options.command === 'update') {
      return await runSelfUpdate({
        binName: 'sweep',
        toolName: 'sweep',
        entryMetaUrl: import.meta.url,
        argv: options.updateArgs ?? [],
        color: colors,
      });
    }

    const resolvedPath = resolveConfigPath({
      flag: options.config,
      homedir: home,
    });
    activeConfigPath = resolvedPath.path;

    if (options.command === 'init') {
      return await handleInitCommand({
        configPath: resolvedPath.path,
        defaultConfig: options.defaultConfig,
        interactive: interactive(),
        colors,
        home,
        locale,
        print,
        warn: (line) => warn(line, colors.stderr),
      });
    }

    if (options.command === 'migrate') {
      const outcome = await runMigrationFlow({
        resolved: resolvedPath,
        explicit: true,
        interactive: interactive(),
        colors,
        home,
        locale,
        print,
        warn: (line) => warn(line, colors.stderr),
        notice,
      });
      return outcome.state === 'error' ? 1 : 0;
    }

    if (options.command === 'config') {
      return await reportConfig(resolvedPath, colors.stdout, print, locale);
    }

    const resolved = await resolveActiveConfig({
      resolved: resolvedPath,
      colors,
      home,
      locale,
      interactive: interactive(),
      print,
      warn: (line) => warn(line, colors.stderr),
      notice,
    });
    if (resolved.state === 'abort') return resolved.exitCode;

    const freshConfig = resolved.source === 'wizard';
    if (freshConfig && options.yes) {
      notice(
        t(
          locale,
          '首次配置已生成; 本轮先预览, 复核后可再运行 --yes 执行',
          'Initial configuration created; showing preview first. Rerun with --yes to clean',
        ),
      );
    }

    return await sweep(
      resolved.config,
      resolved.excludeExplicit,
      freshConfig ? { ...options, yes: false } : options,
      colors,
      home,
      locale,
    );
  } catch (error) {
    warn(localizeSweepError(error, activeConfigPath, locale), colors.stderr);
    return 1;
  }
}

process.exitCode = await main();
