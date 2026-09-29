/**
 * 入口编排: 参数解析 → 配置定位, 子命令分流 (`init` 向导 / `config` 报告) 或装载
 * (缺失按交互与否分流) → 清理流程 (处理链全在 API 包 createSweeper: 预览走 plan,
 * `--yes` 走 run; 本层只做选项组装、告警透传、渲染与退出码)。
 * 权威: docs/designs/cli-surface.md (命令面 / 退出码) 与 config-and-initialization.md。
 */
import { lstat, mkdir, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname } from 'node:path';

import {
  type Config,
  type ConfigSource,
  type CrossDeviceKind,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  type ScanResult,
  type SkipCandidate,
  type SweepEntry,
  type SweepOutcomeEntry,
  type SweepPlan,
  type SweepProgressEvent,
  collectSkips,
  createSweeper,
  crossDeviceNote,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

import { helpText } from './help.ts';
import { type InitResult, createReadlineIO, runInit } from './init.ts';
import {
  type RenderEntry,
  bannerLine,
  neutralLine,
  paint,
  render,
  sanitizeLine,
  sanitizeOutputLine,
} from './render.ts';

interface CliOptions {
  /** 子命令: 缺省为清理流程, init 只跑向导, config 只报告配置 */
  command: 'sweep' | 'init' | 'config';
  /** 执行删除 (缺省为预览) */
  yes: boolean;
  /** 连同疑似安装树一并纳入删除批 (缺省跳过; 只影响批次构造, 不放宽安全闸的不变量) */
  force: boolean;
  /** `--exclude` 可重复, 与配置名单合并 */
  exclude: string[];
  /** `--include` 可重复, 与配置名单合并 */
  include: string[];
  /** `--config` 旗标值 (配置路径的最高优先级来源) */
  config?: string;
  help: boolean;
}

type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

/**
 * 解析参数: `--yes` / `--force` / `--exclude <name>` / `--include <name>` / `--config <path>` /
 * `--help` 与 `init` / `config` 子命令; 未知参数、旗标缺值、多余位置参数一律判错 (调用方落退出码 1)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   argv = ['--exclude', 'my-kits', '--include', 'self', '--yes']
 *
 * 步骤 1：逐项识别
 *   --exclude 收值 'my-kits'; --include 收值 'self'; --yes 置位; 无位置参数
 *
 * Output（数据契约）
 *   return { ok: true, options: { command: 'sweep', yes: true, force: false, exclude: ['my-kits'], include: ['self'], help: false } }
 * ```
 */
function parseArgs(argv: string[]): ParseOutcome {
  const options: CliOptions = {
    command: 'sweep',
    yes: false,
    force: false,
    exclude: [],
    include: [],
    help: false,
  };
  const positionals: string[] = [];

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    // 索引由循环条件保证在界内, 此判仅为 noUncheckedIndexedAccess 的类型收窄
    if (arg === undefined) continue;
    if (arg === '--yes') {
      options.yes = true;
      continue;
    }
    if (arg === '--force') {
      options.force = true;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--exclude' || arg === '--include' || arg === '--config') {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, message: `参数 ${arg} 缺少取值` };
      }
      if (arg === '--exclude') options.exclude.push(value);
      else if (arg === '--include') options.include.push(value);
      else options.config = value;
      index += 1;
      continue;
    }
    if (arg.startsWith('-')) return { ok: false, message: `未知参数: ${arg}` };
    positionals.push(arg);
  }

  const [only] = positionals;
  if (
    positionals.length > 1 ||
    (only !== undefined && only !== 'init' && only !== 'config')
  ) {
    return { ok: false, message: `未知参数: ${positionals.join(' ')}` };
  }
  if (only === 'init' || only === 'config') options.command = only;
  return { ok: true, options };
}

/**
 * 运行时自述 (如 `bun 1.4.2`), 供输出如实展示本次的执行环境: 取运行时自报字段而非外部探测
 * (直接跑 `node dist/cli.js` 或经启动器跑, 报的都是真身)。
 * 设计裁定 runtime 适配层不属公开面 (api-surface.md §2.1: 调用方自取), 故在本层一行自取;
 * 探测方式与原 runtime.ts 同款。
 */
const RUNTIME_NAME = typeof Bun === 'undefined' ? 'node' : 'bun';
const runtimeLabel = `${RUNTIME_NAME} ${
  (process.versions as Record<string, string | undefined>)[RUNTIME_NAME] ??
  'unknown'
}`;

/** 着色开关: 仅标准输出为 TTY 且未设 NO_COLOR (空值按未设处理) */
function colorEnabled(): boolean {
  return process.stdout.isTTY === true && !process.env.NO_COLOR;
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
 * 诊断信息 (错误 / 告警) 走 stderr, 不污染清单输出; TTY 下带红色 ✗ 前缀, 非 TTY 零 ANSI 纯文本。
 * 文本一律经 sanitizeOutputLine 净化 (与清单面同一源实现): 本面承载的恰是最脏的数据 ——
 * 磁盘路径 / `du` 的 stderr 原文 / 配置文件与 argv 里的名单拼写 / 参数错误消息, 全是低信任输入;
 * 净化挡两件事: 控制字节直达终端 (改标题 / 清屏 / 光标回写覆盖已打印内容), 以及换行把一条告警
 * 劈成两行、伪造出一行可信输出 (非 TTY 下 stderr 常被 tee 与 CI 原样落盘, 回放时同样生效)。
 * --yes 流程下 stdout 为空, 本面是删除前唯一可见信息, 故与清单面同等设防。
 */
function warn(line: string, color: boolean): void {
  const text = sanitizeOutputLine(line);
  process.stderr.write(
    color ? `${paint('✗', '31', color)} ${text}\n` : `${text}\n`,
  );
}

/**
 * 非诊断性提示 (回退说明 / 拒绝详情) 走 stderr 但不加标记, 与告警区分层级;
 * 净化口径与 warn 同源 (行首缩进保留 —— 它是层级视觉而非外部数据)。
 */
function notice(line: string): void {
  process.stderr.write(`${sanitizeOutputLine(line)}\n`);
}

/** 文件存在判定 (lstat 语义): 向导的落盘前判重与 config 子命令的「文件状态」共用同一口径 */
async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * 跑初始化向导 (交互全在 init 模块, 本层只注入 readline 与落盘通道)。
 * 落盘前先建目标目录: 平台默认配置路径首跑时父目录尚不存在 (如 ~/.config/sweep-node-modules)。
 * 锚点形态的两个判定入口 (根 / 落盘目标) 都直接取自 guard (删除侧同一实现): 向导不该另有一套口径,
 * 否则「向导通过、--yes 全拒」的错位又会从实现分家里长回来, 写入侧的锚点各自实现也会分家成
 * 「向导照写、删除侧照拒」的同一类错位。
 */
function runWizard(configPath: string, color: boolean): Promise<InitResult> {
  return runInit({
    configPath,
    fileExists,
    firstSymlinkOnRoot,
    firstSymlinkOnTarget,
    async writeFile(path, text) {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf8');
    },
    io: createReadlineIO(color),
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
 * 与 `--help` 的分工: 帮助里的「默认配置位置」刻意屏蔽环境变量、只答平台默认 (见 help.ts 的 defaultConfigPath),
 * 本命令答的是三级覆盖后真正生效的那一个。
 * 只 lstat 探存在性、不装载内容: 配置损坏与否不在报告面内 (那是清理流程的硬错)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   resolved = { path: '/Users/iyowei/.config/sweep-node-modules/config.json', source: 'platform-default' }
 *
 * 步骤 1：来源映射人话 (flag → '--config 指定'; env → '环境变量 SWEEP_NM_CONFIG'; platform-default → '平台默认')
 *   label = '平台默认'
 *
 * 步骤 2：探文件存在 (lstat; 不存在也照常报告, 不改退出码)
 *   exists = false
 *
 * Output（数据契约）
 *   print 顶栏 + 两行中性提示 (来源 / 路径 / 文件状态); return 0
 * ```
 */
async function reportConfig(
  resolved: ResolvedConfigPath,
  color: boolean,
): Promise<number> {
  const exists = await fileExists(resolved.path);
  // 来源是最核心信息, 由顶栏承载; 路径与状态作顶栏下方的中性提示行 (与清单同一视觉语言)
  // 路径来自旗标 / 环境变量原样透传, 属外部数据, 经同一净化 (来源标签是固定枚举, 无需净化)
  print(bannerLine(`配置 · 来源: ${SOURCE_LABELS[resolved.source]}`, color));
  print(neutralLine(`配置路径: ${sanitizeLine(resolved.path)}`, color));
  print(neutralLine(`文件状态: ${exists ? '存在' : '不存在'}`, color));
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
 * 缺失 (absent) 只可能来自平台默认来源 (旗标 / 环境变量指向不存在文件由 loadResolvedConfig 抛错),
 * 此时按交互与否分流 (设计: config-and-initialization.md「配置初始化模型」):
 * TTY 进向导, 完成后继续本次预览; 非 TTY 回退「以当前目录为根」并标记回退态, 由调用方分流提示与拒绝。
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
 *   return { config: { roots: ['/Users/iyowei/workspace/development'], exclude: [...DEFAULT_EXCLUDE], include: [] }, fallback: true }
 *
 * Output（数据契约）
 *   return ResolvedConfig (向导取消 / 拒绝覆盖时 return null, 本次不启动清理)
 * ```
 */
async function resolveConfig(
  resolved: ResolvedConfigPath,
  color: boolean,
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

  const result = await runWizard(resolved.path, color);
  if (result.state === 'written' && result.config !== undefined) {
    // 直接用向导返回的配置: 它与 init 写盘的对象同一份, 白名单已由 init 显式落空数组
    // (设计: config-and-initialization.md), 此处不重述
    return { config: result.config, source: 'wizard' };
  }

  print('配置未写入, 本次未执行清理');
  return null;
}

/** 单条删除结果 (对应 render 条目的 ok / error 字段) */
interface RemovalOutcome {
  ok: boolean;
  error?: string;
}

/** 整批中止时给未被删除条目的统一说明 (与普通删除失败区分: 这些目标根本没被动过) */
const ABORTED_HINT = '整批中止, 未执行删除';

/*
 * 跳过类目标 (疑似安装树 / 跨设备目标) 的文案与集合见 skip.ts (单源); 本层只管接线:
 * 领域条目 → 渲染条目、结果回挂与退出码。
 */

/**
 * 领域条目 → 渲染条目: 行尾说明按 疑似安装树 → 跨设备 → 体积失败 的次序并置 (两空格分隔),
 * 与改造前的 toEntries 逐字同源; 跳过类的「为什么没删」不在这里 (那是执行面的 ok / error)。
 */
function toRenderEntry(entry: SweepEntry): RenderEntry {
  const notes: string[] = [];
  if (entry.kind === 'suspect-install-tree')
    notes.push(`疑似安装树: ${entry.kindReason}`);
  if (entry.crossDevice !== undefined)
    notes.push(crossDeviceNote(entry.crossDevice));
  if (entry.bytes === undefined && entry.unmeasuredReason !== undefined)
    notes.push(`体积统计失败: ${entry.unmeasuredReason}`);
  return {
    target: entry.target,
    bytes: entry.bytes,
    project: basename(entry.project),
    suspect: entry.kind === 'suspect-install-tree',
    ...(notes.length > 0 ? { note: notes.join('  ') } : {}),
  };
}

/**
 * 执行结果 → 渲染的 ok 与行尾原因 (与改造前的 withOutcomes 逐字同源):
 * removed / missing / stale 计成功侧 (missing 是「目标已达成」语义; stale 是被陈旧容忍
 * 摘出的已消失目标); failed 附失败串; skipped 附跳过类的放行说明 (未测到体积者不重复附原因,
 * 原因已在行尾 note 上); not-attempted 附整批中止的统一说明 (这些目标根本没被动过)。
 */
function outcomeResult(entry: SweepOutcomeEntry): RemovalOutcome {
  const { outcome } = entry;
  switch (outcome.kind) {
    case 'removed':
    case 'missing':
    case 'stale':
      return { ok: true };
    case 'failed':
      return { ok: false, error: outcome.failure.message };
    case 'skipped':
      return outcome.reason === 'unmeasured'
        ? { ok: false }
        : { ok: false, error: entry.skipNote };
    case 'not-attempted':
      return { ok: false, error: ABORTED_HINT };
    case 'rejected':
    case 'not-expected':
      // 本层不产生这两种分支 (整批拒绝走专用分支; 不传 expectedBatch), 兜底按未达成呈现
      return { ok: false };
  }
}

/** 执行面条目 = 渲染条目 + ok 与行尾原因 */
const toExecuteEntry = (entry: SweepOutcomeEntry): RenderEntry => ({
  ...toRenderEntry(entry),
  ...outcomeResult(entry),
});

/**
 * 清单末行说明 (trailer) 与跳过集册同源: 由计划的领域条目重建候选集, 经 skip.ts 的
 * collectSkips 单源生成, 与 plan.skipped / entry.skipNote 的计数与文案恒等;
 * hints 本层不用 (行尾说明已随 skipNote 携带)。
 */
function planTrailer(plan: SweepPlan): string[] {
  const candidates: SkipCandidate[] = plan.entries.map((entry) => ({
    target: entry.target,
    bytes: entry.bytes,
    unmeasuredReason: entry.unmeasuredReason,
    suspect: entry.kind === 'suspect-install-tree',
  }));
  const device = new Map<string, CrossDeviceKind>();
  for (const entry of plan.entries) {
    if (entry.crossDevice !== undefined)
      device.set(entry.target, entry.crossDevice);
  }
  return [...collectSkips(candidates, device, plan.policy).trailer];
}

/** 名单命中统计 (字段可选, 胜出门面提供; 排除与包含同形) */
type NameMatches = NonNullable<ScanResult['excludeMatches']>;

/** 内置默认排除名单的名字集合 (零命中静默的判据; 名单本体见 config.ts 的 DEFAULT_EXCLUDE) */
const BUILTIN_EXCLUDE_NAMES = new Set(DEFAULT_EXCLUDE);

/**
 * 名单反馈 (名单写错不得静默, 见 types.ts「excludeMatches」与「includeMatches」):
 * 未命中的名字一律就地告警 (写错必须立刻可见, 走 stderr 且压在顶栏之前, 位置本身即是强调);
 * 命中的回执照旧只报给真终端, 但不就地打印, 而是交回调用方随清单输出为顶栏下方的中性提示行
 * (见 render.ts「notes」: 裸文本压在顶栏上方会打断顶栏与清单的紧邻关系)。
 * 两者的后果方向相反, 文案各说各的: 排除名写错只是少排除 (多排除 = 少删, 错在安全侧),
 * 包含名写错则整个筛选为空, 故白名单全零命中时另补一句后果说明。
 * 命中回执的用词两侧各按事实取: 排除侧说「排除生效」属实 (它确实生效); 包含侧只说「包含命中」,
 * 不说「生效」: 同一名字同时出现在两份名单时 exclude 优先把该子树整棵截走, 计数照旧成立
 * (见 scan-parallel.ts 的计数点注释: 截走不等于没匹配上), 但该名字并未真的纳入任何候选,
 * 此时说「生效」即是不实承诺。
 *
 * 唯一的告警例外是内置默认名单项零命中 (见下方判定): 它们依平台与用户环境而异, 不是可修正的输入。
 */
function collectNameNotes(
  excludeMatches: NameMatches | undefined,
  includeMatches: NameMatches | undefined,
  color: boolean,
): string[] {
  const notes: string[] = [];
  // 与 notes 的去向 (stdout) 同一判据: 提示进清单流, 便按 stdout 是否为终端决定要不要加
  const tty = process.stdout.isTTY === true;

  // 措辞不断言「名字不存在」: 名字位于被 exclude 的祖先目录之下时, 该子树按排除优先整棵跳过、
  // 不参与逐名计数, 此时报的是「未命中已扫描的目录」而非「写错了」(见 behavior-contract.md BC-33 例外)
  for (const item of excludeMatches ?? []) {
    if (item.hits === 0) {
      // 默认名单项 (如 Linux 上没有 Library) 零命中是环境事实而非拼写错误: 逐项告警必然刷屏,
      // 用户也无从「修正」; 用户显式写同名项时同样静默 —— 该项已由默认名单覆盖, 写与不写等效
      if (BUILTIN_EXCLUDE_NAMES.has(item.name)) continue;
      warn(
        `排除名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
        color,
      );
    } else if (tty) notes.push(`排除生效: ${item.name} (${item.hits} 处)`);
  }

  const includes = includeMatches ?? [];
  for (const item of includes) {
    if (item.hits === 0)
      warn(
        `包含名未命中任何已扫描的目录: ${item.name} (按目录名精确匹配; 若其上层目录已被排除则属预期)`,
        color,
      );
    else if (tty) notes.push(`包含命中: ${item.name} (${item.hits} 处)`);
  }
  // 逐名告警已在上方给出, 此处点明整体后果: 白名单一条都没命中, 本次必然什么都扫不出
  if (includes.length > 0 && includes.every((item) => item.hits === 0))
    warn(
      '包含名单无一条命中, 本次扫描必为空结果 (请核对名字与大小写; 若名字位于被排除的目录之下则属预期)',
      color,
    );

  return notes;
}

/**
 * 清理流程 (库编排 + 渲染薄壳): 预览 = plan → 渲染; `--yes` = run → 渲染执行报告。
 * 退出码 (设计: cli-surface.md「退出码」; 即库侧三档配方的严格档): 预览 / 空结果 / 仅 missing 记 0;
 * 安全闸整批拒绝 / 删除复核整批中止 / 删除有失败 / 有跳过项 (疑似安装树 / 跨设备目标)
 * 或未测到体积的目标记 1。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   config = { roots: ['/w'], exclude: [], include: [] }
 *   options = { command: 'sweep', yes: true, force: false, exclude: [], include: [], help: false }
 *   磁盘树 = /w/alpha/node_modules (4.6 GB, 可读), /w/pkg/lib/node_modules (80 KB, 可读),
 *            /w/locked/node_modules (权限不足, 测不到体积)
 *
 * 步骤 1：组装 SweepOptions 构造 sweeper (构造期参数错误同步抛, 由 main 的 catch 落退出码 1)
 *
 * 步骤 2：run 编排 (--yes; 预览面为 plan): 事件流里 warning 逐条打 stderr; 报告:
 *   report.entries = [alpha removed, lib skipped, locked skipped]
 *   report.releasedBytes = 4939212390
 *
 * 步骤 3：领域条目 → 渲染条目 (outcome → ok / 行尾原因), 名单回执与跳过说明随清单输出
 *   entries = [alpha ✓, lib ✗ 已跳过 (加 --force 一并清理),
 *              locked ✗ 体积统计失败: 权限不足, 无法读取]
 *
 * Output（数据契约）
 *   print 执行报告 (render mode: 'execute', trailer 含『疑似安装树 1 处默认跳过』); return 1 (有跳过项)
 * ```
 */
async function sweep(
  config: Config,
  options: CliOptions,
  color: boolean,
): Promise<number> {
  const sweeper = createSweeper({
    roots: config.roots,
    exclude: mergeNames(config.exclude, options.exclude),
    include: mergeNames(config.include, options.include),
    policy: { releaseSuspects: options.force },
  });

  // 运行时自述与名单回执同判据: 都只在真终端展示, 非 TTY (脚本 / 管道) 下不增噪音
  const runtime = process.stdout.isTTY === true ? runtimeLabel : undefined;
  // home 同时服务两处: 清单路径的 ~ 缩写与疑似安装树的隐藏目录判定 (同一份语义; 编排层缺省同源)
  const home = homedir();
  // 告警 (根不存在等环境问题与体积统计告警) 实时透传 stderr; --yes 流程下这是删除前唯一的可见信息
  const onProgress = (event: SweepProgressEvent): void => {
    if (event.kind === 'warning') warn(event.warning.message, color);
  };
  // 未命中的名单名就地告警、命中的回执随清单输出 (写错不得静默, 见 collectNameNotes)
  const nameNotesOf = (plan: SweepPlan): string[] =>
    collectNameNotes(plan.nameMatches.exclude, plan.nameMatches.include, color);

  if (!options.yes) {
    const plan = await sweeper.plan({ onProgress });
    print(
      render({
        mode: 'preview',
        roots: plan.roots,
        entries: plan.entries.map(toRenderEntry),
        color,
        home,
        notes: nameNotesOf(plan),
        runtime,
        trailer: planTrailer(plan),
      }),
    );
    return 0;
  }

  const report = await sweeper.run({ onProgress });

  // 安全闸整批拒绝: 零删除, 逐条报告拒绝理由 (不渲染清单, 与改造前一致)
  if (report.status === 'rejected') {
    const rejected = report.validation?.rejected ?? [];
    warn(
      `整批拒绝: ${rejected.length} 个目标未通过安全闸, 未执行任何删除`,
      color,
    );
    for (const item of rejected) notice(`  ${item.target} (${item.message})`);
    return 1;
  }

  print(
    render({
      mode: 'execute',
      roots: report.plan.roots,
      entries: report.entries.map(toExecuteEntry),
      color,
      home,
      releasedBytes: report.releasedBytes,
      notes: nameNotesOf(report.plan),
      runtime,
      trailer: planTrailer(report.plan),
    }),
  );

  // 复核中止与逐条失败区分展示 (紧贴汇总, 便于诊断): 此时整批目标一个都没动
  if (report.removal?.aborted !== undefined) {
    warn(`整批中止: ${report.removal.aborted.message}`, color);
    notice(`  本轮未执行删除: ${report.plan.batch.length} 处`);
  }

  // 退出码: 库侧三档配方的严格档 (任何未处理项或失败都算失败; 与改造前 ok === false 的口径同值)。
  // 配方里的 status !== 'rejected' 一项由此前的整批拒绝分支提前 return 代偿, 不再重复判定
  const summary = summarizeReport(report);
  return summary.failed === 0 && summary.unprocessed === 0 && !summary.aborted
    ? 0
    : 1;
}

async function main(): Promise<number> {
  const color = colorEnabled();
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    warn(`参数错误: ${parsed.message} (用 --help 查看用法)`, color);
    return 1;
  }

  const { options } = parsed;
  if (options.help) {
    print(helpText(color));
    return 0;
  }

  try {
    // 路径与其来源一并保留: 来源决定「文件不存在」是硬错 (旗标 / 环境变量打错) 还是软态 (平台默认)
    const resolvedPath = resolveConfigPath({ flag: options.config });

    // init 子命令: 只跑向导重写配置, 不进入清理流程; 向导要逐问逐答, 无交互终端即报错退出
    if (options.command === 'init') {
      if (!interactive()) {
        warn('init 需要交互终端 (请在终端直接运行, 不要重定向或经管道)', color);
        return 1;
      }
      const result = await runWizard(resolvedPath.path, color);
      // 成功路径的收尾指引按中性提示行呈现 (取消路径的「配置未变更」保持原样, 不带视觉标记)
      if (result.state === 'written')
        print(neutralLine('运行 sweep-nm 查看预览', color));
      else print('配置未变更');
      return 0;
    }

    // config 子命令: 只报告本次实际生效的配置, 不进入装载与清理流程 (文件不存在也退 0)
    if (options.command === 'config') {
      return await reportConfig(resolvedPath, color);
    }

    const resolved = await resolveConfig(resolvedPath, color);
    if (resolved === null) return 0;

    // 无配置的 cwd 回退态不承载执行语义: 首次用户可能只凭一行提示就删掉整棵目录树的 node_modules
    if (resolved.source === 'fallback') {
      const roots = resolved.config.roots.join(', ');
      if (options.yes) {
        warn('拒绝执行: 当前无配置文件, --yes 不可用', color);
        notice(`  将扫的根: ${roots}`);
        notice('  先 sweep-nm init 生成配置, 或用 --config 指定配置文件');
        return 1;
      }
      notice(
        `未找到配置文件, 本次以当前目录为根: ${roots} (想固定此设置, 运行 sweep-nm init)`,
      );
    }

    // 向导刚写入配置的这一轮强制预览: 用户尚未见过任何清单, 带 --yes 也不得直删
    // (设计: config-and-initialization.md「生成后继续本次预览」)
    const freshConfig = resolved.source === 'wizard';
    if (freshConfig && options.yes) {
      notice('首次配置已生成; 本轮先预览, 复核后可再运行 --yes 执行');
    }

    return await sweep(
      resolved.config,
      freshConfig ? { ...options, yes: false } : options,
      color,
    );
  } catch (error) {
    warn(error instanceof Error ? error.message : String(error), color);
    return 1;
  }
}

process.exitCode = await main();
