/**
 * `liveSettle` 实时收敛契约测试:
 * - 手动目标转速在 97.6%->99.7% 缓慢逼近时不因超短超时或误判平台提前退出, 直至真正抵达目标十分位 (100.0%)
 * - 物理电机真卡死在目标容差 (<= 35 RPM) 且连续稳定满 `manualPlateauMs` 时安全兜底收口而不死循环
 * - M2 Pro 最低转速微欠冲 (2310 < 2317)、`fan auto` 缓慢降速与真实平台期、空 `apply` 及 `Ctrl+C` 中断优雅退出
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { type FanController, FanError, type FanTransport } from '@iyowei/fan';

import { renderWithLiveSettle } from './cli-helpers.ts';
import { runCli } from './cli.ts';

const tempHomes: string[] = [];

afterEach(() => {
  for (const dir of tempHomes.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeIsolatedHome(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fan-cli-settle-'));
  tempHomes.push(dir);
  return dir;
}

describe('liveSettle 手动转速完整收敛与稳态兜底', () => {
  test('fan max 在 97.6%->99.7% 缓慢爬升多拍时不提前退出, 直至 100.0%', async () => {
    const slowClimbRpms = [
      6131, 6220, 6223, 6226, 6229, 6232, 6235, 6238, 6240, 6242, 6244, 6246,
      6247, 6248, 6250,
    ];
    let climbIdx = 0;
    const slowClimbTransport: FanTransport = {
      readFans: () => {
        const rpm =
          slowClimbRpms[Math.min(climbIdx, slowClimbRpms.length - 1)]!;
        const pct = Math.round(((rpm - 1350) / 4900) * 1000) / 10;
        climbIdx += 1;
        return [
          {
            index: 0,
            actualRpm: rpm,
            targetRpm: 6250,
            minRpm: 1350,
            maxRpm: 6250,
            mode: 'manual',
            percent: pct,
          },
        ];
      },
      applyWrites() {
        climbIdx = 0;
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const climbChunks: string[] = [];
    const climbCode = await runCli(['max', '--once'], {
      transport: slowClimbTransport,
      stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => climbChunks.push(c),
      liveSettle: true,
      settleIntervalMs: 2,
    });
    expect(climbCode).toBe(0);
    expect(climbChunks[climbChunks.length - 1]).toContain('100.0%');
    expect(climbChunks[climbChunks.length - 1]).toContain('手动 6250 RPM');
  });

  test('物理电机长期微欠冲卡在容差 (<= 35 RPM) 且稳态持续满窗口时安全收口为「手动」', async () => {
    const stuckFan = {
      index: 0,
      actualRpm: 6230,
      targetRpm: 6250,
      minRpm: 1350,
      maxRpm: 6250,
      mode: 'manual' as const,
      percent: 99.6,
    };
    const stubController: FanController = {
      status: () => ({
        fans: [{ ...stuckFan }],
        macsFanControlRunning: false,
        warnings: [],
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
    };
    const chunks: string[] = [];
    await renderWithLiveSettle({
      initialReport: stubController.status(),
      controller: stubController,
      fanIndex: undefined,
      color: false,
      locale: 'zh',
      title: '已开启全速模式',
      writeRaw: (c) => chunks.push(c),
      intervalMs: 2,
      maxMs: undefined,
      manualPlateauMs: 30,
    });
    const last = chunks[chunks.length - 1]!;
    expect(last).toContain('99.6%');
    expect(last).toContain('手动 6250 RPM');
    expect(last).not.toContain('提速');
  });
});

describe('liveSettle 混合模式、auto 降速平台、空 apply 与 SIGINT 收口', () => {
  test('M2 Pro 最低转速微欠冲 (2310 < 2317) 与混合 auto 稳态收敛, 空 apply 不虚报', async () => {
    const home = makeIsolatedHome();
    const env = { CLIS_TEST_OS_LOCALE: 'zh-CN' };
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
    const minCode = await Promise.race([
      runCli(['min', '--fan', '0', '--once'], {
        transport: m2MinTransport,
        stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
        homedir: home,
        env,
        stdoutColor: false,
        stderrColor: false,
        rawWrite: () => {},
        liveSettle: true,
        settleIntervalMs: 5,
      }),
      new Promise<number>((resolve) => setTimeout(() => resolve(99), 400)),
    ]);
    expect(minCode).toBe(0);

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
  });

  test('fan auto 缓慢连续降速时不误判平台期直至 0 RPM; 真实带载平台稳态则按锚点收口', async () => {
    const home = makeIsolatedHome();
    const env = { CLIS_TEST_OS_LOCALE: 'zh-CN' };

    let slowAutoRpm = 200;
    const slowAutoTransport: FanTransport = {
      readFans: () => {
        const cur = slowAutoRpm;
        slowAutoRpm = Math.max(0, slowAutoRpm - 10);
        return [
          {
            index: 0,
            actualRpm: cur,
            targetRpm: 0,
            minRpm: 1350,
            maxRpm: 6250,
            mode: 'auto',
            percent: 0,
          },
        ];
      },
      applyWrites() {
        slowAutoRpm = 200;
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const slowAutoChunks: string[] = [];
    const slowAutoCode = await runCli(['auto', '--once'], {
      transport: slowAutoTransport,
      stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
      homedir: home,
      env,
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => slowAutoChunks.push(c),
      liveSettle: true,
      settleIntervalMs: 2,
    });
    expect(slowAutoCode).toBe(0);
    expect(slowAutoChunks[slowAutoChunks.length - 1]).toContain('   0 RPM');

    let steadyTick = 0;
    const steadyAutoTransport: FanTransport = {
      readFans: () => {
        steadyTick += 1;
        return [
          {
            index: 0,
            actualRpm: steadyTick % 2 === 0 ? 1805 : 1798,
            targetRpm: 0,
            minRpm: 1350,
            maxRpm: 6250,
            mode: 'auto',
            percent: 9.2,
          },
        ];
      },
      applyWrites() {
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const steadyCode = await Promise.race([
      runCli(['auto', '--once'], {
        transport: steadyAutoTransport,
        stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
        homedir: home,
        env,
        stdoutColor: false,
        stderrColor: false,
        rawWrite: () => {},
        liveSettle: true,
        settleIntervalMs: 2,
      }),
      new Promise<number>((resolve) => setTimeout(() => resolve(99), 500)),
    ]);
    expect(steadyCode).toBe(0);
  });

  test('liveSettle 等待期间 Ctrl+C 终止子采样返回退出码 0 且不报错', async () => {
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
    const sigErr: string[] = [];
    const sigCode = await runCli(['max', '--once'], {
      transport: sigintTransport,
      stateStore: { path: '/stub/s.json', read: () => null, write: () => {} },
      homedir: makeIsolatedHome(),
      env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
      stdoutColor: false,
      stderrColor: false,
      rawWrite: () => {},
      err: (l) => sigErr.push(l),
      liveSettle: true,
      settleIntervalMs: 5,
      settleMaxMs: 200,
    });
    expect(sigCode).toBe(0);
    expect(sigErr).toEqual([]);
  });
});
