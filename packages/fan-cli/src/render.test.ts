/**
 * `render.ts` 单元测试: 着色与降级纯文本一致性、持久化提示、守护状态与 JSON 输出。
 */
import { describe, expect, test } from 'bun:test';

import type { FanStatusReport, PersistDaemonStatus } from '@iyowei/fan';

import {
  BAR_BLOCK,
  renderPersistStatus,
  renderReport,
  renderWatchLine,
} from './render.ts';

const SAMPLE_REPORT: FanStatusReport = {
  fans: [
    {
      index: 0,
      actualRpm: 6250,
      targetRpm: 6250,
      minRpm: 1350,
      maxRpm: 6250,
      mode: 'manual',
      percent: 100,
    },
  ],
  macsFanControlRunning: true,
  warnings: [
    {
      code: 'MACS_FAN_CONTROL_RUNNING',
      message: 'Macs Fan Control running',
    },
  ],
};

const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, '');
}

describe('renderReport & renderPersistStatus & renderWatchLine', () => {
  test('color=false 零 ANSI 且与 stripAnsi(color=true) 逐字等价', () => {
    const plain = renderReport(SAMPLE_REPORT, {
      color: false,
      json: false,
      title: '已开启全速模式',
    });
    const colored = renderReport(SAMPLE_REPORT, {
      color: true,
      json: false,
      title: '已开启全速模式',
    });

    expect(plain).not.toContain('\u001B');
    expect(plain).toContain(`${BAR_BLOCK} FAN`);
    expect(plain).toContain('6250 RPM');
    expect(plain).toContain('Macs Fan Control running');
    expect(stripAnsi(colored)).toBe(plain);
  });

  test('展示 didPersist 自动记住与 --once 临时生效提示', () => {
    const saved = renderReport(
      {
        ...SAMPLE_REPORT,
        didPersist: true,
        persisted: {
          version: 1,
          updatedAt: '2026-11-25T00:00:00.000Z',
          fans: { '0': { mode: 'manual', kind: 'percent', value: 30 } },
        },
      },
      { color: false, json: false },
    );
    expect(saved).toContain('已记住配置 (Fan 0=30%)');

    const once = renderReport(
      { ...SAMPLE_REPORT, didPersist: false },
      { color: false, json: false },
    );
    expect(once).toContain('仅本次生效 (--once)');
  });

  test('renderPersistStatus 支持纯文本、着色等价与 JSON', () => {
    const status: PersistDaemonStatus = {
      installed: true,
      running: true,
      label: 'com.iyowei.fan',
      plistPath: '/Library/LaunchDaemons/com.iyowei.fan.plist',
      daemonScriptPath: '/Library/Application Support/iyowei-fan/fan-daemon.py',
      statePath: '/Library/Application Support/iyowei-fan/state.json',
      logPath: '/var/log/iyowei-fan.log',
      state: {
        version: 1,
        updatedAt: '2026-11-25T00:00:00.000Z',
        fans: { '0': { mode: 'manual', kind: 'percent', value: 30 } },
      },
    };
    const plain = renderPersistStatus(status, { color: false, json: false });
    const colored = renderPersistStatus(status, { color: true, json: false });
    expect(stripAnsi(colored)).toBe(plain);
    expect(plain).toContain('已安装 / 运行中');
    expect(plain).toContain('Fan 0=30%');
    expect(
      JSON.parse(renderPersistStatus(status, { color: false, json: true })),
    ).toEqual(status);
  });

  test('json 模式输出合法 JSON, watch 行格式正确', () => {
    const jsonOut = renderReport(SAMPLE_REPORT, { color: false, json: true });
    expect(JSON.parse(jsonOut)).toEqual(SAMPLE_REPORT);
    expect(renderWatchLine(SAMPLE_REPORT, '13:45:00', false)).toBe(
      '[13:45:00] F0: 6250/6250 RPM (manual)',
    );
  });
});
