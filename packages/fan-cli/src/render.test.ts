/**
 * `render.ts` 单元测试: 着色与降级纯文本一致性、64 列等宽仪表对齐、auto 隐藏残留目标值、持久化与守护提示及 JSON 输出。
 */
import { describe, expect, test } from 'bun:test';

import type { FanStatusReport, PersistDaemonStatus } from '@iyowei/fan';

import {
  BAR_BLOCK,
  displayWidth,
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
    {
      index: 1,
      actualRpm: 5992,
      targetRpm: 6000,
      minRpm: 1350,
      maxRpm: 6750,
      mode: 'auto',
      percent: 86,
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
  test('color=false 零 ANSI、与 stripAnsi(color=true) 逐字等价且仪表列宽对齐 66 列', () => {
    const plain = renderReport(SAMPLE_REPORT, {
      color: false,
      json: false,
      title: '风扇状态',
    });
    const colored = renderReport(SAMPLE_REPORT, {
      color: true,
      json: false,
      title: '风扇状态',
    });

    expect(plain).not.toContain('\u001B');
    expect(plain).toContain(`${BAR_BLOCK} FAN`);
    expect(plain).toContain('手动 6250 RPM');
    expect(plain).toContain('◼◼◼◼◼◼◼◼◼◼◼◼');
    // auto 模式下显示「自动温控」, 不再打印残留的旧 targetRpm=6000 误导用户
    expect(plain).toContain('自动温控');
    expect(plain).not.toContain('手动 6000 RPM');
    expect(plain).toContain('Macs Fan Control running');
    expect(stripAnsi(colored)).toBe(plain);

    // 刚从 0 RPM 设定手动目标尚未破零起转时显示「起转中」与「目标 XXXX RPM」, 爬升途中显示「提速 XXXX RPM」
    const starting = renderReport(
      {
        fans: [
          {
            index: 0,
            actualRpm: 0,
            targetRpm: 2820,
            minRpm: 1350,
            maxRpm: 6250,
            mode: 'manual',
            percent: 0,
          },
          {
            index: 1,
            actualRpm: 1600,
            targetRpm: 2970,
            minRpm: 1350,
            maxRpm: 6750,
            mode: 'manual',
            percent: 4.6,
          },
        ],
        macsFanControlRunning: false,
        warnings: [],
      },
      { color: false, json: false, title: '已设定手动转速' },
    );
    expect(starting).toContain('起转中');
    expect(starting).toContain('目标 2820 RPM');
    expect(starting).toContain('▪▪▪▪▪▪▪▪▪▪▪▪');
    expect(starting).toContain('提速 2970 RPM');
    for (const line of starting
      .split('\n')
      .filter((l) => l.startsWith('  Fan '))) {
      expect(displayWidth(line)).toBe(66);
    }

    // 标题行与每条 Fan 行的总显示宽度均严格等于 66 列 (2 缩进 + 64 面板宽), 零横线且绝不断行
    const bodyLines = plain
      .split('\n')
      .filter((l) => l.includes(`${BAR_BLOCK} FAN`) || l.startsWith('  Fan '));
    expect(bodyLines.length).toBe(3);
    for (const line of bodyLines) {
      expect(displayWidth(line)).toBe(66);
    }
  });

  test('展示 didPersist 手动/自动回执、守护同步与 --once 临时生效提示', () => {
    const saved = renderReport(
      {
        ...SAMPLE_REPORT,
        didPersist: true,
        daemonAction: 'updated',
        persisted: {
          version: 1,
          updatedAt: '2026-11-25T00:00:00.000Z',
          fans: { '0': { mode: 'manual', kind: 'percent', value: 30 } },
        },
      },
      { color: false, json: false },
    );
    expect(saved).toContain('已记住预设 (30%) · 合盖停转 / 唤醒恢复');
    expect(saved).toContain('已同步更新后台守护 (com.iyowei.fan)');
    for (const line of saved.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(72);
    }

    const savedMixed = renderReport(
      {
        ...SAMPLE_REPORT,
        didPersist: true,
        persisted: {
          version: 1,
          updatedAt: '2026-11-25T00:00:00.000Z',
          fans: {
            '0': { mode: 'manual', kind: 'percent', value: 60 },
            '1': { mode: 'auto' },
          },
        },
      },
      { color: false, json: false },
    );
    expect(savedMixed).toContain('已记住预设 (Fan 0: 60% · Fan 1: 自动)');

    const savedAuto = renderReport(
      {
        ...SAMPLE_REPORT,
        didPersist: true,
        persisted: {
          version: 1,
          updatedAt: '2026-11-25T00:00:00.000Z',
          fans: { '0': { mode: 'auto' }, '1': { mode: 'auto' } },
        },
      },
      { color: false, json: false },
    );
    expect(savedAuto).toContain('已保存为系统自动温控');
    expect(savedAuto).not.toContain('F0 auto');

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
    expect(plain).toContain('已安装 · 运行中');
    expect(plain).toContain('30%');
    expect(
      JSON.parse(renderPersistStatus(status, { color: false, json: true })),
    ).toEqual(status);

    const corruptStatus: PersistDaemonStatus = {
      ...status,
      state: null,
      stateError:
        '持久化状态文件损坏: /Library/Application Support/iyowei-fan/state.json',
    };
    const corruptZh = renderPersistStatus(corruptStatus, {
      color: false,
      json: false,
      locale: 'zh',
    });
    const corruptEn = renderPersistStatus(corruptStatus, {
      color: false,
      json: false,
      locale: 'en',
    });
    expect(corruptZh).toContain('状态文件损坏/不可读');
    expect(corruptZh).toContain('状态文件异常');
    expect(corruptEn).toContain('Corrupted / unreadable');
    expect(corruptEn).toContain('State file error');
  });

  test('STATE_CORRUPT 告警支持中英文渲染', () => {
    const withCorrupt = {
      ...SAMPLE_REPORT,
      warnings: [
        {
          code: 'STATE_CORRUPT' as const,
          message: '持久化状态文件损坏 (非合法 JSON)',
        },
      ],
    };
    expect(
      renderReport(withCorrupt, { color: false, json: false, locale: 'zh' }),
    ).toContain('持久化状态文件损坏');
    expect(
      renderReport(withCorrupt, { color: false, json: false, locale: 'en' }),
    ).toContain('Persisted state file is corrupted or unreadable');
  });

  test('json 模式输出合法 JSON, watch 行格式正确且着色降级一致', () => {
    const jsonOut = renderReport(SAMPLE_REPORT, { color: false, json: true });
    expect(JSON.parse(jsonOut)).toEqual(SAMPLE_REPORT);
    const wPlain = renderWatchLine(SAMPLE_REPORT, '13:45:00', false);
    const wColor = renderWatchLine(SAMPLE_REPORT, '13:45:00', true);
    expect(stripAnsi(wColor)).toBe(wPlain);
    expect(wPlain).toContain('13:45:00');
    expect(wPlain).toContain('F0 6250 RPM');
    expect(wPlain).toContain('手动 6250');
    expect(wPlain).toContain('(自动)');
  });
});
