/**
 * `cli.ts` (`runCli`) 编排测试 (注入 `FanTransport` / `FanStateStore` / `PersistDaemonOps` 桩, 覆盖全部子命令与持久化)。
 */
import { describe, expect, test } from 'bun:test';

import type {
  FanInfo,
  FanPersistedState,
  FanStateStore,
  FanTransport,
  PersistDaemonStatus,
} from '@iyowei/fan';

import { type PersistDaemonOps, runCli } from './cli.ts';

function makeStubTransport(): FanTransport {
  const fans: FanInfo[] = [
    {
      index: 0,
      actualRpm: 0,
      targetRpm: 0,
      minRpm: 1350,
      maxRpm: 6250,
      mode: 'auto',
      percent: 0,
    },
    {
      index: 1,
      actualRpm: 0,
      targetRpm: 0,
      minRpm: 1350,
      maxRpm: 6750,
      mode: 'auto',
      percent: 0,
    },
  ];
  return {
    readFans: () => fans.map((f) => ({ ...f })),
    applyWrites(requests) {
      for (const req of requests) {
        const f = fans[req.fanIndex]!;
        if (req.kind === 'auto') {
          f.mode = 'auto';
          f.targetRpm = 0;
          f.actualRpm = 0;
          f.percent = 0;
        } else {
          f.mode = 'manual';
          f.targetRpm = req.targetRpm;
          f.actualRpm = req.targetRpm;
          f.percent =
            Math.round(
              ((f.actualRpm - f.minRpm) / (f.maxRpm - f.minRpm)) * 1000,
            ) / 10;
        }
      }
      return fans.map((f) => ({ ...f }));
    },
    isMacsFanControlRunning: () => false,
  };
}

function makeStubStateStore(): FanStateStore {
  let state: FanPersistedState | null = null;
  return {
    path: '/stub/state.json',
    read: () => state,
    write(next) {
      state = next;
    },
  };
}

function makeStubPersistOps(installedInitial = false): PersistDaemonOps {
  let installed = installedInitial;
  const build = (): PersistDaemonStatus => ({
    installed,
    running: installed,
    label: 'com.iyowei.fan',
    plistPath: '/stub/com.iyowei.fan.plist',
    daemonScriptPath: '/stub/fan-daemon.py',
    statePath: '/stub/state.json',
    logPath: '/stub/iyowei-fan.log',
    state: null,
  });
  return {
    getStatus: build,
    install() {
      installed = true;
      return build();
    },
    uninstall() {
      installed = false;
      return build();
    },
  };
}

describe('runCli 编排', () => {
  test('status / max / set / --once / apply / min / auto 与 persist 全链路', async () => {
    const transport = makeStubTransport();
    const stateStore = makeStubStateStore();
    const persistOps = makeStubPersistOps(false);
    const run = async (argv: string[]) => {
      const out: string[] = [];
      const err: string[] = [];
      const code = await runCli(argv, {
        transport,
        stateStore,
        persistOps,
        stdoutColor: false,
        stderrColor: false,
        out: (l) => out.push(l),
        err: (l) => err.push(l),
        version: '1.0.0',
      });
      return { code, out: out.join('\n'), err: err.join('\n') };
    };

    expect((await run(['-V'])).out).toBe('1.0.0');
    expect((await run(['-h'])).out).toContain('FAN');

    // 未安装守护前修改默认自动持久化并自动安装启用后台守护
    const setRes = await run(['set', '30%']);
    expect(setRes.code).toBe(0);
    expect(setRes.out).toContain('已记住预设 (30%)');
    expect(setRes.out).toContain('已自动启用后台守护 (com.iyowei.fan)');
    expect(persistOps.getStatus().installed).toBe(true);
    expect(stateStore.read()?.fans).toEqual({
      '0': { mode: 'manual', kind: 'percent', value: 30 },
      '1': { mode: 'manual', kind: 'percent', value: 30 },
    });

    // 查看或显式重装守护状态正常, 再 set --once: 硬件变为 max, 磁盘配置仍保持 30%
    const inst = await run(['persist', 'status']);
    expect(inst.code).toBe(0);
    expect(inst.out).toContain('已安装 · 运行中');

    const onceMax = await run(['max', '--once', '--json']);
    expect(onceMax.code).toBe(0);
    const onceJson = JSON.parse(onceMax.out) as {
      fans: FanInfo[];
      didPersist: boolean;
    };
    expect(onceJson.didPersist).toBe(false);
    expect(onceJson.fans.map((f) => f.targetRpm)).toEqual([6250, 6750]);

    // apply 恢复此前记住的 30% (Fan 0: 2820, Fan 1: 2970)
    const applied = await run(['apply', '--json']);
    expect(applied.code).toBe(0);
    const appliedJson = JSON.parse(applied.out) as { fans: FanInfo[] };
    expect(appliedJson.fans.map((f) => f.targetRpm)).toEqual([2820, 2970]);

    const minRes = await run(['min']);
    expect(minRes.code).toBe(0);
    expect(minRes.out).toContain('1350 RPM');

    const autoRes = await run(['auto']);
    expect(autoRes.code).toBe(0);
    expect(autoRes.out).toContain('自动温控');

    const uninst = await run(['persist', 'uninstall', '--json']);
    expect(uninst.code).toBe(0);
    expect((JSON.parse(uninst.out) as PersistDaemonStatus).installed).toBe(
      false,
    );
  });

  test('非法参数或领域错误写 stderr 并返回退出码 1', async () => {
    const transport = makeStubTransport();
    const out: string[] = [];
    const err: string[] = [];
    const code = await runCli(['set', '99999'], {
      transport,
      stateStore: makeStubStateStore(),
      stdoutColor: false,
      stderrColor: false,
      out: (l) => out.push(l),
      err: (l) => err.push(l),
    });
    expect(code).toBe(1);
    expect(out).toEqual([]);
    expect(err.join('\n')).toContain('超出允许范围');
  });
});

describe('runCli liveSettle 动态追踪', () => {
  test('原地重绘追踪风扇从 0 RPM 爬升、auto 归零及 100% 严苛满速到位', async () => {
    let actual = 0;
    let target = 0;
    const transport: FanTransport = {
      readFans: () => [
        {
          index: 0,
          actualRpm: actual,
          targetRpm: target,
          minRpm: 1350,
          maxRpm: 6250,
          mode: target > 0 ? 'manual' : 'auto',
          percent: target > 0 ? Math.max(0, ((actual - 1350) / 4900) * 100) : 0,
        },
      ],
      applyWrites(reqs) {
        const req = reqs[0]!;
        target = req.kind === 'manual' ? req.targetRpm : 0;
        // 模拟刚写入瞬间物理风扇仍为 0 RPM, 后续每次 status 采样爬升 1500 RPM
        actual = 0;
        const snap = this.readFans();
        return snap;
      },
      isMacsFanControlRunning: () => false,
    };

    let pollCount = 0;
    const origRead = transport.readFans.bind(transport);
    transport.readFans = () => {
      const snap = origRead();
      if (target > 0) {
        pollCount += 1;
        if (pollCount >= 2) {
          actual = Math.min(target, actual + 1500);
        }
      }
      return snap;
    };

    const chunks: string[] = [];
    const code = await runCli(['set', '2820', '--once'], {
      transport,
      stateStore: makeStubStateStore(),
      persistOps: makeStubPersistOps(true),
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => chunks.push(c),
      liveSettle: true,
      settleIntervalMs: 5,
      settleMaxMs: 200,
    });

    expect(code).toBe(0);
    // 首帧显示「起转中」与「目标 2820 RPM」, 中间帧显示「提速 2820 RPM」, 最终定格为「手动 2820 RPM」且移除等待提示
    expect(chunks[0]).toContain('起转中');
    expect(chunks[0]).toContain('目标 2820 RPM');
    expect(chunks.some((c) => c.includes('提速 2820 RPM'))).toBe(true);
    expect(chunks.some((c) => c.includes('\u001B['))).toBe(true);
    const lastFrame = chunks[chunks.length - 1]!;
    expect(lastFrame).toContain('2820 RPM');
    expect(lastFrame).toContain('手动 2820 RPM');
    expect(lastFrame).not.toContain('跳过等待');

    // 再测 fan auto: 从 2820 RPM 逐帧降速至 0 RPM 后自动定格退出
    let autoActual = 2820;
    const autoTransport: FanTransport = {
      readFans: () => [
        {
          index: 0,
          actualRpm: autoActual,
          targetRpm: 2820,
          minRpm: 1350,
          maxRpm: 6250,
          mode: 'auto',
          percent: Math.max(0, ((autoActual - 1350) / 4900) * 100),
        },
      ],
      applyWrites() {
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const origAutoRead = autoTransport.readFans.bind(autoTransport);
    let autoPolls = 0;
    autoTransport.readFans = () => {
      const snap = origAutoRead();
      autoPolls += 1;
      if (autoPolls >= 2) {
        autoActual = Math.max(0, autoActual - 1500);
      }
      return snap;
    };

    const autoChunks: string[] = [];
    const autoCode = await runCli(['auto'], {
      transport: autoTransport,
      stateStore: makeStubStateStore(),
      persistOps: makeStubPersistOps(true),
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => autoChunks.push(c),
      liveSettle: true,
      settleIntervalMs: 5,
      settleMaxMs: 200,
    });
    expect(autoCode).toBe(0);
    expect(autoChunks[0]).toContain('自动 (降速中)');
    const autoFinal = autoChunks[autoChunks.length - 1]!;
    expect(autoFinal).toContain('0 RPM');
    expect(autoFinal).toContain('▪▪▪▪▪▪▪▪▪▪▪▪');
    expect(autoFinal).toContain('自动温控');
    expect(autoFinal).not.toContain('跳过等待');

    // 100% 满速严苛守卫: 连续停留在 99.7% (6735/6750) 时绝不提前退出, 直至真正捕捉到 100.0% 才退出
    const samples = [0, 6735, 6735, 6735, 6735, 6750];
    let sampleIdx = 0;
    const maxTransport: FanTransport = {
      readFans: () => {
        const rpm = samples[Math.min(sampleIdx, samples.length - 1)]!;
        const pct = Math.round(((rpm - 1350) / 5400) * 1000) / 10;
        return [
          {
            index: 1,
            actualRpm: rpm,
            targetRpm: 6750,
            minRpm: 1350,
            maxRpm: 6750,
            mode: 'manual',
            percent: Math.max(0, Math.min(100, pct)),
          },
        ];
      },
      applyWrites() {
        sampleIdx = 0;
        return this.readFans();
      },
      isMacsFanControlRunning: () => false,
    };
    const origMaxRead = maxTransport.readFans.bind(maxTransport);
    let maxPolls = 0;
    maxTransport.readFans = () => {
      const snap = origMaxRead();
      maxPolls += 1;
      if (maxPolls >= 2) {
        sampleIdx += 1;
      }
      return snap;
    };

    const maxChunks: string[] = [];
    const maxCode = await runCli(['set', '100%', '--once'], {
      transport: maxTransport,
      stateStore: makeStubStateStore(),
      persistOps: makeStubPersistOps(true),
      stdoutColor: false,
      stderrColor: false,
      rawWrite: (c) => maxChunks.push(c),
      liveSettle: true,
      settleIntervalMs: 5,
    });
    expect(maxCode).toBe(0);
    expect(maxChunks.some((c) => c.includes('99.7%'))).toBe(true);
    const maxFinal = maxChunks[maxChunks.length - 1]!;
    expect(maxFinal).toContain('100.0%');
    expect(maxFinal).not.toContain('99.7%');
  });
});

describe('runCli 双风扇百分比精确十分位守卫 (零硬编码通用规则)', () => {
  test('升速 (89.9%/90.1% -> 90.0%) 与降速 (36.0%/36.1% -> 36.0%) 均须双风扇精确落到目标十分位才退出', async () => {
    const runPairScenario = async (
      arg: string,
      targets: [number, number],
      samples: [number, number][],
    ) => {
      let idx = 0;
      let polls = 0;
      const transport: FanTransport = {
        readFans: () => {
          const [rpm0, rpm1] = samples[Math.min(idx, samples.length - 1)]!;
          const snap: FanInfo[] = [
            {
              index: 0,
              actualRpm: rpm0,
              targetRpm: targets[0],
              minRpm: 1350,
              maxRpm: 6250,
              mode: 'manual',
              percent: Math.round(((rpm0 - 1350) / 4900) * 1000) / 10,
            },
            {
              index: 1,
              actualRpm: rpm1,
              targetRpm: targets[1],
              minRpm: 1350,
              maxRpm: 6750,
              mode: 'manual',
              percent: Math.round(((rpm1 - 1350) / 5400) * 1000) / 10,
            },
          ];
          polls += 1;
          if (polls >= 2) idx += 1;
          return snap;
        },
        applyWrites() {
          idx = 0;
          polls = 0;
          return this.readFans();
        },
        isMacsFanControlRunning: () => false,
      };
      const chunks: string[] = [];
      const code = await runCli(['set', arg, '--once', '--lang', 'en'], {
        transport,
        stateStore: makeStubStateStore(),
        persistOps: makeStubPersistOps(true),
        stdoutColor: false,
        stderrColor: false,
        rawWrite: (c) => chunks.push(c),
        liveSettle: true,
        settleIntervalMs: 5,
      });
      expect(code).toBe(0);
      return chunks;
    };

    // 1. 升速 90%: 89.9% 或 90.1% 均不提前退出, 直到双风扇同为 90.0%
    const upChunks = await runPairScenario(
      '90%',
      [5760, 6210],
      [
        [5765, 6206], // 90.1% & 89.9% -> 继续等
        [5763, 6210], // 90.1% & 90.0% -> 仍不提前退出
        [5760, 6210], // 90.0% & 90.0% -> 精确收敛退出
      ],
    );
    expect(upChunks.some((c) => c.includes('89.9%'))).toBe(true);
    expect(upChunks.some((c) => c.includes('Ramping 6210 RPM'))).toBe(true);
    const upFinal = upChunks[upChunks.length - 1]!;
    expect(upFinal).toContain('90.0%');
    expect(upFinal).not.toContain('89.9%');
    expect(upFinal).not.toContain('90.1%');

    // 2. 降速 36%: Fan 0=36.0% 但 Fan 1=36.1% (3297/3294) 时绝不提前退出, 直到双风扇同为 36.0%
    const downChunks = await runPairScenario(
      '36%',
      [3114, 3294],
      [
        [3112, 3297], // 36.0% & 36.1% -> Fan 1 仍在降速, 绝不提前退出
        [3114, 3295], // 36.0% & 36.0% -> 双风扇精确 36.0% 退出
      ],
    );
    expect(downChunks.some((c) => c.includes('36.1%'))).toBe(true);
    expect(downChunks.some((c) => c.includes('Slowing 3294 RPM'))).toBe(true);
    const downFinal = downChunks[downChunks.length - 1]!;
    expect(downFinal).toContain('36.0%');
    expect(downFinal).not.toContain('36.1%');
  });
});
