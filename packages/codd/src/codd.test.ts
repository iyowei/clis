/**
 * @iyowei/codd 基础算法与校验单测:
 * 覆盖硬件推导公式、唯一指纹防冲突路径、严格模板渲染、SSH 命令净化、清单注入拦截与边界校验。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  ConfigError,
  type DeployManifest,
  SizingError,
  TemplateRenderError,
  assertBunEngineCompatible,
  computeSizing,
  parseSshInput,
  renderTemplate,
  resolveServerBackupDir,
  validateManifest,
  validateSafeAbsPath,
} from './index.ts';

const baseSingleManifest = (): DeployManifest => ({
  mode: 'single',
  name: 'app',
  apps: [{ db: 'app', user: 'appu' }],
  nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
});

describe('硬件资源与数据库参数公式推导', () => {
  test('2C2G / 4C8G / 8C16G 三档规格精确推导缓存、连接数、oplog 与 ulimit', () => {
    const s2 = computeSizing({ cpuCores: 2, memoryGb: 2, diskGb: 32 });
    expect(s2.wtCacheGb).toBe(0.5);
    expect(s2.memoryLimitPodman).toBe('2g');
    expect(s2.memoryReservationPodman).toBe('1g');
    expect(s2.k8sRequestMemory).toBe('2Gi');
    expect(s2.k8sLimitMemory).toBe('2Gi');
    expect(s2.maxIncomingConnections).toBe(100);
    expect(s2.oplogSizeMb).toBe(990);
    expect(s2.blockCompressor).toBe('zstd');
    expect(s2.nofileUlimit).toBe(65536);
    expect(s2.nprocUlimit).toBe(65536);
    expect(s2.stopGracePeriodSec).toBe(30);
    expect(s2.backupConcurrency).toBe(1);

    const hw4 = { cpuCores: 4, memoryGb: 8, diskGb: 200 };
    const s4 = computeSizing({ ...hw4, workload: 'write-heavy' });
    expect(s4.wtCacheGb).toBe(3);
    expect(s4.blockCompressor).toBe('snappy');
    expect(s4.memoryReservationPodman).toBe('4g');
    expect(s4.k8sRequestMemory).toBe('8Gi');
    expect(s4.maxIncomingConnections).toBe(400);
    expect(s4.oplogSizeMb).toBe(16380);
    expect(s4.slowOpThresholdMs).toBe(80);
    expect(s4.stopGracePeriodSec).toBe(64);
    expect(s4.backupConcurrency).toBe(2);
    expect(s4.logMaxSize).toBe('100m');

    const hw8 = { cpuCores: 8, memoryGb: 16, diskGb: 250 };
    const s8 = computeSizing(hw8);
    expect(s8.wtCacheGb).toBe(7.5);
    expect(s8.blockCompressor).toBe('zstd');
    expect(s8.stopGracePeriodSec).toBe(128);
    expect(s8.backupConcurrency).toBe(4);

    const s8Read = computeSizing({ ...hw8, workload: 'read-heavy' });
    expect([s8Read.wtCacheGb, s8Read.blockCompressor]).toEqual([8.25, 'zstd']);

    const hw1 = { cpuCores: 1, memoryGb: 1, diskGb: 32 };
    const s1Write = computeSizing({ ...hw1, workload: 'write-heavy' });
    expect(s1Write.wtCacheGb).toBe(0.25);
    expect(s1Write.blockCompressor).toBe('snappy');
    expect(s1Write.warnings.some((w) => w.includes('make drill'))).toBe(true);
  });

  test('expectedAppConnections 受内存安全上限封顶并在超限时告警, 且 steps[2].formula 算术自洽', () => {
    const hw4c8g = { cpuCores: 4, memoryGb: 8, diskGb: 100 };
    const base = computeSizing(hw4c8g);
    expect([base.maxIncomingConnections, base.steps[2]?.formula]).toEqual([
      350,
      'clamp(floor50((8 - 3.5) x 80), 100, 5000)',
    ]);

    const belowBase = computeSizing({ ...hw4c8g, expectedAppConnections: 200 });
    expect([
      belowBase.maxIncomingConnections,
      belowBase.steps[2]?.formula,
    ]).toEqual([350, 'clamp(floor50((8 - 3.5) x 80), 100, 5000)']);

    const ok = computeSizing({ ...hw4c8g, expectedAppConnections: 320 });
    expect([
      ok.maxIncomingConnections,
      ok.steps[2]?.value,
      ok.steps[2]?.formula,
    ]).toEqual([400, '400 个', 'ceil50(320 x 1.25)']);
    expect(ok.warnings.length).toBe(0);

    const high = computeSizing({
      cpuCores: 2,
      memoryGb: 2,
      diskGb: 32,
      expectedAppConnections: 500,
    });
    expect([
      high.maxIncomingConnections,
      high.steps[2]?.value,
      high.steps[2]?.formula,
    ]).toEqual([150, '150 个', 'clamp(floor50((2 - 0.5) x 130), 100, 5000)']);
    expect(high.warnings.length).toBe(1);
    expect(high.warnings[0]).toContain('预期连接数');
  });

  test('非法硬件边界与 expectedAppConnections 的 NaN / Infinity / 负数 / 小数抛出 SizingError', () => {
    expect(() =>
      computeSizing({ cpuCores: 0, memoryGb: 4, diskGb: 50 }),
    ).toThrow(SizingError);
    expect(() =>
      computeSizing({ cpuCores: 2, memoryGb: 2, diskGb: 5 }),
    ).toThrow(SizingError);
    for (const bad of [Number.NaN, Number.POSITIVE_INFINITY, 0, -5, 12.5]) {
      expect(() =>
        computeSizing({
          cpuCores: 2,
          memoryGb: 4,
          diskGb: 50,
          expectedAppConnections: bad,
        }),
      ).toThrow(SizingError);
    }
  });
});

describe('清单安全校验与注入拦截', () => {
  test('拦截非对象顶层 JSON 与 apps[0].user=undefined 强转绕过', () => {
    expect(() => validateManifest(null as unknown as DeployManifest)).toThrow(
      ConfigError,
    );
    expect(() => validateManifest([] as unknown as DeployManifest)).toThrow(
      ConfigError,
    );
    expect(() => validateManifest('raw' as unknown as DeployManifest)).toThrow(
      ConfigError,
    );

    const badUser = baseSingleManifest();
    badUser.apps = [{ db: 'app', user: undefined as unknown as string }];
    expect(() => validateManifest(badUser)).toThrow(ConfigError);
  });

  test('name 与 stackPrefix 严格要求合规 DNS-1123 标签 (禁止纯 "-" 或首尾 "-")', () => {
    for (const bad of ['-', '-app', 'app-', 'App', 'app_1']) {
      expect(() =>
        validateManifest({ ...baseSingleManifest(), name: bad }),
      ).toThrow(ConfigError);
      expect(() =>
        validateManifest({ ...baseSingleManifest(), stackPrefix: bad }),
      ).toThrow(ConfigError);
    }
    expect(() =>
      validateManifest({
        ...baseSingleManifest(),
        name: 'a',
        stackPrefix: 'm1-db',
      }),
    ).not.toThrow();
  });

  test('拦截 k8s.* / auth.existingSecret / 镜像 / 时区 / 路径穿越与 Shell/YAML 注入', () => {
    const baseK8s: DeployManifest = {
      mode: 'k8s-single',
      name: 'app',
      apps: [{ db: 'app', user: 'appu' }],
      k8s: { namespace: 'data' },
    };

    const base = baseSingleManifest();
    const badSvc = 'LoadBalancer' as unknown as 'ClusterIP';
    const badAff = 'none' as unknown as 'hard';
    const badManifests: DeployManifest[] = [
      { ...baseK8s, k8s: { namespace: 'data"; rm -rf /' } },
      { ...baseK8s, k8s: { releaseName: '$(id)' } },
      { ...baseK8s, k8s: { storageClass: 'gp3\n  injected: true' } },
      { ...baseK8s, k8s: { existingSecret: 'sec;id' } },
      { ...baseK8s, k8s: { nodePort: 29999 } },
      { ...baseK8s, k8s: { nodePort: 32768 } },
      { ...baseK8s, k8s: { serviceType: badSvc } },
      { ...baseK8s, k8s: { podAntiAffinity: badAff } },
      { ...baseK8s, auth: { existingSecret: 'bad`id`' } },
      { ...base, imageName: 'mongo;id' },
      { ...base, imageTag: '9.0.8\nrestart: always' },
      { ...base, bunImage: 'oven/bun:1 $(id)' },
      { ...base, tz: 'Asia/Shanghai;id' },
      { ...base, rsName: 'rs0"bad' },
      { ...base, keepDaily: 0 },
      { ...base, keepWeekly: -1 },
      { ...base, multiNetAlias: 'true' as unknown as boolean },
      { ...base, nodes: [{ os: 'linux', backupDir: '/home/ops/../etc' }] },
      { ...base, nodes: [{ os: 'linux', backupDir: '/home/ops/bak;rm' }] },
      {
        ...base,
        nodes: [
          { os: 'linux', backupDir: '/opt/b', stackDir: '/home/ops/../../etc' },
        ],
      },
      {
        ...base,
        nodes: [
          { os: 'linux', backupDir: '/opt/b', podmanBin: '/opt/bin/podman;id' },
        ],
      },
    ];

    for (const m of badManifests) {
      expect(() => validateManifest(m)).toThrow(ConfigError);
    }

    expect(() =>
      validateManifest({
        ...baseSingleManifest(),
        keepDaily: 7,
        keepWeekly: 0,
        multiNetAlias: true,
      }),
    ).not.toThrow();
  });
});

describe('系统核心目录黑名单与 Makefile 路径门禁', () => {
  test('宽松放行外挂卷与数据路径且不误杀前缀超集, 精确拦截系统核心目录与占位路径', () => {
    const allowed = [
      '/Users/ops/srv/backups /Volumes/BackupDisk/mongo /opt/backups /var/folders/xx/bak',
      '/private/var/mongo-bak /tmp/mongo-bak /srv/mongo/backups /data/mongo /mnt/nas/mongo',
      '/media/usb/mongo /home/ops/backups /root/backups /usr/local/var/backups',
      '/devdata/bak /library/bak /procdump/bak /systemic/bak /ApplicationsData/bak',
    ].flatMap((s) => s.split(' '));
    for (const p of allowed) {
      expect(validateSafeAbsPath(p, 'macos'), `macos allow ${p}`).toBeNull();
      expect(validateSafeAbsPath(p, 'linux'), `linux allow ${p}`).toBeNull();
      expect(() =>
        validateManifest({
          ...baseSingleManifest(),
          nodes: [{ os: 'macos', backupDir: p, stackDir: p }],
        }),
      ).not.toThrow();
    }

    const forbiddenCommon = [
      '/ /etc /etc/ /etc/bak /private/etc /private/etc/hosts /proc /proc/1 /sys /sys/fs',
      '/dev /dev/shm /boot /boot/grub /bin/sh /sbin/init /lib/x /lib64/x',
      '/usr/bin/bak /usr/sbin/x /usr/lib/x /usr/lib64/x /path/to /path/to/bak',
    ].flatMap((s) => s.split(' '));
    for (const bad of forbiddenCommon) {
      expect(validateSafeAbsPath(bad, 'linux'), bad).not.toBeNull();
      expect(validateSafeAbsPath(bad, 'macos'), bad).not.toBeNull();
      for (const node of [
        { os: 'linux' as const, backupDir: bad },
        { os: 'linux' as const, backupDir: '/opt/backups', stackDir: bad },
      ]) {
        expect(() =>
          validateManifest({ ...baseSingleManifest(), nodes: [node] }),
        ).toThrow(ConfigError);
      }
    }

    const forbiddenMac =
      '/System /System/ /System/Volumes/x /Applications /Applications/x'.split(
        ' ',
      );
    for (const badMac of forbiddenMac) {
      expect(validateSafeAbsPath(badMac, 'macos'), badMac).not.toBeNull();
      for (const node of [
        { os: 'macos' as const, backupDir: badMac },
        {
          os: 'macos' as const,
          backupDir: '/Volumes/BackupDisk/mongo',
          stackDir: badMac,
        },
      ]) {
        expect(() =>
          validateManifest({ ...baseSingleManifest(), nodes: [node] }),
        ).toThrow(ConfigError);
      }
    }

    if (process.platform !== 'win32') {
      const tmplDir = dirname(fileURLToPath(import.meta.url));
      const makeTmpl = readFileSync(
        resolve(tmplDir, '../template/podman/Makefile.tmpl'),
        'utf8',
      );
      const snippet = /\t@bdir="[\s\S]*?^\tesac$/m.exec(makeTmpl)?.[0] ?? '';
      expect(snippet.length).toBeGreaterThan(0);
      const script = snippet
        .replace(/^\t@?/gm, '')
        .replaceAll('$(BACKUP_DIR)', '$$TEST_BACKUP_DIR')
        .replaceAll('$$', '$');
      const envRun = (d: string) =>
        spawnSync('sh', ['-c', script], {
          env: { ...process.env, TEST_BACKUP_DIR: d },
        }).status;
      for (const d of '/Volumes/BackupDisk/mongo /opt/backups /var/folders/xx/bak /devdata/bak /library/bak'.split(
        ' ',
      )) {
        expect(envRun(d), d).toBe(0);
      }
      const badMake =
        '/ /// relative/bak /path/to/bak /etc/bak /etc/ /proc/1 /dev/shm /usr/bin/bak /System/Volumes/x /Applications/x';
      for (const d of ['', ...badMake.split(' ')]) {
        expect(envRun(d), d).toBe(1);
      }
    }
  });
});

describe('零冲突指纹路径、模板渲染与 SSH 解析', () => {
  test('幂等归一化服务器备份路径并嵌入 12 位唯一指纹', () => {
    const fp = 'a1b2c3d4e5f6';
    const root = '/Users/ops/srv/backups';
    const expected = `${root}/mongo-hola-${fp}`;
    expect(resolveServerBackupDir(root, 'mongo', 'hola', fp)).toBe(expected);
    expect(
      resolveServerBackupDir(`${root}/mongo-hola`, 'mongo', 'hola', fp),
    ).toBe(expected);
    expect(resolveServerBackupDir(`${expected}/`, 'mongo', 'hola', fp)).toBe(
      expected,
    );
    expect(
      resolveServerBackupDir('/home/ops/bak/mongo-ha', 'mongo', 'ha', fp, 'n2'),
    ).toBe(`/home/ops/bak/mongo-ha-${fp}-n2`);
  });

  test('缺失占位或残留花括号立即抛出 TemplateRenderError', () => {
    expect(() =>
      renderTemplate('x.tmpl', 'A={{FOO}} B={{BAR}}', { FOO: '1' }),
    ).toThrow(TemplateRenderError);
    expect(() =>
      renderTemplate('y.tmpl', 'A={{FOO}} {{unparsed', { FOO: '1' }),
    ).toThrow(TemplateRenderError);
    expect(() =>
      renderTemplate('z.tmpl', 'A={{FOO}}', { FOO: '{{ESCAPED}}' }),
    ).toThrow(TemplateRenderError);
    expect(
      renderTemplate('ok.tmpl', 'A={{FOO}} B={{BAR}}', { FOO: '1', BAR: 2 }),
    ).toBe('A=1 B=2');
  });

  test('支持显式 Bun 版本门限校验工具与 SSH 命令智能提取', () => {
    expect(() => assertBunEngineCompatible('>=1.4.2', '1.4.2')).not.toThrow();
    expect(() => assertBunEngineCompatible('>=1.4.2', '1.5.0')).not.toThrow();
    expect(() => assertBunEngineCompatible('>=1.4.2', '1.4.1')).toThrow(
      ConfigError,
    );

    expect(parseSshInput('ssh mybox')).toEqual({
      target: 'mybox',
      normalized: 'mybox',
      rsyncRshFlag: '',
    });
    expect(
      parseSshInput('ssh -N -L 8000:127.0.0.1:8000 -p 2222 ops@10.8.0.2'),
    ).toEqual({
      target: 'ops@10.8.0.2',
      port: 2222,
      normalized: 'ssh -p 2222 ops@10.8.0.2',
      rsyncRshFlag: '-e "ssh -p 2222" ',
    });
    expect(() => parseSshInput('ssh')).toThrow(ConfigError);
    expect(() => parseSshInput('mybox; rm -rf /')).toThrow(ConfigError);
    expect(() => parseSshInput('-oProxyCommand=evil')).toThrow(ConfigError);
  });

  test('非整 GB 自动转整 m/Mi、cpuCores 规整至 0.001 步长并防 workload 原型链污染', () => {
    const frac = computeSizing({
      cpuCores: 1.5556,
      memoryGb: 1.5,
      diskGb: 12.5,
      workload: 'balanced',
    });
    expect(frac.cpuLimit).toBe(1.556);
    expect(frac.memoryLimitPodman).toBe('1536m');
    expect(frac.k8sLimitMemory).toBe('1536Mi');
    expect(frac.k8sRequestMemory).toBe('1536Mi');
    expect(frac.persistenceSize).toBe('12800Mi');

    const mem3 = computeSizing({ cpuCores: 2, memoryGb: 3, diskGb: 30 });
    expect(mem3.memoryReservationPodman).toBe('1536m');

    for (const protoKey of ['constructor', 'toString', '__proto__']) {
      expect(() =>
        computeSizing({
          cpuCores: 2,
          memoryGb: 4,
          diskGb: 50,
          workload: protoKey as 'balanced',
        }),
      ).toThrow(SizingError);
    }
  });

  test('错误类显式设置 name、子对象未知字段/超长库名/超长 releaseName 被拦截', () => {
    expect([
      new ConfigError('x').name,
      new SizingError('x').name,
      new TemplateRenderError('x').name,
    ]).toEqual(['ConfigError', 'SizingError', 'TemplateRenderError']);

    const badPatches: Array<Record<string, unknown>> = [
      { $schema: 123 },
      { hardware: {} },
      { hardware: { cpuCores: 0, memoryGb: 2, diskGb: 32 } },
      { hardware: { cpuCores: 2, memoryGb: 2, diskGb: 32, extraField: 1 } },
      { hardware: 'bad' },
      { apps: [{ db: 'app', user: 'appu', unknownKey: true }] },
      { apps: [{ db: 'a'.repeat(64), user: 'appu' }] },
      {
        nodes: [
          { os: 'linux', backupDir: '/home/ops/bak', bindIP: '10.0.0.1' },
        ],
      },
    ];
    for (const patch of badPatches) {
      expect(() =>
        validateManifest({
          ...baseSingleManifest(),
          ...patch,
        } as DeployManifest),
      ).toThrow(ConfigError);
    }

    const k8sBase = {
      mode: 'k8s-single' as const,
      name: 'app',
      apps: [{ db: 'app', user: 'appu' }],
    };
    expect(() =>
      validateManifest({ ...k8sBase, k8s: { releaseName: 'a'.repeat(51) } }),
    ).toThrow(ConfigError);
    expect(() =>
      validateManifest({ ...k8sBase, k8s: { releaseName: 'a'.repeat(50) } }),
    ).not.toThrow();
  });

  test('assertBunEngineCompatible 兼容 ^ / ~ / >=, SSH 拦截 -J/-F/非法 target, 备份目录精确匹配 unitSlug', () => {
    expect(() => assertBunEngineCompatible('^1.4.2', '1.9.0')).not.toThrow();
    expect(() => assertBunEngineCompatible('^1.4.2', '2.0.0')).toThrow(
      ConfigError,
    );
    expect(() => assertBunEngineCompatible('~1.4.2', '1.4.9')).not.toThrow();
    expect(() => assertBunEngineCompatible('~1.4.2', '1.5.0')).toThrow(
      ConfigError,
    );

    expect(() => parseSshInput('ssh -J bastion ops@10.0.0.2')).toThrow(
      ConfigError,
    );
    expect(() => parseSshInput('ssh -F /tmp/ssh.cfg mybox')).toThrow(
      ConfigError,
    );
    expect(() => parseSshInput('user@@host')).toThrow(ConfigError);
    expect(() => parseSshInput('user@')).toThrow(ConfigError);

    const fp = 'a1b2c3d4e5f6';
    expect(
      resolveServerBackupDir(
        `/home/ops/srv/backups/mongo-ha-${fp}`,
        'mongo',
        'ha',
        fp,
        'node2',
      ),
    ).toBe(`/home/ops/srv/backups/mongo-ha-${fp}-node2`);
  });
});
