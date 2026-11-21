/**
 * 转写契约套件 · 确定性验收器 (conformance runner) 入口。
 *
 * 职责: 解析 CLI → 加载语料 → 逐条建 fixture 树、以最小白名单 env 执行被测命令、逐项比对、
 * 清理现场 → 汇总报告 (含全量核验水印与可选 `--emit-failures` 自包含诊断单), 任一条失败即非零退出。
 * 纯程序、零 AI、零第三方依赖 (bun / node 直跑)。
 *
 * 模块划分 (同目录, 本文件只留 CLI 解析 / 编排 / 帮助):
 * - corpus.ts   语料类型、$FIXTURE 变量替换契约、目录加载;
 * - validate.ts 语料手写校验 (schema 的物化子集, 见文件头);
 * - fixture.ts  fixture 建树 / setup 预置 / 最小 env / 执行 / 清理 (cli 与 api 两类 case);
 * - compare.ts  逐项比对 (cli: 退出码 / stdout 与 stderr 的子串含与禁含 / fs 终态; api: 返回值 / 抛错 / 事件);
 * - report.ts   报告数据结构、全量核验水印、人读 / JSON 渲染与 `--emit-failures` 诊断单导出;
 * - api-harness.ts 参考 API harness (独立入口; 协议见 packages/sweep/docs/protocol/conformance/api-harness-protocol.md)。
 *
 * 语料权威: packages/sweep/docs/protocol/conformance/corpus.schema.json (字段语义以 schema 为准; 手写校验是
 * schema 的物化子集, 只为尽早给出可读报错, 不复刻 schema 的全部约束)。
 *
 * 用法: bun scripts/transcription/run-conformance.ts --target "bun packages/sweep-cli/src/cli.ts" [--api-target "bun scripts/transcription/api-harness.ts"] [--corpus <dir>] [--filter <id 子串>]
 *       [--emit-failures <dir>] [--timeout <ms>] [--json] [--keep] [--help]
 *
 * 退出码: 0 全部通过; 1 存在失败用例; 2 用法 / 语料 / 环境错误 (runner 自身问题, 非被测缺陷)。
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import { compareApiCase, compareCase } from './compare.ts';
import {
  CONTRACT_REL,
  CORPUS_REL,
  type CorpusCase,
  loadCorpus,
} from './corpus.ts';
import {
  type ExecOutcome,
  type RunContext,
  applySetup,
  buildFixture,
  cleanupFixture,
  executeApiCase,
  executeCase,
} from './fixture.ts';
import {
  type CaseReport,
  type FailureItem,
  type RunSummaryMeta,
  emitFailureDiagnostics,
  printHumanReport,
  printJsonReport,
} from './report.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
/**
 * 默认语料目录: 从 corpus.ts 的唯一协议根常量 (PROTOCOL_ROOT) 派生, 避免路径硬编码散落。
 */
const DEFAULT_CORPUS_DIR = join(REPO_ROOT, CORPUS_REL);
const DEFAULT_CONTRACT_PATH = join(REPO_ROOT, CONTRACT_REL);
const DEFAULT_TIMEOUT_MS = 15000;
/** 默认 API harness 命令数组: 直接以 argv 形态构造, 不对含绝对路径的命令做空白 split */
const DEFAULT_API_TARGET_ARGV: readonly string[] = [
  'bun',
  join(HERE, 'api-harness.ts'),
];

interface CliOptions {
  target: string;
  /** 显式传入的 --api-target 字符串; 缺省时直接使用 DEFAULT_API_TARGET_ARGV 数组 */
  apiTarget?: string;
  corpusDir: string;
  filter?: string;
  emitFailuresDir?: string;
  timeoutMs: number;
  json: boolean;
  keep: boolean;
  help: boolean;
}

type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

// ---------------------------------------------------------------------------
// 命令行解析
// ---------------------------------------------------------------------------

const HELP_TEXT = [
  '用法: bun scripts/transcription/run-conformance.ts --target "<被测命令>" [选项]',
  '',
  '  --target <cmd>        被测进程命令 (如 "bun packages/sweep-cli/src/cli.ts", 或 PATH 中的 "sweep" / 绝对路径形态); 按空白拆分, 支持用单 / 双引号包裹含空格的路径',
  '  --api-target <cmd>    API 用例的被测 harness 命令 (缺省: 随套件参考 harness, 即 "bun <仓库根>/scripts/transcription/api-harness.ts"); 拆分与绝对化规则同 --target',
  `  --corpus <dir>        语料目录 (默认: ${CORPUS_REL})`,
  '  --filter <text>       只跑 id 含该子串的用例 (报告会显式标示非全量运行, 不可作全绿交付依据)',
  '  --emit-failures <dir> 存在失败用例时, 按用例导出自包含 Markdown 诊断单 (含条款原文、差异、原始输出与语料 JSON)',
  '  --timeout <ms>        单条用例执行超时 (默认 15000), 到期即判失败 (超时守卫)',
  '  --json                输出结构化 JSON 报告 (stdout 仅 JSON, 诊断走 stderr)',
  '  --keep                保留 fixture 目录并打印路径 (调试用; 默认跑完即清理)',
  '  --help                显示本帮助',
  '',
  '退出码: 0 全部通过; 1 存在失败用例; 2 用法 / 语料 / 环境错误',
].join('\n');

/**
 * 解析参数: 仅支持 `--flag value` 与布尔旗标; 未知参数、缺值一律判错 (调用方落退出码 2)。
 *
 * ### 数据流转示例
 * ```text
 * Input (真实 Payload):
 *   argv = ['--target', 'bun packages/sweep-cli/src/cli.ts', '--filter', 'scan-', '--emit-failures', '~/tmp/fail']
 *
 * 步骤 1: 逐项识别旗标与取值 (--target / --api-target / --corpus / --filter / --emit-failures / --timeout / --json / --keep / --help)
 * 步骤 2: 校验非 --help 时必含非空 --target, --timeout 为正整数
 *
 * Output (数据契约):
 *   return { ok: true, options: { target, apiTarget?, corpusDir, filter, emitFailuresDir?, timeoutMs, json, keep, help } }
 * ```
 */
function parseArgs(argv: string[]): ParseOutcome {
  let target: string | undefined;
  let apiTarget: string | undefined;
  let corpusDir = DEFAULT_CORPUS_DIR;
  let filter: string | undefined;
  let emitFailuresDir: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  let keep = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--help' || arg === '-h') {
      help = true;
      continue;
    }
    if (arg === '--json') {
      json = true;
      continue;
    }
    if (arg === '--keep') {
      keep = true;
      continue;
    }
    if (
      arg === '--target' ||
      arg === '--api-target' ||
      arg === '--corpus' ||
      arg === '--filter' ||
      arg === '--emit-failures' ||
      arg === '--timeout'
    ) {
      const value = argv[index + 1];
      if (value === undefined || value.startsWith('-')) {
        return { ok: false, message: `参数 ${arg} 缺少取值` };
      }
      if (arg === '--target') target = value;
      if (arg === '--api-target') apiTarget = value;
      if (arg === '--corpus') corpusDir = value;
      if (arg === '--filter') filter = value;
      if (arg === '--emit-failures') emitFailuresDir = value;
      if (arg === '--timeout') {
        const parsed = Number(value);
        if (!Number.isInteger(parsed) || parsed <= 0) {
          return {
            ok: false,
            message: `--timeout 须为正整数毫秒, 收到: ${value}`,
          };
        }
        timeoutMs = parsed;
      }
      index += 1;
      continue;
    }
    return { ok: false, message: `未知参数: ${arg}` };
  }

  if (help) {
    return {
      ok: true,
      options: {
        target: target ?? '',
        apiTarget,
        corpusDir,
        filter,
        emitFailuresDir,
        timeoutMs,
        json,
        keep,
        help: true,
      },
    };
  }
  if (target === undefined || target.trim() === '') {
    return { ok: false, message: '缺少 --target (被测命令)' };
  }

  return {
    ok: true,
    options: {
      target,
      apiTarget,
      corpusDir,
      filter,
      emitFailuresDir,
      timeoutMs,
      json,
      keep,
      help: false,
    },
  };
}

/**
 * 将命令行字符串切分为 argv 数组: 支持单 / 双引号包裹含空格的路径,
 * 避免直接 `.split(/\s+/)` 撕裂含空格的绝对路径。
 */
function splitCommand(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (current !== '') parts.push(current);
  return parts;
}

/**
 * 把 target 命令里按启动目录写的相对路径绝对化。
 * 必要原因: 被测进程的 cwd 会被设为 fixture 目录 (用例可声明), 而 `--target "bun packages/sweep-cli/src/cli.ts"`
 * 里 `packages/sweep-cli/src/cli.ts` 是相对 runner 启动目录书写的; 不绝对化就会在 fixture cwd 下解析而找不到文件。
 * 规则保守: 只动 index >= 1 (argv[0] 是命令名, 留给 PATH 解析)、非旗标、且相对启动目录真实存在
 * 的路径串, 其余原样透传。
 */
function absolutizeTargetArgv(
  targetArgv: readonly string[],
  launchDir: string,
): string[] {
  return targetArgv.map((part, index) => {
    if (index === 0 || isAbsolute(part) || part.startsWith('-')) return part;
    const candidate = resolve(launchDir, part);
    return existsSync(candidate) ? candidate : part;
  });
}

/** 根据语料目录推断配套的 behavior-contract.md (优先同协议目录, 兜底仓根默认契约) */
function resolveContractPath(corpusDir: string): string | undefined {
  const sibling = resolve(corpusDir, '..', '..', 'behavior-contract.md');
  if (existsSync(sibling)) return sibling;
  if (existsSync(DEFAULT_CONTRACT_PATH)) return DEFAULT_CONTRACT_PATH;
  return undefined;
}

// ---------------------------------------------------------------------------
// 单条用例编排
// ---------------------------------------------------------------------------

/**
 * 跑一条用例: 建树 -> setup -> 按 cli/api 双面分流执行并比对 -> 清理 (keep 时保留现场)。
 * 外部副作用: fixture 目录的创建与删除 (keep 时仅创建)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  caseSpec (CliCorpusCase | ApiCorpusCase), ctx (targetArgv / apiTargetArgv / timeoutMs / keep)
 * 步骤 1: makeTmpRoot('conformance-') -> realpath 归一为 $FIXTURE 真路径 root
 * 步骤 2: buildFixture(root) + applySetup(root) 物化目录树与预置文件
 * 步骤 3: 双面分流执行与断言:
 *         - kind === 'api': executeApiCase (stdin 喂替换 $FIXTURE 后的 steps JSON) -> compareApiCase
 *         - 默认 cli:       executeCase (被测 CLI 子进程 + 白名单 env) -> compareCase
 * 步骤 4: finally 清理 fixture (或 --keep 打印保留路径)
 * Output: CaseReport ({ id, specRefs, status, durationMs, failures, diagnostics? })
 * ```
 */
async function runCase(
  caseSpec: CorpusCase,
  ctx: RunContext,
): Promise<CaseReport> {
  const startedAt = Date.now();
  const rawRoot = makeTmpRoot('conformance-');
  // realpath 归一: macOS 上 /var 与 /private/var 是同一位置的两种拼写, 统一用 realpath 形态
  // 作 $FIXTURE 的替换值, 使期望文本与 process.cwd() / realpath 化输出一致。
  const root = await realpath(rawRoot);
  let failures: FailureItem[] = [];
  let exec: ExecOutcome | undefined;

  try {
    await buildFixture(root, caseSpec.fixture);
    await applySetup(root, caseSpec.setup ?? []);
    if (caseSpec.kind === 'api') {
      exec = executeApiCase(caseSpec, root, ctx);
      failures = await compareApiCase(caseSpec.expect, exec, root);
    } else {
      exec = executeCase(caseSpec, root, ctx);
      failures = await compareCase(caseSpec.expect, exec, root);
    }
  } finally {
    if (ctx.keep) {
      process.stderr.write(`[keep] fixture 保留于: ${root}\n`);
    } else {
      await cleanupFixture(rawRoot, caseSpec.fixture);
    }
  }

  return {
    id: caseSpec.id,
    specRefs: caseSpec.specRefs,
    status: failures.length === 0 ? 'pass' : 'fail',
    durationMs: Date.now() - startedAt,
    failures,
    ...(failures.length > 0 && exec !== undefined
      ? { diagnostics: { stdout: exec.stdout, stderr: exec.stderr } }
      : {}),
  };
}

// ---------------------------------------------------------------------------
// 主流程
// ---------------------------------------------------------------------------

async function main(): Promise<number> {
  const parsed = parseArgs(process.argv.slice(2));
  if (!parsed.ok) {
    process.stderr.write(`参数错误: ${parsed.message}\n\n${HELP_TEXT}\n`);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  const targetArgv = absolutizeTargetArgv(
    splitCommand(options.target),
    process.cwd(),
  );
  const apiTargetArgv =
    options.apiTarget === undefined
      ? [...DEFAULT_API_TARGET_ARGV]
      : absolutizeTargetArgv(splitCommand(options.apiTarget), process.cwd());
  let cases: CorpusCase[];
  const resolvedCorpusDir = resolve(options.corpusDir);
  try {
    cases = await loadCorpus(resolvedCorpusDir);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const selected =
    options.filter === undefined
      ? cases
      : cases.filter((item) => item.id.includes(options.filter!));
  if (selected.length === 0) {
    process.stderr.write(
      `--filter "${options.filter}" 未匹配到任何用例 (合计 ${cases.length} 条)\n`,
    );
    return 2;
  }

  const ctx: RunContext = {
    targetArgv,
    apiTargetArgv,
    timeoutMs: options.timeoutMs,
    keep: options.keep,
  };

  const reports: CaseReport[] = [];
  for (const caseSpec of selected) {
    reports.push(await runCase(caseSpec, ctx));
  }

  const failedCount = reports.filter(
    (report) => report.status === 'fail',
  ).length;
  const skipped = cases.length - selected.length;
  let emittedFailuresDir: string | undefined;
  if (options.emitFailuresDir !== undefined && failedCount > 0) {
    const outDir = resolve(options.emitFailuresDir);
    const casesById = new Map<string, unknown>(
      selected.map((item) => [item.id, item]),
    );
    emitFailureDiagnostics(outDir, reports, casesById, {
      target: options.target,
      corpusDir: options.corpusDir,
      contractPath: resolveContractPath(resolvedCorpusDir),
    });
    emittedFailuresDir = outDir;
  }

  const meta: RunSummaryMeta = {
    totalCorpus: cases.length,
    selected: selected.length,
    skipped,
    ...(options.filter !== undefined ? { filter: options.filter } : {}),
    fullRunVerified:
      skipped === 0 && options.filter === undefined && failedCount === 0,
    ...(emittedFailuresDir !== undefined ? { emittedFailuresDir } : {}),
  };

  if (options.json) {
    printJsonReport(options.corpusDir, options.target, reports, meta);
  } else {
    printHumanReport(options.corpusDir, options.target, reports, meta);
  }

  return failedCount > 0 ? 1 : 0;
}

try {
  process.exitCode = await main();
} catch (error) {
  // 未预期异常兜底归入「环境错误」退出码 (头注释的 2), 冒泡成默认的退 1 + 栈会把
  // runner 自身故障伪装成「存在失败用例」, 误导对被测实现的判定。
  process.stderr.write(
    `验收器未预期错误: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 2;
}
