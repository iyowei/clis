/**
 * 基准编排: 依次跑 扫描 / 体积 / 真实工作区 / 压测 四组基准, 汇总打印并分 schema 存档
 * (常规基准 → results/bench.jsonl; 长跑压测 → results/stress.jsonl, 异构 schema 不混写)。
 *
 * 收敛记账: 每轮跑完看 results/bench.jsonl 前后对比, **连续 3 轮无收益即收口**。
 * 用法: bun packages/sweep-node-modules/bench/run.ts [--label r1] [--json] [--quick] [--case <name>]
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { runRealWorkspaceBench } from './real-workspace.ts';
import { type BenchSample, runScanBench } from './scan.bench.ts';
import { runSizeBench } from './size.bench.ts';
import { type StressSample, runStressBench } from './stress.bench.ts';

const BENCH_DIR = dirname(fileURLToPath(import.meta.url));
const argv = process.argv.slice(2);
const jsonMode = argv.includes('--json');
const quickMode = argv.includes('--quick');
const labelIndex = argv.indexOf('--label');
const label =
  labelIndex >= 0 ? (argv[labelIndex + 1] ?? 'unlabeled') : 'unlabeled';
const caseIndex = argv.indexOf('--case');
const caseFilter = caseIndex >= 0 ? argv[caseIndex + 1] : undefined;

function toJsonCases(
  benchSamples: readonly BenchSample[],
  stressSamples: readonly StressSample[],
) {
  const cases = [
    ...benchSamples.map((sample) => ({
      name: `${sample.case}:${sample.name}`,
      role: sample.role ?? 'primary',
      iterations: sample.iterations,
      samplesMs: sample.samplesMs ?? [sample.medianMs],
      minMs: sample.minMs,
      medianMs: sample.medianMs,
      p95Ms: sample.p95Ms ?? sample.medianMs,
      heapDeltaMB: sample.heapDeltaMB,
      peakRssMB: sample.peakRssMB,
      cpuUserMs: sample.cpuUserMs,
      cpuSysMs: sample.cpuSysMs,
      size: sample.size,
      digest: sample.digest,
    })),
    ...stressSamples.map((sample) => ({
      name: `${sample.case}:${sample.name}`,
      iterations: sample.iterations,
      samplesMs: [sample.minMs, sample.medianMs],
      minMs: sample.minMs,
      medianMs: sample.medianMs,
      p95Ms: sample.medianMs,
      heapDeltaMB: sample.heapDeltaMB,
      peakRssMB: sample.peakRssMB,
      size: sample.size,
    })),
  ];

  if (caseFilter === undefined) return cases;
  return cases.filter(
    (c) => c.name === caseFilter || c.name.startsWith(`${caseFilter}:`),
  );
}

const benchSamples: BenchSample[] = [];
if (
  caseFilter === undefined ||
  caseFilter.startsWith('scan-large') ||
  caseFilter === 'scan'
) {
  benchSamples.push(...(await runScanBench()));
}
if (
  caseFilter === undefined ||
  caseFilter.startsWith('size-large') ||
  caseFilter === 'size'
) {
  benchSamples.push(...(await runSizeBench()));
}
if (!quickMode && (caseFilter === undefined || caseFilter.startsWith('real'))) {
  benchSamples.push(...(await runRealWorkspaceBench()));
}

const stressSamples: StressSample[] =
  !quickMode && (caseFilter === undefined || caseFilter.startsWith('stress'))
    ? await runStressBench(label)
    : [];

if (jsonMode) {
  const isBun = typeof Bun !== 'undefined';
  const payload = {
    schemaVersion: 1,
    package: '@iyowei/sweep-node-modules',
    runtime: isBun ? 'bun' : 'node',
    runtimeVersion: isBun ? Bun.version : process.version.replace(/^v/, ''),
    suite: quickMode ? 'quick' : 'full',
    cases: toJsonCases(benchSamples, stressSamples),
  };
  process.stdout.write(`${JSON.stringify(payload)}\n`);
} else {
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

  const resultsDir = join(BENCH_DIR, 'results');
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
}
