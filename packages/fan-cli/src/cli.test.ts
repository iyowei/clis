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

    // 未安装守护前修改默认自动持久化并提示 install
    const setRes = await run(['set', '30%']);
    expect(setRes.code).toBe(0);
    expect(setRes.out).toContain('已记住配置 (Fan 0=30%, Fan 1=30%)');
    expect(setRes.out).toContain('fan persist install');
    expect(stateStore.read()?.fans).toEqual({
      '0': { mode: 'manual', kind: 'percent', value: 30 },
      '1': { mode: 'manual', kind: 'percent', value: 30 },
    });

    // 安装守护后再 set --once: 硬件变为 max, 但磁盘配置仍保持 30%
    const inst = await run(['persist', 'install']);
    expect(inst.code).toBe(0);
    expect(inst.out).toContain('已安装 / 运行中');

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
    expect(autoRes.out).toContain('auto');

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
