/**
 * `@iyowei/fan` 持久化状态读写与 LaunchDaemon 辅助单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { mkdtempSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { buildDaemonPythonScript } from './daemon-script.ts';
import {
  FAN_DAEMON_LABEL,
  buildLaunchDaemonPlist,
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
    });
  });

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
    expect(py).toContain('0xE0000270');
    expect(py).toContain('0xE0000280');
    expect(py).toContain('0xE0000300');
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
    });
  });
});
