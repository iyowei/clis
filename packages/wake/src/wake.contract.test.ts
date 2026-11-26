/**
 * `@iyowei/wake` 核心唤醒编排契约测试 (可注入传输与时钟替身, 全平台确定性验证)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveWakeConfig } from './config-write.ts';
import { isWakeError } from './errors.ts';
import type { LocalLanInterface } from './types.ts';
import { wakeTarget } from './wake.ts';

const dirs: string[] = [];

function makeConfigFile(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wake-contract-'));
  dirs.push(dir);
  const path = join(dir, 'config.json');
  saveWakeConfig(path, {
    version: 1,
    defaultTarget: 'workstation',
    targets: {
      workstation: {
        macs: ['00:11:22:33:44:55', 'aa:bb:cc:dd:ee:ff'],
        host: '192.0.2.10',
        port: 22,
        broadcast: ['192.0.2.255'],
        relays: ['bastion-a', 'bastion-b'],
        waitTimeoutMs: 5_000,
        relayTimeoutMs: 3_000,
      },
    },
  });
  return path;
}

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

const SAMPLE_IFACES: LocalLanInterface[] = [
  {
    name: 'utun4',
    address: '198.51.100.5',
    netmask: '255.255.255.0',
    broadcast: '198.51.100.255',
    isVirtual: true,
  },
  {
    name: 'en0',
    address: '192.0.2.50',
    netmask: '255.255.255.0',
    broadcast: '192.0.2.255',
    isVirtual: false,
  },
];

describe('@iyowei/wake 核心唤醒契约', () => {
  test('预检目标已在线时直接短路返回 already-online 且零发包', async () => {
    const configPath = makeConfigFile();
    let relayCalled = false;
    let udpCalled = false;

    const report = await wakeTarget(
      { target: 'workstation', configPath },
      {
        network: {
          probeTcp: async () => ({ reachable: true, latencyMs: 3 }),
          sendUdpBurst: async () => {
            udpCalled = true;
            return {
              packetsSent: 1,
              destinations: [],
              sourceAddresses: [],
              warnings: [],
            };
          },
        },
        relay: {
          dispatchViaRelay: async () => {
            relayCalled = true;
            return { ok: true, packetsSent: 1 };
          },
        },
      },
    );

    expect(report.status).toBe('already-online');
    expect(report.dispatched).toBe(false);
    expect(report.packetsSent).toBe(0);
    expect(relayCalled).toBe(false);
    expect(udpCalled).toBe(false);
  });

  test('首个中继失败时故障转移到第二个中继并等待就绪上线', async () => {
    const configPath = makeConfigFile();
    let nowMs = 1000;
    let probeCalls = 0;
    const calledRelays: string[] = [];

    const report = await wakeTarget(
      { target: 'workstation', configPath, pollIntervalMs: 100 },
      {
        clock: {
          now: () => nowMs,
          sleep: async (ms) => {
            nowMs += ms;
          },
        },
        network: {
          probeTcp: async () => {
            probeCalls += 1;
            return {
              reachable: probeCalls >= 4,
              latencyMs: 2,
            };
          },
        },
        relay: {
          dispatchViaRelay: async ({ relay }) => {
            calledRelays.push(relay);
            if (relay === 'bastion-a') {
              return { ok: false, reason: 'SSH timeout' };
            }
            return {
              ok: true,
              packetsSent: 8,
              destinations: ['192.0.2.255', '192.0.2.10'],
            };
          },
        },
      },
    );

    expect(calledRelays).toEqual(['bastion-a', 'bastion-b']);
    expect(report.status).toBe('woken');
    expect(report.method).toBe('relay');
    expect(report.activeRelay).toBe('bastion-b');
    expect(report.packetsSent).toBe(8);
    expect(report.relayAttempts).toHaveLength(2);
    expect(report.relayAttempts[0]?.ok).toBe(false);
    expect(report.relayAttempts[1]?.ok).toBe(true);
  });

  test('全部中继失败时回退本机真实 LAN 网卡子网广播, 跳过虚拟隧道接口', async () => {
    const configPath = makeConfigFile();
    let capturedSource: readonly string[] = [];
    let capturedDests: readonly string[] = [];

    const report = await wakeTarget(
      { target: 'workstation', configPath, wait: false },
      {
        network: {
          probeTcp: async () => ({ reachable: false, latencyMs: 5 }),
          listInterfaces: () => SAMPLE_IFACES,
          sendUdpBurst: async (opts) => {
            capturedSource = opts.sourceAddresses;
            capturedDests = opts.destinations;
            return {
              packetsSent: 12,
              destinations: [...opts.destinations],
              sourceAddresses: [...opts.sourceAddresses],
              warnings: [],
            };
          },
        },
        relay: {
          dispatchViaRelay: async ({ relay }) => ({
            ok: false,
            reason: `${relay} unreachable`,
          }),
        },
      },
    );

    expect(report.status).toBe('dispatched');
    expect(report.method).toBe('local');
    expect(report.warnings.some((w) => w.code === 'RELAY_FALLBACK')).toBe(true);
    expect(capturedSource).toEqual(['192.0.2.50']);
    expect(capturedDests).toContain('192.0.2.255');
    expect(capturedDests).not.toContain('198.51.100.255');
  });

  test('禁用本地回退且所有中继失败时抛 RELAY_FAILED', async () => {
    const configPath = makeConfigFile();
    let caught: unknown;
    try {
      await wakeTarget(
        {
          target: 'workstation',
          configPath,
          noLocalFallback: true,
          wait: false,
        },
        {
          network: {
            probeTcp: async () => ({ reachable: false, latencyMs: 5 }),
          },
          relay: {
            dispatchViaRelay: async () => ({
              ok: false,
              reason: 'connection refused',
            }),
          },
        },
      );
    } catch (error) {
      caught = error;
    }
    expect(isWakeError(caught)).toBe(true);
    if (isWakeError(caught)) {
      expect(caught.code).toBe('RELAY_FAILED');
    }
  });

  test('支持无配置文件纯 --mac 直发并在等待超时后返回 timeout 与阶段补发', async () => {
    let nowMs = 0;
    let burstCount = 0;

    const report = await wakeTarget(
      {
        macs: ['00:11:22:33:44:55'],
        host: '192.0.2.10',
        wait: true,
        waitTimeoutMs: 2_500,
        pollIntervalMs: 500,
        reburstIntervalMs: 1_000,
        localOnly: true,
      },
      {
        clock: {
          now: () => nowMs,
          sleep: async (ms) => {
            nowMs += ms;
          },
        },
        network: {
          listInterfaces: () => SAMPLE_IFACES,
          probeTcp: async () => ({ reachable: false, latencyMs: 5 }),
          sendUdpBurst: async (opts) => {
            burstCount += 1;
            return {
              packetsSent: 4,
              destinations: [...opts.destinations],
              sourceAddresses: [...opts.sourceAddresses],
              warnings: [],
            };
          },
        },
      },
    );

    expect(report.status).toBe('timeout');
    expect(burstCount).toBeGreaterThanOrEqual(2);
    expect(report.packetsSent).toBe(burstCount * 4);
  });
});
