/**
 * 候选 A (双轨快路径): 系统 `du -sk` 批量统计磁盘占用 (目标数 < 5 单进程保序, >= 5 轮询分片并发 2~6 路)。
 * 上游: `size.ts` 门面; 下游: `size-du-parse.ts` 负责 stdout 集合一致性校验与 stderr 归因解析。
 * 探针与口径: 仅探测绝对路径 `/usr/bin/du` 与 `/bin/du`, win32 一律禁用 (EC-03); 报磁盘占用 (按块取整, >= 逻辑字节)。
 * 安全红线: 固定 `LC_ALL=C` + `--` 终止选项 + 每批 <= 128 KiB 防 `E2BIG` + 含 `\n`/`\r` 前置拒收 + 集合不符整批 fail-safe 降级。
 */
import { spawn } from 'node:child_process';
import { accessSync, constants } from 'node:fs';
import { availableParallelism } from 'node:os';

import type { UnmeasuredCode } from './codes.ts';
import { SweepError } from './errors.ts';
import {
  type DuFailure,
  type DuOutputAssessment,
  PROG_PREFIX_RE,
  assessDuOutput,
  describeDuAnomaly,
  describeDuFailure,
  parseDuErrorLine,
  unescapeGnuShellQuoted,
} from './size-du-parse.ts';
import type {
  MeasureOptions,
  MeasureProgressEvent,
  SizeEntry,
  SizeResult,
  Sizer,
  SweepWarning,
  UnmeasuredEntry,
} from './types.ts';

export {
  type DuOutputAssessment,
  assessDuOutput,
  parseDuErrorLine,
  unescapeGnuShellQuoted,
};

const DU_PROBES = ['/usr/bin/du', '/bin/du'];
const hasControlChar = (target: string): boolean =>
  target.includes('\n') || target.includes('\r');

/** 默认平台 findDu 探针缓存 (避免高频调用重复 accessSync; 显式传 platform 时始终实时判定) */
let cachedDefaultDu: string | null | undefined;

/**
 * 探测可用的 du 可执行文件; 均缺失返回 null。
 * win32 一律返回 null (防当前盘根 usr\bin\du 劫持面, 行为契约 EC-03)。
 */
export function findDu(platform?: NodeJS.Platform): string | null {
  const targetPlatform = platform ?? process.platform;
  if (platform === undefined && cachedDefaultDu !== undefined) {
    return cachedDefaultDu;
  }
  let found: string | null = null;
  if (targetPlatform !== 'win32') {
    for (const probe of DU_PROBES) {
      try {
        accessSync(probe, constants.X_OK);
        found = probe;
        break;
      } catch {
        // 该探针缺失或不可执行, 继续探测下一个
      }
    }
  }
  if (platform === undefined) cachedDefaultDu = found;
  return found;
}

/** 单次 du spawn 的参数字节上限 (128 KiB, 防 E2BIG) */
export const DU_BATCH_MAX_BYTES = 128 * 1024;

/** 触发多进程并发分片的最小目标数 (小工作区保持单进程零额外 fork 开销) */
const DU_PARALLEL_MIN_TARGETS = 5;

/** 有界并发 du 进程上限 (2~6 路自适应 CPU 核心数, 实测 4~6 路进入平台期) */
const DU_CONCURRENCY = Math.min(6, Math.max(2, availableParallelism()));

/** 按 UTF-8 字节长度 (+1 NUL 终止符) 将目标列表拆分为多批, 每批至少 1 条 */
export function chunkTargetsByBytes(
  targets: readonly string[],
  maxBytes: number = DU_BATCH_MAX_BYTES,
): string[][] {
  const batches: string[][] = [];
  let current: string[] = [];
  let currentBytes = 0;
  for (const target of targets) {
    const size = Buffer.byteLength(target, 'utf8') + 1;
    if (current.length > 0 && currentBytes + size > maxBytes) {
      batches.push(current);
      current = [];
      currentBytes = 0;
    }
    current.push(target);
    currentBytes += size;
  }
  if (current.length > 0) batches.push(current);
  return batches;
}

/** 为有界并发 du 切分批次: 目标数 >= 5 且未因字节上限拆满时, 轮询交错打散为最多 DU_CONCURRENCY 批 */
function partitionTargetsForDu(
  safeTargets: readonly string[],
  maxBatchBytes: number,
): { batches: string[][]; concurrency: number } {
  if (safeTargets.length < DU_PARALLEL_MIN_TARGETS) {
    return {
      batches: chunkTargetsByBytes(safeTargets, maxBatchBytes),
      concurrency: 1,
    };
  }
  const byteChunks = chunkTargetsByBytes(safeTargets, maxBatchBytes);
  if (byteChunks.length >= DU_CONCURRENCY) {
    return { batches: byteChunks, concurrency: DU_CONCURRENCY };
  }
  const bucketCount = Math.min(
    DU_CONCURRENCY,
    Math.ceil(safeTargets.length / 2),
  );
  const buckets: string[][] = Array.from({ length: bucketCount }, () => []);
  for (let i = 0; i < safeTargets.length; i += 1) {
    buckets[i % bucketCount]!.push(safeTargets[i]!);
  }
  const batches: string[][] = [];
  for (const bucket of buckets) {
    if (bucket.length > 0) {
      batches.push(...chunkTargetsByBytes(bucket, maxBatchBytes));
    }
  }
  return { batches, concurrency: Math.min(DU_CONCURRENCY, batches.length) };
}

interface DuRunResult {
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: NodeJS.Signals | null;
  spawnError: Error | null;
}

/** 构造固定 C locale 的 du 环境变量 (单次调用复用一份干净拷贝) */
function createDuEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env, LC_ALL: 'C', LANG: 'C' };
  delete env.QUOTING_STYLE;
  delete env.LANGUAGE;
  return env;
}

/** spawn 一次 `du -sk --` 汇总本批 target, 固定 C locale 并按 UTF-8 收回 stdout / stderr */
function runDu(
  bin: string,
  targets: string[],
  env: NodeJS.ProcessEnv,
): Promise<DuRunResult> {
  return new Promise((resolve) => {
    const child = spawn(bin, ['-sk', '--', ...targets], {
      stdio: ['ignore', 'pipe', 'pipe'],
      env,
    });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    const outChunks: string[] = [];
    const errChunks: string[] = [];
    let settled = false;
    const finish = (result: DuRunResult): void => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    child.stdout.on('data', (chunk: string) => outChunks.push(chunk));
    child.stderr.on('data', (chunk: string) => errChunks.push(chunk));
    child.on('error', (error) => {
      finish({
        stdout: outChunks.join(''),
        stderr: errChunks.join(''),
        exitCode: null,
        signal: null,
        spawnError: error,
      });
    });
    child.on('close', (exitCode, signal) => {
      finish({
        stdout: outChunks.join(''),
        stderr: errChunks.join(''),
        exitCode,
        signal,
        spawnError: null,
      });
    });
  });
}

interface BatchCollectState {
  sizes: Map<string, number>;
  failures: Map<string, DuFailure>;
  degraded: Set<string>;
  warnings: SweepWarning[];
  emitted: Set<string>;
  emit?: (event: MeasureProgressEvent) => void;
}

/** 解析单个已完成 du 批次的输出、合并归因并实时发射进度事件 */
function applyDuBatchResult(
  batch: string[],
  run: DuRunResult,
  state: BatchCollectState,
  signal: AbortSignal | undefined,
): void {
  const { sizes, failures, degraded, warnings, emitted, emit } = state;
  if (run.spawnError !== null || run.signal !== null) {
    for (const target of batch) degraded.add(target);
    const errno = (run.spawnError as { code?: string } | null)?.code;
    const reason =
      run.spawnError !== null
        ? `du 执行失败 (${run.spawnError.message})`
        : `du 被信号 ${run.signal} 中止`;
    warnings.push({
      code: 'SIZE_DU_UNAVAILABLE',
      message: `${reason}: 本批 ${batch.length} 个目标的体积均未采信`,
      ...(typeof errno === 'string' ? { errno } : {}),
    });
    return;
  }

  const batchSet = new Set(batch);
  const assessment = assessDuOutput(run.stdout, batch, batchSet);
  const batchSizes = new Map<string, number>();
  if (!assessment.intact) {
    for (const target of batch) degraded.add(target);
    warnings.push({
      code: 'SIZE_DU_OUTPUT_MISMATCH',
      message: `du 输出与输入集合不符 (${describeDuAnomaly(assessment)}): 本批 ${batch.length} 个目标的体积均未采信`,
    });
  } else {
    for (const [path, bytes] of assessment.sizes) batchSizes.set(path, bytes);
  }

  const batchFailures = new Map<string, DuFailure>();
  for (const line of run.stderr.split('\n')) {
    if (line.trim() === '') continue;
    const errorLine = parseDuErrorLine(line);
    if (errorLine === null) {
      warnings.push({
        code: 'SIZE_DU_LINE_UNATTRIBUTED',
        message: `体积统计失败 (未归因): ${line.replace(PROG_PREFIX_RE, '').trim()}`,
      });
      continue;
    }
    const failure = describeDuFailure(errorLine.detail);
    if (!batchSet.has(errorLine.path)) {
      warnings.push({
        code: 'SIZE_SUBPATH_FAILED',
        message: `体积统计失败 (${failure.reason}): ${errorLine.path}`,
        path: errorLine.path,
      });
      continue;
    }
    batchFailures.set(errorLine.path, failure);
    failures.set(errorLine.path, failure);
  }

  // GNU du 对不可读目录仍输出目录自身块大小: 剔除已归因失败项后再采信并流式上报
  for (const path of batchFailures.keys()) batchSizes.delete(path);
  for (const [path, bytes] of batchSizes) sizes.set(path, bytes);

  if (emit === undefined || signal?.aborted === true) return;
  for (const target of batch) {
    if (signal?.aborted) break;
    emitted.add(target);
    const unmeasured = (
      code: UnmeasuredCode,
      reason: string,
    ): MeasureProgressEvent => ({ kind: 'unmeasured', target, code, reason });
    if (degraded.has(target)) {
      emit(unmeasured('SIZE_UNMEASURED_UNPARSEABLE', '输出不可解析'));
      continue;
    }
    const bytes = batchSizes.get(target);
    if (bytes !== undefined) {
      emit({ kind: 'measured', target, bytes, basis: 'disk-usage' });
      continue;
    }
    const failure = batchFailures.get(target);
    if (failure === undefined) {
      emit(unmeasured('SIZE_UNMEASURED_UNPARSEABLE', '输出不可解析'));
    } else if (failure.missing) {
      emit({ kind: 'gone', target });
    } else {
      emit(unmeasured(failure.code, failure.reason));
    }
  }
}

/** 分批并发跑 du 并汇总各批结果 (取消时停派新批、等在飞批自然收尾后抛 CANCELLED) */
async function measureDuBatches(
  bin: string,
  safeTargets: readonly string[],
  maxBatchBytes: number,
  signal: AbortSignal | undefined,
  emit: ((event: MeasureProgressEvent) => void) | undefined,
): Promise<BatchCollectState> {
  const state: BatchCollectState = {
    sizes: new Map<string, number>(),
    failures: new Map<string, DuFailure>(),
    degraded: new Set<string>(),
    warnings: [],
    emitted: new Set<string>(),
    emit,
  };
  const { batches, concurrency } = partitionTargetsForDu(
    safeTargets,
    maxBatchBytes,
  );
  const env = createDuEnv();
  let nextIdx = 0;
  let cancelledBeforeSpawn = false;
  let firstError: unknown;
  let hasError = false;

  async function worker(): Promise<void> {
    while (!hasError) {
      if (signal?.aborted) {
        cancelledBeforeSpawn = true;
        return;
      }
      const batch = batches[nextIdx];
      if (batch === undefined) return;
      nextIdx += 1;
      const run = await runDu(bin, batch, env);
      try {
        applyDuBatchResult(batch, run, state, signal);
      } catch (error) {
        if (!hasError) {
          hasError = true;
          firstError = error;
        }
        return;
      }
    }
  }

  await Promise.all(Array.from({ length: concurrency }, () => worker()));
  if (hasError) throw firstError;
  if (cancelledBeforeSpawn) {
    throw new SweepError('CANCELLED', '体积统计在批量统计前被取消', {
      phase: 'measure',
    });
  }
  return state;
}

/**
 * 构造系统 `du -sk` 体积统计器 (`bin` / `maxBatchBytes` 可注入供测试, 生产调用不传)。
 * 外部副作用: 只读子进程执行 `du -sk -- <batch>` (无磁盘写入)。
 *
 * ### 数据流转示例
 * ```text
 * Input: targets = ['/w/a/node_modules', '/w/b/bad\nname', '/w/c/gone', '/w/d/locked']
 * 步骤 1: 去重升序排序, 筛出含 \n/\r 的 '/w/b/bad\nname' 不传给 du
 * 步骤 2: 安全目标按字节上限 (128 KiB) 与并发阈值 (>= 5 拆 2~6 批) 分片, 固定 C locale 跑 `du -sk --`
 * 步骤 3: assessDuOutput 核验 stdout 与输入集合一致 (异常则整批进 degraded); 解析 stderr 归因并剔除已失败项的伪块大小
 * 步骤 4: 按升序全划分归三桶 (entries / unmeasured / gone), 消失项补发 SIZE_TARGET_VANISHED 告警
 * Output: { basis: 'disk-usage', entries: [{ target: '/w/a/node_modules', bytes: 4096 }],
 *           unmeasured: [{ target: '/w/b/bad\nname', code: 'SIZE_UNMEASURED_CONTROL_CHAR', ... },
 *                        { target: '/w/d/locked', code: 'SIZE_UNMEASURED_PERMISSION', ... }],
 *           gone: ['/w/c/gone'], warnings: [SIZE_TARGET_VANISHED] }
 * ```
 */
export function createDuSizer(
  bin: string | null = findDu(),
  maxBatchBytes: number = DU_BATCH_MAX_BYTES,
): Sizer {
  return {
    name: 'du',
    basis: 'disk-usage',
    async measure(
      targets: string[],
      options?: MeasureOptions,
    ): Promise<SizeResult> {
      if (options?.signal?.aborted) {
        throw new SweepError('CANCELLED', '体积统计在批量统计前被取消', {
          phase: 'measure',
        });
      }
      const sorted = [...new Set(targets)].sort();
      const emit = options?.onProgress;

      if (bin === null) {
        const unmeasured: UnmeasuredEntry[] = [];
        for (const target of sorted) {
          if (options?.signal?.aborted) {
            throw new SweepError('CANCELLED', '体积统计在逐目标检查点被取消', {
              phase: 'measure',
            });
          }
          const entry: UnmeasuredEntry = {
            target,
            code: 'SIZE_UNMEASURED_OTHER',
            reason: 'du 候选不可用',
          };
          unmeasured.push(entry);
          emit?.({ kind: 'unmeasured', ...entry });
        }
        return {
          entries: [],
          basis: 'disk-usage',
          warnings: [
            {
              code: 'SIZE_DU_UNAVAILABLE',
              message:
                'du 候选不可用: /usr/bin/du 与 /bin/du 均不存在, 本候选跳过体积统计',
            },
          ],
          unmeasured,
          gone: [],
        };
      }
      if (sorted.length === 0) {
        return {
          entries: [],
          basis: 'disk-usage',
          warnings: [],
          unmeasured: [],
          gone: [],
        };
      }

      const entries: SizeEntry[] = [];
      const unmeasured: UnmeasuredEntry[] = [];
      const gone: string[] = [];

      const safeTargets = sorted.filter((target) => !hasControlChar(target));
      const { sizes, failures, degraded, warnings, emitted } =
        safeTargets.length > 0
          ? await measureDuBatches(
              bin,
              safeTargets,
              maxBatchBytes,
              options?.signal,
              emit,
            )
          : {
              sizes: new Map<string, number>(),
              failures: new Map<string, DuFailure>(),
              degraded: new Set<string>(),
              warnings: [] as SweepWarning[],
              emitted: new Set<string>(),
            };

      const pushUnmeasured = (
        target: string,
        code: UnmeasuredCode,
        reason: string,
      ): void => {
        unmeasured.push({ target, code, reason });
        if (!emitted.has(target)) {
          emit?.({ kind: 'unmeasured', target, code, reason });
        }
      };

      for (const target of sorted) {
        if (options?.signal?.aborted) {
          throw new SweepError('CANCELLED', '体积统计在逐目标检查点被取消', {
            phase: 'measure',
          });
        }
        if (hasControlChar(target)) {
          pushUnmeasured(
            target,
            'SIZE_UNMEASURED_CONTROL_CHAR',
            '路径含控制字符',
          );
          continue;
        }
        if (degraded.has(target)) {
          pushUnmeasured(target, 'SIZE_UNMEASURED_UNPARSEABLE', '输出不可解析');
          continue;
        }
        const bytes = sizes.get(target);
        if (bytes !== undefined) {
          entries.push({ target, bytes });
          if (!emitted.has(target)) {
            emit?.({ kind: 'measured', target, bytes, basis: 'disk-usage' });
          }
          continue;
        }
        const failure = failures.get(target);
        if (failure === undefined) {
          pushUnmeasured(target, 'SIZE_UNMEASURED_UNPARSEABLE', '输出不可解析');
          continue;
        }
        if (failure.missing) {
          gone.push(target);
          warnings.push({
            code: 'SIZE_TARGET_VANISHED',
            message: `体积统计失败 (不存在): ${target}`,
            path: target,
          });
          if (!emitted.has(target)) emit?.({ kind: 'gone', target });
          continue;
        }
        pushUnmeasured(target, failure.code, failure.reason);
      }

      return { entries, basis: 'disk-usage', warnings, unmeasured, gone };
    },
  };
}
