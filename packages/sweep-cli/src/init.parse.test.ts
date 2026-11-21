/**
 * 初始化向导答案解析与护栏单测:
 * 1. parsePathList (含 ~ 展开与 home 注入)、parseNameList (不做 ~ 展开) 与 parsePresetList;
 * 2. runInit 护栏: 未知预设重问 / 普通文件根拦截 / 名单路径分隔符提示 / finally 调 io.close / home 注入。
 */
import { describe, expect, test } from 'bun:test';

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import { DEFAULT_EXCLUDE, createDefaultPresets } from '@iyowei/sweep';

import {
  type InitDeps,
  type InitIO,
  parseNameList,
  parsePathList,
  parsePresetList,
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
  test('空串 / 全空白 / null 回落 fallback', () => {
    expect(parsePathList('', ['/default'])).toEqual(['/default']);
    expect(parsePathList('   \t ', ['/default'])).toEqual(['/default']);
    expect(parsePathList(null, ['/default'])).toEqual(['/default']);
  });

  test('半角/全角逗号、空白与成对引号均正确切分', () => {
    expect(parsePathList('/a,/b，/c', [])).toEqual([
      resolve('/a'),
      resolve('/b'),
      resolve('/c'),
    ]);
    expect(parsePathList('  /a   /b\t/c  ', [])).toEqual([
      resolve('/a'),
      resolve('/b'),
      resolve('/c'),
    ]);
    expect(parsePathList('"/tmp/My Projects", \'/tmp/a, b\'', [])).toEqual([
      resolve('/tmp/My Projects'),
      resolve('/tmp/a, b'),
    ]);
    expect(parsePathList('/a "b c', [])).toEqual([
      resolve('/a'),
      resolve('"b'),
      resolve('c'),
    ]);
  });

  test('相对路径绝对化、去重与 ~ 展开 (含自定义 home 注入)', () => {
    expect(parsePathList('. ./app ./app ../sibling', [])).toEqual([
      resolve('.'),
      resolve('./app'),
      resolve('../sibling'),
    ]);
    expect(parsePathList('~', [])).toEqual([resolve(homedir())]);
    expect(parsePathList('~/lab, ~\\lab', [], '/custom/home')).toEqual([
      resolve(join('/custom/home', 'lab')),
    ]);
    expect(parsePathList('"~/My Projects"', [], '/custom/home')).toEqual([
      resolve(join('/custom/home', 'My Projects')),
    ]);
  });
});

describe('parseNameList: 目录名答案解析 (用于 exclude / include)', () => {
  test('不做 ~ 家目录展开, 保留字面目录名并支持引号与全角逗号', () => {
    expect(parseNameList('~, ~/sub, ~\\win, dist', [])).toEqual([
      '~',
      '~/sub',
      '~\\win',
      'dist',
    ]);
    expect(parseNameList('', ['fallback'])).toEqual(['fallback']);
    expect(parseNameList(null, ['fallback'])).toEqual(['fallback']);
    expect(parseNameList('"my dir", cache，vendor', [])).toEqual([
      'my dir',
      'cache',
      'vendor',
    ]);
  });
});

describe('parsePresetList: 预设列表解析', () => {
  test('空串 / 全空白 / null 回落推荐 6 预设全集', () => {
    expect(parsePresetList('')).toEqual({
      ok: true,
      presets: createDefaultPresets(),
    });
    expect(parsePresetList('   \t ')).toEqual({
      ok: true,
      presets: createDefaultPresets(),
    });
    expect(parsePresetList(null)).toEqual({
      ok: true,
      presets: createDefaultPresets(),
    });
  });

  test('支持有效预设组合 (大小写不敏感、逗号/全角逗号/空白分隔与去重)', () => {
    expect(parsePresetList('Node, RUST，os-junk node')).toEqual({
      ok: true,
      presets: { node: {}, rust: {}, 'os-junk': {} },
    });
    expect(parsePresetList('python java cpp')).toEqual({
      ok: true,
      presets: { python: {}, java: {}, cpp: {} },
    });
  });

  test('含未知预设名时返回 ok: false 与非法列表', () => {
    expect(parsePresetList('node, ruby, go')).toEqual({
      ok: false,
      invalid: ['ruby', 'go'],
    });
  });
});

describe('runInit: 非法预设重问 / 非目录根拦截 / 名单分隔符 / io.close / home 注入', () => {
  test('未知预设报错 (经净化) 后重问 Q2, 改填合法预设后照常落盘', async () => {
    const { deps, askCalls, prints } = makeGuardDeps({
      asks: ['/ok', 'node, bad\u001b[31mstack', 'node, python', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(result.config?.presets).toEqual({ node: {}, python: {} });
    expect(
      prints.some(
        (line) => line.includes('未知预设:') && line.includes('bad[31mstack'),
      ),
    ).toBe(true);
    expect(prints.some((line) => line.includes('\u001b'))).toBe(false);
    // Q1(1) + Q2(2) + Q3(1) + Q4(1) = 5
    expect(askCalls).toHaveLength(5);
    expect(askCalls[2]).toBe(askCalls[1]);
  });

  test('普通文件路径作扫描根: 报「根不是目录」并重问, 不写入配置', async () => {
    const okDir = resolve('/dir-ok');
    const fileRoot = resolve('/some/file.txt');
    const { deps, askCalls, prints } = makeGuardDeps({
      rootExists: () => true,
      rootIsDirectory: (path) => path === okDir,
      asks: ['/some/file.txt', '/dir-ok', '', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(result.config).toEqual({
      version: 2,
      roots: [okDir],
      exclude: [...DEFAULT_EXCLUDE],
      include: [],
      presets: createDefaultPresets(),
      rules: [],
    });
    expect(prints).toContain(`  ✗ 根不是目录: ${fileRoot}`);
    expect(askCalls).toHaveLength(5);
  });

  test('exclude / include 含路径分隔符时提示 (且 ~ 不展开为家目录)', async () => {
    const { deps, prints } = makeGuardDeps({
      asks: ['/ok', 'node', 'foo/bar, ~', 'a\\b'],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(result.config).toEqual({
      version: 2,
      roots: [resolve('/ok')],
      exclude: ['foo/bar', '~'],
      include: ['a\\b'],
      presets: { node: {} },
      rules: [],
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
    const written = makeGuardDeps({ asks: ['', '', '', ''], confirms: [true] });
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
      asks: ['~/work', '', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(result.config).toEqual({
      version: 2,
      roots: [resolve(join(customHome, 'work'))],
      exclude: [...DEFAULT_EXCLUDE],
      include: [],
      presets: createDefaultPresets(),
      rules: [],
    });
  });
});
