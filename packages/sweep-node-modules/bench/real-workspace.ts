/**
 * 体验基线: 真实工作区 (经 SWEEP_BENCH_ROOT 或首个位置参数指定, 缺省回退 cwd) 的只读扫描 + 体积统计端到端耗时。
 * **只读**: 绝不执行任何删除; 目标目录不存在时返回空样本并说明。
 * 验收目标: 预览耗时「感觉不到等待」(真实工作区预览 < 1s 的体验基线)。
 */
import { existsSync } from 'node:fs';

import { createScanner } from '../src/scan.ts';
import { createDuSizer } from '../src/size-du.ts';
import { createJsSizer } from '../src/size-js.ts';
import type { BenchSample } from './scan.bench.ts';

function resolveBenchRoot(): string {
  const fromEnv = process.env.SWEEP_BENCH_ROOT;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const arg = process.argv[2];
  if (arg !== undefined && !arg.startsWith('-')) return arg;
  return process.cwd();
}

export async function runRealWorkspaceBench(): Promise<BenchSample[]> {
  const root = resolveBenchRoot();
  if (!existsSync(root)) {
    console.log(`[real-workspace] 跳过: ${root} 不存在`);
    return [];
  }

  const scanner = createScanner();
  const exclude: string[] = [];

  const scanStarted = performance.now();
  const { hits } = await scanner.scan({ roots: [root], exclude, include: [] });
  const scanMs = performance.now() - scanStarted;

  const samples: BenchSample[] = [
    {
      name: scanner.name,
      case: 'real-scan',
      iterations: 1,
      minMs: scanMs,
      medianMs: scanMs,
      size: hits.length,
    },
  ];

  const targets = hits.map((hit) => hit.target);
  for (const sizer of [createJsSizer(), createDuSizer()]) {
    const started = performance.now();
    const result = await sizer.measure(targets);
    const elapsed = performance.now() - started;
    samples.push({
      name: sizer.name,
      case: 'real-size',
      iterations: 1,
      minMs: elapsed,
      medianMs: elapsed,
      size: result.entries.length,
    });
  }

  return samples;
}
