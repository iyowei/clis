/**
 * @iyowei/codd Podman rootless 兼容性、内核调优保护、macOS LaunchAgent、
 * nextSteps 闭环指引与安全 5 位端口推荐回归测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, readFileSync, readdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatUploadNextStep } from './emit-podman-helpers.ts';
import {
  digitalRoot,
  generateBundle,
  recommendSafePort,
  validateManifest,
} from './index.ts';

const SOURCE_TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../template',
);

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codd-podman-compat-'));
  tempDirs.push(dir);
  return dir;
};

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

describe('Podman rootless 兼容与内核调优保护', () => {
  test('podman-compose.yml 保留 nofile 并移除 nproc 硬编码以防 rootless crun 拒启', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'rootless',
        hardware: { cpuCores: 2, memoryGb: 2, diskGb: 32 },
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            os: 'macos',
            sshTarget: 'woz',
            backupDir: '/Users/alice/srv/backups',
          },
        ],
      },
    });
    const bDir = res.bundleDirs[0]!;
    const compose = readFileSync(join(bDir, 'podman-compose.yml'), 'utf8');
    expect(compose).toContain('nofile:');
    expect(compose).toContain('soft: 65536');
    expect(compose).toContain('hard: 65536');
    expect(compose).not.toMatch(/^\s*nproc:/m);

    const tuneSh = readFileSync(join(bDir, 'tune-linux-host.sh'), 'utf8');
    expect(tuneSh).toContain('cur_maps');
    expect(tuneSh).toContain('[ "$cur_maps" -gt 262144 ]');
    expect(tuneSh).toContain('保留系统原值不降配');
    expect(tuneSh).toContain('echo "vm.max_map_count = 262144"');
    if (process.platform !== 'win32') {
      expect(
        spawnSync('sh', ['-n', join(bDir, 'tune-linux-host.sh')]).status,
      ).toBe(0);
    }
  });
});

describe('macOS LaunchAgent 去重、日志目录与 nextSteps 完整闭环', () => {
  test('默认 podmanBin 不重复拼接 /opt/homebrew/bin, 自定义 podmanBin 正确前置, Makefile 自动建日志目录', () => {
    const dir = makeTempDir();
    const resDefault = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'macdef',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'macos', backupDir: '/Users/alice/srv/backups' }],
      },
    });
    const bDef = resDefault.bundleDirs[0]!;
    const plistDefName = readdirSync(bDef).find((f) => f.endsWith('.plist'))!;
    const plistDefPath = join(bDef, plistDefName);
    const plistDef = readFileSync(plistDefPath, 'utf8');
    expect(plistDef).toContain(
      '<string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
    expect(plistDef).not.toContain('/opt/homebrew/bin:/opt/homebrew/bin');

    const makefile = readFileSync(join(bDef, 'Makefile'), 'utf8');
    expect(makefile).toContain('com.codd.mongo-backup-*.plist');
    expect(makefile).toContain('StandardOutPath');

    if (process.platform !== 'win32') {
      const awkOut = spawnSync(
        'awk',
        [
          '/<key>StandardOutPath<\\/key>/{getline; sub(/^.*<string>/, ""); sub(/<\\/string>.*$/, ""); print; exit}',
          plistDefPath,
        ],
        { encoding: 'utf8' },
      );
      expect(awkOut.status).toBe(0);
      expect(awkOut.stdout.trim()).toBe(
        `/Users/alice/srv/logs/mongo-backup-${resDefault.fingerprint}.log`,
      );
    }

    const resCustom = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'maccust',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            os: 'macos',
            backupDir: '/Users/alice/srv/backups',
            podmanBin: '/opt/custom/bin/podman',
          },
        ],
      },
    });
    const bCust = resCustom.bundleDirs[0]!;
    const plistCustName = readdirSync(bCust).find((f) => f.endsWith('.plist'))!;
    const plistCust = readFileSync(join(bCust, plistCustName), 'utf8');
    expect(plistCust).toContain(
      '<string>/opt/custom/bin:/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>',
    );
  });

  test('nextSteps 包含远程建目录防护 (保留 ~/ 展开) 与 single 模式启动/macOS 定时备份指引', () => {
    const dir = makeTempDir();
    const resMac = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'wozapp',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            os: 'macos',
            sshTarget: 'woz',
            backupDir: '/Users/alice/srv/backups',
          },
        ],
      },
    });
    const remoteDirMac = `~/srv/stacks/mongo-wozapp-${resMac.fingerprint}`;
    if (process.platform !== 'win32') {
      expect(resMac.nextSteps[0]).toContain(
        `ssh woz 'mkdir -p ${remoteDirMac}' && rsync -av`,
      );
      expect(resMac.nextSteps[0]).toContain(`"woz:${remoteDirMac}/"`);
    }
    expect(resMac.nextSteps[1]).toContain(
      `ssh woz 'cd ${remoteDirMac} && make up && make status'`,
    );
    expect(resMac.nextSteps[1]).toContain('make tune-host');
    expect(resMac.nextSteps[2]).toContain(
      `com.codd.mongo-backup-${resMac.fingerprint}.plist`,
    );
    expect(resMac.nextSteps[2]).toContain('launchctl load -w');

    const resLinux = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'linapp',
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [
          {
            os: 'linux',
            sshTarget: 'ssh -p 2222 -i ~/.ssh/id_ops ops@10.0.0.2',
            backupDir: '/home/ops/srv/backups',
            stackDir: '/opt/mongo-stacks',
          },
        ],
      },
    });
    const remoteDirLin = `/opt/mongo-stacks/mongo-linapp-${resLinux.fingerprint}`;
    if (process.platform !== 'win32') {
      expect(resLinux.nextSteps[0]).toContain(
        `ssh -p 2222 -i ~/.ssh/id_ops ops@10.0.0.2 'mkdir -p "${remoteDirLin}"' && rsync -av -e "ssh -p 2222 -i ~/.ssh/id_ops"`,
      );
    }
    expect(resLinux.nextSteps[1]).toContain(
      `cd "${remoteDirLin}" && make up && make status`,
    );
    expect(resLinux.nextSteps.length).toBe(2);

    const winStep = formatUploadNextStep({
      nodeName: 'main',
      rsRole: 'primary',
      bundleDir: 'C:\\work\\dist\\mongo-app-abc',
      remoteStackDir: '~/srv/stacks/mongo-app-abc',
      parsedSsh: {
        target: 'ops@10.0.0.2',
        port: 2222,
        normalized: 'ssh -p 2222 ops@10.0.0.2',
        rsyncRshFlag: '-e "ssh -p 2222" ',
      },
      platform: 'win32',
    });
    expect(winStep).toContain('ssh -p 2222 ops@10.0.0.2 mkdir -p');
    expect(winStep).toContain('scp -r -P 2222');
  });
});

describe('digitalRoot 与数根 3/6/9 安全 5 位端口推荐', () => {
  test('digitalRoot 精确计算数根并拒绝非正整数', () => {
    expect(digitalRoot(3)).toBe(3);
    expect(digitalRoot(9)).toBe(9);
    expect(digitalRoot(10002)).toBe(3);
    expect(digitalRoot(10005)).toBe(6);
    expect(digitalRoot(27117)).toBe(9);
    expect(digitalRoot(29997)).toBe(9);
    for (const bad of [0, -9, 3.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => digitalRoot(bad)).toThrow(RangeError);
    }
  });

  test('recommendSafePort 恒落在 10002-29997、数根属于 {3,6,9}、排除黑名单且零清单告警', () => {
    const blocked = new Set([27017, 27018, 27019, 11211, 15672, 26379, 27000]);
    const sampled = new Set<number>();
    for (let i = 0; i < 300; i += 1) {
      const p = recommendSafePort();
      expect(Number.isInteger(p)).toBe(true);
      expect(p).toBeGreaterThanOrEqual(10002);
      expect(p).toBeLessThanOrEqual(29997);
      expect([3, 6, 9]).toContain(digitalRoot(p));
      expect(blocked.has(p)).toBe(false);
      sampled.add(p);
    }
    expect(sampled.size).toBeGreaterThan(50);

    // 验证边界 rng 不越界, 且经 validateManifest 不触发端口警告
    for (const rng of [
      () => 0,
      () => 0.5,
      () => 1,
      () => -0.5,
      () => Number.NaN,
    ]) {
      const p = recommendSafePort(rng);
      expect([3, 6, 9]).toContain(digitalRoot(p));
      const warnings = validateManifest({
        mode: 'single',
        name: 'portok',
        port: p,
        hardware: { cpuCores: 2, memoryGb: 2, diskGb: 32 },
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
      });
      expect(warnings).toEqual([]);
    }
  });
});
