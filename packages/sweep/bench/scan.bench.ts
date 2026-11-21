/**
 * 扫描候选基准: 在 40 项目合成工作区上对比 `prune` / `native` / `parallel` 三候选耗时与资源画像。
 * 上下游: 依赖 `src/fixtures.ts` 建临时工作区; 输出结构化 `BenchSample[]` 供 `bench/run.ts` 汇总存档 (`parallel` 标为 primary)。
 * 核心红线: 交叉校验三候选命中数必须完全一致, 否则抛错拒比; 临时工作区在 finally 必清理。
 */
import { createHash } from 'node:crypto';
import { relative } from 'node:path';

import { makeWorkspace } from '../src/fixtures.ts';
import { createNativeScanner } from '../src/scan-native.ts';
import { createParallelScanner } from '../src/scan-parallel.ts';
import { createPruningScanner } from '../src/scan-prune.ts';
import type { Scanner } from '../src/types.ts';

export interface BenchSample {
  name: string;
  role?: 'primary' | 'reference';
  case: string;
  iterations: number;
  samplesMs?: number[];
  minMs: number;
  medianMs: number;
  p95Ms?: number;
  /** 规模元数据: 命中数 / 条目数等 */
  size: number;
  /** 运行前后堆内存增量 (MB, 过程指示值, 受 GC 时序影响) */
  heapDeltaMB?: number;
  peakRssMB?: number;
  cpuUserMs?: number;
  cpuSysMs?: number;
  digest?: string;
}

function percentileSorted(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return 0;
  const pos = (sorted.length - 1) * p;
  const low = Math.floor(pos);
  const high = Math.ceil(pos);
  const weight = pos - low;
  return (
    (sorted[low] ?? 0) + ((sorted[high] ?? 0) - (sorted[low] ?? 0)) * weight
  );
}

function bigProjects() {
  const projects: {
    dir: string;
    files: number;
    bytesPerFile: number;
    nested: boolean;
  }[] = [];
  for (let i = 0; i < 40; i += 1) {
    projects.push({
      dir: `proj-${String(i).padStart(2, '0')}/web`,
      files: 150,
      bytesPerFile: 512,
      nested: i % 5 === 0,
    });
  }
  return projects;
}

async function timeScan(
  scanner: Scanner,
  workspaceRoot: string,
  roots: string[],
  exclude: string[],
  iterations: number,
) {
  await scanner.scan({ roots, exclude, include: [] }); // 预热
  const cpuBefore = process.cpuUsage();
  const heapBefore = process.memoryUsage().heapUsed;
  let peakRss = process.memoryUsage().rss;
  const samplesMs: number[] = [];
  let hitsCount = 0;
  let digest = '';

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const result = await scanner.scan({ roots, exclude, include: [] });
    samplesMs.push(performance.now() - started);
    const rss = process.memoryUsage().rss;
    if (rss > peakRss) peakRss = rss;
    hitsCount = result.hits.length;
    if (i === iterations - 1) {
      const sortedTargets = result.hits
        .map((h) => relative(workspaceRoot, h.target).replaceAll('\\', '/'))
        .sort();
      digest = createHash('sha256')
        .update(sortedTargets.join('\n'))
        .digest('hex')
        .slice(0, 16);
    }
  }

  const cpuDiff = process.cpuUsage(cpuBefore);
  const sorted = [...samplesMs].sort((a, b) => a - b);
  const heapDeltaMB =
    Math.round(((process.memoryUsage().heapUsed - heapBefore) / 1048576) * 10) /
    10;
  return {
    samplesMs,
    minMs: sorted[0] ?? 0,
    medianMs: percentileSorted(sorted, 0.5),
    p95Ms: percentileSorted(sorted, 0.95),
    hits: hitsCount,
    heapDeltaMB,
    peakRssMB: Math.round((peakRss / 1048576) * 10) / 10,
    cpuUserMs: Math.round((cpuDiff.user / 1000) * 100) / 100,
    cpuSysMs: Math.round((cpuDiff.system / 1000) * 100) / 100,
    digest,
  };
}

/**
 * 在 40 项目合成工作区 (排除 `proj-05`) 上跑三候选扫描基准 (预热 + N 轮采样), 校验命中数一致后返回 3 条样本。
 * 流转: `makeWorkspace(40 项目)` -> 各候选 `timeScan` (耗时/内存/CPU/sha256 摘要) -> 命中数对账 -> `BenchSample[3]`
 */
export async function runScanBench(iterations = 5): Promise<BenchSample[]> {
  const workspace = await makeWorkspace({ projects: bigProjects() });
  try {
    const roots = [workspace.root];
    const exclude = ['proj-05'];
    const scanners = [
      createPruningScanner(),
      createNativeScanner(),
      createParallelScanner(),
    ];
    const samples: BenchSample[] = [];

    for (const scanner of scanners) {
      const time = await timeScan(
        scanner,
        workspace.root,
        roots,
        exclude,
        iterations,
      );
      samples.push({
        name: scanner.name,
        role: scanner.name === 'parallel' ? 'primary' : 'reference',
        case: 'scan-large',
        iterations,
        samplesMs: time.samplesMs,
        minMs: time.minMs,
        medianMs: time.medianMs,
        p95Ms: time.p95Ms,
        size: time.hits,
        heapDeltaMB: time.heapDeltaMB,
        peakRssMB: time.peakRssMB,
        cpuUserMs: time.cpuUserMs,
        cpuSysMs: time.cpuSysMs,
        digest: time.digest,
      });
    }

    const reference = samples[0];
    for (const sample of samples.slice(1)) {
      if (reference && sample.size !== reference.size) {
        throw new Error(
          `基准前置校验失败: 候选命中数不一致 (${reference.name}=${reference.size} vs ${sample.name}=${sample.size}), 数据不可比`,
        );
      }
    }
    return samples;
  } finally {
    await workspace.cleanup();
  }
}
