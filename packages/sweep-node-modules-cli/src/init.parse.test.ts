/**
 * 初始化向导答案解析与新护栏单测:
 * 1. parsePathList (含 ~ 展开与 home 注入) 与 parseNameList (不做 ~ 展开);
 * 2. runInit 新护栏: 普通文件根拦截 / 名单路径分隔符提示 / finally 调用 io.close / deps.home 注入。
 */
import { describe, expect, test } from 'bun:test';

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_EXCLUDE } from '@iyowei/sweep-node-modules';

import {
  type InitDeps,
  type InitIO,
  parseNameList,
  parsePathList,
  runInit,
} from './init.ts';

function makeGuardDeps(options: {
  configExists?: boolean;
  rootExists?: (path: string) => boolean;
  rootIsDirectory?: (path: string) => boolean;
  home?: string;
  asks?: (string | null)[];
  confirms?: boolean[];
}) {
  const prints: string[] = [];
  const askCalls: string[] = [];
  let closeCalls = 0;
  const pendingAsks = [...(options.asks ?? [])];
  const pendingConfirms = [...(options.confirms ?? [])];

  const io: InitIO = {
    color: false,
    async ask(question) {
      askCalls.push(question);
      if (pendingAsks.length === 0)
        throw new Error('fake IO: ask 答案脚本已耗尽');
      return pendingAsks.shift()!;
    },
    async confirm() {
      if (pendingConfirms.length === 0)
        throw new Error('fake IO: confirm 答案脚本已耗尽');
      return pendingConfirms.shift()!;
    },
    print(line) {
      prints.push(line);
    },
    close() {
      closeCalls += 1;
    },
  };

  const deps: InitDeps = {
    configPath: '/cfg/config.json',
    configExists: async () => options.configExists ?? false,
    rootExists: async (path) => options.rootExists?.(path) ?? true,
    rootIsDirectory: async (path) =>
      options.rootIsDirectory?.(path) ?? options.rootExists?.(path) ?? true,
    firstSymlinkOnRoot: async () => null,
    firstSymlinkOnTarget: async () => null,
    writeFile: async () => {},
    home: options.home,
    io,
  };

  return { deps, prints, askCalls, getCloseCalls: () => closeCalls };
}

describe('parsePathList: 路径答案解析 (用于 roots)', () => {
  test('空串与全空白回落 fallback', () => {
    expect(parsePathList('', ['/default'])).toEqual(['/default']);
    expect(parsePathList('   \t ', ['/default'])).toEqual(['/default']);
    expect(parsePathList('', [])).toEqual([]);
  });

  test('null (取消态) 回落 fallback', () => {
    expect(parsePathList(null, ['/default'])).toEqual(['/default']);
    expect(parsePathList(null, [])).toEqual([]);
  });

  test('逗号分隔: 半角与全角均成立', () => {
    expect(parsePathList('/a,/b', [])).toEqual([resolve('/a'), resolve('/b')]);
    expect(parsePathList('/a，/b', [])).toEqual([resolve('/a'), resolve('/b')]);
  });

  test('空白分隔: 多空格 / 制表符 / 首尾空白', () => {
    expect(parsePathList('  /a   /b\t/c  ', [])).toEqual([
      resolve('/a'),
      resolve('/b'),
      resolve('/c'),
    ]);
  });

  test('混合分隔与空项过滤', () => {
    expect(parsePathList(', /a ,, /b ,', [])).toEqual([
      resolve('/a'),
      resolve('/b'),
    ]);
  });

  test('中文路径不被破坏', () => {
    expect(
      parsePathList('/Users/iyowei/我的文档，/Users/iyowei/项目数据', []),
    ).toEqual([
      resolve('/Users/iyowei/我的文档'),
      resolve('/Users/iyowei/项目数据'),
    ]);
  });

  test('成对引号: 空格与逗号保留, 引号本身剥离', () => {
    expect(parsePathList('"/tmp/My Projects"', [])).toEqual([
      resolve('/tmp/My Projects'),
    ]);
    expect(parsePathList('"/tmp/a, b"', [])).toEqual([resolve('/tmp/a, b')]);
    expect(parsePathList("'/tmp/a b' /c", [])).toEqual([
      resolve('/tmp/a b'),
      resolve('/c'),
    ]);
  });

  test('未配对引号按普通字符处理, 不吞后续内容', () => {
    expect(parsePathList('/a "b c', [])).toEqual([
      resolve('/a'),
      resolve('"b'),
      resolve('c'),
    ]);
  });

  test('相对路径绝对化并去重 (SWEEPCLI-P0-1)', () => {
    expect(parsePathList('. ./app ./app ../sibling', [])).toEqual([
      resolve('.'),
      resolve('./app'),
      resolve('../sibling'),
    ]);
    expect(parsePathList('~/lab, ~/lab', [], '/custom/home')).toEqual([
      resolve(join('/custom/home', 'lab')),
    ]);
  });

  test('~ 展开为家目录 (含引号内的 ~ / win32 习惯的 ~\\ 与自定义 home 注入)', () => {
    expect(parsePathList('~', [])).toEqual([resolve(homedir())]);
    expect(parsePathList('~/lab', [])).toEqual([
      resolve(join(homedir(), 'lab')),
    ]);
    expect(parsePathList('~\\lab', [])).toEqual([
      resolve(join(homedir(), 'lab')),
    ]);
    expect(parsePathList('"~/My Projects" ~/lab', [])).toEqual([
      resolve(join(homedir(), 'My Projects')),
      resolve(join(homedir(), 'lab')),
    ]);
    expect(parsePathList('~/repo', [], '/custom/home')).toEqual([
      resolve(join('/custom/home', 'repo')),
    ]);
  });
});

describe('parseNameList: 目录名答案解析 (用于 exclude / include)', () => {
  test('不做 ~ 家目录展开, 保留字面目录名', () => {
    expect(parseNameList('~, ~/sub, ~\\win, dist', [])).toEqual([
      '~',
      '~/sub',
      '~\\win',
      'dist',
    ]);
  });

  test('空串 / null 回落 fallback, 支持逗号与引号', () => {
    expect(parseNameList('', ['fallback'])).toEqual(['fallback']);
    expect(parseNameList(null, ['fallback'])).toEqual(['fallback']);
    expect(parseNameList('"my dir", cache，vendor', [])).toEqual([
      'my dir',
      'cache',
      'vendor',
    ]);
  });
});

describe('runInit: 非目录根拦截 / 名单分隔符提示 / io.close / home 注入', () => {
  test('普通文件路径作扫描根: 报「根不是目录」并重问, 不写入配置', async () => {
    const okDir = resolve('/dir-ok');
    const fileRoot = resolve('/some/file.txt');
    const { deps, askCalls, prints } = makeGuardDeps({
      rootExists: () => true,
      rootIsDirectory: (path) => path === okDir,
      asks: ['/some/file.txt', '/dir-ok', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [okDir],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
      },
    });
    expect(prints).toContain(`  ✗ 根不是目录: ${fileRoot}`);
    expect(askCalls).toHaveLength(4);
  });

  test('exclude / include 含路径分隔符时提示 (且 ~ 不展开为家目录)', async () => {
    const { deps, prints } = makeGuardDeps({
      asks: ['/ok', 'foo/bar, ~', 'a\\b'],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [resolve('/ok')],
        exclude: ['foo/bar', '~'],
        include: ['a\\b'],
      },
    });
    expect(
      prints.some(
        (line) =>
          line.includes('排除名含路径分隔符') && line.includes('foo/bar'),
      ),
    ).toBe(true);
    expect(
      prints.some(
        (line) => line.includes('包含名含路径分隔符') && line.includes('a\\b'),
      ),
    ).toBe(true);
  });

  test('io.close 在 written / cancelled / declined-overwrite 全路径的 finally 均被调用', async () => {
    const written = makeGuardDeps({ asks: ['', '', ''], confirms: [true] });
    await runInit(written.deps);
    expect(written.getCloseCalls()).toBe(1);

    const cancelled = makeGuardDeps({ asks: [null] });
    await runInit(cancelled.deps);
    expect(cancelled.getCloseCalls()).toBe(1);

    const declined = makeGuardDeps({ configExists: true, confirms: [false] });
    await runInit(declined.deps);
    expect(declined.getCloseCalls()).toBe(1);
  });

  test('deps.home 注入生效: 默认根与 ~ 展开均走注入的家目录', async () => {
    const customHome = '/custom/home';
    const { deps } = makeGuardDeps({
      home: customHome,
      asks: ['~/work', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result).toEqual({
      state: 'written',
      config: {
        roots: [resolve(join(customHome, 'work'))],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
      },
    });
  });
});
