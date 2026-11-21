/**
 * 配置 v2 契约测试: 定位 (三级覆盖 + 平台矩阵 + 旧路径)、32 项默认护栏、
 * 装载校验 (v2 归一化 / 缺省 roots / 硬拒绝项 / v1 触发迁移码) 与名单合并。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  CONFIG_ENV_VAR,
  CONFIG_VERSION,
  DEFAULT_EXCLUDE,
  createDefaultConfig,
  loadConfig,
  loadResolvedConfig,
  mergeNames,
  resolveConfigPath,
  resolveDefaultRoot,
  resolveLegacyConfigPath,
} from './config.ts';
import { isSweepError } from './errors.ts';

const dirs: string[] = [];

async function makeDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sweep-lab-config-'));
  dirs.push(dir);
  return dir;
}

async function writeConfig(name: string, text: string): Promise<string> {
  const path = join(await makeDir(), name);
  await writeFile(path, text);
  return path;
}

/** 捕获 rejection 并断言为 SweepError, 返回 code / details / message / cause */
async function catchSweepError(failure: Promise<unknown>): Promise<{
  code: string;
  details: unknown;
  message: string;
  cause: unknown;
}> {
  let caught: unknown;
  try {
    await failure;
  } catch (error) {
    caught = error;
  }
  expect(isSweepError(caught)).toBe(true);
  if (!isSweepError(caught)) throw new Error('应抛 SweepError');
  return {
    code: caught.code,
    details: caught.details,
    message: caught.message,
    cause: caught.cause,
  };
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});

describe('config v2 契约: 路径定位与常量', () => {
  test('优先级: --config > SWEEP_CONFIG > 平台默认 (sweep/config.json)', () => {
    expect(CONFIG_VERSION).toBe(2);
    expect(CONFIG_ENV_VAR).toBe('SWEEP_CONFIG');
    const env = { SWEEP_CONFIG: '/env/config.json' };
    const base = { platform: 'darwin', homedir: '/Users/u', env };

    expect(resolveConfigPath({ ...base, flag: './custom.json' })).toEqual({
      path: './custom.json',
      source: 'flag',
    });
    expect(resolveConfigPath(base)).toEqual({
      path: '/env/config.json',
      source: 'env',
    });
    expect(resolveConfigPath({ ...base, env: {} })).toEqual({
      path: '/Users/u/.config/sweep/config.json',
      source: 'platform-default',
    });
  });

  test('三端平台默认路径与旧路径 (sweep-node-modules/config.json)', () => {
    expect(
      resolveConfigPath({ platform: 'linux', homedir: '/home/u', env: {} }),
    ).toEqual({
      path: '/home/u/.config/sweep/config.json',
      source: 'platform-default',
    });
    expect(
      resolveConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\u',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      }),
    ).toEqual({
      path: 'C:\\Users\\u\\AppData\\Roaming\\sweep\\config.json',
      source: 'platform-default',
    });
    expect(
      resolveConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\u',
        env: { USERPROFILE: 'D:\\home\\u' },
      }),
    ).toEqual({
      path: 'D:\\home\\u\\AppData\\Roaming\\sweep\\config.json',
      source: 'platform-default',
    });
    expect(
      resolveConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\u',
        env: {},
      }),
    ).toEqual({
      path: 'C:\\Users\\u\\AppData\\Roaming\\sweep\\config.json',
      source: 'platform-default',
    });
    expect(
      resolveConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\u',
        env: {
          SWEEP_CONFIG: 'D:\\etc\\sweep.json',
          APPDATA: 'C:\\Users\\u\\AppData\\Roaming',
        },
      }),
    ).toEqual({ path: 'D:\\etc\\sweep.json', source: 'env' });

    expect(
      resolveLegacyConfigPath({
        platform: 'darwin',
        homedir: '/Users/u',
        env: {},
      }),
    ).toBe('/Users/u/.config/sweep-node-modules/config.json');
    expect(
      resolveLegacyConfigPath({
        platform: 'win32',
        homedir: 'C:\\Users\\u',
        env: { APPDATA: 'C:\\Users\\u\\AppData\\Roaming' },
      }),
    ).toBe('C:\\Users\\u\\AppData\\Roaming\\sweep-node-modules\\config.json');
  });

  test('DEFAULT_EXCLUDE 为已冻结的 32 项三端家目录安全护栏, createDefaultConfig 生成完整 v2 配置', async () => {
    expect(Object.isFrozen(DEFAULT_EXCLUDE)).toBe(true);
    expect(DEFAULT_EXCLUDE).toHaveLength(32);
    const mustHave = [
      '.Trash',
      'Trash',
      '$Recycle.Bin',
      'AppData',
      'scoop',
      '.cargo',
      '.rustup',
      '.m2',
      '.gradle',
      '.conda',
      '.pyenv',
      '.uv',
    ];
    for (const item of mustHave) {
      expect(DEFAULT_EXCLUDE).toContain(item);
    }

    const fakeHome = await makeDir();
    const realHome = await realpath(fakeHome);
    expect(resolveDefaultRoot(fakeHome)).toBe(realHome);
    const created = createDefaultConfig({ homedir: fakeHome });
    expect(created).toEqual({
      version: 2,
      roots: [realHome],
      presets: {
        node: {},
        rust: {},
        python: {},
        java: {},
        cpp: {},
        'os-junk': {},
      },
      rules: [],
    });
  });
});

describe('config v2 契约: 装载正常态 (loadConfig)', () => {
  test('完整 v2 配置按原样读出, rules[].action 缺省强制补为 trash', async () => {
    const path = await writeConfig(
      'config.json',
      JSON.stringify({
        version: 2,
        roots: ['/a', '/b'],
        exclude: ['x'],
        include: ['y'],
        presets: { node: {}, rust: { action: 'trash' } },
        rules: [
          { name: '旧日志', kind: 'file', match: '*.log', olderThanDays: 14 },
          { name: '临时包', kind: 'dir', match: 'tmp-*', action: 'delete' },
        ],
      }),
    );

    expect(await loadConfig(path)).toEqual({
      state: 'ok',
      excludeExplicit: true,
      config: {
        version: 2,
        roots: ['/a', '/b'],
        exclude: ['x'],
        include: ['y'],
        presets: { node: {}, rust: { action: 'trash' } },
        rules: [
          {
            name: '旧日志',
            kind: 'file',
            match: '*.log',
            action: 'trash',
            olderThanDays: 14,
          },
          { name: '临时包', kind: 'dir', match: 'tmp-*', action: 'delete' },
        ],
      },
    });
  });

  test('极简 v2 配置: 省略 roots 取 [realpath(homedir)], 省略 exclude 取 32 项护栏', async () => {
    const fakeHome = await makeDir();
    const realHome = await realpath(fakeHome);
    const path = await writeConfig(
      'minimal.json',
      JSON.stringify({ version: 2, presets: { node: {} } }),
    );

    expect(await loadConfig(path, { homedir: fakeHome })).toEqual({
      state: 'ok',
      excludeExplicit: false,
      config: {
        version: 2,
        roots: [realHome],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
        presets: { node: {} },
        rules: [],
      },
    });
  });

  test('显式写出 exclude: [] 接管默认值且标记 excludeExplicit: true', async () => {
    const path = await writeConfig(
      'explicit-empty.json',
      JSON.stringify({ version: 2, roots: ['/a'], exclude: [], include: [] }),
    );

    expect(await loadConfig(path)).toEqual({
      state: 'ok',
      excludeExplicit: true,
      config: {
        version: 2,
        roots: ['/a'],
        exclude: [],
        include: [],
        presets: {},
        rules: [],
      },
    });
  });

  test('absent: 文件与目录均不存在返回 absent, 不抛错', async () => {
    const dir = await makeDir();
    expect(await loadConfig(join(dir, 'no-such-dir', 'config.json'))).toEqual({
      state: 'absent',
    });
  });
});

describe('config v2 契约: 迁移拦截与硬拒绝 (loadConfig)', () => {
  test('旧版 v1 (缺 version 或 version: 1) 抛 CONFIG_NEEDS_MIGRATION', async () => {
    const v1NoVer = await writeConfig(
      'v1-no-ver.json',
      JSON.stringify({ roots: ['/a'], exclude: [] }),
    );
    const err1 = await catchSweepError(loadConfig(v1NoVer));
    expect(err1.code).toBe('CONFIG_NEEDS_MIGRATION');
    expect(err1.details).toEqual({ path: v1NoVer, version: 1 });

    const v1Explicit = await writeConfig(
      'v1-explicit.json',
      JSON.stringify({ version: 1, roots: ['/a'] }),
    );
    const err2 = await catchSweepError(loadConfig(v1Explicit));
    expect(err2.code).toBe('CONFIG_NEEDS_MIGRATION');
    expect(err2.details).toEqual({ path: v1Explicit, version: 1 });
  });

  test('显式 roots: [] 与空串元素硬报错拒绝 (CONFIG_CORRUPT_SHAPE)', async () => {
    const emptyRoots = await writeConfig(
      'empty-roots.json',
      JSON.stringify({ version: 2, roots: [] }),
    );
    const err1 = await catchSweepError(loadConfig(emptyRoots));
    expect(err1.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(err1.details).toEqual({ path: emptyRoots, field: 'roots' });

    const blankItem = await writeConfig(
      'blank-root.json',
      JSON.stringify({ version: 2, roots: ['/a', ''] }),
    );
    const err2 = await catchSweepError(loadConfig(blankItem));
    expect(err2.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(err2.details).toEqual({ path: blankItem, field: 'roots[1]' });
  });

  test('presets.<k>.enabled 与未知预设键硬报错拒绝', async () => {
    const withEnabled = await writeConfig(
      'enabled.json',
      JSON.stringify({
        version: 2,
        roots: ['/a'],
        presets: { node: { enabled: true } },
      }),
    );
    const err1 = await catchSweepError(loadConfig(withEnabled));
    expect(err1.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(err1.details).toEqual({
      path: withEnabled,
      field: 'presets.node.enabled',
    });

    const unknownPreset = await writeConfig(
      'unknown-preset.json',
      JSON.stringify({
        version: 2,
        roots: ['/a'],
        presets: { golang: {} },
      }),
    );
    const err2 = await catchSweepError(loadConfig(unknownPreset));
    expect(err2.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(err2.details).toEqual({
      path: unknownPreset,
      field: 'presets.golang',
    });
  });

  test('rules[].match 非法值硬报错拒绝', async () => {
    for (const badMatch of ['', '.', '..', '.git', '*', 'a/b']) {
      const path = await writeConfig(
        'bad-rule.json',
        JSON.stringify({
          version: 2,
          roots: ['/a'],
          rules: [{ name: 'bad', kind: 'any', match: badMatch }],
        }),
      );
      const err = await catchSweepError(loadConfig(path));
      expect(err.code, `match=${badMatch}`).toBe('CONFIG_CORRUPT_SHAPE');
      expect(err.details).toEqual({ path, field: 'rules[0].match' });
    }
  });

  test('JSON 损坏 / 顶层非对象 / 高版本 / 读取目录分别抛对应结构化错误码', async () => {
    const broken = await writeConfig('broken.json', '{ invalid');
    const jsonErr = await catchSweepError(loadConfig(broken));
    expect(jsonErr.code).toBe('CONFIG_CORRUPT_JSON');
    expect(jsonErr.details).toEqual({ path: broken });
    expect(jsonErr.cause).toBeInstanceOf(Error);

    const asArray = await writeConfig('array.json', '[]');
    const arrErr = await catchSweepError(loadConfig(asArray));
    expect(arrErr.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(arrErr.details).toEqual({ path: asArray, field: '<root>' });

    const future = await writeConfig(
      'v3.json',
      JSON.stringify({ version: 3, roots: ['/a'] }),
    );
    const verErr = await catchSweepError(loadConfig(future));
    expect(verErr.code).toBe('CONFIG_CORRUPT_SHAPE');
    expect(verErr.details).toEqual({ path: future, field: 'version' });

    const dir = await makeDir();
    const readErr = await catchSweepError(loadConfig(dir));
    expect(readErr.code).toBe('CONFIG_READ_FAILED');
    expect((readErr.details as { path?: string }).path).toBe(dir);

    for (const field of ['exclude', 'include'] as const) {
      const emptyItemCfg = await writeConfig(
        `empty-${field}.json`,
        JSON.stringify({ version: 2, roots: ['/a'], [field]: [''] }),
      );
      const emptyErr = await catchSweepError(loadConfig(emptyItemCfg));
      expect(emptyErr.code).toBe('CONFIG_CORRUPT_SHAPE');
      expect(emptyErr.details).toEqual({
        path: emptyItemCfg,
        field: `${field}[0]`,
      });
    }
  });
});

describe('config v2 契约: 显式来源与名单合并', () => {
  const base = { platform: 'darwin', homedir: '/no-such-home', env: {} };

  test('loadResolvedConfig: flag / SWEEP_CONFIG 缺失抛 CONFIG_ABSENT, 平台默认返回 absent', async () => {
    const missing = join(await makeDir(), 'no-such.json');
    const flagErr = await catchSweepError(
      loadResolvedConfig(resolveConfigPath({ ...base, flag: missing })),
    );
    expect(flagErr.code).toBe('CONFIG_ABSENT');
    expect(flagErr.details).toEqual({ path: missing, source: 'flag' });

    const envErr = await catchSweepError(
      loadResolvedConfig(
        resolveConfigPath({ ...base, env: { SWEEP_CONFIG: missing } }),
      ),
    );
    expect(envErr.code).toBe('CONFIG_ABSENT');
    expect(envErr.details).toEqual({ path: missing, source: 'env' });

    expect(await loadResolvedConfig(resolveConfigPath(base))).toEqual({
      state: 'absent',
    });
  });

  test('mergeNames: 去重保序、不改动入参、仅静默剔除 .git (保留 node_modules 与大小写变体)', () => {
    const cfg = ['.git', 'node_modules', 'dist'];
    const cli = ['dist', '.git', 'docs-site', '.GIT'];
    expect(mergeNames(cfg, cli)).toEqual([
      'node_modules',
      'dist',
      'docs-site',
      '.GIT',
    ]);
    expect(cfg).toEqual(['.git', 'node_modules', 'dist']);
    expect(cli).toEqual(['dist', '.git', 'docs-site', '.GIT']);
    expect(mergeNames(['.git'], ['.git'])).toEqual([]);
  });
});
