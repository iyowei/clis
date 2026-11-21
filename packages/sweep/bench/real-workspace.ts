/**
 * 体验基线基准: 在真实工作区上采集端到端只读扫描 + 双轨体积统计 (`js` / `du`) 耗时。
 * 上下游: 调用 `src/scan.ts` (缺省预设 `{ node: {} }`)、`src/size-js.ts` 与 `src/size-du.ts`; 由 `bench/run.ts` 在非 `--quick` 模式下调度。
 * 目标根解析序: `SWEEP_BENCH_ROOT` > 首个非旗标位置参数 > `process.cwd()` (不存在时跳过返回空数组)。
 * 核心红线: 严格只读, 绝不触发任何删除; 验收体验基线为真实工作区预览耗时 < 1s。
 */
import { existsSync } from 'node:fs';

import { createScanner } from '../src/scan.ts';
import { createDuSizer } from '../src/size-du.ts';
import { createJsSizer } from '../src/size-js.ts';
import type { BenchSample } from './scan.bench.ts';

function resolveBenchRoot(): string {
  const fromEnv = process.env.SWEEP_BENCH_ROOT;
  if (fromEnv !== undefined && fromEnv.trim() !== '') return fromEnv.trim();
  const arg = process.argv.slice(2).find((item) => !item.startsWith('-'));
  if (arg !== undefined) return arg;
  return process.cwd();
}

/** 在解析出的真实工作区上执行单轮只读扫描与 js/du 体积测量, 返回 3 条样本 (根不存在时返回 []) */
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
      samplesMs: [scanMs],
      minMs: scanMs,
      medianMs: scanMs,
      p95Ms: scanMs,
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
      samplesMs: [elapsed],
      minMs: elapsed,
      medianMs: elapsed,
      p95Ms: elapsed,
      size: result.entries.length,
    });
  }

  return samples;
}
