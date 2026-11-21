/**
 * 转写契约套件 · 确定性验收器 (conformance runner) 入口。
 *
 * 支持两种运行模式:
 * 1. 显式目标模式: `--target "<cmd>" [--api-target "<cmd>"] [--corpus <dir>]` (兼容外部任意语言实现);
 * 2. 多产品自动模式: `--all-products [--runtime bun|node]` (自动遍历仓内全部带 `docs/protocol/` 的双包产品)。
 * 另支持 `--exclude-tag <tag>` (可重复, 供 Linux CI 跳过 `apfs-block-size` 块大小耦合用例)、
 * `--filter <text>`、`--emit-failures <dir>`、`--timeout <ms>`、`--json`、`--keep`。
 *
 * 退出码: 0 全部通过; 1 存在失败用例; 2 用法 / 语料 / 环境错误。
 */
import { existsSync } from 'node:fs';
import { realpath } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import { resolveCommandArgv } from './command-argv.ts';
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
import { discoverProtocolProducts } from './protocol-discovery.ts';
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
const DEFAULT_CORPUS_DIR = join(REPO_ROOT, CORPUS_REL);
const DEFAULT_CONTRACT_PATH = join(REPO_ROOT, CONTRACT_REL);
const DEFAULT_TIMEOUT_MS = 15000;
const API_HARNESS_PATH = join(HERE, 'api-harness.ts');
const DEFAULT_API_TARGET_ARGV: readonly string[] = ['bun', API_HARNESS_PATH];

interface CliOptions {
  target?: string;
  apiTarget?: string;
  corpusDir: string;
  allProducts: boolean;
  runtime: 'bun' | 'node';
  filter?: string;
  excludeTags: string[];
  emitFailuresDir?: string;
  timeoutMs: number;
  json: boolean;
  keep: boolean;
  help: boolean;
}

type ParseOutcome =
  { ok: true; options: CliOptions } | { ok: false; message: string };

const KNOWN_FLAGS = new Set([
  '--target',
  '--api-target',
  '--corpus',
  '--all-products',
  '--runtime',
  '--filter',
  '--exclude-tag',
  '--emit-failures',
  '--timeout',
  '--json',
  '--keep',
  '--help',
  '-h',
]);

const HELP_TEXT = [
  '用法: bun scripts/transcription/run-conformance.ts --target "<被测命令>" [选项]',
  '  或: bun scripts/transcription/run-conformance.ts --all-products [--runtime bun|node] [选项]',
  '',
  '  --target <cmd>        被测进程命令 (如 "bun packages/sweep-cli/src/cli.ts"); 支持单/双引号路径',
  '  --api-target <cmd>    API 用例的被测 harness 命令 (缺省: bun scripts/transcription/api-harness.ts)',
  `  --corpus <dir>        语料目录 (默认: ${CORPUS_REL})`,
  '  --all-products        自动遍历仓内全部带 docs/protocol/ 的双包产品并逐一验收',
  '  --runtime <bun|node>  配合 --all-products 指定运行载体 (默认: bun)',
  '  --filter <text>       只跑 id 含该子串的用例 (报告会标示非全量运行)',
  '  --exclude-tag <tag>   跳过带指定标签的用例 (可重复, 如 --exclude-tag apfs-block-size)',
  '  --emit-failures <dir> 存在失败用例时按用例导出自包含 Markdown 诊断单',
  '  --timeout <ms>        单条用例执行超时毫秒 (默认 15000)',
  '  --json                输出结构化 JSON 报告',
  '  --keep                保留 fixture 目录并打印路径',
  '  --help                显示本帮助',
  '',
  '退出码: 0 全部通过; 1 存在失败用例; 2 用法 / 语料 / 环境错误',
].join('\n');

function parseArgs(argv: string[]): ParseOutcome {
  let target: string | undefined;
  let apiTarget: string | undefined;
  let corpusDir = DEFAULT_CORPUS_DIR;
  let allProducts = false;
  let runtime: 'bun' | 'node' = 'bun';
  let filter: string | undefined;
  const excludeTags: string[] = [];
  let emitFailuresDir: string | undefined;
  let timeoutMs = DEFAULT_TIMEOUT_MS;
  let json = false;
  let keep = false;
  let help = false;

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
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
    if (arg === '--all-products') {
      allProducts = true;
      continue;
    }
    if (
      arg === '--target' ||
      arg === '--api-target' ||
      arg === '--corpus' ||
      arg === '--runtime' ||
      arg === '--filter' ||
      arg === '--exclude-tag' ||
      arg === '--emit-failures' ||
      arg === '--timeout'
    ) {
      const value = argv[index + 1];
      const allowLeadingDash = arg === '--filter';
      if (
        value === undefined ||
        (allowLeadingDash ? KNOWN_FLAGS.has(value) : value.startsWith('-'))
      ) {
        return { ok: false, message: `参数 ${arg} 缺少取值` };
      }
      if (arg === '--target') target = value;
      else if (arg === '--api-target') apiTarget = value;
      else if (arg === '--corpus') corpusDir = value;
      else if (arg === '--filter') filter = value;
      else if (arg === '--exclude-tag') excludeTags.push(value);
      else if (arg === '--emit-failures') emitFailuresDir = value;
      else if (arg === '--runtime') {
        if (value !== 'bun' && value !== 'node') {
          return {
            ok: false,
            message: `--runtime 仅支持 bun|node, 收到: ${value}`,
          };
        }
        runtime = value;
      } else if (arg === '--timeout') {
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
        target,
        apiTarget,
        corpusDir,
        allProducts,
        runtime,
        filter,
        excludeTags,
        emitFailuresDir,
        timeoutMs,
        json,
        keep,
        help: true,
      },
    };
  }
  if (!allProducts && (target === undefined || target.trim() === '')) {
    return { ok: false, message: '缺少 --target (或传 --all-products)' };
  }
  return {
    ok: true,
    options: {
      target,
      apiTarget,
      corpusDir,
      allProducts,
      runtime,
      filter,
      excludeTags,
      emitFailuresDir,
      timeoutMs,
      json,
      keep,
      help: false,
    },
  };
}

function resolveContractPath(corpusDir: string): string | undefined {
  const sibling = resolve(corpusDir, '..', '..', 'behavior-contract.md');
  if (existsSync(sibling)) return sibling;
  if (existsSync(DEFAULT_CONTRACT_PATH)) return DEFAULT_CONTRACT_PATH;
  return undefined;
}

async function runCase(
  caseSpec: CorpusCase,
  ctx: RunContext,
): Promise<CaseReport> {
  const startedAt = Date.now();
  const rawRoot = makeTmpRoot('conformance-');
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

interface SuiteTarget {
  label: string;
  corpusDir: string;
  targetArgv: string[];
  apiTargetArgv: string[];
  emitDir?: string;
}

async function runSingleSuite(
  suite: SuiteTarget,
  options: CliOptions,
): Promise<number> {
  const resolvedCorpusDir = resolve(suite.corpusDir);
  let cases: CorpusCase[];
  try {
    cases = await loadCorpus(resolvedCorpusDir);
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }

  const excluded = new Set(options.excludeTags);
  let selected = cases;
  if (excluded.size > 0) {
    selected = selected.filter(
      (item) => !(item.tags ?? []).some((tag) => excluded.has(tag)),
    );
  }
  if (options.filter !== undefined) {
    selected = selected.filter((item) => item.id.includes(options.filter!));
  }
  if (selected.length === 0) {
    process.stderr.write(
      `筛选条件未匹配到任何用例 (合计 ${cases.length} 条)\n`,
    );
    return 2;
  }

  const ctx: RunContext = {
    targetArgv: suite.targetArgv,
    apiTargetArgv: suite.apiTargetArgv,
    timeoutMs: options.timeoutMs,
    keep: options.keep,
  };

  const reports: CaseReport[] = [];
  for (const caseSpec of selected) {
    reports.push(await runCase(caseSpec, ctx));
  }

  const failedCount = reports.filter((r) => r.status === 'fail').length;
  const skipped = cases.length - selected.length;
  let emittedFailuresDir: string | undefined;
  if (suite.emitDir !== undefined && failedCount > 0) {
    const outDir = resolve(suite.emitDir);
    const casesById = new Map<string, unknown>(
      selected.map((item) => [item.id, item]),
    );
    emitFailureDiagnostics(outDir, reports, casesById, {
      target: suite.label,
      corpusDir: suite.corpusDir,
      contractPath: resolveContractPath(resolvedCorpusDir),
    });
    emittedFailuresDir = outDir;
  }

  const filterTagNote =
    options.excludeTags.length > 0
      ? `exclude-tag:${options.excludeTags.join(',')}`
      : undefined;
  const filterNote =
    options.filter !== undefined && filterTagNote !== undefined
      ? `${options.filter} (${filterTagNote})`
      : (options.filter ?? filterTagNote);

  const meta: RunSummaryMeta = {
    totalCorpus: cases.length,
    selected: selected.length,
    skipped,
    ...(filterNote !== undefined ? { filter: filterNote } : {}),
    fullRunVerified:
      skipped === 0 && filterNote === undefined && failedCount === 0,
    ...(emittedFailuresDir !== undefined ? { emittedFailuresDir } : {}),
  };

  if (options.json) {
    printJsonReport(suite.corpusDir, suite.label, reports, meta);
  } else {
    printHumanReport(suite.corpusDir, suite.label, reports, meta);
  }
  return failedCount > 0 ? 1 : 0;
}

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

  const suites: SuiteTarget[] = [];
  if (options.allProducts) {
    const products = discoverProtocolProducts(REPO_ROOT);
    if (products.length === 0) {
      process.stderr.write('未发现任何带 docs/protocol/ 的双包产品\n');
      return 2;
    }
    for (const product of products) {
      const cliSrc = join(REPO_ROOT, product.cli.dir, 'src', 'cli.ts');
      suites.push({
        label: `${options.runtime} ${product.cli.dir}/src/cli.ts`,
        corpusDir: product.corpusRel,
        targetArgv: [options.runtime, cliSrc],
        apiTargetArgv: [
          options.runtime,
          API_HARNESS_PATH,
          '--product',
          product.api.dir,
        ],
        emitDir:
          options.emitFailuresDir !== undefined
            ? join(options.emitFailuresDir, product.id)
            : undefined,
      });
    }
  } else {
    let targetArgv: string[];
    let apiTargetArgv: string[];
    try {
      targetArgv = resolveCommandArgv(options.target!, process.cwd());
      apiTargetArgv =
        options.apiTarget === undefined
          ? [...DEFAULT_API_TARGET_ARGV]
          : resolveCommandArgv(options.apiTarget, process.cwd());
    } catch (error) {
      process.stderr.write(`参数错误: ${(error as Error).message}\n`);
      return 2;
    }
    suites.push({
      label: options.target!,
      corpusDir: options.corpusDir,
      targetArgv,
      apiTargetArgv,
      emitDir: options.emitFailuresDir,
    });
  }

  let worstCode = 0;
  for (const suite of suites) {
    const code = await runSingleSuite(suite, options);
    if (code === 2) return 2;
    if (code !== 0) worstCode = code;
  }
  return worstCode;
}

try {
  process.exitCode = await main();
} catch (error) {
  process.stderr.write(
    `验收器未预期错误: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
  );
  process.exitCode = 2;
}
