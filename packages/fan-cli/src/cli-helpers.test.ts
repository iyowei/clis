/**
 * `cli.ts` 与 `cli-helpers.ts` 边界覆盖:
 * - 注入 `platform !== 'darwin'` 的快速拒绝与错误信息本地化
 * - `NO_COLOR=1` 禁用默认 `liveSettle`、`rawWrite` 缺失时回落 `out`
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

  test('NO_COLOR=1 时关闭颜色且默认不启用 liveSettle', async () => {
    let reads = 0;
    const out: string[] = [];
    const code = await runCli(['set', '2820', '--once'], {
      transport: makeSimpleTransport({
        rpm: 0,
        onRead: () => {
          reads += 1;
        },
      }),
      stateStore: {
        path: '/stub/state.json',
        read: () => null,
        write: () => {},
      },
      homedir: makeIsolatedHome(),
      env: { NO_COLOR: '1', CLIS_TEST_OS_LOCALE: 'zh-CN' },
      out: (line) => out.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(reads).toBe(1);
    expect(out.join('\n')).not.toContain('\u001B[');
  });

  test('liveSettle=true 且未提供 rawWrite 时回 fallback 到 out', async () => {
    const out: string[] = [];
    const code = await runCli(['set', '2820', '--once'], {
      transport: makeSimpleTransport({ rpm: 2820 }),
      stateStore: {
        path: '/stub/state.json',
        read: () => null,
        write: () => {},
      },
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      liveSettle: true,
      out: (line) => out.push(line),
      err: () => {},
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('手动 2820 RPM');
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

  test('手动爬升途中被外部服务或合盖切回 auto 时立即终止等待并附加 EXTERNAL_AUTO_OVERRIDE 告警', async () => {
    let reverted = false;
    const overrideTransport: FanTransport = {
      readFans: () => [
        {
          index: 0,
          actualRpm: reverted ? 1380 : 0,
          targetRpm: reverted ? 0 : 6250,
          minRpm: 1350,
          maxRpm: 6250,
          mode: reverted ? 'auto' : 'manual',
          percent: reverted ? 0.6 : 0,
        },
      ],
      applyWrites() {
        reverted = false;
        const snap = this.readFans();
        reverted = true;
        return snap;
      },
      isMacsFanControlRunning: () => false,
    };
    const chunks: string[] = [];
    const code = await runCli(['max', '--once'], {
      transport: overrideTransport,
      stateStore: {
        path: '/stub/state.json',
        read: () => null,
        write: () => {},
      },
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => chunks.push(c),
      liveSettle: true,
      settleIntervalMs: 5,
      settleMaxMs: 200,
    });
    expect(code).toBe(0);
    const finalFrame = chunks[chunks.length - 1]!;
    expect(finalFrame).toContain('已切回自动温控');
    expect(finalFrame).not.toContain('已开启全速模式');
    expect(finalFrame).toContain('手动转速已被切回自动温控');
  });
});

describe('liveSettle 物理稳态收敛、空预设 apply 与 SIGINT 优雅退出', () => {
  test('M2 Pro 最低转速微欠冲 (2310 < 2317)、混合 auto+manual 平台期、空 apply 与 Ctrl+C 中断均诚实收敛不挂死', async () => {
    const home = makeIsolatedHome();
    const env = { CLIS_TEST_OS_LOCALE: 'zh-CN' };

    // 1) M2 Pro fan min: minRpm=2317 但稳态停在 2310 RPM (不传 settleMaxMs, 验证绝不死锁!)
    const m2MinTransport: FanTransport = {
      readFans: () => [
        {
          index: 0,
          actualRpm: 2310,
          targetRpm: 2317,
          minRpm: 2317,
          maxRpm: 6800,
          mode: 'manual',
          percent: 0,
        },
        {
          index: 1,
          actualRpm: 2500,
          targetRpm: 0,
          minRpm: 2317,
          maxRpm: 6800,
          mode: 'auto',
          percent: 4.1,
        },
      ],
      applyWrites() {
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const minChunks: string[] = [];
    const minCode = await Promise.race([
      runCli(['min', '--fan', '0', '--once'], {
        transport: m2MinTransport,
        stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
        homedir: home,
        env,
        stdoutColor: false,
        stderrColor: false,
        rawWrite: (c) => minChunks.push(c),
        liveSettle: true,
        settleIntervalMs: 5,
      }),
      new Promise<number>((resolve) => setTimeout(() => resolve(99), 250)),
    ]);
    expect(minCode).toBe(0);

    // 2) 空 state.json 执行 fan apply: 不得谎报「已应用持久化配置」
    const applyOut: string[] = [];
    const applyCode = await runCli(['apply'], {
      transport: m2MinTransport,
      stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
      homedir: home,
      env,
      stdoutColor: false,
      stderrColor: false,
      out: (l) => applyOut.push(l),
      err: () => {},
    });
    expect(applyCode).toBe(0);
    expect(applyOut.join('\n')).toContain('暂无已存预设');
    expect(applyOut.join('\n')).not.toContain('已应用持久化配置');

    // 3) liveSettle 等待期间用户按 Ctrl+C 导致同步采样抛错: 应优雅结束并返回 0 而非炸错退 1
    let polls = 0;
    const sigintTransport: FanTransport = {
      readFans: () => {
        polls += 1;
        if (polls >= 3) {
          throw new FanError('SMC_COMMAND_FAILED', 'KeyboardInterrupt');
        }
        return [
          {
            index: 0,
            actualRpm: 0,
            targetRpm: 6250,
            minRpm: 1350,
            maxRpm: 6250,
            mode: 'manual',
            percent: 0,
          },
        ];
      },
      applyWrites() {
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const sigChunks: string[] = [];
    const sigErr: string[] = [];
    const sigCode = await runCli(['max', '--once'], {
      transport: sigintTransport,
      stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
      homedir: home,
      env,
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => sigChunks.push(c),
      err: (l) => sigErr.push(l),
      liveSettle: true,
      settleIntervalMs: 5,
      settleMaxMs: 200,
    });
    expect(sigCode).toBe(0);
    expect(sigErr).toEqual([]);
  });
});
