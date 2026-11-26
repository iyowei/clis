/**
 * `@iyowei/wake` 只读诊断 (`diagnoseWake`) 单元测试: 保证严格只读、绝不发魔术包。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { saveWakeConfig } from './config-write.ts';
import { diagnoseWake } from './doctor.ts';

const dirs: string[] = [];

afterEach(() => {
  while (dirs.length > 0) {
    rmSync(dirs.pop()!, { recursive: true, force: true });
  }
});

describe('@iyowei/wake diagnoseWake', () => {
  test('配置缺失时仍输出本机接口与不存在标记而不发送任何网络包', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-doctor-empty-'));
    dirs.push(dir);
    const missingCfg = join(dir, 'config.json');

    const report = await diagnoseWake(
      { configPath: missingCfg },
      {
        network: {
          listInterfaces: () => [
            {
              name: 'en0',
              address: '192.0.2.50',
              netmask: '255.255.255.0',
              broadcast: '192.0.2.255',
              isVirtual: false,
            },
          ],
          sendUdpBurst: async () => {
            throw new Error('doctor 不得触发 UDP 发包');
          },
        },
      },
    );

    expect(report.configExists).toBe(false);
    expect(report.interfaces).toHaveLength(1);
    expect(report.relays).toEqual([]);
  });

  test('探测已配置目标在线态与全部关联 SSH 中继状态', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'wake-doctor-ok-'));
    dirs.push(dir);
    const cfgPath = join(dir, 'config.json');
    saveWakeConfig(cfgPath, {
      version: 1,
      defaultTarget: 'nas',
      targets: {
        nas: {
          macs: ['00:11:22:33:44:55'],
          host: '192.0.2.20',
          port: 2222,
          relays: ['bastion-a', 'bastion-b'],
        },
      },
    });

    const report = await diagnoseWake(
      { configPath: cfgPath, target: 'nas' },
      {
        network: {
          listInterfaces: () => [],
          probeTcp: async () => ({ reachable: false, latencyMs: 12 }),
        },
        relay: {
          probeRelay: async ({ relay }) =>
            relay === 'bastion-a'
              ? {
                  relay,
                  reachable: true,
                  remoteWakeAvailable: true,
                  remoteWakeVersion: '1.0.0',
                }
              : {
                  relay,
                  reachable: false,
                  remoteWakeAvailable: false,
                  reason: 'SSH 响应超时',
                },
        },
      },
    );

    expect(report.configExists).toBe(true);
    expect(report.targetName).toBe('nas');
    expect(report.targetFound).toBe(true);
    expect(report.port).toBe(2222);
    expect(report.targetReachable).toBe(false);
    expect(report.relays).toEqual([
      {
        relay: 'bastion-a',
        reachable: true,
        remoteWakeAvailable: true,
        remoteWakeVersion: '1.0.0',
      },
      {
        relay: 'bastion-b',
        reachable: false,
        remoteWakeAvailable: false,
        reason: 'SSH 响应超时',
      },
    ]);
  });
});
