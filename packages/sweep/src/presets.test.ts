/**
 * 六大内置技术栈预设 (node / rust / python / java / cpp / os-junk) 专项测试。
 * 重点覆盖正例命中、无锚点防误删反例、~/.gradle 与项目 .gradle 双重护栏、以及局部覆盖。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdir, mkdtemp, realpath, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXCLUDE } from './config.ts';
import { POSIX_STYLE, WIN32_STYLE } from './guard.ts';
import {
  OS_JUNK_FILES,
  PRESET_BY_NAME,
  PRESET_NAMES,
  createDefaultPresets,
  isPresetName,
  matchesAnyActivePresetLeaf,
  resolvePresetAction,
} from './presets.ts';
import {
  canBypassDefaultGradleExclude,
  createScanMatcher,
} from './scan-match.ts';
import { createParallelScanner } from './scan-parallel.ts';
import { createSweeper } from './sweep.ts';

const dirs: string[] = [];

async function makeTempRoot(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'sweep-lab-presets-'));
  const real = await realpath(raw);
  dirs.push(real);
  return real;
}

async function touch(filePath: string, content = ''): Promise<void> {
  await mkdir(join(filePath, '..'), { recursive: true });
  await writeFile(filePath, content, 'utf8');
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});

describe('presets 注册表与工具函数', () => {
  test('6 大内置预设顺序稳定、类型守卫与默认动作正确', () => {
    expect(PRESET_NAMES).toEqual([
      'node',
      'rust',
      'python',
      'java',
      'cpp',
      'os-junk',
    ]);
    expect(isPresetName('node')).toBe(true);
    expect(isPresetName('os-junk')).toBe(true);
    expect(isPresetName('golang')).toBe(false);
    expect(createDefaultPresets()).toEqual({
      node: {},
      rust: {},
      python: {},
      java: {},
      cpp: {},
      'os-junk': {},
    });
    expect(resolvePresetAction('rust')).toBe('delete');
    expect(resolvePresetAction('rust', { action: 'trash' })).toBe('trash');
    expect([...OS_JUNK_FILES].sort()).toEqual([
      '.DS_Store',
      'Thumbs.db',
      'ehthumbs.db',
      'ehthumbs_vista.db',
    ]);
  });

  test('matchesAnyActivePresetLeaf 仅放行已激活预设对应的叶名', () => {
    expect(matchesAnyActivePresetLeaf('target', { rust: {} })).toBe(true);
    expect(matchesAnyActivePresetLeaf('target', { node: {} })).toBe(false);
    expect(matchesAnyActivePresetLeaf('cmake-build-debug', { cpp: {} })).toBe(
      true,
    );
    expect(matchesAnyActivePresetLeaf('cmake-build-', { cpp: {} })).toBe(false);
    expect(matchesAnyActivePresetLeaf('.DS_Store', { 'os-junk': {} })).toBe(
      true,
    );
    expect(matchesAnyActivePresetLeaf('desktop.ini', { 'os-junk': {} })).toBe(
      false,
    );
  });
});

describe('presets 锚定校验: node / rust / python / cpp', () => {
  test('node: 有同级普通文件 package.json 命中, 裸 node_modules 与目录同名假锚点跳过', async () => {
    const root = await makeTempRoot();
    // 正例: 同级普通文件 package.json
    await mkdir(join(root, 'valid-app', 'node_modules'), { recursive: true });
    await touch(join(root, 'valid-app', 'package.json'), '{}');
    // 反例 1: 裸 node_modules 无 package.json
    await mkdir(join(root, 'bare-dir', 'node_modules'), { recursive: true });
    // 反例 2: package.json 是目录而非普通文件
    await mkdir(join(root, 'dir-anchor', 'node_modules'), { recursive: true });
    await mkdir(join(root, 'dir-anchor', 'package.json'), { recursive: true });

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { node: {} },
    });

    expect(hits).toEqual([
      {
        project: join(root, 'valid-app'),
        target: join(root, 'valid-app', 'node_modules'),
        root,
        entryKind: 'dir',
        action: 'delete',
        source: { kind: 'preset', name: 'node' },
      },
    ]);
  });

  test('rust: 有同级 Cargo.toml 的 target 命中, 无 Cargo.toml 跳过且继续下钻子项目', async () => {
    const root = await makeTempRoot();
    await mkdir(join(root, 'my-crate', 'target'), { recursive: true });
    await touch(join(root, 'my-crate', 'Cargo.toml'), '[package]\n');
    // 反例: 业务 target 无 Cargo.toml, 其内部嵌套一个真 Rust 子项目
    await mkdir(join(root, 'business', 'target', 'nested-crate', 'target'), {
      recursive: true,
    });
    await touch(
      join(root, 'business', 'target', 'nested-crate', 'Cargo.toml'),
      '[package]\n',
    );

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { rust: {} },
    });

    expect(hits.map((h) => h.target)).toEqual([
      join(root, 'business', 'target', 'nested-crate', 'target'),
      join(root, 'my-crate', 'target'),
    ]);
    expect(
      hits.every(
        (h) => h.source?.kind === 'preset' && h.source.name === 'rust',
      ),
    ).toBe(true);
  });

  test('python: 虚拟环境三锚点命中、裸 venv 跳过, 四类工具缓存目录直接命中', async () => {
    const root = await makeTempRoot();
    // 虚拟环境正例 1: pyproject.toml
    await mkdir(join(root, 'py-toml', '.venv'), { recursive: true });
    await touch(join(root, 'py-toml', 'pyproject.toml'), '');
    // 虚拟环境正例 2: requirements.txt
    await mkdir(join(root, 'py-req', 'venv'), { recursive: true });
    await touch(join(root, 'py-req', 'requirements.txt'), '');
    // 虚拟环境正例 3: 内含 pyvenv.cfg
    await mkdir(join(root, 'py-cfg', '.venv'), { recursive: true });
    await touch(join(root, 'py-cfg', '.venv', 'pyvenv.cfg'), 'home = /usr\n');
    // 虚拟环境反例: 裸 .venv 与裸 venv
    await mkdir(join(root, 'bare-1', '.venv'), { recursive: true });
    await mkdir(join(root, 'bare-2', 'venv'), { recursive: true });
    // 四类工具缓存目录
    for (const cache of [
      '__pycache__',
      '.pytest_cache',
      '.mypy_cache',
      '.ruff_cache',
    ]) {
      await mkdir(join(root, 'pkg', cache), { recursive: true });
    }

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { python: {} },
    });

    expect(hits.map((h) => h.target)).toEqual(
      [
        join(root, 'pkg', '.mypy_cache'),
        join(root, 'pkg', '.pytest_cache'),
        join(root, 'pkg', '.ruff_cache'),
        join(root, 'pkg', '__pycache__'),
        join(root, 'py-cfg', '.venv'),
        join(root, 'py-req', 'venv'),
        join(root, 'py-toml', '.venv'),
      ].sort(),
    );
  });

  test('cpp: build 与 cmake-build-* 经 CMakeLists.txt 或内含 CMakeCache.txt 命中, 裸 build 跳过', async () => {
    const root = await makeTempRoot();
    // 正例 1: 同级 CMakeLists.txt + build & cmake-build-debug
    await mkdir(join(root, 'cmake-app', 'build'), { recursive: true });
    await mkdir(join(root, 'cmake-app', 'cmake-build-debug'), {
      recursive: true,
    });
    await touch(join(root, 'cmake-app', 'CMakeLists.txt'), 'project(x)\n');
    // 正例 2: 无同级清单但内含 CMakeCache.txt
    await mkdir(join(root, 'out-of-tree', 'cmake-build-release'), {
      recursive: true,
    });
    await touch(
      join(root, 'out-of-tree', 'cmake-build-release', 'CMakeCache.txt'),
      '# cache\n',
    );
    // 反例: 裸业务 build 与空后缀 cmake-build-
    await mkdir(join(root, 'biz', 'build'), { recursive: true });
    await mkdir(join(root, 'cmake-app', 'cmake-build-'), { recursive: true });

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { cpp: {} },
    });

    expect(hits.map((h) => h.target)).toEqual(
      [
        join(root, 'cmake-app', 'build'),
        join(root, 'cmake-app', 'cmake-build-debug'),
        join(root, 'out-of-tree', 'cmake-build-release'),
      ].sort(),
    );
  });
});

describe('presets 锚定校验: java 双重护栏与 os-junk 白名单', () => {
  test('java: Maven/Gradle 正反例与 ~/.gradle 全局缓存 vs 项目 .gradle 双重护栏', async () => {
    const fakeHome = await makeTempRoot();
    // 家目录全局 ~/.gradle (即使放了诱饵 build.gradle 也必须受保护)
    await mkdir(join(fakeHome, '.gradle', 'caches'), { recursive: true });
    await touch(join(fakeHome, 'build.gradle'), '// bait\n');
    // Maven 正反例
    await mkdir(join(fakeHome, 'dev', 'mvn-ok', 'target'), { recursive: true });
    await touch(join(fakeHome, 'dev', 'mvn-ok', 'pom.xml'), '<project/>');
    await mkdir(join(fakeHome, 'dev', 'mvn-bare', 'target'), {
      recursive: true,
    });
    // Gradle 正例 (build.gradle.kts / settings.gradle)
    await mkdir(join(fakeHome, 'dev', 'gr-kts', '.gradle'), {
      recursive: true,
    });
    await mkdir(join(fakeHome, 'dev', 'gr-kts', 'build'), { recursive: true });
    await touch(join(fakeHome, 'dev', 'gr-kts', 'build.gradle.kts'), '');
    await mkdir(join(fakeHome, 'dev', 'gr-settings', '.gradle'), {
      recursive: true,
    });
    await touch(join(fakeHome, 'dev', 'gr-settings', 'settings.gradle'), '');
    // Gradle 反例: 无锚点目录中的 build 与 .gradle
    await mkdir(join(fakeHome, 'dev', 'gr-bare', 'build'), { recursive: true });
    await mkdir(join(fakeHome, 'dev', 'gr-bare', '.gradle'), {
      recursive: true,
    });

    // 1. 默认护栏 (excludeExplicit: false): ~/.gradle 严禁命中, 项目 .gradle 放行命中
    const defaultScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: [...DEFAULT_EXCLUDE],
      excludeExplicit: false,
      include: [],
      presets: { java: {} },
    });

    const expectedDefault = [
      join(fakeHome, 'dev', 'gr-kts', '.gradle'),
      join(fakeHome, 'dev', 'gr-kts', 'build'),
      join(fakeHome, 'dev', 'gr-settings', '.gradle'),
      join(fakeHome, 'dev', 'mvn-ok', 'target'),
    ].sort();
    expect(defaultScan.hits.map((h) => h.target)).toEqual(expectedDefault);
    expect(
      defaultScan.hits.some((h) => h.target === join(fakeHome, '.gradle')),
    ).toBe(false);

    // 2. 用户显式 excludeExplicit: true 且名单含 .gradle → 项目 .gradle 也被拦截
    const explicitExcludeScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: [...DEFAULT_EXCLUDE],
      excludeExplicit: true,
      include: [],
      presets: { java: {} },
    });
    expect(explicitExcludeScan.hits.map((h) => h.target)).toEqual(
      [
        join(fakeHome, 'dev', 'gr-kts', 'build'),
        join(fakeHome, 'dev', 'mvn-ok', 'target'),
      ].sort(),
    );

    // 3. 预设局部 presets.java.exclude 含 .gradle -> 项目 .gradle 被拦截
    const localExcludeScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: [...DEFAULT_EXCLUDE],
      excludeExplicit: false,
      include: [],
      presets: { java: { exclude: ['.gradle'] } },
    });
    expect(localExcludeScan.hits.map((h) => h.target)).toEqual(
      [
        join(fakeHome, 'dev', 'gr-kts', 'build'),
        join(fakeHome, 'dev', 'mvn-ok', 'target'),
      ].sort(),
    );

    // 4. 显式不含 .gradle 的 exclude + excludeExplicit: true + java & os-junk:
    // 项目 .gradle 正常命中, ~/.gradle 与无锚点 .gradle 一律剪枝严禁下钻扫出内部 .DS_Store
    await touch(join(fakeHome, '.gradle', 'caches', '.DS_Store'), 'junk');
    await touch(
      join(fakeHome, 'dev', 'gr-bare', '.gradle', 'sub', '.DS_Store'),
      'junk',
    );
    await touch(
      join(fakeHome, 'dev', 'gr-kts', '.gradle', 'caches', '.DS_Store'),
      'junk',
    );
    const customExcludeScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: ['archive'],
      excludeExplicit: true,
      include: [],
      presets: { java: {}, 'os-junk': {} },
    });
    expect(customExcludeScan.hits.map((h) => h.target)).toEqual(
      expectedDefault,
    );
    const osJunkOnlyScan = await createParallelScanner().scan({
      roots: [fakeHome],
      home: fakeHome,
      exclude: ['archive'],
      excludeExplicit: true,
      include: [],
      presets: { 'os-junk': {} },
    });
    expect(osJunkOnlyScan.hits).toEqual([]);
  });

  test('java: win32 下 parentDir 与 home 大小写/正反斜杠/尾斜杠不同仍保护 ~/.gradle, posix 保持区分大小写', async () => {
    const siblings = new Set(['build.gradle']);
    const winMatcher = createScanMatcher({
      presets: { java: {} },
      excludeExplicit: false,
      rawHome: 'C:\\Users\\Alice\\',
      realHome: 'C:\\Users\\Alice',
      style: WIN32_STYLE,
    });
    expect(
      canBypassDefaultGradleExclude(
        '.gradle',
        'c:/users/alice',
        siblings,
        winMatcher,
      ),
    ).toBe(false);
    expect(
      canBypassDefaultGradleExclude(
        '.gradle',
        'c:/users/alice/dev/app',
        siblings,
        winMatcher,
      ),
    ).toBe(true);
    expect(
      await PRESET_BY_NAME.java.verifyAnchor({
        name: '.gradle',
        kind: 'dir',
        parentDir: 'c:/users/alice',
        targetPath: 'c:/users/alice/.gradle',
        siblingFiles: siblings,
        realHome: 'C:\\Users\\Alice\\',
        style: WIN32_STYLE,
      }),
    ).toBe(false);

    const posixMatcher = createScanMatcher({
      presets: { java: {} },
      excludeExplicit: false,
      rawHome: '/Users/Alice',
      realHome: '/Users/Alice',
      style: POSIX_STYLE,
    });
    expect(
      canBypassDefaultGradleExclude(
        '.gradle',
        '/Users/Alice/',
        siblings,
        posixMatcher,
      ),
    ).toBe(false);
    expect(
      canBypassDefaultGradleExclude(
        '.gradle',
        '/Users/alice',
        siblings,
        posixMatcher,
      ),
    ).toBe(true);
  });

  test('os-junk: 仅精确匹配 4 个普通文件, 严禁命中 desktop.ini / .directory / ._foo 及同名目录', async () => {
    const root = await makeTempRoot();
    // 4 个合法正例文件
    const allowed = [
      '.DS_Store',
      'Thumbs.db',
      'ehthumbs.db',
      'ehthumbs_vista.db',
    ];
    for (const file of allowed) {
      await touch(join(root, 'files', file), 'junk');
    }
    // 反例文件: 严禁命中
    await touch(join(root, 'files', 'desktop.ini'), 'keep');
    await touch(join(root, 'files', '.directory'), 'keep');
    await touch(join(root, 'files', '._foo'), 'keep');
    await touch(join(root, 'files', '._DS_Store'), 'keep');
    // 反例目录: 与 .DS_Store / Thumbs.db 同名的目录严禁命中
    await mkdir(join(root, 'dirs', '.DS_Store'), { recursive: true });
    await mkdir(join(root, 'dirs', 'Thumbs.db'), { recursive: true });

    const { hits } = await createParallelScanner().scan({
      roots: [root],
      exclude: [],
      include: [],
      presets: { 'os-junk': {} },
    });

    expect(hits.map((h) => h.target)).toEqual(
      allowed.map((f) => join(root, 'files', f)).sort(),
    );
    expect(hits.every((h) => h.entryKind === 'file')).toBe(true);
    expect(
      hits.every(
        (h) => h.source?.kind === 'preset' && h.source.name === 'os-junk',
      ),
    ).toBe(true);
  });
});

describe('presets 局部过滤与 action 覆盖', () => {
  test('预设局部 exclude / include 收紧范围, action: trash 贯穿 plan 与 run', async () => {
    const root = await makeTempRoot();
    for (const dir of ['team-a/keep', 'team-a/drop', 'team-b/other']) {
      await mkdir(join(root, dir, 'target'), { recursive: true });
      await touch(join(root, dir, 'Cargo.toml'), '[package]\n');
    }

    const trashedArgs: string[] = [];
    const sweeper = createSweeper({
      roots: [root],
      exclude: [],
      presets: {
        rust: {
          action: 'trash',
          include: ['team-a'],
          exclude: ['keep'],
        },
      },
      trashDeps: {
        platform: 'darwin',
        existsSync: () => true,
        execFile: async (_bin, args) => {
          trashedArgs.push(...args);
          return { code: 0, stdout: '', stderr: '' };
        },
      },
    });

    const plan = await sweeper.plan();
    const expectedTarget = join(root, 'team-a', 'drop', 'target');
    expect(plan.entries).toHaveLength(1);
    expect(plan.entries[0]).toMatchObject({
      target: expectedTarget,
      entryKind: 'dir',
      action: 'trash',
      source: { kind: 'preset', name: 'rust' },
      inBatch: true,
    });

    const report = await sweeper.run();
    expect(report.status).toBe('executed');
    expect(report.removal?.trashed).toEqual([expectedTarget]);
    expect(report.removal?.removed).toEqual([]);
    expect(report.entries[0]?.outcome).toEqual({ kind: 'trashed' });
    expect(trashedArgs).toEqual(['-s', expectedTarget]);
  });
});
