/**
 * 候选 B (跨平台纯实现基线): 纯 JS 统计目录树与单文件目标的逻辑字节 (`basis: 'logical-bytes'`)。
 * 上游: `size.ts` 在 Windows 或缺失系统 `du` 时选用; 仅依赖 `node:fs` 与 `node:path`。
 * 并发与安全红线:
 * - 跨目标共享有界回调池 (`IO_CONCURRENCY = 48`, 最多 `ACTIVE_TARGET_LIMIT = 6` 个目标重叠展开), 严控 FD 防 `EMFILE`;
 * - 顶层 `lstat`: 符号链接直接归 `SIZE_UNMEASURED_NOT_DIR`, 普通文件 (如 `.DS_Store`) 直取 `st.size`, 目录递归累加且内部跳过软链;
 * - 进度回调通过 `nextEmitIdx` 滑动窗口与最终三桶均严格按 `target` 升序输出, 保证跨平台确定性。
 */
import { type Dirent, lstat, readdir } from 'node:fs';
import { join, sep } from 'node:path';

import type { UnmeasuredCode } from './codes.ts';
import { SweepError } from './errors.ts';
import type {
  MeasureOptions,
  MeasureProgressEvent,
  SizeEntry,
  SizeResult,
  Sizer,
  SweepWarning,
  UnmeasuredEntry,
} from './types.ts';

function describeFailure(
  code: string | undefined,
):
  | { missing: true; reason: string }
  | { missing: false; code: UnmeasuredCode; reason: string } {
  switch (code) {
    case 'ENOENT':
      return { missing: true, reason: '不存在' };
    case 'EACCES':
    case 'EPERM':
      return {
        missing: false,
        code: 'SIZE_UNMEASURED_PERMISSION',
        reason: '权限不足, 无法读取',
      };
    case 'ENOTDIR':
      return {
        missing: false,
        code: 'SIZE_UNMEASURED_NOT_DIR',
        reason: '不是目录',
      };
    case 'ELOOP':
      return {
        missing: false,
        code: 'SIZE_UNMEASURED_LOOP',
        reason: '符号链接层级过深',
      };
    default:
      return {
        missing: false,
        code: 'SIZE_UNMEASURED_OTHER',
        reason: code === undefined ? '读取失败' : `读取失败 (${code})`,
      };
  }
}

function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** 全局同时在飞的 readdir / lstat 硬上限 (跨目标共享, 严控 FD 防 EMFILE) */
const IO_CONCURRENCY = 48;

/** 同时允许展开遍历的目标上限 (消除目标间尾部排空空转, 同时限制内存队列水位) */
const ACTIVE_TARGET_LIMIT = 6;

interface TargetJob {
  readonly index: number;
  readonly target: string;
  total: number;
  pending: number;
}

interface DirTask {
  readonly job: TargetJob;
  readonly dir: string;
}

interface FileBatch {
  readonly job: TargetJob;
  readonly prefix: string;
  readonly names: string[];
  cursor: number;
}

type TargetOutcome =
  | { kind: 'entry'; entry: SizeEntry }
  | { kind: 'unmeasured'; entry: UnmeasuredEntry }
  | { kind: 'gone'; target: string };

function pushSubpathWarning(
  warnings: SweepWarning[],
  path: string,
  error: unknown,
): void {
  const errno = errorCode(error);
  warnings.push({
    code: 'SIZE_SUBPATH_FAILED',
    message: `体积统计失败 (${describeFailure(errno).reason}): ${path}`,
    path,
    ...(errno !== undefined ? { errno } : {}),
  });
}

function emitOutcome(
  emit: (event: MeasureProgressEvent) => void,
  outcome: TargetOutcome,
): void {
  if (outcome.kind === 'entry') {
    emit({
      kind: 'measured',
      target: outcome.entry.target,
      bytes: outcome.entry.bytes,
      basis: 'logical-bytes',
    });
  } else if (outcome.kind === 'unmeasured') {
    emit({ kind: 'unmeasured', ...outcome.entry });
  } else {
    emit({ kind: 'gone', target: outcome.target });
  }
}

/** 将目录条目分类推入目录栈与文件批次 (不跟随符号链接) */
function enqueueTargetDirents(
  dirStack: DirTask[],
  fileBatches: FileBatch[],
  job: TargetJob,
  prefix: string,
  dirents: readonly Dirent[],
): void {
  if (dirents.length === 0) return;
  let fileNames: string[] | null = null;
  for (let i = 0; i < dirents.length; i += 1) {
    const dirent = dirents[i]!;
    if (dirent.isSymbolicLink()) continue;
    if (dirent.isDirectory()) {
      dirStack.push({ job, dir: `${prefix}${dirent.name}` });
      job.pending += 1;
    } else if (dirent.isFile()) {
      if (fileNames === null) fileNames = [];
      fileNames.push(dirent.name);
    }
  }
  if (fileNames !== null) {
    job.pending += fileNames.length;
    fileBatches.push({ job, prefix, names: fileNames, cursor: 0 });
  }
}

/** 从文件批次尾领一个待 lstat 文件 (零额外对象包装) */
function popFileFromBatches(
  fileBatches: FileBatch[],
): { job: TargetJob; path: string } | null {
  while (fileBatches.length > 0) {
    const top = fileBatches[fileBatches.length - 1]!;
    const name = top.names[top.cursor];
    if (name === undefined) {
      fileBatches.pop();
      continue;
    }
    top.cursor += 1;
    if (top.cursor >= top.names.length) fileBatches.pop();
    return { job: top.job, path: `${top.prefix}${name}` };
  }
  return null;
}

/** 将顶层 target 读取/lstat 失败转为目标结果并记录必要的消失告警 */
function toTopErrorOutcome(
  target: string,
  error: unknown,
  warnings: SweepWarning[],
): TargetOutcome {
  const failure = describeFailure(errorCode(error));
  if (failure.missing) {
    warnings.push({
      code: 'SIZE_TARGET_VANISHED',
      message: `体积统计失败 (${failure.reason}): ${target}`,
      path: target,
    });
    return { kind: 'gone', target };
  }
  return {
    kind: 'unmeasured',
    entry: { target, code: failure.code, reason: failure.reason },
  };
}

/** 使用跨目标共享有界回调池并发统计全部已去重排序的目标 */
function measureTargetsCallbackPool(
  sorted: readonly string[],
  signal: AbortSignal | undefined,
  emit: ((event: MeasureProgressEvent) => void) | undefined,
): Promise<{
  outcomes: (TargetOutcome | undefined)[];
  warnings: SweepWarning[];
}> {
  return new Promise((resolve, reject) => {
    const outcomes: (TargetOutcome | undefined)[] = Array.from({
      length: sorted.length,
    });
    const warnings: SweepWarning[] = [];
    const dirStack: DirTask[] = [];
    const fileBatches: FileBatch[] = [];

    let nextTargetIdx = 0;
    let activeTargets = 0;
    let activeIo = 0;
    let nextEmitIdx = 0;
    let cancelled = false;
    let hasError = false;
    let firstError: unknown;
    let settled = false;

    const stopped = (): boolean => cancelled || hasError;

    const flushProgress = (): void => {
      if (emit === undefined) return;
      while (nextEmitIdx < sorted.length && !stopped()) {
        const outcome = outcomes[nextEmitIdx];
        if (outcome === undefined) break;
        nextEmitIdx += 1;
        try {
          emitOutcome(emit, outcome);
        } catch (error) {
          if (!hasError) {
            hasError = true;
            firstError = error;
          }
          return;
        }
      }
    };

    const finishTarget = (index: number, outcome: TargetOutcome): void => {
      activeTargets -= 1;
      outcomes[index] = outcome;
      flushProgress();
    };

    const finishJob = (job: TargetJob): void => {
      finishTarget(job.index, {
        kind: 'entry',
        entry: { target: job.target, bytes: job.total },
      });
    };

    const onTopError = (
      index: number,
      target: string,
      error: unknown,
    ): void => {
      finishTarget(index, toTopErrorOutcome(target, error, warnings));
    };

    const maybeSettle = (): void => {
      if (settled || activeIo > 0) return;
      if (
        !stopped() &&
        (fileBatches.length > 0 ||
          dirStack.length > 0 ||
          nextTargetIdx < sorted.length)
      ) {
        return;
      }
      settled = true;
      if (hasError) {
        reject(firstError);
      } else if (cancelled || signal?.aborted) {
        reject(
          new SweepError('CANCELLED', '体积统计在目录遍历检查点被取消', {
            phase: 'measure',
          }),
        );
      } else {
        resolve({ outcomes, warnings });
      }
    };

    const startTarget = (index: number): void => {
      const target = sorted[index]!;
      activeTargets += 1;
      activeIo += 1;
      // 仅 lstat 末段拦截顶层符号链接 (不误伤 macOS /var 等祖先软链)
      lstat(target, (lstatErr, st) => {
        if (lstatErr !== null) {
          onTopError(index, target, lstatErr);
          activeIo -= 1;
          pump();
          return;
        }
        if (st.isSymbolicLink()) {
          finishTarget(index, {
            kind: 'unmeasured',
            entry: {
              target,
              code: 'SIZE_UNMEASURED_NOT_DIR',
              reason: '不是目录',
            },
          });
          activeIo -= 1;
          pump();
          return;
        }
        if (st.isFile()) {
          finishTarget(index, {
            kind: 'entry',
            entry: { target, bytes: st.size },
          });
          activeIo -= 1;
          pump();
          return;
        }
        if (stopped() || signal?.aborted) {
          if (signal?.aborted) cancelled = true;
          activeTargets -= 1;
          activeIo -= 1;
          pump();
          return;
        }
        readdir(target, { withFileTypes: true }, (readErr, dirents) => {
          if (readErr !== null) {
            onTopError(index, target, readErr);
          } else {
            const job: TargetJob = { index, target, total: 0, pending: 0 };
            // 仅顶层目标调一次 join 归一化尾斜杠/双斜杠, 内部子目录直接 `${dir}${sep}`
            const topPrefix = join(target, 'a').slice(0, -1);
            enqueueTargetDirents(
              dirStack,
              fileBatches,
              job,
              topPrefix,
              dirents,
            );
            if (job.pending === 0) finishJob(job);
          }
          activeIo -= 1;
          pump();
        });
      });
    };

    const pump = (): void => {
      while (activeIo < IO_CONCURRENCY && !stopped()) {
        if (signal?.aborted) {
          cancelled = true;
          break;
        }
        const fileTask = popFileFromBatches(fileBatches);
        if (fileTask !== null) {
          activeIo += 1;
          lstat(fileTask.path, (err, stats) => {
            if (err !== null) pushSubpathWarning(warnings, fileTask.path, err);
            else if (stats.isFile()) fileTask.job.total += stats.size;
            fileTask.job.pending -= 1;
            if (fileTask.job.pending === 0) finishJob(fileTask.job);
            activeIo -= 1;
            pump();
          });
          continue;
        }
        const dirTask = dirStack.pop();
        if (dirTask !== undefined) {
          activeIo += 1;
          readdir(dirTask.dir, { withFileTypes: true }, (err, children) => {
            if (err !== null) {
              pushSubpathWarning(warnings, dirTask.dir, err);
            } else {
              enqueueTargetDirents(
                dirStack,
                fileBatches,
                dirTask.job,
                `${dirTask.dir}${sep}`,
                children,
              );
            }
            dirTask.job.pending -= 1;
            if (dirTask.job.pending === 0) finishJob(dirTask.job);
            activeIo -= 1;
            pump();
          });
          continue;
        }
        if (
          nextTargetIdx < sorted.length &&
          activeTargets < ACTIVE_TARGET_LIMIT
        ) {
          const idx = nextTargetIdx;
          nextTargetIdx += 1;
          startTarget(idx);
          continue;
        }
        break;
      }
      maybeSettle();
    };

    pump();
  });
}

/**
 * 构造纯 JS 逻辑字节体积统计器 (跨平台单一代码路径, 兼容目录与普通文件目标)。
 * 外部副作用: 只读文件系统 (`lstat` / `readdir`), 不跟随符号链接, 零写入。
 *
 * ### 数据流转示例
 * ```text
 * Input: targets = ['/w/a/.DS_Store', '/w/b/target', '/w/c/symlink', '/w/d/vanished']
 * 步骤 1: 去重升序排序, 推入共享回调池 (最多 6 个目标重叠展开, 全局同时在飞 I/O <= 48)
 * 步骤 2: 顶层 lstat 分流:
 *   - '/w/a/.DS_Store' 为普通文件 -> 直接结算 bytes = st.size
 *   - '/w/b/target' 为目录 -> readdir 拆目录栈 + 文件批次, 累加所有非软链文件 st.size (子项错记 SIZE_SUBPATH_FAILED)
 *   - '/w/c/symlink' 为符号链接 -> 拒测, 归 SIZE_UNMEASURED_NOT_DIR
 *   - '/w/d/vanished' 报 ENOENT -> 归 gone 并记 SIZE_TARGET_VANISHED 告警
 * 步骤 3: flushProgress 按排序下标顺序发射进度事件, 最终按升序汇总三桶
 * Output: { basis: 'logical-bytes', entries: [a/.DS_Store, b/target],
 *           unmeasured: [{ target: '/w/c/symlink', code: 'SIZE_UNMEASURED_NOT_DIR', ... }],
 *           gone: ['/w/d/vanished'], warnings: [SIZE_TARGET_VANISHED] }
 * ```
 */
export function createJsSizer(): Sizer {
  return {
    name: 'js',
    basis: 'logical-bytes',
    async measure(
      targets: string[],
      options?: MeasureOptions,
    ): Promise<SizeResult> {
      if (options?.signal?.aborted) {
        throw new SweepError('CANCELLED', '体积统计在逐目标检查点被取消', {
          phase: 'measure',
        });
      }
      const sorted = [...new Set(targets)].sort();
      if (sorted.length === 0) {
        return {
          entries: [],
          basis: 'logical-bytes',
          warnings: [],
          unmeasured: [],
          gone: [],
        };
      }

      const { outcomes, warnings } = await measureTargetsCallbackPool(
        sorted,
        options?.signal,
        options?.onProgress,
      );

      const entries: SizeEntry[] = [];
      const unmeasured: UnmeasuredEntry[] = [];
      const gone: string[] = [];
      for (const outcome of outcomes) {
        if (outcome === undefined) continue;
        if (outcome.kind === 'entry') entries.push(outcome.entry);
        else if (outcome.kind === 'unmeasured') unmeasured.push(outcome.entry);
        else gone.push(outcome.target);
      }

      return { entries, basis: 'logical-bytes', warnings, unmeasured, gone };
    },
  };
}
