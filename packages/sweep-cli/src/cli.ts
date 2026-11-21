/**
 * CLI 顶层入口编排: 上游由 `bin/sweep.mjs` 启动, 下游串联 `args.ts` / `cli-commands.ts` /
 * `migrate-cli.ts` / `@iyowei/sweep` (`createSweeper`) / `progress.ts` / `outcome.ts` / `render.ts`。
 * 红线: 向导刚写入配置的当轮强制预览 (即使带 `--yes`); 非 TTY 缺配置拒盲扫退 1;
 * 异常统一收口至 stderr 并返回退出码 1 (权威: `cli-surface.md` 与 ADR 0024)。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type Config,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  type ScanResult,
  type SweepPlan,
  type SweepProgressEvent,
  createSweeper,
  isSweepError,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
  summarizeReport,
} from '@iyowei/sweep';

import { type CliOptions, parseArgs } from './args.ts';
import {
  type ColorChannels,
  handleInitCommand,
  reportConfig,
  runWizard,
} from './cli-commands.ts';
import { helpText } from './help.ts';
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

type ResolveOutcome =
  | {
      state: 'ready';
      config: Config;
      excludeExplicit: boolean;
      source: 'file' | 'wizard' | 'migrated';
    }
  | { state: 'abort'; exitCode: number };

/**
 * 装载生效配置 (先探自动迁移, 再按存在性与交互性分流):
 * - 命中旧路径 / v1 配置: 触发 `runMigrationFlow` (写前必备份, 非 TTY 仅 100% 无损放行);
 * - 未触发迁移: 调 `loadResolvedConfig` (显式 `--config` / `SWEEP_CONFIG` 缺失会抛 `CONFIG_ABSENT`);
 * - 平台默认路径缺失: TTY 拉起 `runWizard` (返回 `source: 'wizard'`, 上游强制本轮预览);
 *   非 TTY 严禁阻塞或盲扫家目录, 立即告警并返回 `{ state: 'abort', exitCode: 1 }`。
 *
 * ### 数据流转示例
 * ```text
 * Input  : resolved = { path: '~/.config/sweep/config.json', source: 'platform-default' }, interactive = true
 * 步骤 1 : runMigrationFlow({ explicit: false }) -> { state: 'none' } (无旧配置)
 * 步骤 2 : loadResolvedConfig(resolved) -> { state: 'absent' } (默认配置不存在)
 * 步骤 3 : TTY 分支启动 runWizard -> 用户完成四问并确认写盘 -> { state: 'written', config }
 * Output : { state: 'ready', config, excludeExplicit, source: 'wizard' } (main 随后剥离 --yes 强制预览)
 * ```
 */
async function resolveConfig(
  resolved: ResolvedConfigPath,
  colors: ColorChannels,
  home: string,
): Promise<ResolveOutcome> {
  const migration = await runMigrationFlow({
    resolved,
    explicit: false,
    interactive: interactive(),
    colors,
    home,
    print,
    warn: (line) => warn(line, colors.stderr),
    notice,
  });

  if (migration.state === 'error') return { state: 'abort', exitCode: 1 };
  if (migration.state === 'cancelled') return { state: 'abort', exitCode: 0 };
  if (migration.state === 'migrated') {
    return {
      state: 'ready',
      config: migration.config,
      excludeExplicit: migration.excludeExplicit,
      source: 'migrated',
    };
  }

  const loaded = await loadResolvedConfig(resolved, { homedir: home });
  if (loaded.state === 'ok') {
    return {
      state: 'ready',
      config: loaded.config,
      excludeExplicit: loaded.excludeExplicit,
      source: 'file',
    };
  }

  if (!interactive()) {
    warn(
      `未找到配置文件 (${resolved.path}), 非交互模式下拒绝盲扫; 请先运行 sweep init 或 sweep init --default, 或用 --config 指定配置文件`,
      colors.stderr,
    );
    return { state: 'abort', exitCode: 1 };
  }

  const result = await runWizard(resolved.path, colors.stdout, home);
  if (result.state === 'written' && result.config !== undefined) {
    return {
      state: 'ready',
      config: result.config,
      excludeExplicit: result.excludeExplicit ?? false,
      source: 'wizard',
    };
  }

  print('配置未写入, 本次未执行清理');
  return { state: 'abort', exitCode: 0 };
}

type NameMatches = NonNullable<ScanResult['excludeMatches']>;
const BUILTIN_EXCLUDE_NAMES = new Set(DEFAULT_EXCLUDE);

/** 汇总扫描期排除/包含名单回执: 用户自定义项零命中走 stderr 告警 (跳过内置护栏), 命中项仅在 stdout 为 TTY 时入顶栏提示 */
function collectNameNotes(
  excludeMatches: NameMatches | undefined,
  includeMatches: NameMatches | undefined,
  stderrColor: boolean,
): string[] {
  const notes: string[] = [];
  const tty = process.stdout.isTTY === true;

  for (const item of excludeMatches ?? []) {
    if (item.hits === 0) {
      if (BUILTIN_EXCLUDE_NAMES.has(item.name)) continue;
      warn(
        `排除名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
        stderrColor,
      );
    } else if (tty) notes.push(`排除生效: ${item.name} (${item.hits} 处)`);
  }

  const includes = includeMatches ?? [];
  for (const item of includes) {
    if (item.hits === 0)
      warn(
        `包含名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
        stderrColor,
      );
    else if (tty) notes.push(`包含命中: ${item.name} (${item.hits} 处)`);
  }
  if (includes.length > 0 && includes.every((item) => item.hits === 0))
    warn(
      '包含名单无一条命中, 本次扫描必为空结果 (请核对名字与大小写; 若名字位于被排除的目录之下则属预期)',
      stderrColor,
    );

  return notes;
}

/**
 * 执行主清理编排: 组装 `createSweeper` -> 驱动 stderr 实时进度 -> 按 `options.yes` 分流预览 (`plan`) 或执行 (`run`)。
 * 告警事件经 `progress.suspend() -> warn() -> progress.resume()` 插入防花屏;
 * 预览恒退 0, 执行在安全闸整批拒绝、存在失败/未处理项或整批中止时退 1。
 *
 * ### 数据流转示例
 * ```text
 * Input  : config (v2), options = { yes: true, force: false, exclude: ['demo'], include: [] }
 * 步骤 1 : mergeNames 合并配置与 CLI 名单 -> createSweeper({ ..., policy: { releaseSuspects: false } })
 * 步骤 2 : progress.start() -> sweeper.run({ onProgress }) -> finally { progress.stop() }
 * 步骤 3 : status === 'rejected' 时输出被拒清单并退 1; 否则 entries.map(toExecuteEntry) -> render(mode='execute')
 * 步骤 4 : 若 removal.aborted 补整批中止告警与 abortedUnattemptedCount; summarizeReport 判定退出码
 * Output : 0 (failed === 0 && unprocessed === 0 && !aborted) 或 1
 * ```
 */
async function sweep(
  config: Config,
  excludeExplicit: boolean,
  options: CliOptions,
  colors: ColorChannels,
  home: string,
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
  });

  const onProgress = (event: SweepProgressEvent): void => {
    if (event.kind === 'warning') {
      progress.suspend();
      warn(event.warning.message, colors.stderr);
      progress.resume();
      return;
    }
    progress.update(event);
  };

  const nameNotesOf = (plan: SweepPlan): string[] =>
    collectNameNotes(
      plan.nameMatches.exclude,
      plan.nameMatches.include,
      colors.stderr,
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
        entries: plan.entries.map(toRenderEntry),
        color: colors.stdout,
        home,
        notes: nameNotesOf(plan),
        runtime,
        trailer: plan.trailer,
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
      `整批拒绝: ${rejected.length} 个目标未通过安全闸, 未执行任何删除`,
      colors.stderr,
    );
    for (const item of rejected) notice(`  ${item.target} (${item.message})`);
    return 1;
  }

  print(
    render({
      mode: 'execute',
      roots: report.plan.roots,
      entries: report.entries.map(toExecuteEntry),
      color: colors.stdout,
      home,
      releasedBytes: report.releasedBytes,
      notes: nameNotesOf(report.plan),
      runtime,
      trailer: report.plan.trailer,
    }),
  );

  const summary = summarizeReport(report);
  if (report.removal?.aborted !== undefined) {
    warn(`整批中止: ${report.removal.aborted.message}`, colors.stderr);
    notice(`  本轮未执行删除: ${abortedUnattemptedCount(report, summary)} 处`);
  }

  return summary.failed === 0 && summary.unprocessed === 0 && !summary.aborted
    ? 0
    : 1;
}

/** 总入口: 参数解析 -> `-V`/`-h` 短路 -> `update`/`init`/`migrate`/`config` 子命令分流 -> 配置装载与主清理; 异常统一落 stderr 退 1 */
async function main(): Promise<number> {
  const colors = colorChannels();
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    warn(`参数错误: ${parsed.message} (用 --help 查看用法)`, colors.stderr);
    return 1;
  }

  const { options } = parsed;
  if (options.version) {
    print(readCliVersion());
    return 0;
  }
  if (options.help) {
    print(helpText(colors.stdout));
    return 0;
  }
  const home = homedir();
  let activeConfigPath: string | undefined;

  try {
    if (options.command === 'update') {
      return await runSelfUpdate({
        binName: 'sweep',
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
        print,
        warn: (line) => warn(line, colors.stderr),
        notice,
      });
      return outcome.state === 'error' ? 1 : 0;
    }

    if (options.command === 'config') {
      return await reportConfig(resolvedPath, colors.stdout, print);
    }

    const resolved = await resolveConfig(resolvedPath, colors, home);
    if (resolved.state === 'abort') return resolved.exitCode;

    // 向导刚写入配置的这一轮强制预览: 用户尚未见过任何清单, 带 --yes 也不得直删
    const freshConfig = resolved.source === 'wizard';
    if (freshConfig && options.yes) {
      notice('首次配置已生成; 本轮先预览, 复核后可再运行 --yes 执行');
    }

    return await sweep(
      resolved.config,
      resolved.excludeExplicit,
      freshConfig ? { ...options, yes: false } : options,
      colors,
      home,
    );
  } catch (error) {
    const baseMessage = error instanceof Error ? error.message : String(error);
    const message =
      isSweepError(error) &&
      error.code === 'INVALID_ARGUMENT' &&
      activeConfigPath !== undefined
        ? `${baseMessage} (配置: ${activeConfigPath})`
        : baseMessage;
    warn(message, colors.stderr);
    return 1;
  }
}

process.exitCode = await main();
