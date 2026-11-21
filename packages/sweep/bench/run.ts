/**
 * 基准总编排入口: 依次调度 扫描 / 体积 / 真实工作区 / 长跑压测 四组基准并汇总输出或分 schema 存档。
 * 上下游: 由 `package.json` 的 `bench` 脚本调用 (`bun packages/sweep/bench/run.ts [--label r1] [--json] [--quick] [--case <name>]`),
 * 聚合 `scan.bench.ts` / `size.bench.ts` / `real-workspace.ts` / `stress.bench.ts` 样本。
 * 核心红线: 常规样本 (`results/bench.jsonl`) 与压测样本 (`results/stress.jsonl`) 异构 schema 严格分文件落盘; 连续 3 轮无收益即收口。
 *
 * ### 数据流转示例
 * - Input: CLI 参数 (`--quick` 跳过 real/stress, `--case <name>` 过滤用例, `--json` 切结构化输出)
 * - 流程: 执行命中的基准组收集 `benchSamples` / `stressSamples`
 * - Output: `--json` 写 `schemaVersion: 1` JSON 到 stdout (不写盘); 默认打印终端汇总并分表追加 `bench.jsonl` 与 `stress.jsonl`
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
    package: '@iyowei/sweep',
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
