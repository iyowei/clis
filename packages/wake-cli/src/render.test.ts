/**
 * `@iyowei/wake-cli` 双语渲染与错误本地化单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { WakeError } from '@iyowei/wake';

import {
  localizeWakeError,
  renderDoctorReport,
  renderListReport,
  renderProgressLine,
  renderWakeReport,
} from './render.ts';

describe('wake-cli 双语视图渲染', () => {
  test('渲染 WakeReport (JSON、中英文人类可读视图及控制字符净化)', () => {
    const report = {
      target: 'work\u001B[31mstation\n',
      status: 'woken' as const,
      method: 'relay' as const,
      activeRelay: 'bastion-a',
      macs: ['00:11:22:33:44:55'],
      host: '192.0.2.10',
      port: 22,
      packetsSent: 8,
      destinations: ['192.0.2.255'],
      relayAttempts: [
        { relay: 'bastion-0', ok: false, reason: 'SSH timeout' },
        { relay: 'bastion-a', ok: true, packetsSent: 8 },
      ],
      warnings: [],
      elapsedMs: 4200,
      dispatched: true,
    };

    const zh = renderWakeReport(report, {
      color: false,
      json: false,
      locale: 'zh',
    });
    expect(zh).toContain('▍ WAKE');
    expect(zh).toContain('workstation');
    expect(zh).not.toContain('\u001B[');
    expect(zh).toContain('bastion-a');
    expect(zh).toContain('4.2s');

    const en = renderWakeReport(report, {
      color: false,
      json: false,
      locale: 'en',
    });
    expect(en).toContain('Woken and reachable');

    const jsonOut = renderWakeReport(report, {
      color: false,
      json: true,
      locale: 'en',
    });
    expect((JSON.parse(jsonOut) as { status: string }).status).toBe('woken');
  });

  test('渲染清单、诊断与等待进度流光文本', () => {
    const listOut = renderListReport(
      '/tmp/config.json',
      {
        version: 1,
        defaultTarget: 'nas',
        targets: {
          nas: {
            macs: ['00:11:22:33:44:55'],
            host: '192.0.2.20',
            port: 22,
            relays: ['bastion-a'],
          },
        },
      },
      { color: false, json: false, locale: 'en' },
    );
    expect(listOut).toContain('nas');
    expect(listOut).toContain('bastion-a');

    const docOut = renderDoctorReport(
      {
        configPath: '/tmp/config.json',
        configExists: true,
        targetName: 'nas',
        targetFound: true,
        targetReachable: false,
        interfaces: [
          {
            name: 'en0',
            address: '192.0.2.50',
            netmask: '255.255.255.0',
            broadcast: '192.0.2.255',
            isVirtual: false,
          },
        ],
        relays: [
          {
            relay: 'bastion-a',
            reachable: true,
            remoteWakeAvailable: true,
            remoteWakeVersion: '1.0.0',
          },
        ],
      },
      { color: false, json: false, locale: 'zh' },
    );
    expect(docOut).toContain('192.0.2.255');
    expect(docOut).toContain('bastion-a');

    const progress = renderProgressLine(
      {
        phase: 'waiting',
        host: '192.0.2.10',
        port: 22,
        elapsedMs: 1500,
        timeoutMs: 90_000,
        attempt: 2,
      },
      2,
      false,
      'en',
    );
    expect(progress).toContain('Waiting for 192.0.2.10:22');
  });

  test('双语错误映射覆盖 WakeError', () => {
    const err = new WakeError('CONFIG_ABSENT', 'missing');
    expect(localizeWakeError(err, 'en')).toContain('not found');
  });
});
