/**
 * perf-loop 主命令行薄入口 (仅负责参数解析与子命令分发)。
 */
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
const REPO_ROOT = resolveRepoRoot(SCRIPT_DIR);
const TMP_BASE = join(
  process.env.HOME ?? process.env.USERPROFILE ?? '/tmp',
  'tmp',
  'perf-loop',
);

function getArgValue(
  argv: readonly string[],
  flag: string,
): string | undefined {
  const idx = argv.indexOf(flag);
  if (idx < 0) return undefined;
  return argv[idx + 1];
}

function requireArg(argv: readonly string[], flag: string): string {
  const val = getArgValue(argv, flag);
  if (val === undefined || val.trim() === '') {
    throw new Error(`缺少必填参数: ${flag}`);
  }
  return val.trim();
}

function main(): void {
  const [command, ...rest] = process.argv.slice(2);
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
    const suiteArg = getArgValue(rest, '--suite') ?? 'quick';
    const suite: BenchSuiteKind = suiteArg === 'full' ? 'full' : 'quick';
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
    const cyclesRaw = Number(getArgValue(rest, '--cycles') ?? '3');
    const cycles = Number.isFinite(cyclesRaw) && cyclesRaw >= 1 ? cyclesRaw : 3;
    const out = runEvaluateCommand({
      repoRoot: REPO_ROOT,
      tmpBase: TMP_BASE,
      pkgHint: requireArg(rest, '--pkg'),
      runId: requireArg(rest, '--run'),
      proposal: requireArg(rest, '--proposal'),
      dimension: requireArg(rest, '--dimension') as PerfDimension,
      expectedTier: requireArg(rest, '--expected-tier') as PriorityTier,
      rationale: getArgValue(rest, '--rationale') ?? '',
      caseFilter: getArgValue(rest, '--case'),
      allowCrossPkg: rest.includes('--allow-cross-pkg'),
      cycles,
    });
    process.stdout.write(`${JSON.stringify(out, null, 2)}\n`);
    return;
  }
  if (command === 'recover') {
    const msg = runRecoverCommand(
      REPO_ROOT,
      TMP_BASE,
      requireArg(rest, '--run'),
    );
    process.stdout.write(`${msg}\n`);
    return;
  }

  process.stderr.write(
    '用法: bun .agents/skills/perf-loop/scripts/loop.ts <status|next|init-bench|prepare|evaluate|recover> [参数]\n',
  );
  process.exitCode = 2;
}

if (import.meta.main) {
  try {
    main();
  } catch (error) {
    process.stderr.write(
      `perf-loop 失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
