/**
 * 基准编排: 依次跑 扫描 / 体积 / 真实工作区 / 压测 四组基准, 汇总打印并分 schema 存档
 * (常规基准 → results/bench.jsonl; 长跑压测 → results/stress.jsonl, 异构 schema 不混写)。
 *
 * 收敛记账: 每轮跑完看 results/bench.jsonl 前后对比, **连续 3 轮无收益即收口**。
 * 用法: bun packages/sweep-node-modules/bench/run.ts [--label r1] (等价入口: 仓库根 `bun run bench`)
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { runRealWorkspaceBench } from './real-workspace.ts';
import { type BenchSample, runScanBench } from './scan.bench.ts';
import { runSizeBench } from './size.bench.ts';
import { type StressSample, runStressBench } from './stress.bench.ts';

const labelIndex = process.argv.indexOf('--label');
const label =
  labelIndex >= 0 ? (process.argv[labelIndex + 1] ?? 'unlabeled') : 'unlabeled';

const benchSamples: BenchSample[] = [];
benchSamples.push(...(await runScanBench()));
benchSamples.push(...(await runSizeBench()));
benchSamples.push(...(await runRealWorkspaceBench()));

const stressSamples: StressSample[] = await runStressBench(label);

console.log('\n=== 基准汇总 ===');
for (const sample of benchSamples) {
  console.log(
    `${sample.case.padEnd(12)} ${sample.name.padEnd(8)} min=${sample.minMs.toFixed(1)}ms ` +
      `median=${sample.medianMs.toFixed(1)}ms n=${sample.size} ` +
      `heap=${sample.heapDeltaMB ?? '-'}MB`,
  );
}
for (const sample of stressSamples) {
  console.log(
    `${sample.case.padEnd(21)} ${sample.name.padEnd(8)} min=${sample.minMs.toFixed(1)}ms ` +
      `median=${sample.medianMs.toFixed(1)}ms n=${sample.size} ` +
      `heap=${sample.heapDeltaMB}MB rssPeak=${sample.peakRssMB}MB`,
  );
}

const resultsDir = join(import.meta.dir, 'results');
await mkdir(resultsDir, { recursive: true });

const benchFile = join(resultsDir, 'bench.jsonl');
for (const sample of benchSamples) {
  await appendFile(
    benchFile,
    `${JSON.stringify({ ts: Date.now(), label, ...sample })}\n`,
  );
}

const stressFile = join(resultsDir, 'stress.jsonl');
for (const sample of stressSamples) {
  await appendFile(stressFile, `${JSON.stringify(sample)}\n`);
}

console.log(
  `\n已存档 ${benchSamples.length} 条 → ${benchFile}, ${stressSamples.length} 条 → ${stressFile} (label=${label})`,
);
