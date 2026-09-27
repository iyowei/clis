/**
 * 删除安全闸契约测试: 五不变量 × 平台矩阵。
 * 字符串级判定走 posix / win32 纯样本 (不依赖真实文件系统); 真实语义 (符号链接、
 * 目录包含性、根锚点链) 由 fixtures 真实目录样本覆盖; 设备边界 (st_dev 比对) 另成
 * 一册 (guard.device.contract.test.ts), 判定不同源、注入面也不同。
 * 设计: docs/designs/deletion-guard.md; 可移植性: docs/adrs/0007-platform-portability.md。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdir, realpath, symlink, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import {
  POSIX_STYLE,
  WIN32_STYLE,
  anchorChainPaths,
  dedupeKey,
  firstSymlinkOnAnchor,
  firstSymlinkOnRoot,
  firstSymlinkOnTarget,
  hasNodeModulesLeaf,
  insideAnyRoot,
  isFilesystemRootBody,
  isHomeBody,
  validateTargets,
} from './guard.ts';

const workspaces: Workspace[] = [];
async function make(spec: WorkspaceSpec): Promise<Workspace> {
  const workspace = await makeWorkspace(spec);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
  workspaces.length = 0;
});

describe('不变量 ① 末段恰为 node_modules (纯判定)', () => {
  test('posix: 末段为 node_modules, 含尾分隔符写法', () => {
    expect(hasNodeModulesLeaf('/work/app/node_modules', POSIX_STYLE)).toBe(
      true,
    );
    expect(hasNodeModulesLeaf('/work/app/node_modules/', POSIX_STYLE)).toBe(
      true,
    );
  });

  test('posix: 大小写敏感, 近似名与普通目录均不符', () => {
    expect(hasNodeModulesLeaf('/work/app/NODE_MODULES', POSIX_STYLE)).toBe(
      false,
    );
    expect(hasNodeModulesLeaf('/work/app/node_modules.bak', POSIX_STYLE)).toBe(
      false,
    );
    expect(hasNodeModulesLeaf('/work/app', POSIX_STYLE)).toBe(false);
  });

  test('win32: 大小写不敏感, NODE_MODULES 视为同一目录', () => {
    expect(hasNodeModulesLeaf('C:\\Repo\\App\\node_modules', WIN32_STYLE)).toBe(
      true,
    );
    expect(hasNodeModulesLeaf('C:\\Repo\\App\\NODE_MODULES', WIN32_STYLE)).toBe(
      true,
    );
    expect(hasNodeModulesLeaf('C:\\Repo\\App\\src', WIN32_STYLE)).toBe(false);
  });
});

describe('不变量 ② realpath 位于某 root 之下 (纯判定)', () => {
  test('posix: 根内命中; 多根任一命中即可', () => {
    expect(
      insideAnyRoot('/work/app/node_modules', ['/work'], POSIX_STYLE),
    ).toBe(true);
    expect(
      insideAnyRoot('/other/x/node_modules', ['/work', '/other'], POSIX_STYLE),
    ).toBe(true);
  });

  test('posix: 前缀相似但实际越界 (字符串前缀比较会误放行)', () => {
    expect(
      insideAnyRoot(
        '/work/proj-evil/node_modules',
        ['/work/proj'],
        POSIX_STYLE,
      ),
    ).toBe(false);
    expect(insideAnyRoot('/work2/node_modules', ['/work'], POSIX_STYLE)).toBe(
      false,
    );
  });

  test('posix: ../ 上溯逃逸', () => {
    expect(
      insideAnyRoot(
        '/work/proj/../other/node_modules',
        ['/work/proj'],
        POSIX_STYLE,
      ),
    ).toBe(false);
    expect(insideAnyRoot('/other/node_modules', ['/work'], POSIX_STYLE)).toBe(
      false,
    );
  });

  test('posix: 等于 root 本体视为不通过 (严格子路径)', () => {
    expect(
      insideAnyRoot('/work/node_modules', ['/work/node_modules'], POSIX_STYLE),
    ).toBe(false);
  });

  test('win32: 大小写不同仍视为根内', () => {
    expect(
      insideAnyRoot('C:\\Repo\\App\\node_modules', ['c:\\repo'], WIN32_STYLE),
    ).toBe(true);
    expect(
      insideAnyRoot('c:\\repo\\app\\node_modules', ['C:\\Repo'], WIN32_STYLE),
    ).toBe(true);
  });

  test('win32: 跨盘符拒绝 (relative 返回绝对路径即逃逸)', () => {
    expect(
      insideAnyRoot('D:\\App\\node_modules', ['C:\\Repo'], WIN32_STYLE),
    ).toBe(false);
  });
});

describe('不变量 ③ 拒绝 / 本体与 home 本体 (纯判定)', () => {
  test('posix: 文件系统根本体', () => {
    expect(isFilesystemRootBody('/', POSIX_STYLE)).toBe(true);
    expect(isFilesystemRootBody('/work/node_modules', POSIX_STYLE)).toBe(false);
  });

  test('posix: home 本体; 其下的 node_modules 不受影响', () => {
    expect(isHomeBody('/Users/x', '/Users/x', POSIX_STYLE)).toBe(true);
    expect(
      isHomeBody('/Users/x/work/node_modules', '/Users/x', POSIX_STYLE),
    ).toBe(false);
  });

  test('home 传 null: 关闭该防线', () => {
    expect(isHomeBody('/Users/x', null, POSIX_STYLE)).toBe(false);
  });

  test('win32: 盘根本体与 home 本体 (大小写不敏感)', () => {
    expect(isFilesystemRootBody('C:\\', WIN32_STYLE)).toBe(true);
    expect(isFilesystemRootBody('c:\\', WIN32_STYLE)).toBe(true);
    expect(isFilesystemRootBody('C:\\Repo', WIN32_STYLE)).toBe(false);
    expect(isHomeBody('C:\\Users\\X', 'c:\\users\\x', WIN32_STYLE)).toBe(true);
    expect(
      isHomeBody(
        'C:\\Users\\X\\work\\node_modules',
        'C:\\Users\\X',
        WIN32_STYLE,
      ),
    ).toBe(false);
  });
});

describe('不变量 ④ realpath 去重键 (纯判定)', () => {
  test('posix: 原样保留', () => {
    expect(dedupeKey('/work/app/node_modules', POSIX_STYLE)).toBe(
      '/work/app/node_modules',
    );
  });

  test('win32: 大小写折叠后同一键', () => {
    expect(dedupeKey('C:\\Repo\\App\\NODE_MODULES', WIN32_STYLE)).toBe(
      dedupeKey('c:\\repo\\app\\node_modules', WIN32_STYLE),
    );
  });
});

describe('不变量 ⑤ 根锚点链无符号链接 (纯判定)', () => {
  test('posix: 逐级前缀自根的一级子目录排到根自身 (文件系统根本身不入链)', () => {
    expect(anchorChainPaths('/Users/x/ws/app', POSIX_STYLE)).toEqual([
      '/Users',
      '/Users/x',
      '/Users/x/ws',
      '/Users/x/ws/app',
    ]);
  });

  test('posix: 根为 / 时链为空 (解析起点没有可查的上级)', () => {
    expect(anchorChainPaths('/', POSIX_STYLE)).toEqual([]);
  });

  test('posix: 尾分隔符与空段归一为同一链', () => {
    expect(anchorChainPaths('/w//a/', POSIX_STYLE)).toEqual(['/w', '/w/a']);
  });

  test('win32: 盘符前缀整体不拆, 逐级以反斜杠拼接', () => {
    expect(anchorChainPaths('C:\\Repo\\App', WIN32_STYLE)).toEqual([
      'C:\\Repo',
      'C:\\Repo\\App',
    ]);
  });

  test('检出首个符号链接; 全链真目录返回 null; 空链返回 null', () => {
    expect(
      firstSymlinkOnAnchor([
        { path: '/w', symlink: false },
        { path: '/w/a', symlink: false },
      ]),
    ).toBeNull();
    expect(
      firstSymlinkOnAnchor([
        { path: '/var', symlink: true },
        { path: '/var/w', symlink: false },
      ]),
    ).toBe('/var');
    expect(firstSymlinkOnAnchor([])).toBeNull();
  });

  test('符号链接即拒, 不看指向何处或是否悬空 (悬空链接同样命中)', () => {
    expect(firstSymlinkOnAnchor([{ path: '/w', symlink: true }])).toBe('/w');
  });
});

describe('validateTargets · 不变量 ⑤ (根锚点链, 真实目录)', () => {
  test('根自身是符号链接: 拒绝并给出根锚点理由', async () => {
    const { root } = await make({ projects: [{ dir: 'real-root/app' }] });
    await symlink(join(root, 'real-root'), join(root, 'link-root'));

    const target = join(root, 'link-root', 'app', 'node_modules');
    const result = await validateTargets([target], {
      roots: [join(root, 'link-root')],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([target]);
    expect(result.rejected[0]?.reason).toContain('根锚点');
    expect(result.rejected[0]?.reason).toContain(join(root, 'link-root'));
  });

  test('根的祖先链被换成符号链接: 同样拒绝 (根自身经解析仍是真目录)', async () => {
    const { root } = await make({ projects: [{ dir: 'elsewhere/work' }] });
    await symlink(join(root, 'elsewhere'), join(root, 'link-parent'));

    const target = join(root, 'link-parent', 'work', 'node_modules');
    const result = await validateTargets([target], {
      roots: [join(root, 'link-parent', 'work')],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('根锚点');
    expect(result.rejected[0]?.reason).toContain(join(root, 'link-parent'));
  });

  test('多根: 只拒换位根下的目标, 正常根下的目标照常通过', async () => {
    const { root } = await make({
      projects: [{ dir: 'good/app' }, { dir: 'real-root/app' }],
    });
    await symlink(join(root, 'real-root'), join(root, 'link-root'));

    const attacked = join(root, 'link-root', 'app', 'node_modules');
    const safe = join(root, 'good', 'app', 'node_modules');
    const result = await validateTargets([attacked, safe], {
      roots: [join(root, 'link-root'), join(root, 'good')],
    });

    expect(result.accepted).toEqual([await realpath(safe)]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([attacked]);
    expect(result.rejected[0]?.reason).toContain('根锚点');
  });

  test('悬空符号链接作根: 其下目标被拒 (realpath 不可解析), 校验不崩溃', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/app' }] });
    await symlink(join(root, 'nowhere'), join(root, 'dangling'));

    const under = join(root, 'dangling', 'app', 'node_modules');
    const result = await validateTargets([under], {
      roots: [join(root, 'dangling')],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([under]);
  });
});

describe('写入侧目标锚点 firstSymlinkOnTarget (真实目录)', () => {
  test('目标自身是符号链接: 报出该路径 (写入会跟随它改写其目标)', async () => {
    const { root } = await make({ projects: [] });
    await writeFile(join(root, 'victim.json'), '{}\n');
    await symlink(join(root, 'victim.json'), join(root, 'config.json'));

    expect(await firstSymlinkOnTarget(join(root, 'config.json'))).toBe(
      join(root, 'config.json'),
    );
  });

  test('祖先链某级是符号链接: 报出该级 (末端点本身是真身也不放行)', async () => {
    const { root } = await make({ projects: [] });
    await mkdir(join(root, 'real'), { recursive: true });
    await writeFile(join(root, 'real', 'config.json'), '{}\n');
    await symlink(join(root, 'real'), join(root, 'link-dir'));

    expect(
      await firstSymlinkOnTarget(join(root, 'link-dir', 'config.json')),
    ).toBe(join(root, 'link-dir'));
  });

  test('悬空符号链接作目标: 同样命中 (lstat 不跟进末段, 链接自身即结果)', async () => {
    const { root } = await make({ projects: [] });
    await symlink(join(root, 'nowhere.json'), join(root, 'config.json'));

    expect(await firstSymlinkOnTarget(join(root, 'config.json'))).toBe(
      join(root, 'config.json'),
    );
  });

  test('全链真身: 末段已存在与尚未创建 (首跑) 均返回 null', async () => {
    const { root } = await make({ projects: [] });
    await writeFile(join(root, 'config.json'), '{}\n');

    expect(await firstSymlinkOnTarget(join(root, 'config.json'))).toBeNull();
    expect(
      await firstSymlinkOnTarget(join(root, 'not-created-yet.json')),
    ).toBeNull();
  });

  test('与向导入口 firstSymlinkOnRoot 同源: 同一路径给同一结论', async () => {
    const { root } = await make({ projects: [] });
    await mkdir(join(root, 'real'), { recursive: true });
    await symlink(join(root, 'real'), join(root, 'link-dir'));

    const through = join(root, 'link-dir');
    const plain = join(root, 'real');
    expect(await firstSymlinkOnTarget(through)).toBe(
      await firstSymlinkOnRoot(through),
    );
    expect(await firstSymlinkOnTarget(plain)).toBe(
      await firstSymlinkOnRoot(plain),
    );
    expect(await firstSymlinkOnTarget(through)).toBe(through);
  });
});

describe('validateTargets (真实目录)', () => {
  test('根内 node_modules: 通过并返回 realpath 后的目标', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/app' }] });

    const target = join(root, 'zone', 'app', 'node_modules');
    const result = await validateTargets([target], { roots: [root] });

    expect(result.rejected).toEqual([]);
    expect(result.accepted).toEqual([await realpath(target)]);
  });

  test('根外 node_modules: 逐条拒绝并给理由 (整批拒绝的责任在调用方)', async () => {
    const { root } = await make({
      projects: [{ dir: 'zone/app' }, { dir: 'outside' }],
    });

    const inside = join(root, 'zone', 'app', 'node_modules');
    const outside = join(root, 'outside', 'node_modules');
    const result = await validateTargets([inside, outside], {
      roots: [join(root, 'zone')],
    });

    expect(result.accepted).toEqual([await realpath(inside)]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([outside]);
    expect(result.rejected[0]?.reason).toContain('root');
  });

  test('符号链接逃逸: 字符串上在根内, realpath 后在根外', async () => {
    const { root } = await make({
      projects: [{ dir: 'zone' }, { dir: 'outside' }],
    });
    await symlink(join(root, 'outside'), join(root, 'zone', 'link'));

    const target = join(root, 'zone', 'link', 'node_modules');
    const result = await validateTargets([target], {
      roots: [join(root, 'zone')],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([target]);
    expect(result.rejected[0]?.reason).toContain('root');
  });

  test('符号链接指向非 node_modules 目录: realpath 末段不符, 拒绝', async () => {
    const { root } = await make({ projects: [{ dir: 'payload' }] });
    await mkdir(join(root, 'zone', 'app'), { recursive: true });
    await symlink(
      join(root, 'payload'),
      join(root, 'zone', 'app', 'node_modules'),
    );

    const target = join(root, 'zone', 'app', 'node_modules');
    const result = await validateTargets([target], { roots: [root] });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('node_modules');
  });

  test('去重: 别名符号链接与真身实为一条, 只保留首次', async () => {
    const { root } = await make({ projects: [{ dir: 'shared' }] });
    await mkdir(join(root, 'zone', 'app2'), { recursive: true });
    await symlink(
      join(root, 'shared', 'node_modules'),
      join(root, 'zone', 'app2', 'node_modules'),
    );

    const canonical = join(root, 'shared', 'node_modules');
    const alias = join(root, 'zone', 'app2', 'node_modules');
    const result = await validateTargets([canonical, alias], { roots: [root] });

    expect(result.accepted).toEqual([await realpath(canonical)]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([alias]);
    expect(result.rejected[0]?.reason).toContain('重复');
  });

  test('末段不符: 真实存在但非 node_modules 的目录, 拒于字符串层', async () => {
    const { root } = await make({ projects: [{ dir: 'app' }] });

    const target = join(root, 'app');
    const result = await validateTargets([target], { roots: [root] });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('node_modules');
  });

  test('不存在的目标: realpath 失败即拒', async () => {
    const { root } = await make({ projects: [] });

    const target = join(root, 'ghost', 'node_modules');
    const result = await validateTargets([target], { roots: [root] });

    expect(result.accepted).toEqual([]);
    expect(result.rejected.map((entry) => entry.target)).toEqual([target]);
    expect(result.rejected[0]?.reason).toContain('realpath');
  });

  test('home 本体: 即使位于 root 之内也拒', async () => {
    const { root } = await make({ projects: [{ dir: 'app' }] });

    const homeLike = join(root, 'app', 'node_modules');
    const result = await validateTargets([homeLike], {
      roots: [root],
      home: homeLike,
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.reason).toContain('home');
  });
});
