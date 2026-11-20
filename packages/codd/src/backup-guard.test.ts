/**
 * 定时备份四重磁盘防爆守卫单元测试:
 * 1) 过期 .partial 孤儿文件自动收尸
 * 2) 前置可用磁盘空间硬门禁 (底线 + 1.5x 上次归档预估)
 * 3) 硬链接零复制周备 + inode 物理去重总容量裁剪 (死守每库最新 1 份)
 * 4) Makefile 原地日志轮转 (保留 inode 兼容 launchd O_APPEND) 与公式/清单参数端到端透传
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  FatalError,
  assertEnoughDiskSpace,
  cleanStalePartials,
  formatBytes,
  linkOrCopyFile,
  pruneByTotalBudget,
  resolveBackupArchivePath,
} from '../template/podman/lib.ts';
import {
  ConfigError,
  computeSizing,
  generateBundle,
  validateManifest,
} from './index.ts';

const SOURCE_TEMPLATE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '../template',
);

const tempDirs: string[] = [];
const makeTempDir = (): string => {
  const dir = mkdtempSync(join(tmpdir(), 'codd-backup-guard-'));
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

describe('备份四重磁盘防爆守卫 (lib.ts)', () => {
  test('cleanStalePartials 仅清理超过阈值的僵尸 .partial, 保留活跃半成品与正常归档', async () => {
    const dir = makeTempDir();
    const now = 2_000_000_000_000;
    const staleName = 'mongo-app-20261119_033000.archive.gz.partial';
    const freshName = 'mongo-app-20261120_033000.archive.gz.partial';
    const goodName = 'mongo-app-20261119_033000.archive.gz';
    writeFileSync(join(dir, staleName), 'stale');
    writeFileSync(join(dir, freshName), 'fresh');
    writeFileSync(join(dir, goodName), 'good');
    utimesSync(
      join(dir, staleName),
      (now - 7 * 3600 * 1000) / 1000,
      (now - 7 * 3600 * 1000) / 1000,
    );
    utimesSync(
      join(dir, freshName),
      (now - 10 * 60 * 1000) / 1000,
      (now - 10 * 60 * 1000) / 1000,
    );
    utimesSync(
      join(dir, goodName),
      (now - 48 * 3600 * 1000) / 1000,
      (now - 48 * 3600 * 1000) / 1000,
    );

    const removed = await cleanStalePartials(dir, 6 * 3600 * 1000, now);
    expect(removed).toEqual([staleName]);
    expect(existsSync(join(dir, staleName))).toBe(false);
    expect(existsSync(join(dir, freshName))).toBe(true);
    expect(existsSync(join(dir, goodName))).toBe(true);
  });

  test('assertEnoughDiskSpace 拦截低空间并放行充足空间或 minFreeMb=0', async () => {
    const dir = makeTempDir();
    const mib = 1024 * 1024;
    const fakeReadFs = (availMib: number) => async () => ({
      bavail: availMib * 256,
      bsize: 4096,
      frsize: 4096,
    });

    await expect(
      assertEnoughDiskSpace({
        dir,
        minFreeMb: 1024,
        estimatedNewBytes: 512 * mib,
        readFs: fakeReadFs(1500),
      }),
    ).rejects.toThrow(FatalError);

    const okAvail = await assertEnoughDiskSpace({
      dir,
      minFreeMb: 1024,
      estimatedNewBytes: 512 * mib,
      readFs: fakeReadFs(2048),
    });
    expect(okAvail).toBe(2048 * mib);

    const skipped = await assertEnoughDiskSpace({
      dir,
      minFreeMb: 0,
      readFs: fakeReadFs(1),
    });
    expect(skipped).toBe(-1);

    expect(formatBytes(512)).toBe('512 B');
    expect(formatBytes(2048)).toBe('2.0 KiB');
    expect(formatBytes(5 * mib)).toBe('5.0 MiB');
    expect(formatBytes(2 * 1024 * mib)).toBe('2.00 GiB');
  });

  test('linkOrCopyFile 同盘走硬链接复用 inode, 硬链接失败自动降级拷贝', async () => {
    const dir = makeTempDir();
    const src = join(dir, 'src.archive.gz');
    const dstLink = join(dir, 'weekly-link.archive.gz');
    const dstCopy = join(dir, 'weekly-copy.archive.gz');
    writeFileSync(src, 'payload-data');

    const mode1 = await linkOrCopyFile(src, dstLink);
    expect(mode1).toBe('link');
    expect(statSync(dstLink).ino).toBe(statSync(src).ino);

    const mode2 = await linkOrCopyFile(src, dstCopy, async () => {
      throw new Error('EXDEV');
    });
    expect(mode2).toBe('copy');
    expect(readFileSync(dstCopy, 'utf8')).toBe('payload-data');
  });

  test('pruneByTotalBudget 按物理 inode 去重裁剪最旧备份并死守每库最新 1 份底线', async () => {
    const rootDir = makeTempDir();
    const weeklyDir = join(rootDir, 'weekly');
    mkdirSync(weeklyDir, { recursive: true });
    const oneMb = Buffer.alloc(1024 * 1024, 65);

    const fApp1 = 'mongo-app-20261117_033000.archive.gz';
    const fApp2 = 'mongo-app-20261118_033000.archive.gz';
    const fApp3 = 'mongo-app-20261119_033000.archive.gz';
    const fOrd1 = 'mongo-orders-20261118_033000.archive.gz';
    const fOrd2 = 'mongo-orders-20261119_033000.archive.gz';

    writeFileSync(join(rootDir, fApp1), oneMb);
    writeFileSync(join(rootDir, fApp2), oneMb);
    writeFileSync(join(rootDir, fApp3), oneMb);
    writeFileSync(join(rootDir, fOrd1), oneMb);
    writeFileSync(join(rootDir, fOrd2), oneMb);
    // 周日硬链接与最新日备共享同一物理 inode, 不应重复计费也不应白删
    await linkOrCopyFile(join(rootDir, fApp3), join(weeklyDir, fApp3));
    // 独立旧周备 (物理上多占 1 MiB)
    writeFileSync(join(weeklyDir, fApp1), oneMb);

    utimesSync(join(weeklyDir, fApp1), 1000, 1000);
    utimesSync(join(rootDir, fApp1), 1000, 1000);
    utimesSync(join(rootDir, fApp2), 2000, 2000);
    utimesSync(join(rootDir, fOrd1), 2500, 2500);
    utimesSync(join(rootDir, fApp3), 3000, 3000);
    utimesSync(join(rootDir, fOrd2), 3500, 3500);

    // 物理总大小 6 MiB, 配额 3 MiB -> 应优先删最旧的 3 个 (weekly/fApp1, fApp1, fApp2)
    const res1 = await pruneByTotalBudget({
      rootDir,
      weeklyDir,
      maxTotalMb: 3,
    });
    expect(res1.overBudget).toBe(false);
    expect(res1.totalBytes).toBe(3 * 1024 * 1024);
    expect(res1.deleted).toEqual([`weekly/${fApp1}`, fApp1, fApp2]);
    expect(existsSync(join(rootDir, fApp3))).toBe(true);
    expect(existsSync(join(weeklyDir, fApp3))).toBe(true);
    expect(existsSync(join(rootDir, fOrd2))).toBe(true);

    // 配额设为 1 MiB (低于 2 个库各自最新 1 份总和 2 MiB): 必须删掉 fOrd1 后保底停手, 绝不清空最新日备
    const res2 = await pruneByTotalBudget({
      rootDir,
      weeklyDir,
      maxTotalMb: 1,
    });
    expect(res2.deleted).toEqual([fOrd1]);
    expect(res2.overBudget).toBe(true);
    expect(res2.totalBytes).toBe(2 * 1024 * 1024);
    expect(existsSync(join(rootDir, fApp3))).toBe(true);
    expect(existsSync(join(rootDir, fOrd2))).toBe(true);
  });

  test('resolveBackupArchivePath 支持根目录、weekly/ 显式路径与纯文件名自动回退 weekly/, 严拒路径穿越与保留库', async () => {
    const rootDir = makeTempDir();
    const weeklyDir = join(rootDir, 'weekly');
    mkdirSync(weeklyDir, { recursive: true });

    const dailyName = 'mongo-app-20261120_033000.archive.gz';
    const weeklyOnlyName = 'mongo-insight-20261108_033000.archive.gz';
    writeFileSync(join(rootDir, dailyName), 'daily');
    writeFileSync(join(weeklyDir, weeklyOnlyName), 'weekly');

    expect(await resolveBackupArchivePath(dailyName, rootDir)).toEqual({
      file: join(rootDir, dailyName),
      relPath: dailyName,
      db: 'app',
    });
    expect(
      await resolveBackupArchivePath(`weekly/${weeklyOnlyName}`, rootDir),
    ).toEqual({
      file: join(weeklyDir, weeklyOnlyName),
      relPath: `weekly/${weeklyOnlyName}`,
      db: 'insight',
    });
    expect(
      await resolveBackupArchivePath(`./weekly/${weeklyOnlyName}`, rootDir),
    ).toEqual({
      file: join(weeklyDir, weeklyOnlyName),
      relPath: `weekly/${weeklyOnlyName}`,
      db: 'insight',
    });
    // 纯文件名在根目录不存在时自动回退命中 weekly/
    expect(await resolveBackupArchivePath(weeklyOnlyName, rootDir)).toEqual({
      file: join(weeklyDir, weeklyOnlyName),
      relPath: `weekly/${weeklyOnlyName}`,
      db: 'insight',
    });

    // 显式 weekly/ 不回退根目录 (文件确实不在 weekly/ 里则报错)
    await expect(
      resolveBackupArchivePath(`weekly/${dailyName}`, rootDir),
    ).rejects.toThrow(FatalError);

    for (const bad of [
      '',
      '   ',
      `../${dailyName}`,
      `weekly/../${dailyName}`,
      `/backup/${dailyName}`,
      `other/${dailyName}`,
      'mongo-admin-20261120_033000.archive.gz',
      'not-a-backup.tar.gz',
      'mongo-app-20261101_033000.archive.gz',
    ]) {
      await expect(resolveBackupArchivePath(bad, rootDir)).rejects.toThrow(
        FatalError,
      );
    }
  });
});

describe('公式推导、清单校验、模板透传与 Makefile 原地日志轮转', () => {
  test('computeSizing 推导备份余量底线与总配额, validateManifest 校验自定义值并拦截负数', () => {
    const s2 = computeSizing({ cpuCores: 2, memoryGb: 2, diskGb: 32 });
    expect(s2.backupMinFreeMb).toBe(1536);
    expect(s2.backupMaxTotalMb).toBe(49152);

    const s4 = computeSizing({ cpuCores: 4, memoryGb: 8, diskGb: 100 });
    expect(s4.backupMinFreeMb).toBe(5120);
    expect(s4.backupMaxTotalMb).toBe(153600);

    expect(() =>
      validateManifest({
        mode: 'single',
        name: 'guardok',
        backupMinFreeMb: 0,
        backupMaxTotalMb: 10240,
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
      }),
    ).not.toThrow();

    expect(() =>
      validateManifest({
        mode: 'single',
        name: 'guardbad',
        backupMaxTotalMb: -1,
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
      }),
    ).toThrow(ConfigError);
  });

  test('生成产物透传 BACKUP_MIN_FREE_MB / BACKUP_MAX_TOTAL_MB, 且 make rotate-backup-log 原地截断保留 inode', () => {
    const dir = makeTempDir();
    const res = generateBundle({
      workDir: dir,
      templateDir: SOURCE_TEMPLATE_ROOT,
      manifest: {
        mode: 'single',
        name: 'logrot',
        backupMinFreeMb: 2048,
        backupMaxTotalMb: 20480,
        hardware: { cpuCores: 2, memoryGb: 2, diskGb: 32 },
        apps: [{ db: 'app', user: 'appu' }],
        nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
      },
    });
    const bDir = res.bundleDirs[0]!;
    const envFile = readFileSync(join(bDir, '.env'), 'utf8');
    expect(envFile).toContain('BACKUP_MIN_FREE_MB=2048');
    expect(envFile).toContain('BACKUP_MAX_TOTAL_MB=20480');

    const compose = readFileSync(join(bDir, 'podman-compose.yml'), 'utf8');
    expect(compose).toContain(
      'BACKUP_MIN_FREE_MB: ${BACKUP_MIN_FREE_MB:-2048}',
    );
    expect(compose).toContain(
      'BACKUP_MAX_TOTAL_MB: ${BACKUP_MAX_TOTAL_MB:-20480}',
    );

    if (process.platform !== 'win32') {
      const logFile = join(dir, 'backup.log');
      writeFileSync(logFile, 'x'.repeat(2048), 'utf8');
      const origIno = statSync(logFile).ino;

      const rot = spawnSync(
        'make',
        [
          '-C',
          bDir,
          'rotate-backup-log',
          `BACKUP_LOG_FILE=${logFile}`,
          'BACKUP_LOG_MAX_BYTES=1024',
        ],
        { encoding: 'utf8' },
      );
      expect(rot.status).toBe(0);
      expect(statSync(logFile).ino).toBe(origIno);
      expect(statSync(logFile).size).toBe(0);
      expect(statSync(`${logFile}.1`).size).toBe(2048);
    }
  });
});
