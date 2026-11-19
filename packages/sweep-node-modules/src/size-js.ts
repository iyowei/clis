/**
 * 候选 B (统一): 纯 JS 递归统计逻辑字节 (跨平台单一代码路径)。
 * 口径: 目录内普通文件大小求和 (磁盘占用口径由 du 候选承担, 差异交基准裁定);
 * 符号链接一律不跟随 (与扫描同策);
 * 根目录存在但不可读 → 结构化记入 unmeasured; 子目录失败 → 告警并继续累计已读部分。
 */
import type { Dirent } from 'node:fs';
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import type { UnmeasuredCode } from './codes.ts';
import { SweepError } from './errors.ts';
import type {
  MeasureOptions,
  SizeEntry,
  SizeResult,
  Sizer,
  SweepWarning,
  UnmeasuredEntry,
} from './types.ts';

/** 失败归因 (判别联合: ENOENT 进 gone 桶, 其余带未测到码); 未知错误码保留码值便于诊断 */
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

/** 取错误码; 非对象或缺失时返回 undefined */
function errorCode(error: unknown): string | undefined {
  return (error as { code?: string } | null)?.code;
}

/** 同时在飞的 readdir / lstat 上限 (参照 scan-parallel.ts 32 路有界并发池, 防 FD 爆炸) */
const SIZE_CONCURRENCY = 32;

/** 待统计工作项 (显式栈, 零深递归) */
type SizeWorkItem =
  { kind: 'dir'; path: string } | { kind: 'file'; path: string };

/** 追加子路径读取失败告警 (附原始 errno 供调用方定位) */
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

/** 将一批 Dirent 分类入栈 (符号链接不跟随: 防环、防越出 target) */
function enqueueDirents(
  stack: SizeWorkItem[],
  dir: string,
  dirents: readonly Dirent[],
): void {
  for (const dirent of dirents) {
    if (dirent.isSymbolicLink()) continue;
    const path = join(dir, dirent.name);
    if (dirent.isDirectory()) stack.push({ kind: 'dir', path });
    else if (dirent.isFile()) stack.push({ kind: 'file', path });
  }
}

/**
 * 显式栈 + 32 路有界并发池累计目录内普通文件字节数。
 * 出栈前检查取消信号立即抛 CANCELLED; 文件大小改用 lstat 不跟随符号链接;
 * 子目录 / 文件读取失败记中文告警 (含 errno) 并跳过, 同级其余条目照常累计。
 */
async function sumEntries(
  dirents: Dirent[],
  dir: string,
  warnings: SweepWarning[],
  signal: AbortSignal | undefined,
): Promise<number> {
  const stack: SizeWorkItem[] = [];
  enqueueDirents(stack, dir, dirents);
  let total = 0;
  let active = 0;
  const failures: unknown[] = [];
  let resolveDrained: (() => void) | null = null;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  function pump(): void {
    while (
      active < SIZE_CONCURRENCY &&
      stack.length > 0 &&
      failures.length === 0 &&
      !signal?.aborted
    ) {
      const item = stack.pop()!;
      active += 1;
      void processItem(item);
    }
    const stopped = failures.length > 0 || signal?.aborted === true;
    if (
      active === 0 &&
      (stack.length === 0 || stopped) &&
      resolveDrained !== null
    ) {
      const resolve = resolveDrained;
      resolveDrained = null;
      resolve();
    }
  }

  async function processItem(item: SizeWorkItem): Promise<void> {
    try {
      if (signal?.aborted) {
        throw new SweepError('CANCELLED', '体积统计在目录遍历检查点被取消', {
          phase: 'measure',
        });
      }
      if (item.kind === 'dir') {
        try {
          const children = await readdir(item.path, { withFileTypes: true });
          enqueueDirents(stack, item.path, children);
        } catch (error) {
          pushSubpathWarning(warnings, item.path, error);
        }
        return;
      }
      try {
        const stats = await lstat(item.path);
        if (stats.isFile()) total += stats.size;
      } catch (error) {
        pushSubpathWarning(warnings, item.path, error);
      }
    } catch (error) {
      if (failures.length === 0) failures.push(error);
    } finally {
      active -= 1;
      pump();
    }
  }

  pump();
  await drained;
  if (failures.length > 0) throw failures[0];
  if (signal?.aborted) {
    throw new SweepError('CANCELLED', '体积统计在目录遍历检查点被取消', {
      phase: 'measure',
    });
  }
  return total;
}

export function createJsSizer(): Sizer {
  return {
    name: 'js',
    basis: 'logical-bytes',
    async measure(
      targets: string[],
      options?: MeasureOptions,
    ): Promise<SizeResult> {
      // 入口取消预检: 即便 targets 为空数组, 已中止的 signal 仍须立即抛 CANCELLED
      if (options?.signal?.aborted) {
        throw new SweepError('CANCELLED', '体积统计在逐目标检查点被取消', {
          phase: 'measure',
        });
      }
      const warnings: SweepWarning[] = [];
      const entries: SizeEntry[] = [];
      const unmeasured: UnmeasuredEntry[] = [];
      const gone: string[] = [];
      /** 进度事件发射器 (options 省略时零开销) */
      const emit = options?.onProgress;

      /** 未测到项的落桶 + 事件成对发射 (码与原因一次给全) */
      const pushUnmeasured = (
        target: string,
        code: UnmeasuredCode,
        reason: string,
      ): void => {
        unmeasured.push({ target, code, reason });
        emit?.({ kind: 'unmeasured', target, code, reason });
      };

      // 去重排序副本: 不改动调用方数组, 与 du 候选同口径 (重复输入不重复计数与发告警)
      for (const target of [...new Set(targets)].sort()) {
        // 取消检查点 (逐目标之间): 被 abort 即抛 CANCELLED, 语义是「本次未完成」而非「结果为空」
        if (options?.signal?.aborted) {
          throw new SweepError('CANCELLED', '体积统计在逐目标检查点被取消', {
            phase: 'measure',
          });
        }
        let dirents: Dirent[];
        try {
          dirents = await readdir(target, { withFileTypes: true });
        } catch (error) {
          const failure = describeFailure(errorCode(error));
          if (failure.missing) {
            // 「不存在」单列 gone 桶 (BC-13): 与 warnings 的 SIZE_TARGET_VANISHED 事件同源同判定
            gone.push(target);
            warnings.push({
              code: 'SIZE_TARGET_VANISHED',
              message: `体积统计失败 (${failure.reason}): ${target}`,
              path: target,
            });
            emit?.({ kind: 'gone', target });
          } else {
            // 存在但测不到: 结构化上报, 下游不得静默移出清单
            pushUnmeasured(target, failure.code, failure.reason);
          }
          continue;
        }
        const bytes = await sumEntries(
          dirents,
          target,
          warnings,
          options?.signal,
        );
        entries.push({ target, bytes });
        emit?.({ kind: 'measured', target, bytes, basis: 'logical-bytes' });
      }

      return { entries, basis: 'logical-bytes', warnings, unmeasured, gone };
    },
  };
}
