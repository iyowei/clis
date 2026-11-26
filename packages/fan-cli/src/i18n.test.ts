/**
 * `@iyowei/fan-cli` 英文排版栅格与按工具独立语言持久化测试:
 * 核验英文仪表 69 列精确对齐、Starting/Ramping/Manual/Auto Thermal 零抖动、
 * 中文系统下 `fan lang en` 强制英文展示及 `--lang` 临时覆盖。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  FanError,
  type FanInfo,
  type FanStateStore,
  type FanStatusReport,
  type FanTransport,
} from '@iyowei/fan';

import { localizeFanError } from './cli-helpers.ts';
import { runCli } from './cli.ts';
import { helpText } from './help.ts';
import { BAR_BLOCK, displayWidth, renderReport } from './render.ts';

const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
const stripAnsi = (s: string): string => s.replace(ANSI_CSI_RE, '');

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempHome(): string {
  const dir = join(
    tmpdir(),
    `fan-i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

function makeStub(): { transport: FanTransport; stateStore: FanStateStore } {
  const fans: FanInfo[] = [
    {
      index: 0,
      actualRpm: 2820,
      targetRpm: 2820,
      minRpm: 1350,
      maxRpm: 6250,
      mode: 'manual',
      percent: 30,
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
  let saved: FanStatusReport['persisted'] = null;
  return {
    transport: {
      readFans: () => fans.map((f) => ({ ...f })),
      applyWrites(reqs) {
        for (const r of reqs) {
          const f = fans[r.fanIndex]!;
          if (r.kind === 'auto') {
            f.mode = 'auto';
            f.actualRpm = 0;
            f.targetRpm = 0;
            f.percent = 0;
          } else {
            f.mode = 'manual';
            f.targetRpm = r.targetRpm;
            f.actualRpm = r.targetRpm;
            f.percent = 50;
          }
        }
        return fans.map((f) => ({ ...f }));
      },
      isMacsFanControlRunning: () => false,
    },
    stateStore: {
      path: '/stub/state.json',
      read: () => saved ?? null,
      write(next) {
        saved = next;
      },
    },
  };
}

describe('fan-cli 英文 Apple 级等宽栅格与双语切换', () => {
  test('英文仪表在起转、提速、手动稳态、自动与降速态下全部严格对齐 69 列且着色去色等价', () => {
    const report: FanStatusReport = {
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
          actualRpm: 2000,
          targetRpm: 2970,
          minRpm: 1350,
          maxRpm: 6750,
          mode: 'manual',
          percent: 12,
        },
      ],
      macsFanControlRunning: true,
      warnings: [
        {
          code: 'MACS_FAN_CONTROL_RUNNING',
          message:
            '检测到 Macs Fan Control 正在后台运行, 它可能会在数秒内覆写手动设置的 SMC 转速',
        },
      ],
      didPersist: true,
      persisted: {
        version: 1,
        updatedAt: '2026-11-26T00:00:00.000Z',
        fans: { '0': { mode: 'manual', kind: 'percent', value: 30 } },
      },
    };

    const plain = renderReport(report, {
      color: false,
      json: false,
      title: 'Manual Speed Set',
      locale: 'en',
    });
    const colored = renderReport(report, {
      color: true,
      json: false,
      title: 'Manual Speed Set',
      locale: 'en',
    });

    expect(stripAnsi(colored)).toBe(plain);
    expect(plain).toContain('Starting');
    expect(plain).toContain('Target  2820 RPM');
    expect(plain).toContain('Ramping 2970 RPM');
    expect(plain).toContain(
      'Saved preset (30%) · Stops on lid close, restores on wake',
    );
    expect(plain).toContain(
      'Macs Fan Control is running in the background and may override manual SMC speeds',
    );

    const gridLines = plain
      .split('\n')
      .filter((l) => l.includes(`${BAR_BLOCK} FAN`) || l.startsWith('  Fan '));
    expect(gridLines.length).toBe(3);
    for (const line of gridLines) {
      expect(displayWidth(line)).toBe(69);
    }

    const helpEn = helpText(false, 'en');
    expect(helpEn).toContain('macOS AppleSMC Fan Controller');
    expect(helpEn).toContain('lang [lang]');
    expect(helpEn).toContain('--lang <lang>');
    for (const line of helpEn.split('\n')) {
      expect(displayWidth(line)).toBeLessThanOrEqual(88);
    }
  });

  test('系统语言为中文时, fan lang en 持久化切换为英文并支持 --lang 单次覆盖', async () => {
    const home = makeTempHome();
    const { transport, stateStore } = makeStub();
    const env = { CLIS_TEST_OS_LOCALE: 'zh-Hans-SG' };

    // 1. 默认 system -> 展示中文
    const out1: string[] = [];
    expect(
      await runCli(['status'], {
        transport,
        stateStore,
        homedir: home,
        env,
        stdoutColor: false,
        out: (l) => out1.push(l),
      }),
    ).toBe(0);
    expect(out1.join('\n')).toContain('风扇状态');

    // 2. fan lang en -> 切换为英文并回执
    const out2: string[] = [];
    expect(
      await runCli(['lang', 'en'], {
        transport,
        stateStore,
        homedir: home,
        env,
        stdoutColor: false,
        out: (l) => out2.push(l),
      }),
    ).toBe(0);
    expect(out2.join('\n')).toContain('Language Updated');
    expect(out2.join('\n')).toContain('Overrides Chinese system language');

    // 3. 即使系统语言是中文, 后续 fan status 默认展示英文
    const out3: string[] = [];
    expect(
      await runCli(['status'], {
        transport,
        stateStore,
        homedir: home,
        env,
        stdoutColor: false,
        out: (l) => out3.push(l),
      }),
    ).toBe(0);
    expect(out3.join('\n')).toContain('Fan Status');
    expect(out3.join('\n')).toContain('Auto Thermal');

    // 4. 单次 --lang zh 临时覆盖为中文
    const out4: string[] = [];
    expect(
      await runCli(['status', '--lang', 'zh'], {
        transport,
        stateStore,
        homedir: home,
        env,
        stdoutColor: false,
        out: (l) => out4.push(l),
      }),
    ).toBe(0);
    expect(out4.join('\n')).toContain('风扇状态');
  });

  test('英文 STATE_CORRUPT 警告渲染与 localizeFanError 映射一致', () => {
    const report: FanStatusReport = {
      fans: [
        {
          index: 0,
          actualRpm: 0,
          targetRpm: 0,
          minRpm: 1350,
          maxRpm: 6250,
          mode: 'auto',
          percent: 0,
        },
      ],
      macsFanControlRunning: false,
      warnings: [{ code: 'STATE_CORRUPT', message: 'bad json' }],
      persisted: null,
    };
    const rendered = renderReport(report, {
      color: false,
      json: false,
      locale: 'en',
    });
    expect(rendered).toContain(
      'Persisted state file is corrupted or unreadable',
    );
    expect(rendered).toContain('bad json');
    expect(
      localizeFanError(new FanError('STATE_CORRUPT', 'bad json'), 'en'),
    ).toBe('Corrupted fan state file: bad json');
    expect(
      localizeFanError(
        new FanError('UNSUPPORTED_PLATFORM', 'unsupported'),
        'en',
        'linux',
      ),
    ).toContain('current: linux');
  });
});
