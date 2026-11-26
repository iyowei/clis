/**
 * `cli.ts` 与 `cli-helpers.ts` 边界覆盖:
 * - 注入 `platform !== 'darwin'` 的快速拒绝与错误信息本地化
 * - `STATE_CORRUPT` 告警展示与 `persist status` `stateError` 提示
 * - `localizeFanError` 英文/中文错误映射与 `runWatchLoop` `SIGINT` 及时中断
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FanError,
  type FanInfo,
  type FanStateStore,
  type FanTransport,
  type PersistDaemonStatus,
} from '@iyowei/fan';

import { localizeFanError, runWatchLoop } from './cli-helpers.ts';
import { type PersistDaemonOps, runCli } from './cli.ts';

const tempHomes: string[] = [];

afterEach(() => {
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeIsolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fan-cli-edge-'));
  tempHomes.push(dir);
  return dir;
}

function makeSimpleTransport(opts?: {
  onRead?: () => void;
  rpm?: number;
}): FanTransport {
  const fan: FanInfo = {
    index: 0,
    actualRpm: opts?.rpm ?? 2820,
    targetRpm: 2820,
    minRpm: 1350,
    maxRpm: 6250,
    mode: 'manual',
    percent: 30,
  };
  return {
    readFans() {
      opts?.onRead?.();
      return [{ ...fan }];
    },
    applyWrites(reqs) {
      const first = reqs[0];
      if (first?.kind === 'manual') {
        fan.mode = 'manual';
        fan.targetRpm = first.targetRpm;
      }
      return [{ ...fan }];
    },
    isMacsFanControlRunning: () => false,
  };
}

describe('runCli 跨平台注入与输出边界', () => {
  test('注入非 darwin platform 时快速返回退出码 1 并提示注入平台名', async () => {
    let persistTouched = false;
    const persistOps: PersistDaemonOps = {
      getStatus() {
        persistTouched = true;
        throw new Error('should not be called');
      },
      install() {
        persistTouched = true;
        throw new Error('should not be called');
      },
      uninstall() {
        persistTouched = true;
        throw new Error('should not be called');
      },
    };
    const errEn: string[] = [];
    const codeEn = await runCli(['status', '--lang', 'en'], {
      platform: 'linux',
      persistOps,
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      out: () => {},
      err: (line) => errEn.push(line),
    });
    expect(codeEn).toBe(1);
    expect(errEn.join('\n')).toContain('current: linux');
    expect(persistTouched).toBe(false);

    const outStub: string[] = [];
    const codeStub = await runCli(['status', '--lang', 'en'], {
      platform: 'linux',
      transport: makeSimpleTransport(),
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      out: (line) => outStub.push(line),
      err: () => {},
    });
    expect(codeStub).toBe(0);
    expect(outStub.join('\n')).toContain('Fan Status');

    const errPersist: string[] = [];
    const codePersist = await runCli(['persist', 'install', '--lang', 'en'], {
      platform: 'win32',
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      out: () => {},
      err: (line) => errPersist.push(line),
    });
    expect(codePersist).toBe(1);
    expect(errPersist.join('\n')).toContain('current: win32');
  });

  test('STATE_CORRUPT 在只读命令给出告警、在 persist status 展示 stateError', async () => {
    const corruptStore: FanStateStore = {
      path: '/stub/corrupt.json',
      read() {
        throw new FanError('STATE_CORRUPT', 'state.json JSON damaged');
      },
      write: () => {},
    };
    const outRead: string[] = [];
    const statusCode = await runCli(['status', '--lang', 'en'], {
      transport: makeSimpleTransport({ rpm: 2820 }),
      stateStore: corruptStore,
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      out: (line) => outRead.push(line),
      err: () => {},
    });
    expect(statusCode).toBe(0);
    expect(outRead.join('\n')).toContain('Persisted state file is corrupted');

    const daemonStatus: PersistDaemonStatus = {
      installed: true,
      running: true,
      label: 'com.iyowei.fan',
      plistPath: '/stub/com.iyowei.fan.plist',
      daemonScriptPath: '/stub/fan-daemon.py',
      statePath: '/stub/state.json',
      logPath: '/stub/iyowei-fan.log',
      state: null,
      stateError: 'state.json contains invalid JSON',
    };
    const outPersist: string[] = [];
    const persistCode = await runCli(['persist', 'status', '--lang', 'en'], {
      persistOps: {
        getStatus: () => daemonStatus,
        install: () => daemonStatus,
        uninstall: () => daemonStatus,
      },
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      out: (line) => outPersist.push(line),
      err: () => {},
    });
    expect(persistCode).toBe(0);
    expect(outPersist.join('\n')).toContain('Corrupted / unreadable');
    expect(outPersist.join('\n')).toContain('state.json contains invalid JSON');
  });
});

describe('cli-helpers 本地化与 watch 中断', () => {
  test('localizeFanError 正确覆盖 STATE_CORRUPT 与注入 platform', () => {
    const errState = new FanError('STATE_CORRUPT', 'invalid syntax');
    expect(localizeFanError(errState, 'en')).toBe(
      'Corrupted fan state file: invalid syntax',
    );
    expect(localizeFanError(errState, 'zh')).toBe('invalid syntax');

    const errPlatform = new FanError(
      'UNSUPPORTED_PLATFORM',
      '仅支持 macOS (当前: freebsd)',
    );
    expect(localizeFanError(errPlatform, 'en', 'darwin')).toContain(
      'current: freebsd',
    );
  });

  test('runWatchLoop 收到 SIGINT 后无需等待长周期立即返回 0', async () => {
    const lines: string[] = [];
    const timer = setTimeout(() => {
      process.emit('SIGINT');
    }, 15);
    const start = Date.now();
    try {
      const code = await runWatchLoop({
        controller: {
          status: () => ({
            fans: [],
            macsFanControlRunning: false,
            warnings: [],
            persisted: null,
          }),
          set: () => {
            throw new Error('unused');
          },
          max: () => {
            throw new Error('unused');
          },
          min: () => {
            throw new Error('unused');
          },
          auto: () => {
            throw new Error('unused');
          },
          apply: () => {
            throw new Error('unused');
          },
        },
        fanIndex: undefined,
        intervalSec: 30,
        color: false,
        locale: 'en',
        out: (line) => lines.push(line),
      });
      expect(code).toBe(0);
      expect(Date.now() - start).toBeLessThan(1000);
      expect(lines.length).toBeGreaterThanOrEqual(1);
    } finally {
      clearTimeout(timer);
    }
  });
});
