/**
 * `@iyowei/fan` 持久化状态读写与 LaunchDaemon 辅助单元测试。
 */
import { describe, expect, test } from 'bun:test';

import {
  chmodSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDaemonPythonScript } from './daemon-script.ts';
import {
  FAN_DAEMON_LABEL,
  buildLaunchDaemonPlist,
  ensurePersistDaemon,
  getPersistDaemonStatus,
  installPersistDaemon,
  uninstallPersistDaemon,
} from './daemon.ts';
import { isFanError } from './errors.ts';
import {
  createMacOsFanStateStore,
  mergePersistedState,
  readPersistedState,
} from './state.ts';

function withTempDir(fn: (dir: string) => void): void {
  const dir = mkdtempSync(join(tmpdir(), 'fan-state-test-'));
  try {
    fn(dir);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}

describe('@iyowei/fan 持久化状态与守护构建', () => {
  test('readPersistedState 与 mergePersistedState 覆盖读写与合并', () => {
    withTempDir((dir) => {
      const statePath = join(dir, 'state.json');
      expect(readPersistedState(statePath)).toBeNull();

      const first = mergePersistedState(
        null,
        {
          '0': { mode: 'manual', kind: 'percent', value: 30 },
          '1': { mode: 'manual', kind: 'percent', value: 30 },
        },
        '2026-11-25T00:00:00.000Z',
      );
      const store = createMacOsFanStateStore({ statePath });
      store.write(first);

      const loaded = readPersistedState(statePath);
      expect(loaded).toEqual(first);

      const merged = mergePersistedState(
        loaded,
        { '0': { mode: 'auto' } },
        '2026-11-25T00:01:00.000Z',
      );
      expect(merged.fans).toEqual({
        '0': { mode: 'auto' },
        '1': { mode: 'manual', kind: 'percent', value: 30 },
      });
    });
  });

  test('readPersistedState 拒绝符号链接与损坏 JSON', () => {
    withTempDir((dir) => {
      const real = join(dir, 'real.json');
      const link = join(dir, 'link.json');
      writeFileSync(real, '{"version":1,"updatedAt":"","fans":{}}', 'utf8');
      symlinkSync(real, link);

      try {
        readPersistedState(link);
        throw new Error('Expected STATE_CORRUPT for symlink');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('STATE_CORRUPT');
      }

      const bad = join(dir, 'bad.json');
      writeFileSync(bad, '{broken-json', 'utf8');
      try {
        readPersistedState(bad);
        throw new Error('Expected STATE_CORRUPT for bad JSON');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('STATE_CORRUPT');
      }

      const badVer = join(dir, 'bad-ver.json');
      writeFileSync(badVer, '{"version":99,"fans":{}}', 'utf8');
      try {
        readPersistedState(badVer);
        throw new Error('Expected STATE_CORRUPT for bad version');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('STATE_CORRUPT');
      }

      const badRange = join(dir, 'bad-range.json');
      writeFileSync(
        badRange,
        JSON.stringify({
          version: 1,
          updatedAt: '',
          fans: { '0': { mode: 'manual', kind: 'percent', value: 150 } },
        }),
        'utf8',
      );
      try {
        readPersistedState(badRange);
        throw new Error('Expected STATE_CORRUPT for out-of-range percent');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('STATE_CORRUPT');
      }

      const badZeroRpm = join(dir, 'bad-rpm.json');
      writeFileSync(
        badZeroRpm,
        JSON.stringify({
          version: 1,
          updatedAt: '',
          fans: { '0': { mode: 'manual', kind: 'rpm', value: 0 } },
        }),
        'utf8',
      );
      try {
        readPersistedState(badZeroRpm);
        throw new Error('Expected STATE_CORRUPT for zero rpm');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('STATE_CORRUPT');
      }
    });
  });

  test('createMacOsFanStateStore 支持可写嵌套新目录免 sudo 直写与空 FAN_STATE_PATH 回退', () => {
    withTempDir((dir) => {
      const nestedState = join(dir, 'nested', 'sub', 'state.json');
      const store = createMacOsFanStateStore({
        statePath: nestedState,
        platform: 'darwin',
        geteuid: () => 501,
        sudoBin: join(dir, 'missing-sudo-must-not-run'),
      });
      const sample = mergePersistedState(
        null,
        { '0': { mode: 'manual', kind: 'percent', value: 40 } },
        '2026-11-26T00:00:00.000Z',
      );
      store.write(sample);
      expect(readPersistedState(nestedState)).toEqual(sample);

      const defaultPathStore = createMacOsFanStateStore({
        env: { FAN_STATE_PATH: '   ' },
      });
      expect(defaultPathStore.path).toContain('iyowei-fan');
    });
  });
});

describe('@iyowei/fan LaunchDaemon 与守护生命周期', () => {
  test('buildLaunchDaemonPlist 与 buildDaemonPythonScript 生成合法内容', () => {
    const plist = buildLaunchDaemonPlist({
      label: FAN_DAEMON_LABEL,
      python3Bin: '/usr/bin/python3',
      daemonScriptPath: '/Library/Application Support/iyowei-fan/fan-daemon.py',
      logPath: '/var/log/iyowei-fan.log',
    });
    expect(plist).toContain(`<string>${FAN_DAEMON_LABEL}</string>`);
    expect(plist).toContain('<key>RunAtLoad</key>');
    expect(plist).toContain('<key>KeepAlive</key>');
    expect(plist).toContain('<true/>');

    const py = buildDaemonPythonScript(
      '/Library/Application Support/iyowei-fan/state.json',
    );
    expect(py).toContain('IORegisterForSystemPower');
    expect(py).toContain('IOAllowPowerChange');
    expect(py).toContain('IOServiceAddInterestNotification');
    expect(py).toContain('AppleClamshellState');
    expect(py).toContain('AppleClamshellCausesSleep');
    expect(py).toContain('IOPMUserTriggeredFullWake');
    expect(py).toContain('release_manual_fans_to_auto');
    expect(py).toContain('0xE0000270');
    expect(py).toContain('0xE0000280');
    expect(py).toContain('0xE0000300');
  });

  test('ensurePersistDaemon 在已运行且脚本/plist 一致时免 sudo 短路返回 unchanged', () => {
    if (process.platform === 'win32') return;
    withTempDir((dir) => {
      const plistPath = join(dir, 'com.iyowei.fan.plist');
      const daemonScriptPath = join(dir, 'fan-daemon.py');
      const statePath = join(dir, 'state.json');
      const logPath = join(dir, 'iyowei-fan.log');
      const fakePython = join(dir, 'fake-python3');
      const fakeLaunchctl = join(dir, 'fake-launchctl');

      writeFileSync(fakePython, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(fakePython, 0o755);
      writeFileSync(fakeLaunchctl, '#!/bin/sh\nexit 0\n', 'utf8');
      chmodSync(fakeLaunchctl, 0o755);

      writeFileSync(
        daemonScriptPath,
        buildDaemonPythonScript(statePath),
        'utf8',
      );
      writeFileSync(
        plistPath,
        buildLaunchDaemonPlist({
          label: FAN_DAEMON_LABEL,
          python3Bin: fakePython,
          daemonScriptPath,
          logPath,
        }),
        'utf8',
      );

      const sync = ensurePersistDaemon({
        platform: 'darwin',
        plistPath,
        daemonScriptPath,
        statePath,
        logPath,
        python3Bin: fakePython,
        launchctlBin: fakeLaunchctl,
        sudoBin: join(dir, 'missing-sudo-must-not-be-called'),
      });
      expect(sync.action).toBe('unchanged');
      expect(sync.status.installed).toBe(true);
      expect(sync.status.running).toBe(true);
    });
  });

  test('getPersistDaemonStatus 与非 darwin 平台守卫', () => {
    withTempDir((dir) => {
      const plistPath = join(dir, 'com.iyowei.fan.plist');
      const daemonScriptPath = join(dir, 'fan-daemon.py');
      const statePath = join(dir, 'state.json');

      const missing = getPersistDaemonStatus({
        plistPath,
        daemonScriptPath,
        statePath,
        launchctlBin: join(dir, 'no-launchctl'),
      });
      expect(missing.installed).toBe(false);
      expect(missing.running).toBe(false);
      expect(missing.state).toBeNull();

      writeFileSync(plistPath, '<plist/>', 'utf8');
      writeFileSync(daemonScriptPath, '#!/usr/bin/python3\n', 'utf8');
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-25T00:00:00.000Z',
          fans: { '0': { mode: 'manual', kind: 'percent', value: 30 } },
        }),
        'utf8',
      );
      const present = getPersistDaemonStatus({
        plistPath,
        daemonScriptPath,
        statePath,
        launchctlBin: join(dir, 'no-launchctl'),
      });
      expect(present.installed).toBe(true);
      expect(present.running).toBe(false);
      expect(present.state?.fans['0']).toEqual({
        mode: 'manual',
        kind: 'percent',
        value: 30,
      });

      try {
        installPersistDaemon({
          platform: 'linux',
          plistPath,
          daemonScriptPath,
        });
        throw new Error('Expected UNSUPPORTED_PLATFORM');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('UNSUPPORTED_PLATFORM');
      }

      try {
        uninstallPersistDaemon({
          platform: 'linux',
          plistPath,
          daemonScriptPath,
        });
        throw new Error('Expected UNSUPPORTED_PLATFORM');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('UNSUPPORTED_PLATFORM');
      }

      // 损坏的 state.json 在 getPersistDaemonStatus 中必须暴露 stateError 而非静默掩盖
      writeFileSync(statePath, '{broken', 'utf8');
      const corruptStatus = getPersistDaemonStatus({
        plistPath,
        daemonScriptPath,
        statePath,
        launchctlBin: join(dir, 'no-launchctl'),
      });
      expect(corruptStatus.state).toBeNull();
      expect(corruptStatus.stateError).toContain('损坏');

      // uninstallPersistDaemon 在 darwin 下缺少 python3Bin 时抛 SMC_UNAVAILABLE
      try {
        uninstallPersistDaemon({
          platform: 'darwin',
          python3Bin: join(dir, 'missing-python3'),
          plistPath,
          daemonScriptPath,
        });
        throw new Error('Expected SMC_UNAVAILABLE');
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('SMC_UNAVAILABLE');
      }
    });
  });
});
