/**
 * 体积统计候选基准: js (纯实现) / du (平台命令快路径) 在大目标集上的耗时对比。
 * 口径差异 (磁盘占用 vs 逻辑字节) 由契约测试界定, 本基准只比耗时与条目数一致性。
 */
import { createHash } from 'node:crypto';
import { join, relative } from 'node:path';

import { makeWorkspace } from '../src/fixtures.ts';
import { createDuSizer } from '../src/size-du.ts';
import { createJsSizer } from '../src/size-js.ts';
import type { BenchSample } from './scan.bench.ts';

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
  for (let i = 0; i < 30; i += 1) {
    projects.push({
      dir: `proj-${String(i).padStart(2, '0')}`,
      files: 200,
      bytesPerFile: 512,
      nested: false,
    });
  }
  return projects;
}

export async function runSizeBench(iterations = 3): Promise<BenchSample[]> {
  const spec = { projects: bigProjects() };
  const workspace = await makeWorkspace(spec);
  try {
    const targets = spec.projects.map((project) =>
      join(workspace.root, project.dir, 'node_modules'),
    );
    const sizers = [createJsSizer(), createDuSizer()];
    const samples: BenchSample[] = [];
    const counts: number[] = [];

    for (const sizer of sizers) {
      await sizer.measure(targets); // 预热
      const cpuBefore = process.cpuUsage();
      const heapBefore = process.memoryUsage().heapUsed;
      let peakRss = process.memoryUsage().rss;
      const samplesMs: number[] = [];
      let entriesCount = 0;
      let digest = '';

      for (let i = 0; i < iterations; i += 1) {
        const started = performance.now();
        const result = await sizer.measure(targets);
        samplesMs.push(performance.now() - started);
        const rss = process.memoryUsage().rss;
        if (rss > peakRss) peakRss = rss;
        entriesCount = result.entries.length;
        if (i === iterations - 1) {
          const sortedTargets = result.entries
            .map(
              (e) =>
                `${relative(workspace.root, e.target).replaceAll('\\', '/')}:${e.bytes}`,
            )
            .sort();
          digest = createHash('sha256')
            .update(sortedTargets.join('\n'))
            .digest('hex')
            .slice(0, 16);
        }
      }

      const cpuDiff = process.cpuUsage(cpuBefore);
      const sorted = [...samplesMs].sort((a, b) => a - b);
      counts.push(entriesCount);
      const heapDeltaMB =
        Math.round(
          ((process.memoryUsage().heapUsed - heapBefore) / 1048576) * 10,
        ) / 10;

      samples.push({
        name: sizer.name,
        role: 'primary',
        case: 'size-large',
        iterations,
        samplesMs,
        minMs: sorted[0] ?? 0,
        medianMs: percentileSorted(sorted, 0.5),
        p95Ms: percentileSorted(sorted, 0.95),
        size: entriesCount,
        heapDeltaMB,
        peakRssMB: Math.round((peakRss / 1048576) * 10) / 10,
        cpuUserMs: Math.round((cpuDiff.user / 1000) * 100) / 100,
        cpuSysMs: Math.round((cpuDiff.system / 1000) * 100) / 100,
        digest,
      });
    }

    const [first, second] = counts;
    if (first !== undefined && second !== undefined && first !== second) {
      throw new Error(
        `基准前置校验失败: 两候选条目数不一致 (${first} vs ${second})`,
      );
    }
    return samples;
  } finally {
    await workspace.cleanup();
  }
}
