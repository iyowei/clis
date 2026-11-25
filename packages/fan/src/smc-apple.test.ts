/**
 * `AppleSmcTransport` 跨平台分支与 macOS 只读真机冒烟测试。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';

import { isFanError } from './errors.ts';
import { MACOS_PYTHON3_BIN, createAppleSmcTransport } from './smc-apple.ts';

describe('createAppleSmcTransport (注入)', () => {
  test('非 macOS 平台拒绝并抛 UNSUPPORTED_PLATFORM', () => {
    const transport = createAppleSmcTransport({ platform: 'linux' });
    try {
      transport.readFans();
      throw new Error('Expected UNSUPPORTED_PLATFORM');
    } catch (err) {
      expect(isFanError(err)).toBe(true);
      if (isFanError(err)) expect(err.code).toBe('UNSUPPORTED_PLATFORM');
    }
    expect(transport.isMacsFanControlRunning()).toBe(false);
  });

  test('非 root 写操作经绝对路径 sudo 调用系统 python3, 读操作不走 sudo', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeFans = JSON.stringify([
      {
        index: 0,
        actualRpm: 3000,
        targetRpm: 3000,
        minRpm: 1350,
        maxRpm: 6250,
        mode: 'manual',
        percent: 33.7,
      },
    ]);
    const transport = createAppleSmcTransport({
      platform: 'darwin',
      geteuid: () => 501,
      exists: () => true,
      spawnSyncFn: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args: [...args] });
        return {
          pid: 1,
          output: ['', fakeFans, ''],
          stdout: fakeFans,
          stderr: '',
          status: 0,
          signal: null,
        };
      }) as never,
    });

    const read = transport.readFans();
    expect(read[0]?.actualRpm).toBe(3000);
    expect(calls[0]?.cmd).toBe(MACOS_PYTHON3_BIN);

    const written = transport.applyWrites([
      { kind: 'manual', fanIndex: 0, targetRpm: 4000 },
    ]);
    expect(written).toHaveLength(1);
    expect(calls[1]?.cmd).toBe('/usr/bin/sudo');
    expect(calls[1]?.args[0]).toBe(MACOS_PYTHON3_BIN);
  });
});

const hasAppleSmcHost =
  process.platform === 'darwin' && existsSync(MACOS_PYTHON3_BIN);

describe('AppleSMC 真机只读冒烟 (仅 macOS)', () => {
  test.skipIf(!hasAppleSmcHost)(
    'readFans() 可直接读取本机风扇参数且零副作用',
    () => {
      const transport = createAppleSmcTransport();
      const fans = transport.readFans();
      expect(fans.length).toBeGreaterThanOrEqual(1);
      expect(fans[0]!.maxRpm).toBeGreaterThan(fans[0]!.minRpm);
    },
  );
});
