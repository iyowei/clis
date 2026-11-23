/**
 * perf-loop 主命令行薄入口 (仅负责严格参数解析、未知旗标白名单守卫与子命令分发)。
 */
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runEvaluateCommand, runRecoverCommand } from './evaluator.ts';
import { initBenchForPackage } from './init-bench.ts';
import {
  runNextCommand,
  runPrepareCommand,
  runStatusCommand,
} from './planner.ts';
import type { BenchSuiteKind, PerfDimension, PriorityTier } from './types.ts';
import { discoverTargetPackages, resolveRepoRoot } from './workspace-ops.ts';

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT =
  process.env.PERF_LOOP_REPO_ROOT ?? resolveRepoRoot(SCRIPT_DIR);
const TMP_BASE =
  process.env.PERF_LOOP_TMP_BASE ?? join(homedir(), 'tmp', 'perf-loop');

const VALID_SUITES: ReadonlySet<BenchSuiteKind> = new Set(['quick', 'full']);
const VALID_DIMENSIONS: ReadonlySet<PerfDimension> = new Set([
  'arch',
  'impl',
  'gc',
  'interp',
  'io',
]);
const VALID_TIERS: ReadonlySet<PriorityTier> = new Set(['P0', 'P1', 'P2']);

interface SubcommandFlagSpec {
  valueFlags: ReadonlySet<string>;
  booleanFlags: ReadonlySet<string>;
}

const SUBCOMMAND_SPECS: Readonly<Record<string, SubcommandFlagSpec>> = {
  status: {
    valueFlags: new Set(['--pkg']),
    booleanFlags: new Set(),
  },
  next: {
    valueFlags: new Set(),
    booleanFlags: new Set(),
  },
  'init-bench': {
    valueFlags: new Set(['--pkg']),
    booleanFlags: new Set(),
  },
  prepare: {
    valueFlags: new Set(['--pkg', '--suite', '--case']),
    booleanFlags: new Set(),
  },
  evaluate: {
    valueFlags: new Set([
      '--pkg',
      '--run',
      '--proposal',
      '--dimension',
      '--expected-tier',
      '--rationale',
      '--case',
      '--cycles',
    ]),
    booleanFlags: new Set(['--allow-cross-pkg']),
  },
  recover: {
    valueFlags: new Set(['--run']),
    booleanFlags: new Set(),
  },
};

class CliUsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'CliUsageError';
  }
}

/** 严格扫描整个参数序列: 拦截任何未知旗标、重复带值旗标、缺失取值或多余位置参数 */
function validateSubcommandArgs(
  command: string,
  argv: readonly string[],
): void {
  const spec = SUBCOMMAND_SPECS[command];
  if (spec === undefined) {
    throw new CliUsageError(
      '用法: bun .agents/skills/perf-loop/scripts/loop.ts <status|next|init-bench|prepare|evaluate|recover> [参数]',
    );
  }
  const seenValueFlags = new Set<string>();
  for (let i = 0; i < argv.length;) {
    const token = argv[i]!;
    if (spec.booleanFlags.has(token)) {
      i += 1;
      continue;
    }
    if (spec.valueFlags.has(token)) {
      if (seenValueFlags.has(token)) {
        throw new CliUsageError(`参数 ${token} 不允许重复传入`);
      }
      const val = argv[i + 1];
      if (val === undefined || val.startsWith('--') || val.trim() === '') {
        throw new CliUsageError(
          `参数 ${token} 缺少有效取值 (禁止缺失或吞并后续 -- 旗标)`,
        );
      }
      seenValueFlags.add(token);
      i += 2;
      continue;
    }
    if (token.startsWith('-')) {
      const allowed = [...spec.valueFlags, ...spec.booleanFlags];
      const hint = allowed.length > 0 ? allowed.join(', ') : '(无可选旗标)';
      throw new CliUsageError(
        `子命令 ${command} 不支持未知旗标 "${token}", 允许旗标: ${hint}`,
      );
    }
    throw new CliUsageError(`子命令 ${command} 不接受多余位置参数 "${token}"`);
  }
}

/** 读取旗标参数值: 若旗标出现但缺失值或紧跟下一个 --flag, 显式抛参错防止吞并旗标 */
function getArgValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  const val = argv[idx + 1];
  if (val === undefined || val.startsWith('--') || val.trim() === '') {
    throw new CliUsageError(
      `参数 ${flag} 缺少有效取值 (禁止缺失或吞并后续 -- 旗标)`,
    );
  }
  return val;
}

function requireArg(argv: readonly string[], flag: string): string {
  const val = getArgValue(argv, flag);
  if (val === undefined) {
    throw new CliUsageError(`缺少必填参数: ${flag}`);
  }
  return val.trim();
}

function parseEnumArg<T extends string>(
  raw: string,
  allowed: ReadonlySet<T>,
  flag: string,
): T {
  const trimmed = raw.trim();
  if (!allowed.has(trimmed as T)) {
    throw new CliUsageError(
      `参数 ${flag} 取值非法: "${raw}", 仅允许: ${[...allowed].join(' | ')}`,
    );
  }
  return trimmed as T;
}

function parsePositiveIntArg(
  argv: readonly string[],
  flag: string,
  fallback: number,
): number {
  const raw = getArgValue(argv, flag);
  if (raw === undefined) return fallback;
  if (!/^[1-9]\d*$/.test(raw.trim())) {
    throw new CliUsageError(`参数 ${flag} 必须为正整数, 收到: "${raw}"`);
  }
  return Number.parseInt(raw.trim(), 10);
}

function main(): void {
  const [command = '', ...rest] = process.argv.slice(2);
  validateSubcommandArgs(command, rest);

  if (command === 'status') {
    const out = runStatusCommand(REPO_ROOT, getArgValue(rest, '--pkg'));
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (command === 'next') {
    const out = runNextCommand(REPO_ROOT);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (command === 'init-bench') {
    const [pkg] = discoverTargetPackages(REPO_ROOT, requireArg(rest, '--pkg'));
    if (pkg === undefined) throw new Error('未匹配到包');
    const out = initBenchForPackage(REPO_ROOT, pkg.dir, pkg.name);
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (command === 'prepare') {
    const suiteRaw = getArgValue(rest, '--suite');
    const suite: BenchSuiteKind =
      suiteRaw === undefined
        ? 'quick'
        : parseEnumArg(suiteRaw, VALID_SUITES, '--suite');
    const out = runPrepareCommand({
      repoRoot: REPO_ROOT,
      tmpBase: TMP_BASE,
      pkgHint: requireArg(rest, '--pkg'),
      suite,
      caseFilter: getArgValue(rest, '--case'),
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (command === 'evaluate') {
    const cycles = parsePositiveIntArg(rest, '--cycles', 3);
    const dimension = parseEnumArg(
      requireArg(rest, '--dimension'),
      VALID_DIMENSIONS,
      '--dimension',
    );
    const expectedTier = parseEnumArg(
      requireArg(rest, '--expected-tier'),
      VALID_TIERS,
      '--expected-tier',
    );
    const out = runEvaluateCommand({
      repoRoot: REPO_ROOT,
      tmpBase: TMP_BASE,
      pkgHint: requireArg(rest, '--pkg'),
      runId: requireArg(rest, '--run'),
      proposal: requireArg(rest, '--proposal'),
      dimension,
      expectedTier,
      rationale: getArgValue(rest, '--rationale') ?? '',
      caseFilter: getArgValue(rest, '--case'),
      allowCrossPkg: rest.includes('--allow-cross-pkg'),
      cycles,
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  const runId = requireArg(rest, '--run');
  const message = runRecoverCommand(REPO_ROOT, TMP_BASE, runId);
  const out = {
    ok: true as const,
    action: 'recover' as const,
    runId,
    message,
  };
  process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    if (error instanceof CliUsageError) {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 2;
    } else {
      process.stderr.write(
        `perf-loop 失败: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      process.exitCode = 1;
    }
  }
}
