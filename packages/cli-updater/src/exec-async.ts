/**
 * 异步隔离升级执行器: 支持默认静默捕获子进程 stdout/stderr (64 KiB 环形尾部上限防 OOM)
 * 与 `--verbose` 实时透传双模式, 保留隔离临时空目录、Windows verbatim 透传与信号转发。
 */
import { type ChildProcess, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type CommandSpec, buildIsolatedEnv } from './executor.ts';

/** 静默捕获模式下在内存中保留的最大尾部字节数 (64 KiB, 足以容纳完整排障堆栈且严控内存) */
export const MAX_CAPTURE_BYTES = 64 * 1024;

/** 升级执行结果 (同步与异步执行器共用形态) */
export interface ExecuteUpgradeResult {
  status: number | null;
  signal?: NodeJS.Signals | null;
  error?: Error;
  /** 静默捕获模式下的合并尾部输出 (UTF-8, 上限 64 KiB; verbose 模式下为空串) */
  capturedOutput?: string;
  /** 捕获输出是否因超出 64 KiB 上限被截去头部 */
  truncated?: boolean;
  /** 实际执行耗时 (ms) */
  durationMs?: number;
}

/** 可注入的异步 spawn 接口 (供单元测试隔离系统进程) */
export type SpawnAsyncLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    stdio?: 'inherit' | ['ignore', 'pipe', 'pipe'];
    windowsVerbatimArguments?: boolean;
  },
) => ChildProcess;

/** 异步执行升级计划的可选参数 */
export interface ExecuteUpgradeAsyncOptions {
  env?: NodeJS.ProcessEnv;
  /** true 时实时透传子进程 stdio; false (默认) 静默捕获输出供失败排障 */
  verbose?: boolean;
  /** 最大尾部捕获字节数 (默认 MAX_CAPTURE_BYTES = 64 KiB) */
  maxCaptureBytes?: number;
  /** 异步 spawn 注入点 (默认 node:child_process#spawn) */
  spawnAsync?: SpawnAsyncLike;
  /** 时钟源 (默认 Date.now) */
  now?: () => number;
}

/** 固定内存上限的尾部字节缓冲区 (超出上限自动丢弃最老头部, 解码时对齐 UTF-8 字符边界) */
export class TailByteBuffer {
  private readonly chunks: Buffer[] = [];
  private totalBytes = 0;
  private truncatedFlag = false;
  private readonly maxBytes: number;

  constructor(maxBytes: number = MAX_CAPTURE_BYTES) {
    this.maxBytes = Math.max(64, maxBytes);
  }

  /** 追加数据块, 超出 maxBytes 时丢弃最老头部字节并标记 truncated */
  push(chunk: Buffer | string): void {
    const buf = typeof chunk === 'string' ? Buffer.from(chunk, 'utf8') : chunk;
    if (buf.length === 0) return;

    if (buf.length >= this.maxBytes) {
      this.chunks.length = 0;
      this.chunks.push(buf.subarray(buf.length - this.maxBytes));
      this.totalBytes = this.maxBytes;
      this.truncatedFlag = true;
      return;
    }

    this.chunks.push(buf);
    this.totalBytes += buf.length;

    while (this.totalBytes > this.maxBytes && this.chunks.length > 0) {
      this.truncatedFlag = true;
      const overflow = this.totalBytes - this.maxBytes;
      const head = this.chunks[0]!;
      if (head.length <= overflow) {
        this.chunks.shift();
        this.totalBytes -= head.length;
      } else {
        this.chunks[0] = head.subarray(overflow);
        this.totalBytes -= overflow;
      }
    }
  }

  /** 合并剩余缓冲为 UTF-8 字符串 (若曾截断头部则跳过残留续字节, 防首字符乱码) */
  toResult(): { text: string; truncated: boolean } {
    if (this.chunks.length === 0) {
      return { text: '', truncated: this.truncatedFlag };
    }
    let merged = Buffer.concat(this.chunks, this.totalBytes);
    if (this.truncatedFlag) {
      // 跳过截断边界遗留的 UTF-8 续字节 (0x80..0xbf), 避免头部出现乱码替换符
      let offset = 0;
      while (
        offset < merged.length &&
        offset < 4 &&
        merged[offset]! >= 0x80 &&
        merged[offset]! < 0xc0
      ) {
        offset += 1;
      }
      if (offset > 0) merged = merged.subarray(offset);
    }
    return { text: merged.toString('utf8'), truncated: this.truncatedFlag };
  }
}

/** 创建独立临时空目录并在异步回调完成后安全清理 (带 Windows 句柄释放重试) */
async function withIsolatedCwdAsync<T>(
  fn: (cwd: string) => Promise<T>,
): Promise<T> {
  const cwd = mkdtempSync(join(tmpdir(), 'cli-updater-'));
  try {
    return await fn(cwd);
  } finally {
    try {
      rmSync(cwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    } catch {
      // 忽略清理失败, 避免遮蔽升级主流程结果
    }
  }
}

/**
 * 在隔离空目录异步执行升级计划:
 * - 默认 (`verbose: false`): 静默捕获 stdout / stderr (上限 64 KiB 尾部), 释放主事件循环让 TTY Spinner 流畅渲染;
 * - 详细模式 (`verbose: true`): `stdio: 'inherit'` 实时透传包管理器原生日志;
 * - 自动转发 SIGINT / SIGTERM 给子进程防孤儿后台写入。
 */
export async function executeUpgradePlanAsync(
  plan: CommandSpec,
  options: ExecuteUpgradeAsyncOptions = {},
): Promise<ExecuteUpgradeResult> {
  const env = options.env ?? process.env;
  const verbose = options.verbose === true;
  const spawnAsync = options.spawnAsync ?? (spawn as unknown as SpawnAsyncLike);
  const now = options.now ?? (() => Date.now());
  const startedAt = now();

  return await withIsolatedCwdAsync(async (cwd) => {
    const tail = new TailByteBuffer(options.maxCaptureBytes);

    return await new Promise<ExecuteUpgradeResult>((resolve) => {
      let child: ChildProcess;
      try {
        child = spawnAsync(plan.command, plan.args, {
          cwd,
          env: buildIsolatedEnv(env, plan.envOverlay),
          stdio: verbose ? 'inherit' : ['ignore', 'pipe', 'pipe'],
          ...(plan.windowsVerbatimArguments === true
            ? { windowsVerbatimArguments: true }
            : {}),
        });
      } catch (err) {
        resolve({
          status: null,
          error: err instanceof Error ? err : new Error(String(err)),
          durationMs: Math.max(0, now() - startedAt),
        });
        return;
      }

      if (!verbose) {
        child.stdout?.on('data', (chunk: Buffer | string) => tail.push(chunk));
        child.stderr?.on('data', (chunk: Buffer | string) => tail.push(chunk));
      }

      let settled = false;
      const forwardSigInt = (): void => {
        try {
          child.kill('SIGINT');
        } catch {
          // 子进程已退出时忽略
        }
      };
      const forwardSigTerm = (): void => {
        try {
          child.kill('SIGTERM');
        } catch {
          // 子进程已退出时忽略
        }
      };

      const cleanup = (): void => {
        process.off('SIGINT', forwardSigInt);
        process.off('SIGTERM', forwardSigTerm);
      };

      const finish = (partial: {
        status: number | null;
        signal?: NodeJS.Signals | null;
        error?: Error;
      }): void => {
        if (settled) return;
        settled = true;
        cleanup();
        const captured = verbose
          ? { text: '', truncated: false }
          : tail.toResult();
        resolve({
          ...partial,
          capturedOutput: captured.text,
          truncated: captured.truncated,
          durationMs: Math.max(0, now() - startedAt),
        });
      };

      process.on('SIGINT', forwardSigInt);
      process.on('SIGTERM', forwardSigTerm);

      child.once('error', (error) => {
        finish({ status: null, error });
      });
      child.once('close', (status, signal) => {
        finish({ status, signal });
      });
    });
  });
}
