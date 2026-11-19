/**
 * @iyowei/codd 基础算法与校验单测:
 * 覆盖硬件推导公式、唯一指纹防冲突路径、严格模板渲染、SSH 命令净化、清单注入拦截与边界校验。
 */
import { describe, expect, test } from 'bun:test';

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
} from './index.ts';

const baseSingleManifest = (): DeployManifest => ({
  mode: 'single',
  name: 'app',
  apps: [{ db: 'app', user: 'appu' }],
  nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
});

describe('硬件资源与数据库参数公式推导', () => {
  test('2C2G / 4C8G / 8C16G 三档规格精确推导缓存、连接数、oplog 与 ulimit', () => {
    const s2 = computeSizing({
      cpuCores: 2,
      memoryGb: 2,
      diskGb: 32,
      workload: 'balanced',
    });
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

    const s4 = computeSizing({
      cpuCores: 4,
      memoryGb: 8,
      diskGb: 200,
      workload: 'write-heavy',
    });
    expect(s4.wtCacheGb).toBe(3.5);
    expect(s4.memoryReservationPodman).toBe('4g');
    expect(s4.k8sRequestMemory).toBe('8Gi');
    expect(s4.maxIncomingConnections).toBe(350);
    expect(s4.oplogSizeMb).toBe(16380);
    expect(s4.slowOpThresholdMs).toBe(80);
    expect(s4.stopGracePeriodSec).toBe(64);
    expect(s4.backupConcurrency).toBe(2);
    expect(s4.logMaxSize).toBe('100m');

    const s8 = computeSizing({
      cpuCores: 8,
      memoryGb: 16,
      diskGb: 250,
      workload: 'balanced',
    });
    expect(s8.wtCacheGb).toBe(8.25);
    expect(s8.stopGracePeriodSec).toBe(128);
    expect(s8.backupConcurrency).toBe(4);
  });

  test('expectedAppConnections 受内存安全上限封顶并在超限时告警', () => {
    const ok = computeSizing({
      cpuCores: 4,
      memoryGb: 8,
      diskGb: 100,
      expectedAppConnections: 320,
    });
    expect(ok.maxIncomingConnections).toBe(400);
    expect(ok.warnings.length).toBe(0);

    const high = computeSizing({
      cpuCores: 2,
      memoryGb: 2,
      diskGb: 32,
      expectedAppConnections: 500,
    });
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

    const badManifests: DeployManifest[] = [
      { ...baseK8s, k8s: { namespace: 'data"; rm -rf /' } },
      { ...baseK8s, k8s: { releaseName: '$(id)' } },
      { ...baseK8s, k8s: { storageClass: 'gp3\n  injected: true' } },
      { ...baseK8s, k8s: { existingSecret: 'sec;id' } },
      { ...baseK8s, k8s: { nodePort: 29999 } },
      { ...baseK8s, k8s: { nodePort: 32768 } },
      {
        ...baseK8s,
        k8s: { serviceType: 'LoadBalancer' as unknown as 'ClusterIP' },
      },
      {
        ...baseK8s,
        k8s: { podAntiAffinity: 'none' as unknown as 'hard' },
      },
      { ...baseK8s, auth: { existingSecret: 'bad`id`' } },
      { ...baseSingleManifest(), imageName: 'mongo;id' },
      { ...baseSingleManifest(), imageTag: '9.0.8\nrestart: always' },
      { ...baseSingleManifest(), bunImage: 'oven/bun:1 $(id)' },
      { ...baseSingleManifest(), tz: 'Asia/Shanghai;id' },
      { ...baseSingleManifest(), rsName: 'rs0"bad' },
      { ...baseSingleManifest(), keepDaily: 0 },
      { ...baseSingleManifest(), keepWeekly: -1 },
      {
        ...baseSingleManifest(),
        multiNetAlias: 'true' as unknown as boolean,
      },
      {
        ...baseSingleManifest(),
        nodes: [{ os: 'linux', backupDir: '/home/ops/../etc' }],
      },
      {
        ...baseSingleManifest(),
        nodes: [{ os: 'linux', backupDir: '/home/ops/bak;rm' }],
      },
      {
        ...baseSingleManifest(),
        nodes: [
          {
            os: 'linux',
            backupDir: '/home/ops/bak',
            stackDir: '/home/ops/../../etc',
          },
        ],
      },
      {
        ...baseSingleManifest(),
        nodes: [
          {
            os: 'linux',
            backupDir: '/home/ops/bak',
            podmanBin: '/opt/bin/podman;id',
          },
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

describe('零冲突指纹路径、模板渲染与 SSH 解析', () => {
  test('幂等归一化服务器备份路径并嵌入 12 位唯一指纹', () => {
    const fp = 'a1b2c3d4e5f6';
    expect(
      resolveServerBackupDir('/Users/ops/srv/backups', 'mongo', 'hola', fp),
    ).toBe('/Users/ops/srv/backups/mongo-hola-a1b2c3d4e5f6');
    expect(
      resolveServerBackupDir(
        '/Users/ops/srv/backups/mongo-hola',
        'mongo',
        'hola',
        fp,
      ),
    ).toBe('/Users/ops/srv/backups/mongo-hola-a1b2c3d4e5f6');
    expect(
      resolveServerBackupDir(
        '/Users/ops/srv/backups/mongo-hola-a1b2c3d4e5f6/',
        'mongo',
        'hola',
        fp,
      ),
    ).toBe('/Users/ops/srv/backups/mongo-hola-a1b2c3d4e5f6');
    expect(
      resolveServerBackupDir(
        '/home/ops/srv/backups/mongo-ha',
        'mongo',
        'ha',
        fp,
        'node2',
      ),
    ).toBe('/home/ops/srv/backups/mongo-ha-a1b2c3d4e5f6-node2');
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
});
