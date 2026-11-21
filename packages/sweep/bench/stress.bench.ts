/**
 * 长跑维度压测: 在三种超大规模合成形态上对比 `prune` / `parallel` 两候选的墙钟、堆增量、峰值 RSS 与打开句柄数。
 * 上下游: 依赖 `src/fixtures.ts` 生成并清理临时目录; 被 `bench/run.ts` 导入调用或直跑 (`bun packages/sweep/bench/stress.bench.ts [--label r3]`),
 * 样本追加存档 `bench/results/stress.jsonl`。
 * 三种形态:
 * - ① 单目录 1 万条目 (`stress-wide-10k`, 含 20 个项目, 压宽目录单次 readdir);
 * - ② 1500 个项目各含 `node_modules` (`stress-projects-1500`, 压密集命中与 realpath 去重);
 * - ③ 深链 500 层 (`stress-deep-500`, 标称目标, 实际层数受 PATH_MAX 自适应收敛, 压遍历深度上限)。
 * 核心红线: 每形态均校验命中数符合预期且两候选命中清单逐条一致, 不符即抛错拒比。
 */
import { readdirSync } from 'node:fs';
import { appendFile, mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from '../src/fixtures.ts';
import { createParallelScanner } from '../src/scan-parallel.ts';
import { createPruningScanner } from '../src/scan-prune.ts';
import type { ScanOptions, Scanner, SweepWarning } from '../src/types.ts';

const MB = 1048576;

/** 宽目录形态: 总条目数 / 其中含 node_modules 的子目录数 */
const WIDE_ENTRIES = 10000;
const WIDE_PROJECTS = 20;
/** 项目形态: 项目数 */
const PROJECT_COUNT = 1500;
/** 深链形态: 目标层数 (受文件系统路径长度上限约束, 见 buildDeepChain) */
const DEEP_TARGET = 500;

/**
 * 句柄采样: macOS / Linux 经 /dev/fd 可读 (Linux 侧为指向 /proc/self/fd 的软链)。
 * 读不到时返回 null, 由调用方跳过句柄结论而不是伪造 0, 避免把「测不到」读成「没问题」。
 */
function fdCount(): number | null {
  try {
    return readdirSync('/dev/fd').length;
  } catch {
    return null;
  }
}

/**
 * 并发执行 count 次 job, 用于快速铺开 fixture。
 * 串行 await 建 1 万条目要数秒, 并发建只受系统调用延迟支配。
 */
async function runPool(
  count: number,
  concurrency: number,
  job: (index: number) => Promise<void>,
): Promise<void> {
  let next = 0;
  const workers = Array.from(
    { length: Math.min(concurrency, count) },
    async () => {
      for (;;) {
        const index = next;
        next += 1;
        if (index >= count) return;
        await job(index);
      }
    },
  );
  await Promise.all(workers);
}

/**
 * 峰值采样器: 以 1ms 间隔取 RSS 与打开句柄数。
 * 扫描是 I/O 等待型 (readdir / realpath 都会让出事件循环), 定时器因此能稳定触发;
 * 采样本身是两次轻量系统调用, 对墙钟的扰动在噪声量级。peakFd 为 0 表示采样通道不可用。
 */
function startSampler(): { stop(): { peakRss: number; peakFd: number } } {
  let peakRss = 0;
  let peakFd = 0;
  const tick = (): void => {
    const { rss } = process.memoryUsage();
    if (rss > peakRss) peakRss = rss;
    const fd = fdCount();
    if (fd !== null && fd > peakFd) peakFd = fd;
  };
  tick();
  const timer = setInterval(tick, 1);
  return {
    stop() {
      clearInterval(timer);
      tick();
      return { peakRss, peakFd };
    },
  };
}

export interface ShapeSetup {
  workspace: Workspace;
  roots: string[];
  exclude: string[];
  /** 形态规模 (随样本存档) 与期望命中数 (命中数不符即 fixture 失效, 数据不可比) */
  scale: { entries?: number; projects?: number; depth?: number };
  expectedHits: number;
}

/**
 * 深链建到文件系统接受为止, 返回实际层数与链尾项目目录 (链尾已建好 `node_modules` 与 `package.json` 锚点)。
 * macOS 的 PATH_MAX 为 1024 字节, 每层 '/' + 单字符名占 2 字节, 500 层即 1000 字节,
 * 连同临时根路径与链尾的 `node_modules` 后缀已顶到上限, 故不硬编码层数, 改为逐层实建、
 * 以文件系统拒绝为界, 再逐级回退到能容纳 `node_modules` 与 `package.json` 的那一层 (mkdir 失败不产生残留)。
 * 链尾 `node_modules` 保持空目录: 命中判定只看目录名与同级 `package.json` 锚点, 两候选都不下钻其内容, 塞文件无增益。
 */
async function buildDeepChain(
  root: string,
  target: number,
): Promise<{ depth: number; project: string }> {
  const segments: string[] = [];
  let current = root;
  for (let i = 0; i < target; i += 1) {
    const next = join(current, 'd');
    try {
      await mkdir(next);
    } catch {
      break;
    }
    current = next;
    segments.push(next);
  }

  for (let index = segments.length - 1; index >= 0; index -= 1) {
    try {
      await mkdir(join(segments[index]!, 'node_modules'));
      await writeFile(
        join(segments[index]!, 'package.json'),
        '{"name":"deep","private":true}\n',
      );
      return { depth: index + 1, project: segments[index]! };
    } catch {
      // 该层路径已放不下 node_modules / package.json, 继续上退一层再试
    }
  }
  return { depth: 0, project: root };
}

/**
 * 建工作区并铺形态内容。
 * 铺内容阶段抛错时立即清掉已建的工作区: 半成品目录不会被任何人接管, 不清就留在系统临时区。
 */
async function makeShape(
  spec: WorkspaceSpec,
  build: (workspace: Workspace) => Promise<Omit<ShapeSetup, 'workspace'>>,
): Promise<ShapeSetup> {
  const workspace = await makeWorkspace(spec);
  try {
    return { workspace, ...(await build(workspace)) };
  } catch (error) {
    await workspace.cleanup();
    throw error;
  }
}

/** 形态 ①: 单个目录 1 万条目 (1 万个 Dirent 一次性驻留, 宽度压满) */
function makeWideShape(): Promise<ShapeSetup> {
  return makeShape({ projects: [] }, async (workspace) => {
    const wide = join(workspace.root, 'wide');
    await mkdir(wide, { recursive: true });

    await runPool(WIDE_ENTRIES - WIDE_PROJECTS, 64, async (index) => {
      await writeFile(join(wide, `f-${index}.txt`), '');
    });
    await runPool(WIDE_PROJECTS, 8, async (index) => {
      const projectDir = join(wide, `proj-${index}`);
      const nodeModules = join(projectDir, 'node_modules');
      await mkdir(nodeModules, { recursive: true });
      await writeFile(
        join(projectDir, 'package.json'),
        '{"name":"wide","private":true}\n',
      );
      await writeFile(join(nodeModules, 'pkg.js'), '');
    });

    return {
      roots: [workspace.root],
      exclude: [],
      scale: { entries: WIDE_ENTRIES, projects: WIDE_PROJECTS },
      expectedHits: WIDE_PROJECTS,
    };
  });
}

/** 形态 ②: 1500 个项目各含 node_modules (命中密集, 每命中一次都要 realpath 去重) */
function makeProjectsShape(): Promise<ShapeSetup> {
  const projects = Array.from({ length: PROJECT_COUNT }, (_, index) => ({
    dir: `proj-${String(index).padStart(4, '0')}`,
    files: 1,
  }));

  return makeShape({ projects }, async (workspace) => ({
    roots: [workspace.root],
    exclude: [],
    scale: { projects: PROJECT_COUNT },
    expectedHits: PROJECT_COUNT,
  }));
}

/** 形态 ③: 深链到路径上限, 链尾一个 node_modules */
function makeDeepShape(): Promise<ShapeSetup> {
  return makeShape({ projects: [] }, async (workspace) => {
    const { depth } = await buildDeepChain(workspace.root, DEEP_TARGET);
    return {
      roots: [workspace.root],
      exclude: [],
      scale: { depth },
      expectedHits: 1,
    };
  });
}

export interface StressSample {
  ts: number;
  label: string;
  name: string;
  case: string;
  scale: ShapeSetup['scale'];
  iterations: number;
  minMs: number;
  medianMs: number;
  /** 命中数 (两候选必须一致) */
  size: number;
  warnings: number;
  /** 迭代期间堆内存增量 (MB, 过程指示值, 受 GC 时序影响) */
  heapDeltaMB: number;
  /** 迭代期间采样到的 RSS 峰值 (MB, 绝对值) 与其相对本轮起点的增量 */
  peakRssMB: number;
  rssDeltaMB: number;
  /** 句柄: 起点 / 迭代期峰值 / 终点; 通道不可用时为 null */
  fdBefore: number | null;
  fdPeak: number | null;
  fdAfter: number | null;
}

interface MeasureResult {
  minMs: number;
  medianMs: number;
  hits: string[];
  warnings: SweepWarning[];
  heapDeltaMB: number;
  peakRssMB: number;
  rssDeltaMB: number;
  fdBefore: number | null;
  fdPeak: number | null;
  fdAfter: number | null;
}

/**
 * 采集单个候选在单个形态上的资源画像。
 * 首跑作预热 (填 JIT 与目录项缓存), 不计入计时, 避免冷路径污染 min。
 */
async function measure(
  scanner: Scanner,
  options: ScanOptions,
  iterations: number,
): Promise<MeasureResult> {
  await scanner.scan(options);

  const fdBefore = fdCount();
  const before = process.memoryUsage();
  const sampler = startSampler();
  const times: number[] = [];
  let hits: string[] = [];
  let warnings: SweepWarning[] = [];

  for (let i = 0; i < iterations; i += 1) {
    const started = performance.now();
    const result = await scanner.scan(options);
    times.push(performance.now() - started);
    hits = result.hits.map((hit) => hit.target);
    warnings = result.warnings;
  }

  const { peakRss, peakFd } = sampler.stop();
  const after = process.memoryUsage();
  const sorted = [...times].sort((a, b) => a - b);

  return {
    minMs: sorted[0] ?? 0,
    medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
    hits,
    warnings,
    heapDeltaMB: round1((after.heapUsed - before.heapUsed) / MB),
    peakRssMB: round1(peakRss / MB),
    rssDeltaMB: round1((peakRss - before.rss) / MB),
    fdBefore,
    fdPeak: peakFd === 0 ? null : peakFd,
    fdAfter: fdCount(),
  };
}

function round1(value: number): number {
  return Math.round(value * 10) / 10;
}

interface Shape {
  case: string;
  note: string;
  /** 迭代次数: 规模越大单次越贵, 按形态分别取值 */
  iterations: number;
  setup: () => Promise<ShapeSetup>;
}

/**
 * 跑全部 3 种极限形态 x 2 候选, 逐形态交叉核对期望命中数与两候选命中清单一致。
 * 流转: `shape.setup()` -> `prune` / `parallel` 各预热 + 1ms 轮询采样 RSS/fd -> 命中数与清单双校验 -> `StressSample[6]`
 */
export async function runStressBench(
  label: string,
  quiet = false,
): Promise<StressSample[]> {
  const shapes: Shape[] = [
    {
      case: 'stress-wide-10k',
      note: '单目录 1 万条目',
      iterations: 10,
      setup: makeWideShape,
    },
    {
      case: 'stress-projects-1500',
      note: '1500 个项目',
      iterations: 5,
      setup: makeProjectsShape,
    },
    {
      case: 'stress-deep-500',
      note: '深链 500 层 (标称)',
      iterations: 10,
      setup: makeDeepShape,
    },
  ];
  const scanners = [createPruningScanner(), createParallelScanner()];
  const samples: StressSample[] = [];

  for (const shape of shapes) {
    const setup = await shape.setup();
    try {
      const options: ScanOptions = {
        roots: setup.roots,
        exclude: setup.exclude,
        include: [],
      };
      const scale = describeScale(setup.scale);
      if (!quiet) console.log(`\n[${shape.case}] ${shape.note} (${scale})`);

      const results: MeasureResult[] = [];
      for (const scanner of scanners) {
        const result = await measure(scanner, options, shape.iterations);
        results.push(result);
        samples.push({
          ts: Date.now(),
          label,
          name: scanner.name,
          case: shape.case,
          scale: setup.scale,
          iterations: shape.iterations,
          minMs: result.minMs,
          medianMs: result.medianMs,
          size: result.hits.length,
          warnings: result.warnings.length,
          heapDeltaMB: result.heapDeltaMB,
          peakRssMB: result.peakRssMB,
          rssDeltaMB: result.rssDeltaMB,
          fdBefore: result.fdBefore,
          fdPeak: result.fdPeak,
          fdAfter: result.fdAfter,
        });
        if (!quiet) {
          console.log(`  ${formatSample(samples[samples.length - 1]!)}`);
        }
      }

      const reference = results[0]!;
      for (const [index, result] of results.entries()) {
        if (result.hits.length !== setup.expectedHits) {
          const actual = `命中 ${result.hits.length} 条, 期望 ${setup.expectedHits} 条`;
          throw new Error(
            `基准前置校验失败: ${scanners[index]!.name} ${actual} (fixture 失效, 数据不可比)`,
          );
        }
        if (result.hits.join('\n') !== reference.hits.join('\n')) {
          throw new Error(
            `基准前置校验失败: ${scanners[index]!.name} 与 ${scanners[0]!.name} 命中清单不一致, 数据不可比`,
          );
        }
      }
    } finally {
      await setup.workspace.cleanup();
    }
  }

  return samples;
}

function describeScale(scale: ShapeSetup['scale']): string {
  const parts: string[] = [];
  if (scale.entries !== undefined) parts.push(`条目 ${scale.entries}`);
  if (scale.projects !== undefined) parts.push(`项目 ${scale.projects}`);
  if (scale.depth !== undefined) parts.push(`链深 ${scale.depth}`);
  return parts.join(' / ');
}

function formatSample(sample: StressSample): string {
  const fd =
    sample.fdBefore === null
      ? '-'
      : `${sample.fdBefore}→${sample.fdPeak ?? '-'}→${sample.fdAfter ?? '-'}`;
  return [
    sample.name.padEnd(9),
    `min=${sample.minMs.toFixed(1).padStart(8)}ms`,
    `median=${sample.medianMs.toFixed(1).padStart(8)}ms`,
    `hits=${String(sample.size).padStart(5)}`,
    `heap=${sample.heapDeltaMB.toFixed(1).padStart(6)}MB`,
    `rssDelta=${sample.rssDeltaMB.toFixed(1).padStart(6)}MB`,
    `rssPeak=${sample.peakRssMB.toFixed(1).padStart(6)}MB`,
    `fd=${fd}`,
  ].join(' ');
}

// 直接执行 (bun packages/sweep/bench/stress.bench.ts) 时跑全量; 被 bench/run.ts 导入时只导出 runStressBench
if (import.meta.main) {
  const labelIndex = process.argv.indexOf('--label');
  const label =
    labelIndex >= 0
      ? (process.argv[labelIndex + 1] ?? 'unlabeled')
      : 'unlabeled';

  const samples = await runStressBench(label);

  console.log('\n=== 压测汇总 ===');
  for (const sample of samples) {
    console.log(`${sample.case.padEnd(21)} ${formatSample(sample)}`);
  }

  const resultsDir = join(import.meta.dir, 'results');
  await mkdir(resultsDir, { recursive: true });
  const file = join(resultsDir, 'stress.jsonl');
  for (const sample of samples) {
    await appendFile(file, `${JSON.stringify(sample)}\n`);
  }
  console.log(`\n已存档 ${samples.length} 条 → ${file} (label=${label})`);
}
