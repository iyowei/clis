/**
 * `@iyowei/wake` 配置文件解析、安全读写与 ARP 解析单元测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  lstatSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  removeWakeTarget,
  saveWakeConfig,
  upsertWakeTarget,
} from './config-write.ts';
import {
  loadWakeConfig,
  resolveDefaultWakeConfigPath,
  resolveTargetFromConfig,
  resolveWakeConfigPath,
  tryLoadWakeConfig,
} from './config.ts';
import { isWakeError } from './errors.ts';
import { parseArpTableOutput } from './network.ts';

const dirs: string[] = [];

function allocTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'wake-cfg-test-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  while (dirs.length > 0) {
    const dir = dirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('wake 配置路径与校验加载', () => {
  test('按平台与环境变量优先级解析配置路径', () => {
    expect(
      resolveDefaultWakeConfigPath({
        platform: 'darwin',
        homedir: '/Users/demo',
        env: {},
      }),
    ).toBe('/Users/demo/.config/wake/config.json');

    expect(
      resolveDefaultWakeConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\demo',
        env: { APPDATA: 'C:\\Users\\demo\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\demo\\AppData\\Roaming\\wake\\config.json');

    expect(
      resolveWakeConfigPath({
        configPath: '/custom/wake.json',
        env: { WAKE_CONFIG: '/env/wake.json' },
      }),
    ).toBe('/custom/wake.json');

    expect(
      resolveWakeConfigPath({
        env: { WAKE_CONFIG: '/env/wake.json' },
      }),
    ).toBe('/env/wake.json');
  });

  test('原子增删改查配置并维护 defaultTarget 与 0o600 权限', () => {
    const dir = allocTempDir();
    const cfgPath = join(dir, 'nested', 'config.json');

    expect(tryLoadWakeConfig(cfgPath)).toEqual({
      exists: false,
      path: cfgPath,
    });

    upsertWakeTarget(cfgPath, 'workstation', {
      macs: ['00-11-22-33-44-55', 'AA:BB:CC:DD:EE:FF'],
      host: '192.0.2.10',
      port: 22,
      relays: ['bastion-a'],
    });

    const loaded = loadWakeConfig(cfgPath);
    expect(loaded.config.defaultTarget).toBe('workstation');
    expect(loaded.config.targets.workstation?.macs).toEqual([
      '00:11:22:33:44:55',
      'aa:bb:cc:dd:ee:ff',
    ]);
    if (process.platform !== 'win32') {
      const mode = lstatSync(cfgPath).mode;
      expect(mode % 512).toBe(0o600);
    }

    const resolvedDefault = resolveTargetFromConfig(loaded.config);
    expect(resolvedDefault.name).toBe('workstation');

    upsertWakeTarget(
      cfgPath,
      'nas',
      { macs: ['02:00:00:00:00:01'], host: '192.0.2.20', port: 22 },
      { setDefault: true },
    );
    const updated = loadWakeConfig(cfgPath).config;
    expect(updated.defaultTarget).toBe('nas');
    expect(resolveTargetFromConfig(updated, 'workstation').name).toBe(
      'workstation',
    );

    const afterRemove = removeWakeTarget(cfgPath, 'nas');
    expect(afterRemove.defaultTarget).toBe('workstation');
    expect(Object.keys(afterRemove.targets)).toEqual(['workstation']);
  });

  test('拒绝损坏 JSON、符号链接目标与多目标无默认解析', () => {
    const dir = allocTempDir();
    const badPath = join(dir, 'bad.json');
    writeFileSync(badPath, '{not valid json', 'utf8');
    expect(() => loadWakeConfig(badPath)).toThrow();

    if (process.platform !== 'win32') {
      const realCfg = join(dir, 'real.json');
      const linkCfg = join(dir, 'link.json');
      saveWakeConfig(realCfg, {
        version: 1,
        targets: {
          a: { macs: ['00:11:22:33:44:55'] },
          b: { macs: ['00:11:22:33:44:66'] },
        },
      });
      symlinkSync(realCfg, linkCfg);
      try {
        loadWakeConfig(linkCfg);
        expect.unreachable();
      } catch (err) {
        expect(isWakeError(err)).toBe(true);
      }

      const two = loadWakeConfig(realCfg).config;
      expect(() => resolveTargetFromConfig(two)).toThrow();
    }
  });
});

describe('跨平台 ARP 邻接表解析', () => {
  test('同时兼容 Linux ip neigh、macOS arp -an 与 Windows arp -a 并过滤组播 MAC', () => {
    const sample = [
      '192.0.2.10 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE',
      '? (192.0.2.20) at aa-bb-cc-dd-ee-ff on en0 ifscope [ethernet]',
      '  192.0.2.30           02-00-5e-00-01-02     dynamic',
      '224.0.0.22 dev eth0 lladdr 01:00:5e:00:00:16 PERMANENT',
      '? (192.0.2.99) at (incomplete) on en0 ifscope [ethernet]',
    ].join('\n');

    expect(parseArpTableOutput(sample)).toEqual([
      {
        ip: '192.0.2.10',
        mac: '00:11:22:33:44:55',
        iface: 'eth0',
        state: 'REACHABLE',
      },
      {
        ip: '192.0.2.20',
        mac: 'aa:bb:cc:dd:ee:ff',
        iface: 'en0',
      },
      {
        ip: '192.0.2.30',
        mac: '02:00:5e:00:01:02',
        state: 'dynamic',
      },
    ]);
  });
});
