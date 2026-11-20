/**
 * 异步隔离升级执行器 (`executeUpgradePlanAsync`) 与尾部环形缓冲 (`TailByteBuffer`) 单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { type ChildProcess } from 'node:child_process';
import { EventEmitter } from 'node:events';
import { existsSync } from 'node:fs';
import { PassThrough } from 'node:stream';

import {
  type SpawnAsyncLike,
  TailByteBuffer,
  executeUpgradePlanAsync,
} from './exec-async.ts';
import { type CommandSpec } from './executor.ts';

function createFakeChild(): {
  child: ChildProcess;
  stdout: PassThrough;
  stderr: PassThrough;
} {
  const emitter = new EventEmitter();
  const stdout = new PassThrough();
  const stderr = new PassThrough();
  const child = Object.assign(emitter, {
    stdout,
    stderr,
    kill: () => true,
  }) as unknown as ChildProcess;
  return { child, stdout, stderr };
}

const samplePlan: CommandSpec = {
  command: '/usr/local/bin/bun',
  args: ['add', '-g', '@iyowei/sweep-node-modules-cli@0.6.0'],
  displayCommand: 'bun add -g @iyowei/sweep-node-modules-cli@0.6.0',
};

describe('TailByteBuffer 固定上限尾部捕获', () => {
  test('未超限时完整保留内容且 truncated 为 false', () => {
    const buf = new TailByteBuffer(1024);
    buf.push('line 1\n');
    buf.push('line 2\n');
    expect(buf.toResult()).toEqual({
      text: 'line 1\nline 2\n',
      truncated: false,
    });
  });

  test('超出上限时仅保留最新尾部并跳过残缺 UTF-8 续字节避免乱码', () => {
    const buf = new TailByteBuffer(64);
    // 每个汉字 3 字节, 反复写入触发多字节边界截断
    for (let i = 0; i < 40; i += 1) {
      buf.push(`错误日志第${i}行\n`);
    }
    const res = buf.toResult();
    expect(res.truncated).toBe(true);
    expect(Buffer.byteLength(res.text, 'utf8')).toBeLessThanOrEqual(64);
    expect(res.text).toContain('错误日志第39行');
    expect(res.text).not.toContain('\ufffd');
  });
});

describe('executeUpgradePlanAsync 异步隔离与双模式执行', () => {
  test('默认模式静默捕获 stdout/stderr、记录耗时并在结束后清理临时空目录', async () => {
    let seenStdio: unknown;
    let seenCwd: string | undefined;
    let tick = 1000;

    const spawnAsync: SpawnAsyncLike = (_cmd, _args, opts) => {
      seenStdio = opts.stdio;
      seenCwd = opts.cwd;
      const { child, stdout, stderr } = createFakeChild();
      queueMicrotask(() => {
        stdout.write('bun add v1.4.5\ninstalled pkg\n');
        stderr.write('warn: peer dep\n');
        stdout.end();
        stderr.end();
        tick += 2580;
        child.emit('close', 0, null);
      });
      return child;
    };

    const res = await executeUpgradePlanAsync(samplePlan, {
      env: { PATH: '/usr/local/bin' },
      spawnAsync,
      now: () => tick,
    });

    expect(seenStdio).toEqual(['ignore', 'pipe', 'pipe']);
    expect(seenCwd).toBeDefined();
    expect(existsSync(seenCwd!)).toBe(false);
    expect(res.status).toBe(0);
    expect(res.durationMs).toBe(2580);
    expect(res.capturedOutput).toContain('bun add v1.4.5');
    expect(res.capturedOutput).toContain('warn: peer dep');
    expect(res.truncated).toBe(false);
  });

  test('verbose 模式走 stdio: inherit 透传且支持 Windows verbatim 与异常/信号事件', async () => {
    let seenStdio: unknown;
    let seenVerbatim: boolean | undefined;

    const spawnVerbose: SpawnAsyncLike = (_cmd, _args, opts) => {
      seenStdio = opts.stdio;
      seenVerbatim = opts.windowsVerbatimArguments;
      const { child } = createFakeChild();
      queueMicrotask(() => child.emit('close', 0, null));
      return child;
    };

    const okRes = await executeUpgradePlanAsync(
      { ...samplePlan, windowsVerbatimArguments: true },
      { verbose: true, spawnAsync: spawnVerbose },
    );
    expect(seenStdio).toBe('inherit');
    expect(seenVerbatim).toBe(true);
    expect(okRes.status).toBe(0);
    expect(okRes.capturedOutput).toBe('');

    const spawnError: SpawnAsyncLike = () => {
      const { child } = createFakeChild();
      queueMicrotask(() => {
        child.emit('error', new Error('spawn ENOENT'));
        child.emit('close', null, null);
      });
      return child;
    };
    const errRes = await executeUpgradePlanAsync(samplePlan, {
      spawnAsync: spawnError,
    });
    expect(errRes.status).toBeNull();
    expect(errRes.error?.message).toBe('spawn ENOENT');
  });
});
