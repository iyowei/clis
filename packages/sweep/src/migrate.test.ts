/**
 * 配置自动迁移 (`v1 → v2` 与 `sweep-node-modules/config.json → sweep/config.json`) 专项测试。
 * 重点钉死红线 3:
 * 1. 写前必在源配置目录生成 `config.json.YYYYMMDD_HHMMSS.modified` 备份 (逐字节一致), wx 冲突或软链锚点立即中止;
 * 2. 迁移产物 `presets` 严格等价映射为 `{ node: {} }`, 绝不激活其他 5 个新预设;
 * 3. 非无损 / 未知字段 / 空 roots / 高版本 / 畸形 JSON 正确分流。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { loadConfig, resolveConfigPath } from './config.ts';
import { isSweepErrorCode } from './errors.ts';
import {
  NEW_PRESET_HINTS,
  applyMigration,
  buildMigrationBackupPath,
  convertV1ToV2,
  detectMigration,
  formatBackupTimestamp,
} from './migrate.ts';

const dirs: string[] = [];
const FIXED_DATE = new Date(2026, 10, 20, 9, 8, 7);
const DIR_LINK = process.platform === 'win32' ? 'dir' : undefined;

async function makeTempHome(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'sweep-lab-migrate-'));
  const real = await realpath(raw);
  dirs.push(real);
  return real;
}

async function writeText(filePath: string, content: string): Promise<void> {
  await mkdir(dirname(filePath), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});

describe('migrate 工具与无损转换', () => {
  test('备份时间戳格式与路径拼装', () => {
    expect(formatBackupTimestamp(FIXED_DATE)).toBe('20261120_090807');
    expect(
      buildMigrationBackupPath('/home/u/.config/sweep/config.json', FIXED_DATE),
    ).toBe('/home/u/.config/sweep/config.json.20261120_090807.modified');
    expect(NEW_PRESET_HINTS).toEqual([
      'rust',
      'python',
      'java',
      'cpp',
      'os-junk',
    ]);
  });

  test('convertV1ToV2: 严格等价映射为 presets: { node: {} }, 拒绝未知字段/空 roots/高版本/非对象', () => {
    const ok = convertV1ToV2({
      roots: ['/work'],
      exclude: ['vendor'],
      include: ['app'],
    });
    expect(ok.ok).toBe(true);
    if (ok.ok) {
      expect(ok.stored).toEqual({
        version: 2,
        roots: ['/work'],
        exclude: ['vendor'],
        include: ['app'],
        presets: { node: {} },
        rules: [],
      });
      expect(ok.stored.presets.rust).toBeUndefined();
      expect(ok.stored.presets.python).toBeUndefined();
      expect(ok.stored.presets.java).toBeUndefined();
      expect(ok.stored.presets.cpp).toBeUndefined();
      expect(ok.stored.presets['os-junk']).toBeUndefined();
      expect(ok.excludeExplicit).toBe(true);
    }

    expect(convertV1ToV2({ roots: ['/work'], extra: true }).ok).toBe(false);
    expect(convertV1ToV2({ roots: [] }).ok).toBe(false);
    expect(convertV1ToV2({ version: 3, roots: ['/work'] }).ok).toBe(false);
    expect(convertV1ToV2([]).ok).toBe(false);
  });
});

describe('migrate 路径迁移与就地升版 (红线 3)', () => {
  test('旧路径 sweep-node-modules/config.json → sweep/config.json 检测、写前备份与严格仅激活 node', async () => {
    const home = await makeTempHome();
    const legacyPath = join(
      home,
      '.config',
      'sweep-node-modules',
      'config.json',
    );
    const rawV1 = `${JSON.stringify({ roots: [home], exclude: ['vendor'] }, null, 2)}\n`;
    await writeText(legacyPath, rawV1);

    const env = {};
    const resolved = resolveConfigPath({
      platform: 'darwin',
      homedir: home,
      env,
    });
    const detected = await detectMigration(resolved, {
      platform: 'darwin',
      homedir: home,
      env,
    });

    expect(detected.state).toBe('migratable');
    if (detected.state !== 'migratable') throw new Error('应可迁移');
    expect(detected.fromLegacyPath).toBe(true);
    expect(detected.sourcePath).toBe(legacyPath);
    expect(detected.targetPath).toBe(resolved.path);
    expect(detected.lossless).toBe(true);

    const applied = await applyMigration(detected, { now: () => FIXED_DATE });
    const expectedBackup = join(
      dirname(legacyPath),
      'config.json.20261120_090807.modified',
    );
    expect(applied.backupPath).toBe(expectedBackup);
    // 写前备份与原文件逐字节一致
    expect(await readFile(expectedBackup, 'utf8')).toBe(rawV1);
    // 红线 3: 仅启用 node, 其余 5 个预设严格 undefined
    expect(applied.stored.presets).toEqual({ node: {} });
    expect(applied.config.presets).toEqual({ node: {} });
    expect(applied.stored.presets.rust).toBeUndefined();
    expect(applied.stored.presets.python).toBeUndefined();
    expect(applied.stored.presets.java).toBeUndefined();
    expect(applied.stored.presets.cpp).toBeUndefined();
    expect(applied.stored.presets['os-junk']).toBeUndefined();
    expect(applied.newAvailablePresets).toEqual([
      'rust',
      'python',
      'java',
      'cpp',
      'os-junk',
    ]);

    // 新路径落盘后可被 v2 loadConfig 正常装载
    const loaded = await loadConfig(resolved.path, { homedir: home });
    expect(loaded.state).toBe('ok');
    if (loaded.state === 'ok') {
      expect(loaded.excludeExplicit).toBe(true);
      expect(loaded.config.presets).toEqual({ node: {} });
      expect(loaded.config.exclude).toEqual(['vendor']);
    }
  });

  test('同路径 v1 ({ roots } 与 { version: 1, roots }) 就地升版并生成源目录逐字节备份', async () => {
    for (const payload of [
      { roots: ['/work/a'] },
      { version: 1, roots: ['/work/b'], include: ['pkg'] },
    ]) {
      const home = await makeTempHome();
      const targetPath = join(home, '.config', 'sweep', 'config.json');
      const rawV1 = `${JSON.stringify(payload, null, 2)}\n`;
      await writeText(targetPath, rawV1);

      const resolved = resolveConfigPath({
        platform: 'darwin',
        homedir: home,
        env: {},
      });
      const detected = await detectMigration(resolved, {
        platform: 'darwin',
        homedir: home,
        env: {},
      });
      expect(detected.state).toBe('migratable');
      if (detected.state !== 'migratable') throw new Error('应可就地升版');
      expect(detected.fromLegacyPath).toBe(false);

      const applied = await applyMigration(detected, { now: () => FIXED_DATE });
      expect(await readFile(applied.backupPath, 'utf8')).toBe(rawV1);
      expect(applied.stored.version).toBe(2);
      expect(applied.stored.exclude).toBeUndefined();
      expect(applied.excludeExplicit).toBe(false);
      expect(applied.stored.presets).toEqual({ node: {} });
      expect(applied.stored.presets.rust).toBeUndefined();
      expect(applied.stored.presets.python).toBeUndefined();
      expect(applied.stored.presets.java).toBeUndefined();
      expect(applied.stored.presets.cpp).toBeUndefined();
      expect(applied.stored.presets['os-junk']).toBeUndefined();
      expect(applied.newAvailablePresets).toEqual([
        'rust',
        'python',
        'java',
        'cpp',
        'os-junk',
      ]);

      const reloaded = await loadConfig(targetPath, { homedir: home });
      expect(reloaded.state).toBe('ok');
      if (reloaded.state === 'ok') {
        expect(reloaded.config.roots).toEqual(payload.roots);
        expect(reloaded.excludeExplicit).toBe(false);
      }
    }
  });
});

describe('migrate 安全中止与非无损边界', () => {
  test('备份路径 wx 冲突时立即中止, 原文件与既有备份均未篡改', async () => {
    const home = await makeTempHome();
    const configPath = join(home, '.config', 'sweep', 'config.json');
    const rawV1 = '{"roots":["/safe"]}\n';
    await writeText(configPath, rawV1);

    const conflictingBackup = buildMigrationBackupPath(configPath, FIXED_DATE);
    await writeText(conflictingBackup, 'existing-backup-do-not-overwrite');

    const resolved = { path: configPath, source: 'flag' as const };
    const detected = await detectMigration(resolved, { homedir: home });
    expect(detected.state).toBe('migratable');
    if (detected.state !== 'migratable') throw new Error('应检测到可迁移');

    let caught: unknown;
    try {
      await applyMigration(detected, { now: () => FIXED_DATE });
    } catch (error) {
      caught = error;
    }
    expect(isSweepErrorCode(caught, 'CONFIG_MIGRATION_FAILED')).toBe(true);
    expect(await readFile(configPath, 'utf8')).toBe(rawV1);
    expect(await readFile(conflictingBackup, 'utf8')).toBe(
      'existing-backup-do-not-overwrite',
    );
  });

  test('目标路径或备份路径锚点链含软链时立即中止, 原文件与受害目标均未篡改', async () => {
    const home = await makeTempHome();
    const realDir = join(home, 'real-cfg');
    const linkDir = join(home, 'link-cfg');
    await mkdir(realDir, { recursive: true });
    await symlink(realDir, linkDir, DIR_LINK);

    // 场景 A: 目标路径本身为符号链接 (旧路径迁新路径)
    const legacyPath = join(
      home,
      '.config',
      'sweep-node-modules',
      'config.json',
    );
    const victimFile = join(realDir, 'victim.json');
    const targetLink = join(home, '.config', 'sweep', 'config.json');
    await writeText(legacyPath, '{"roots":["/a"]}\n');
    await writeText(victimFile, '{"untouched":true}\n');
    await mkdir(dirname(targetLink), { recursive: true });
    await symlink(victimFile, targetLink);

    const detectedTargetLink = await detectMigration(
      { path: targetLink, source: 'flag' },
      { homedir: home },
    );
    // 手工验证 applyMigration 对符号链接目标的拦截
    let errA: unknown;
    try {
      await applyMigration(
        {
          state: 'migratable',
          sourcePath: legacyPath,
          targetPath: targetLink,
          fromLegacyPath: true,
          rawSource: '{"roots":["/a"]}\n',
          lossless: true,
          stored: {
            version: 2,
            roots: ['/a'],
            presets: { node: {} },
            rules: [],
          },
          config: {
            version: 2,
            roots: ['/a'],
            exclude: [],
            include: [],
            presets: { node: {} },
            rules: [],
          },
          excludeExplicit: false,
        },
        { now: () => FIXED_DATE },
      );
    } catch (error) {
      errA = error;
    }
    expect(detectedTargetLink.state).toBe('unsupported');
    expect(isSweepErrorCode(errA, 'CONFIG_MIGRATION_FAILED')).toBe(true);
    expect(await readFile(victimFile, 'utf8')).toBe('{"untouched":true}\n');
    expect(existsSync(buildMigrationBackupPath(legacyPath, FIXED_DATE))).toBe(
      false,
    );

    // 场景 B: 源路径经过软链目录导致备份路径含软链
    const sourceViaLink = join(linkDir, 'old.json');
    await writeText(join(realDir, 'old.json'), '{"roots":["/b"]}\n');
    const safeTarget = join(home, 'safe-target', 'config.json');
    let errB: unknown;
    try {
      await applyMigration(
        {
          state: 'migratable',
          sourcePath: sourceViaLink,
          targetPath: safeTarget,
          fromLegacyPath: true,
          rawSource: '{"roots":["/b"]}\n',
          lossless: true,
          stored: {
            version: 2,
            roots: ['/b'],
            presets: { node: {} },
            rules: [],
          },
          config: {
            version: 2,
            roots: ['/b'],
            exclude: [],
            include: [],
            presets: { node: {} },
            rules: [],
          },
          excludeExplicit: false,
        },
        { now: () => FIXED_DATE },
      );
    } catch (error) {
      errB = error;
    }
    expect(isSweepErrorCode(errB, 'CONFIG_MIGRATION_FAILED')).toBe(true);
    expect(existsSync(safeTarget)).toBe(false);
  });

  test('未知字段 / 空 roots / 未来版本 v3 / 畸形数组 JSON / 当前已 v2 分别返回 unsupported 或 none', async () => {
    const home = await makeTempHome();

    const checkInPlace = async (name: string, content: string) => {
      const p = join(home, name);
      await writeText(p, content);
      return detectMigration({ path: p, source: 'flag' }, { homedir: home });
    };

    expect(
      (
        await checkInPlace(
          'unknown-field.json',
          JSON.stringify({ roots: ['/a'], unknownKey: 1 }),
        )
      ).state,
    ).toBe('unsupported');
    expect(
      (await checkInPlace('empty-roots.json', JSON.stringify({ roots: [] })))
        .state,
    ).toBe('unsupported');
    expect(
      (
        await checkInPlace(
          'future-v3.json',
          JSON.stringify({ version: 3, roots: ['/a'] }),
        )
      ).state,
    ).toBe('unsupported');
    // 同路径畸形数组 JSON / 损坏 JSON 交由常规 loadConfig 报 CONFIG_CORRUPT_*
    expect((await checkInPlace('array.json', '[]')).state).toBe('none');
    expect((await checkInPlace('broken.json', '{ broken')).state).toBe('none');
    // 同路径合法 v2 无需迁移
    expect(
      (
        await checkInPlace(
          'already-v2.json',
          JSON.stringify({ version: 2, roots: ['/a'], presets: { node: {} } }),
        )
      ).state,
    ).toBe('none');

    // 旧路径出现畸形数组 JSON 则明确报 unsupported
    const legacyHome = await makeTempHome();
    const legacyPath = join(
      legacyHome,
      '.config',
      'sweep-node-modules',
      'config.json',
    );
    await writeText(legacyPath, '[]');
    const resolved = resolveConfigPath({
      platform: 'darwin',
      homedir: legacyHome,
      env: {},
    });
    const legacyArray = await detectMigration(resolved, {
      platform: 'darwin',
      homedir: legacyHome,
      env: {},
    });
    expect(legacyArray.state).toBe('unsupported');
  });
});
