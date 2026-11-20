/**
 * 标准化基准执行协议、Profile 采集与 A/B 交替原位测量调度器。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  parseNodeCpuProfileDir,
  parseProfileMarkdowns,
} from './profile-parse.ts';
import {
  BENCH_JSON_SCHEMA_VERSION,
  type BenchJsonReport,
  type BenchSuiteKind,
  type ProfileDigest,
  type RuntimeKind,
} from './types.ts';
import { restorePackageSnapshot } from './workspace-ops.ts';

/** 校验并解析包 bench --json 的标准输出 (取末行有效 JSON) */
export function parseBenchJsonOutput(
  stdout: string,
  expectedRuntime: RuntimeKind,
): BenchJsonReport {
  const lines = stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
  for (let i = lines.length - 1; i >= 0; i -= 1) {
    const line = lines[i]!;
    if (!line.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(line) as Partial<BenchJsonReport>;
      if (
        parsed.schemaVersion === BENCH_JSON_SCHEMA_VERSION &&
        Array.isArray(parsed.cases)
      ) {
        return {
          schemaVersion: parsed.schemaVersion,
          package: parsed.package ?? 'unknown',
          runtime: parsed.runtime ?? expectedRuntime,
          runtimeVersion: parsed.runtimeVersion ?? 'unknown',
          suite: parsed.suite ?? 'quick',
          cases: parsed.cases,
        };
      }
    } catch {
      // 继续向上扫描非 JSON 日志行
    }
  }
  throw new Error(
    `bench 输出中未找到合法的 schemaVersion=${BENCH_JSON_SCHEMA_VERSION} JSON 载荷`,
  );
}

/** 在指定运行时上运行一次目标包基准 */
export function runBenchOnce(options: {
  repoRoot: string;
  pkgDir: string;
  runtime: RuntimeKind;
  suite: BenchSuiteKind;
  caseFilter?: string;
  timeoutMs?: number;
}): BenchJsonReport {
  const entry = join(options.repoRoot, options.pkgDir, 'bench', 'run.ts');
  if (!existsSync(entry)) {
    throw new Error(`找不到基准入口: ${entry}`);
  }
  const args = [entry, '--json'];
  if (options.suite === 'quick') args.push('--quick');
  if (options.caseFilter !== undefined) args.push('--case', options.caseFilter);

  const res = spawnSync(options.runtime, args, {
    cwd: join(options.repoRoot, options.pkgDir),
    encoding: 'utf8',
    timeout: options.timeoutMs ?? 60000,
  });
  if (res.status !== 0) {
    throw new Error(
      `${options.runtime} bench 执行失败 (exit=${String(res.status)}): ${(res.stderr ?? '').trim()}`,
    );
  }
  return parseBenchJsonOutput(res.stdout ?? '', options.runtime);
}

/** 从单个 BenchJsonReport 抽取各 primary 用例的 CPU 占比与用户态占比 */
function extractCpuMetrics(report: BenchJsonReport): {
  ratios: number[];
  userShares: number[];
} {
  const ratios: number[] = [];
  const userShares: number[] = [];
  const primary = report.cases.filter((c) => c.role !== 'reference');
  const pool = primary.length > 0 ? primary : report.cases;

  for (const c of pool) {
    if (
      c.cpuUserMs === undefined ||
      c.cpuSysMs === undefined ||
      c.medianMs <= 0 ||
      c.iterations <= 0
    ) {
      continue;
    }
    const totalCpu = c.cpuUserMs + c.cpuSysMs;
    const wall = c.medianMs * c.iterations;
    if (wall > 0) ratios.push(totalCpu / wall);
    if (totalCpu > 0) userShares.push(c.cpuUserMs / totalCpu);
  }
  return { ratios, userShares };
}

function medianRounded(values: number[]): number | null {
  if (values.length === 0) return null;
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round((sorted[Math.floor(sorted.length / 2)] ?? 0) * 1000) / 1000;
}

/** 在 prepare 阶段采一次 Bun CPU + Heap Profile 摘要 */
export function collectPackageProfile(options: {
  repoRoot: string;
  pkgDir: string;
  profDir: string;
  suite: BenchSuiteKind;
}): ProfileDigest {
  rmSync(options.profDir, { recursive: true, force: true });
  mkdirSync(options.profDir, { recursive: true });
  const entry = join(options.repoRoot, options.pkgDir, 'bench', 'run.ts');
  const args = [
    '--cpu-prof-md',
    '--cpu-prof-interval=250',
    '--cpu-prof-dir',
    options.profDir,
    '--cpu-prof-name',
    'cpu.md',
    '--heap-prof-md',
    '--heap-prof-dir',
    options.profDir,
    '--heap-prof-name',
    'heap.md',
    entry,
    '--json',
  ];
  if (options.suite === 'quick') args.push('--quick');

  const res = spawnSync('bun', args, {
    cwd: join(options.repoRoot, options.pkgDir),
    encoding: 'utf8',
    timeout: 60000,
  });

  let cpuRatio: number | null = null;
  let userCpuShare: number | null = null;
  if (res.status === 0) {
    try {
      const report = parseBenchJsonOutput(res.stdout ?? '', 'bun');
      const { ratios, userShares } = extractCpuMetrics(report);
      cpuRatio = medianRounded(ratios);
      userCpuShare = medianRounded(userShares);
    } catch {
      // 忽略 profile 阶段偶发输出异常
    }
  }

  return parseProfileMarkdowns(
    join(options.profDir, 'cpu.md'),
    join(options.profDir, 'heap.md'),
    cpuRatio,
    userCpuShare,
  );
}

/** 仅当 Node 端触发 CROSS_RUNTIME_REGRESSION 时按需采集一次 V8 CPU Top-8 热点 */
export function collectNodeCpuHotspots(options: {
  repoRoot: string;
  pkgDir: string;
  profDir: string;
  suite: BenchSuiteKind;
}): string[] {
  const nodeProfDir = join(options.profDir, 'node-prof');
  rmSync(nodeProfDir, { recursive: true, force: true });
  mkdirSync(nodeProfDir, { recursive: true });
  const entry = join(options.repoRoot, options.pkgDir, 'bench', 'run.ts');
  const args = [`--cpu-prof`, `--cpu-prof-dir=${nodeProfDir}`, entry, '--json'];
  if (options.suite === 'quick') args.push('--quick');

  const res = spawnSync('node', args, {
    cwd: join(options.repoRoot, options.pkgDir),
    encoding: 'utf8',
    timeout: 60000,
  });
  if (res.status !== 0) return [];
  return parseNodeCpuProfileDir(nodeProfDir);
}

export interface InterleavedAbResult {
  bunBaseline: BenchJsonReport[];
  bunCandidate: BenchJsonReport[];
  nodeBaseline: BenchJsonReport[];
  nodeCandidate: BenchJsonReport[];
}

function sampleVariant(options: {
  repoRoot: string;
  pkgDir: string;
  snapshotDir: string;
  suite: BenchSuiteKind;
  includeNode: boolean;
  caseFilter?: string;
}): { bunReport: BenchJsonReport; nodeReport: BenchJsonReport | null } {
  restorePackageSnapshot(options.repoRoot, options.pkgDir, options.snapshotDir);
  const bunReport = runBenchOnce({
    repoRoot: options.repoRoot,
    pkgDir: options.pkgDir,
    runtime: 'bun',
    suite: options.suite,
    caseFilter: options.caseFilter,
  });
  const nodeReport = options.includeNode
    ? runBenchOnce({
        repoRoot: options.repoRoot,
        pkgDir: options.pkgDir,
        runtime: 'node',
        suite: options.suite,
        caseFilter: options.caseFilter,
      })
    : null;
  return { bunReport, nodeReport };
}

function runAbCycle(
  options: {
    repoRoot: string;
    pkgDir: string;
    baselineSnapshotDir: string;
    candidateSnapshotDir: string;
    suite: BenchSuiteKind;
    includeNode: boolean;
    caseFilter?: string;
  },
  cycleIndex: number,
  acc: InterleavedAbResult,
): void {
  const order: ('candidate' | 'baseline')[] =
    cycleIndex % 2 === 0
      ? ['candidate', 'baseline']
      : ['baseline', 'candidate'];

  for (const variant of order) {
    const isCand = variant === 'candidate';
    const snapshotDir = isCand
      ? options.candidateSnapshotDir
      : options.baselineSnapshotDir;
    const { bunReport, nodeReport } = sampleVariant({
      repoRoot: options.repoRoot,
      pkgDir: options.pkgDir,
      snapshotDir,
      suite: options.suite,
      includeNode: options.includeNode,
      caseFilter: options.caseFilter,
    });
    (isCand ? acc.bunCandidate : acc.bunBaseline).push(bunReport);
    if (nodeReport !== null) {
      (isCand ? acc.nodeCandidate : acc.nodeBaseline).push(nodeReport);
    }
  }
}

/**
 * 交替运行 Candidate (B) 与 Baseline (A) 多个轮次以消除热降频与系统后台波动。
 */
export function runInterleavedAb(options: {
  repoRoot: string;
  pkgDir: string;
  baselineSnapshotDir: string;
  candidateSnapshotDir: string;
  cycles: number;
  suite: BenchSuiteKind;
  includeNode: boolean;
  caseFilter?: string;
}): InterleavedAbResult {
  const acc: InterleavedAbResult = {
    bunBaseline: [],
    bunCandidate: [],
    nodeBaseline: [],
    nodeCandidate: [],
  };

  const restoreCandidate = (): void => {
    restorePackageSnapshot(
      options.repoRoot,
      options.pkgDir,
      options.candidateSnapshotDir,
    );
  };

  const onSignal = (): void => {
    try {
      restorePackageSnapshot(
        options.repoRoot,
        options.pkgDir,
        options.baselineSnapshotDir,
      );
    } finally {
      process.exit(130);
    }
  };

  process.on('SIGINT', onSignal);
  process.on('SIGTERM', onSignal);

  try {
    for (let i = 0; i < options.cycles; i += 1) {
      runAbCycle(options, i, acc);
    }
  } finally {
    process.off('SIGINT', onSignal);
    process.off('SIGTERM', onSignal);
    restoreCandidate();
  }

  return acc;
}
