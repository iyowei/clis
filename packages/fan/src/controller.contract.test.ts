/**
 * `createFanController` 契约测试 (注入可编程 `FanTransport` 桩, 跨平台确定性运行)。
 */
import { describe, expect, test } from 'bun:test';

import { createFanController } from './controller.ts';
import { isFanError } from './errors.ts';
import { computePercent } from './speed.ts';
import type {
  FanInfo,
  FanPersistedState,
  FanStateStore,
  FanTransport,
  FanWriteRequest,
} from './types.ts';

function makeMemoryStateStore(
  initial: FanPersistedState | null = null,
): FanStateStore {
  let current = initial;
  return {
    path: '/memory/state.json',
    read: () => current,
    write(next) {
      current = next;
    },
  };
}

function makeFakeTransport(
  initialFans: FanInfo[],
  mfcRunning = false,
): {
  transport: FanTransport;
  writes: FanWriteRequest[][];
} {
  const state = initialFans.map((f) => ({ ...f }));
  const writes: FanWriteRequest[][] = [];

  return {
    writes,
    transport: {
      readFans: () => state.map((f) => ({ ...f })),
      applyWrites(requests) {
        writes.push([...requests]);
        for (const req of requests) {
          const fan = state.find((f) => f.index === req.fanIndex);
          if (fan === undefined) continue;
          if (req.kind === 'auto') {
            fan.mode = 'auto';
            fan.targetRpm = 0;
            fan.actualRpm = 0;
            fan.percent = 0;
          } else {
            fan.mode = 'manual';
            fan.targetRpm = req.targetRpm;
            fan.actualRpm = req.targetRpm;
            fan.percent = computePercent(fan.actualRpm, fan.minRpm, fan.maxRpm);
          }
        }
        return state.map((f) => ({ ...f }));
      },
      isMacsFanControlRunning: () => mfcRunning,
    },
  };
}

const DUAL_FANS: FanInfo[] = [
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

describe('createFanController 契约', () => {
  test('status 支持全部与单扇筛选并附带 Macs Fan Control 冲突提示', () => {
    const { transport } = makeFakeTransport(DUAL_FANS, true);
    const fan = createFanController({ transport });

    const all = fan.status();
    expect(all.fans).toHaveLength(2);
    expect(all.macsFanControlRunning).toBe(true);
    expect(all.warnings.map((w) => w.code)).toEqual([
      'MACS_FAN_CONTROL_RUNNING',
    ]);

    const only1 = fan.status({ fanIndex: 1 });
    expect(only1.fans.map((f) => f.index)).toEqual([1]);
  });

  test('max / min / set(百分比与跨上限限幅) / auto 完整闭环', () => {
    const { transport, writes } = makeFakeTransport(DUAL_FANS, false);
    const fan = createFanController({ transport });

    const maxed = fan.max();
    expect(maxed.fans[0]?.targetRpm).toBe(6250);
    expect(maxed.fans[1]?.targetRpm).toBe(6750);
    expect(maxed.fans.every((f) => f.mode === 'manual')).toBe(true);

    const pct50 = fan.set({ speed: '50%', fanIndex: 0 });
    expect(pct50.fans).toHaveLength(1);
    expect(pct50.fans[0]?.targetRpm).toBe(3800);

    // 6500 在 Fan 0 (max 6250) 与 Fan 1 (max 6750) 之间, Fan 0 自动限幅并发告警
    const clamped = fan.set({ speed: '6500' });
    expect(clamped.fans[0]?.targetRpm).toBe(6250);
    expect(clamped.fans[1]?.targetRpm).toBe(6500);
    expect(clamped.warnings.some((w) => w.code === 'FAN_CLAMPED')).toBe(true);

    const minned = fan.min();
    expect(minned.fans.map((f) => f.targetRpm)).toEqual([1350, 1350]);

    const autod = fan.auto();
    expect(autod.fans.every((f) => f.mode === 'auto')).toBe(true);
    expect(writes).toHaveLength(5);
  });

  test('越界转速与非法风扇索引抛出结构化 FanError', () => {
    const { transport } = makeFakeTransport(DUAL_FANS, false);
    const fan = createFanController({ transport });

    try {
      fan.set({ speed: '99999' });
      throw new Error('Expected INVALID_SPEED');
    } catch (err) {
      expect(isFanError(err)).toBe(true);
      if (isFanError(err)) expect(err.code).toBe('INVALID_SPEED');
    }

    try {
      fan.max({ fanIndex: 5 });
      throw new Error('Expected INVALID_FAN_INDEX');
    } catch (err) {
      expect(isFanError(err)).toBe(true);
      if (isFanError(err)) expect(err.code).toBe('INVALID_FAN_INDEX');
    }
  });

  test('默认自动持久化设定, persist=false 不覆写, apply 按需恢复全盘设定', () => {
    const { transport } = makeFakeTransport(DUAL_FANS, false);
    const stateStore = makeMemoryStateStore();
    const fan = createFanController({ transport, stateStore });

    // 1. 默认持久化 30% -> 写入双扇 percentage 条目
    const pct30 = fan.set({ speed: '30%' });
    expect(pct30.didPersist).toBe(true);
    expect(pct30.persisted?.fans).toEqual({
      '0': { mode: 'manual', kind: 'percent', value: 30 },
      '1': { mode: 'manual', kind: 'percent', value: 30 },
    });

    // 2. 单独改 Fan 0 为 4500 RPM 且自动保存 -> 保留 Fan 1 原先的 30%
    const partial = fan.set({ speed: '4500', fanIndex: 0 });
    expect(partial.didPersist).toBe(true);
    expect(partial.persisted?.fans).toEqual({
      '0': { mode: 'manual', kind: 'rpm', value: 4500 },
      '1': { mode: 'manual', kind: 'percent', value: 30 },
    });

    // 3. persist=false (--once 语义): 仅修改硬件转速, 不覆写持久化配置
    const once = fan.set({ speed: '6000', persist: false });
    expect(once.didPersist).toBe(false);
    expect(once.fans.map((f) => f.targetRpm)).toEqual([6000, 6000]);
    expect(once.persisted?.fans).toEqual({
      '0': { mode: 'manual', kind: 'rpm', value: 4500 },
      '1': { mode: 'manual', kind: 'percent', value: 30 },
    });

    // 4. apply(): 恢复磁盘记住的配置 (Fan 0 -> 4500 RPM, Fan 1 -> 30% of 1350..6750 = 2970 RPM)
    const applied = fan.apply();
    expect(applied.fans[0]?.targetRpm).toBe(4500);
    expect(applied.fans[1]?.targetRpm).toBe(2970);

    // 5. auto 默认也记住 -> 清除手动预设为 auto
    const autod = fan.auto();
    expect(autod.didPersist).toBe(true);
    expect(autod.persisted?.fans).toEqual({
      '0': { mode: 'auto' },
      '1': { mode: 'auto' },
    });
  });

  test('set / max / min 自动触发 ensureDaemon 并返回 daemonAction, status 与 auto 不触发安装', () => {
    const { transport } = makeFakeTransport(DUAL_FANS, false);
    const stateStore = makeMemoryStateStore();
    let installed = false;
    let ensureCalls = 0;
    const fan = createFanController({
      transport,
      stateStore,
      ensureDaemon: () => {
        ensureCalls += 1;
        const action = installed ? 'unchanged' : 'installed';
        installed = true;
        return {
          action,
          status: {
            installed: true,
            running: true,
            label: 'com.iyowei.fan',
            plistPath: '/stub/plist',
            daemonScriptPath: '/stub/daemon.py',
            statePath: '/memory/state.json',
            logPath: '/stub/fan.log',
            state: null,
          },
        };
      },
    });

    expect(fan.status().daemonAction).toBeUndefined();
    expect(ensureCalls).toBe(0);

    const firstSet = fan.set({ speed: '40%' });
    expect(firstSet.daemonAction).toBe('installed');
    expect(ensureCalls).toBe(1);

    const nextMax = fan.max();
    expect(nextMax.daemonAction).toBe('unchanged');
    expect(ensureCalls).toBe(2);

    const nextMin = fan.min();
    expect(nextMin.daemonAction).toBe('unchanged');
    expect(ensureCalls).toBe(3);

    const backAuto = fan.auto();
    expect(backAuto.daemonAction).toBeUndefined();
    expect(ensureCalls).toBe(3);
  });
});
