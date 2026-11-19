/**
 * @iyowei/codd 基础算法单测: 覆盖硬件推导公式、唯一指纹防冲突路径、严格模板渲染、SSH 命令净化与 UI 终端排版。
 */
import { describe, expect, test } from 'bun:test';

import {
  ConfigError,
  SizingError,
  TemplateRenderError,
  assertBunEngineCompatible,
  computeSizing,
  parseSshInput,
  renderTemplate,
  resolveServerBackupDir,
} from './index.ts';
import {
  detectLightTerminal,
  displayWidth,
  padEndDisplay,
  truncateDisplay,
  wrapDisplay,
} from './ui/ansi.ts';

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

  test('非法硬件边界抛出 SizingError', () => {
    expect(() =>
      computeSizing({ cpuCores: 0, memoryGb: 4, diskGb: 50 }),
    ).toThrow(SizingError);
    expect(() =>
      computeSizing({ cpuCores: 2, memoryGb: 2, diskGb: 5 }),
    ).toThrow(SizingError);
  });
});

describe('零冲突指纹路径、模板渲染、SSH 解析与 UI 排版', () => {
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

  test('支持 Bun 版本门限校验与 SSH 命令智能提取', () => {
    expect(() => assertBunEngineCompatible('>=1.4.4', '1.4.4')).not.toThrow();
    expect(() => assertBunEngineCompatible('>=1.4.4', '1.5.0')).not.toThrow();
    expect(() => assertBunEngineCompatible('>=1.4.4', '1.4.3')).toThrow(
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

  test('UI 全角列宽计算、安全折行与深浅色终端检测精确无误', () => {
    expect(displayWidth('WT_CACHE_GB')).toBe(11);
    expect(displayWidth('中文123')).toBe(7);
    expect(padEndDisplay('中文', 6)).toBe('中文  ');
    expect(truncateDisplay('一二三四五', 5)).toBe('一二…');
    const wrapped = wrapDisplay('max(350 x 4, 65536) / balanced 慢查询线', 18);
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
    expect(wrapped.every((line) => displayWidth(line) <= 18)).toBe(true);

    const prevFgBg = process.env.COLORFGBG;
    const prevTheme = process.env.CODD_THEME;
    try {
      delete process.env.CODD_THEME;
      process.env.COLORFGBG = '0;15';
      expect(detectLightTerminal()).toBe(true);
      process.env.COLORFGBG = '15;0';
      expect(detectLightTerminal()).toBe(false);
      process.env.CODD_THEME = 'light';
      expect(detectLightTerminal()).toBe(true);
    } finally {
      if (prevFgBg === undefined) delete process.env.COLORFGBG;
      else process.env.COLORFGBG = prevFgBg;
      if (prevTheme === undefined) delete process.env.CODD_THEME;
      else process.env.CODD_THEME = prevTheme;
    }
  });
});
