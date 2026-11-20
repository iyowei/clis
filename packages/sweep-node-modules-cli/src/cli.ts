/**
 * 入口编排: 参数解析 → 配置定位, 子命令分流 (`init` 向导 / `config` 报告) 或装载
 * (缺失按交互与否分流) → 清理流程 (处理链全在 API 包 createSweeper: 预览走 plan,
 * `--yes` 走 run; 本层只做选项组装、告警透传、渲染与退出码)。
 * 权威: packages/sweep-node-modules-cli/docs/designs/cli-surface.md (命令面 / 退出码) 与 config-and-initialization.md。
 */
import { readFileSync } from 'node:fs';
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname } from 'node:path';

import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type Config,
  type ConfigSource,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  type ScanResult,
  type SweepPlan,
  type SweepProgressEvent,
  createSweeper,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  isSweepError,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

import { type CliOptions, parseArgs } from './args.ts';
import { helpText } from './help.ts';
import { type InitResult, createReadlineIO, runInit } from './init.ts';
import {
  abortedUnattemptedCount,
  toExecuteEntry,
  toRenderEntry,
} from './outcome.ts';
import { createSweepProgress } from './progress.ts';
import {
  bannerLine,
  neutralLine,
  paint,
  render,
  sanitizeLine,
  sanitizeOutputLine,
} from './render.ts';

/** stdout 与 stderr 各自独立的着色开关 (任一通道重定向为非 TTY 时互不串色) */
interface ColorChannels {
  stdout: boolean;
  stderr: boolean;
}

/**
 * 运行时自述 (如 `bun 1.4.2`), 供输出如实展示本次的执行环境: 取运行时自报字段而非外部探测
 * (直接跑 `node dist/cli.js` 或经启动器跑, 报的都是真身)。
 */
const RUNTIME_NAME = typeof Bun === 'undefined' ? 'node' : 'bun';
const runtimeLabel = `${RUNTIME_NAME} ${
  (process.versions as Record<string, string | undefined>)[RUNTIME_NAME] ??
  'unknown'
}`;

/** 着色开关: stdout 与 stderr 分别判定各自 isTTY, 同受 NO_COLOR 与 TERM=dumb 能力降级约束 */
function colorChannels(): ColorChannels {
  const allowed =
    !process.env.NO_COLOR && process.env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

/** 交互判定: stdin 与 stdout 均为 TTY 才进向导; 管道 / 重定向一律回退, 不阻塞脚本与定时任务 */
function interactive(): boolean {
  return process.stdin.isTTY === true && process.stdout.isTTY === true;
}

/** 清单主体走 stdout */
function print(line: string): void {
  process.stdout.write(`${line}\n`);
}

/**
 * 诊断信息 (错误 / 告警) 走 stderr, 不污染清单输出; stderr 为 TTY 时带红色 ✗ 前缀, 否则零 ANSI 纯文本。
 * 文本一律经 sanitizeOutputLine 净化 (与清单面同一源实现)。
 */
function warn(line: string, stderrColor: boolean): void {
  const text = sanitizeOutputLine(line);
  process.stderr.write(
    stderrColor ? `${paint('✗', '31', stderrColor)} ${text}\n` : `${text}\n`,
  );
}

/**
 * 非诊断性提示 (回退说明 / 拒绝详情) 走 stderr 但不加标记, 与告警区分层级;
 * 净化口径与 warn 同源 (行首缩进保留 —— 它是层级视觉而非外部数据)。
 */
function notice(line: string): void {
  process.stderr.write(`${sanitizeOutputLine(line)}\n`);
}

/** 读 CLI 包版本号 (从相邻 package.json 读取, 源码态 src/cli.ts 与打包态 dist/cli.js 同相对路径) */
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

/** 路径存在判定 (lstat 语义: 悬空符号链接也算存在): 配置判重、config 查询与根存在性共用 */
async function pathExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/** 目录类型判定 (lstat + isDirectory): 拦截普通文件路径写入 roots */
async function rootIsDirectory(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * 跑初始化向导 (交互全在 init 模块, 本层只注入 readline、家目录与落盘通道)。
 * 锚点形态的两个判定入口 (根 / 落盘目标) 都直接取自 guard (删除侧同一实现)。
 */
function runWizard(
  configPath: string,
  stdoutColor: boolean,
  home: string,
): Promise<InitResult> {
  return runInit({
    configPath,
    configExists: pathExists,
    configIsDirectory: rootIsDirectory,
    rootExists: pathExists,
    rootIsDirectory,
    firstSymlinkOnRoot,
    firstSymlinkOnTarget,
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    home,
    io: createReadlineIO(stdoutColor),
  });
}

/** 配置来源的人话标签 (与 resolveConfigPath 的 source 三档一一对应) */
const SOURCE_LABELS: Record<ConfigSource, string> = {
  flag: '--config 指定',
  env: '环境变量 SWEEP_NM_CONFIG',
  'platform-default': '平台默认',
};

/**
 * config 子命令: 如实报告本次实际生效的配置位置与状态, 退出码恒 0 —— 这是查询不是校验,
 * 文件不存在属报告内容而非错误 (与 `git config --list` / `npm config get` 的惯例一致)。
 * 只 lstat 探存在性、不装载内容: 配置损坏与否不在报告面内 (那是清理流程的硬错)。
 */
async function reportConfig(
  resolved: ResolvedConfigPath,
  stdoutColor: boolean,
): Promise<number> {
  const exists = await pathExists(resolved.path);
  print(
    bannerLine(`配置 · 来源: ${SOURCE_LABELS[resolved.source]}`, stdoutColor),
  );
  print(neutralLine(`配置路径: ${sanitizeLine(resolved.path)}`, stdoutColor));
  print(neutralLine(`文件状态: ${exists ? '存在' : '不存在'}`, stdoutColor));
  return 0;
}

/**
 * 装载结果: 配置来源决定本轮语义 ——
 * file = 既有配置文件 (正常走预览 / 执行); wizard = 本轮向导刚生成 (本轮强制预览);
 * fallback = 无配置的 cwd 回退态 (不承载 --yes 的执行语义)。
 */
interface ResolvedConfig {
  config: Config;
  source: 'file' | 'wizard' | 'fallback';
}

/**
 * 装载配置 (须在 scan 之前, 显式路径写错时不得进入扫描与删除);
 * 缺失 (absent) 只可能来自平台默认来源, 此时按交互与否分流:
 * TTY 进向导, 完成后继续本次预览; 非 TTY 回退「以当前目录为根」并标记回退态。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   resolved = { path: '/Users/iyowei/.config/sweep-node-modules/config.json', source: 'platform-default' }
 *
 * 步骤 1：装载 (显式来源不存在即抛错 `配置不存在`, 平台默认来源保留软行为)
 *   loadResolvedConfig → { state: 'absent' }
 *
 * 步骤 2：非交互 → 以当前目录为根并标记回退态 (排除名单补默认名单, 与配置装载的缺省口径一致)
 *   return { config: { roots: ['/Users/iyowei/workspace/development'], exclude: [...DEFAULT_EXCLUDE], include: [] }, source: 'fallback' }
 *
 * Output（数据契约）
 *   return ResolvedConfig (向导取消 / 拒绝覆盖时 return null, 本次不启动清理)
 * ```
 */
async function resolveConfig(
  resolved: ResolvedConfigPath,
  stdoutColor: boolean,
  home: string,
): Promise<ResolvedConfig | null> {
  const loaded = await loadResolvedConfig(resolved);
  if (loaded.state === 'ok') return { config: loaded.config, source: 'file' };

  if (!interactive())
    return {
      config: {
        roots: [process.cwd()],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
      },
      source: 'fallback',
    };

  const result = await runWizard(resolved.path, stdoutColor, home);
  if (result.state === 'written' && result.config !== undefined) {
    return { config: result.config, source: 'wizard' };
  }

  print('配置未写入, 本次未执行清理');
  return null;
}

/** 名单命中统计 (字段可选, 胜出门面提供; 排除与包含同形) */
type NameMatches = NonNullable<ScanResult['excludeMatches']>;

/** 内置默认排除名单的名字集合 (零命中静默的判据; 名单本体见 config.ts 的 DEFAULT_EXCLUDE) */
const BUILTIN_EXCLUDE_NAMES = new Set(DEFAULT_EXCLUDE);

/**
 * 名单反馈 (名单写错不得静默, 见 types.ts「excludeMatches」与「includeMatches」):
 * 未命中的名字一律就地告警 (走 stderr); 命中的回执仅在 stdout 为真终端时随清单输出为顶栏下方的中性提示行。
 * 内置默认名单项零命中静默 (名单依平台与用户环境而异, 不是可修正的输入)。
 */
function collectNameNotes(
  excludeMatches: NameMatches | undefined,
  includeMatches: NameMatches | undefined,
  stderrColor: boolean,
): string[] {
  const notes: string[] = [];
  // 与 notes 的去向 (stdout) 同一判据: 提示进清单流, 便按 stdout 是否为终端决定要不要加
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
 * 清理流程 (库编排 + 渲染薄壳): 预览 = plan → 渲染; `--yes` = run → 渲染执行报告。
 * 退出码 (设计: cli-surface.md「退出码」; 即库侧三档配方的严格档): 预览 / 空结果 / 仅 missing 记 0;
 * 安全闸整批拒绝 / 删除复核整批中止 / 删除有失败 / 有跳过项 (疑似安装树 / 跨设备目标)
 * 或未测到体积的目标记 1。
 */
async function sweep(
  config: Config,
  options: CliOptions,
  colors: ColorChannels,
  home: string,
): Promise<number> {
  const sweeper = createSweeper({
    roots: config.roots,
    exclude: mergeNames(config.exclude, options.exclude),
    include: mergeNames(config.include, options.include),
    home,
    policy: { releaseSuspects: options.force },
  });

  // 运行时自述与名单回执同判据: 都只在真终端展示, 非 TTY (脚本 / 管道) 下不增噪音
  const runtime = process.stdout.isTTY === true ? runtimeLabel : undefined;
  // TTY 实时进度指示器 (走 stderr, 非 TTY / TERM=dumb 下完全静默 0 字节输出)
  const progress = createSweepProgress({
    enabled:
      process.stderr.isTTY === true &&
      process.env.TERM?.toLowerCase() !== 'dumb',
    color: colors.stderr,
    rootCount: config.roots.length,
  });
  // 告警 (根不存在等环境问题与体积统计告警) 实时透传 stderr; 插队前先擦除进度行防串行
  const onProgress = (event: SweepProgressEvent): void => {
    if (event.kind === 'warning') {
      progress.suspend();
      warn(event.warning.message, colors.stderr);
      progress.resume();
      return;
    }
    progress.update(event);
  };
  // 未命中的名单名就地告警、命中的回执随清单输出 (写错不得静默, 见 collectNameNotes)
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

  // 安全闸整批拒绝: 零删除, 逐条报告拒绝理由 (不渲染清单, 与改造前一致)
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

  // 提前汇总: 供整批中止播报真实未删数 (not-attempted) 与末尾退出码共用
  const summary = summarizeReport(report);

  // 复核中止与逐条失败区分展示 (紧贴汇总, 便于诊断):
  // 并发窗口内已派发条目会完成并如实报告, 此处播报本轮实际未执行删除的条目数
  if (report.removal?.aborted !== undefined) {
    warn(`整批中止: ${report.removal.aborted.message}`, colors.stderr);
    notice(`  本轮未执行删除: ${abortedUnattemptedCount(report, summary)} 处`);
  }

  // 退出码: 库侧三档配方的严格档 (任何未处理项、失败或中止都算失败)
  return summary.failed === 0 && summary.unprocessed === 0 && !summary.aborted
    ? 0
    : 1;
}

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
  // home 统一采样一次, 贯穿配置定位、向导、编排器与清单缩写 (同源语义)
  const home = homedir();
  let activeConfigPath: string | undefined;

  try {
    if (options.command === 'update') {
      return await runSelfUpdate({
        binName: 'sweep-nm',
        entryMetaUrl: import.meta.url,
        argv: options.updateArgs ?? [],
        color: colors,
      });
    }

    // 路径与其来源一并保留: 来源决定「文件不存在」是硬错 (旗标 / 环境变量打错) 还是软态 (平台默认)
    const resolvedPath = resolveConfigPath({
      flag: options.config,
      homedir: home,
    });
    activeConfigPath = resolvedPath.path;

    // init 子命令: 只跑向导重写配置, 不进入清理流程; 向导要逐问逐答, 无交互终端即报错退出
    if (options.command === 'init') {
      if (!interactive()) {
        warn(
          'init 需要交互终端 (请在终端直接运行, 不要重定向或经管道)',
          colors.stderr,
        );
        return 1;
      }
      const result = await runWizard(resolvedPath.path, colors.stdout, home);
      if (result.state === 'written')
        print(neutralLine('运行 sweep-nm 查看预览', colors.stdout));
      else if (result.state === 'declined-overwrite') print('配置未变更');
      return 0;
    }

    // config 子命令: 只报告本次实际生效的配置, 不进入装载与清理流程 (文件不存在也退 0)
    if (options.command === 'config') {
      return await reportConfig(resolvedPath, colors.stdout);
    }

    const resolved = await resolveConfig(resolvedPath, colors.stdout, home);
    if (resolved === null) return 0;

    // 无配置的 cwd 回退态不承载执行语义: 首次用户可能只凭一行提示就删掉整棵目录树的 node_modules
    if (resolved.source === 'fallback') {
      const roots = resolved.config.roots.join(', ');
      if (options.yes) {
        warn('拒绝执行: 当前无配置文件, --yes 不可用', colors.stderr);
        notice(`  将扫的根: ${roots}`);
        notice('  先 sweep-nm init 生成配置, 或用 --config 指定配置文件');
        return 1;
      }
      notice(
        `未找到配置文件, 本次以当前目录为根: ${roots} (想固定此设置, 运行 sweep-nm init)`,
      );
    }

    // 向导刚写入配置的这一轮强制预览: 用户尚未见过任何清单, 带 --yes 也不得直删
    const freshConfig = resolved.source === 'wizard';
    if (freshConfig && options.yes) {
      notice('首次配置已生成; 本轮先预览, 复核后可再运行 --yes 执行');
    }

    return await sweep(
      resolved.config,
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
