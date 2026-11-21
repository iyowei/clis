/**
 * 初始化向导 (`runInit`) 与一键默认配置 (`runInitDefault`) 单测:
 * 覆盖四问交互流 (扫描根 / 激活预设 / 排除名单 / 包含名单)、覆盖保护、前置与落盘前 TOCTOU 锚点检查、
 * v2 落盘形态与结构化摘要渲染 (严禁输出原始 JSON 全文)。
 */
import { describe, expect, test } from 'bun:test';

import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

import {
  DEFAULT_EXCLUDE,
  PRESET_NAMES,
  createDefaultConfig,
  createDefaultPresets,
} from '@iyowei/sweep';

import {
  type InitDefaultDeps,
  type InitDeps,
  type InitIO,
  runInit,
  runInitDefault,
} from './init.ts';

const CONFIG_PATH = join(homedir(), '.config', 'sweep', 'config.json');

/** 断言输出只含结构化摘要, 绝不包含原始 JSON 全文 (ADR 0024 核心红线) */
function expectSummaryWithoutRawJson(lines: string[]): void {
  const joined = lines.join('\n');
  expect(joined).toContain('配置已写入:');
  expect(joined).toContain('扫描根 (');
  expect(joined).toContain('激活预设 (');
  expect(joined).toContain('自定义规则:');
  expect(joined).toContain('全局排除:');
  expect(joined).toContain('快捷指令:');
  expect(joined).toContain('sweep config');
  expect(joined).not.toContain('"version": 2');
  expect(joined).not.toContain('"presets": {');
}

/** 脚本化 fake IO: 按序弹出预设答案, 脚本耗尽即抛错防静默退化 */
function makeFakeIO(script: {
  asks?: (string | null)[];
  confirms?: boolean[];
  color?: boolean;
}) {
  const askCalls: { question: string; hint?: string }[] = [];
  const confirmCalls: { question: string; defaultYes: boolean }[] = [];
  const prints: string[] = [];
  let closeCalls = 0;
  const pendingAsks = [...(script.asks ?? [])];
  const pendingConfirms = [...(script.confirms ?? [])];

  const io: InitIO = {
    color: script.color ?? false,
    async ask(question, hint) {
      askCalls.push({ question, hint });
      if (pendingAsks.length === 0)
        throw new Error('fake IO: ask 答案脚本已耗尽');
      return pendingAsks.shift()!;
    },
    async confirm(question, defaultYes) {
      confirmCalls.push({ question, defaultYes });
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

  return {
    io,
    askCalls,
    confirmCalls,
    prints,
    getCloseCalls: () => closeCalls,
  };
}

function makeDeps(options: {
  configExists?: boolean;
  configIsDirectory?: boolean;
  rootExists?: (path: string) => boolean;
  rootIsDirectory?: (path: string) => boolean;
  rootLink?: (path: string) => string | null;
  targetLink?: (path: string) => string | null;
  home?: string;
  platform?: NodeJS.Platform;
  asks?: (string | null)[];
  confirms?: boolean[];
  color?: boolean;
}) {
  const { io, askCalls, confirmCalls, prints, getCloseCalls } =
    makeFakeIO(options);
  const writes: { path: string; text: string }[] = [];
  const deps: InitDeps = {
    configPath: CONFIG_PATH,
    configExists: async () => options.configExists ?? false,
    configIsDirectory: async () => options.configIsDirectory ?? false,
    rootExists: async (path) => options.rootExists?.(path) ?? true,
    rootIsDirectory: async (path) =>
      options.rootIsDirectory?.(path) ?? options.rootExists?.(path) ?? true,
    firstSymlinkOnRoot: async (path) => options.rootLink?.(path) ?? null,
    firstSymlinkOnTarget: async (path) => options.targetLink?.(path) ?? null,
    writeFile: async (path, text) => {
      writes.push({ path, text });
    },
    home: options.home,
    platform: options.platform ?? 'darwin',
    io,
  };

  return { deps, writes, askCalls, confirmCalls, prints, getCloseCalls };
}

function makeDefaultDeps(
  overrides: Partial<InitDefaultDeps> & {
    exists?: boolean;
    isDir?: boolean;
    targetLink?: string | null;
  } = {},
) {
  const writes: { path: string; text: string }[] = [];
  const prints: string[] = [];
  const warns: string[] = [];
  const deps: InitDefaultDeps = {
    configPath: overrides.configPath ?? CONFIG_PATH,
    configExists:
      overrides.configExists ?? (async () => overrides.exists ?? false),
    configIsDirectory:
      overrides.configIsDirectory ?? (async () => overrides.isDir ?? false),
    firstSymlinkOnTarget:
      overrides.firstSymlinkOnTarget ??
      (async () => overrides.targetLink ?? null),
    writeFile:
      overrides.writeFile ??
      (async (path, text) => {
        writes.push({ path, text });
      }),
    home: overrides.home ?? homedir(),
    platform: overrides.platform ?? 'darwin',
    interactive: overrides.interactive ?? false,
    color: overrides.color ?? false,
    print:
      overrides.print ??
      ((line) => {
        prints.push(line);
      }),
    warn:
      overrides.warn ??
      ((line) => {
        warns.push(line);
      }),
    confirmOverwrite: overrides.confirmOverwrite,
  };
  return { deps, writes, prints, warns };
}

describe('runInit: 四问 written 路径与摘要契约', () => {
  test('一路回车取默认根、6 预设与内置安全护栏 (省略 exclude), 输出结构化摘要且零原始 JSON', async () => {
    const { deps, writes, askCalls, confirmCalls, prints } = makeDeps({
      asks: ['', '', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    const expectedStored = createDefaultConfig({
      roots: [homedir()],
      presets: createDefaultPresets(),
      rules: [],
    });
    expect(result).toEqual({
      state: 'written',
      config: {
        version: 2,
        roots: [homedir()],
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
        presets: createDefaultPresets(),
        rules: [],
      },
      stored: expectedStored,
      excludeExplicit: false,
    });
    expect(writes).toHaveLength(1);
    expect(writes[0]!.path).toBe(CONFIG_PATH);
    expect(writes[0]!.text).toBe(
      `${JSON.stringify(expectedStored, null, 2)}\n`,
    );
    expect(expectedStored.exclude).toBeUndefined();

    expect(askCalls).toHaveLength(4);
    expect(askCalls[0]!.hint).toBe('默认: ~');
    expect(askCalls[1]!.hint).toBe(`默认: ${PRESET_NAMES.join(', ')}`);
    expect(askCalls[2]!.hint).toBe(
      `回车采用内置安全护栏 (${DEFAULT_EXCLUDE.length} 条)`,
    );
    expect(prints[0]).toBe('▍ SWEEP  初始化向导');
    expect(prints[1]).toBe('  ░ 首次使用, 先确定扫描范围与清理预设');
    expect(prints).toContain(
      `  ░ 将写入 1 个扫描根 · ${PRESET_NAMES.length} 个预设 · 排除 ${DEFAULT_EXCLUDE.length} 条 · 包含 0 条`,
    );
    expect(prints).toContain(
      `  配置已写入: ${join('~', '.config', 'sweep', 'config.json')}  ✓`,
    );
    expect(prints.join('\n')).toContain('(内置安全护栏)');
    expectSummaryWithoutRawJson(prints);
    expect(confirmCalls).toHaveLength(1);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
  });

  test('多根 + 自定义预设子集 + 显式排除与包含: 完整写入 v2 配置并回显', async () => {
    const { deps, writes, prints } = makeDeps({
      asks: ['/a, /b  /c', 'node, rust', 'dist, coverage', 'app-web'],
      confirms: [true],
    });

    const result = await runInit(deps);

    const roots = [resolve('/a'), resolve('/b'), resolve('/c')];
    const presets = { node: {}, rust: {} };
    expect(result).toEqual({
      state: 'written',
      config: {
        version: 2,
        roots,
        exclude: ['dist', 'coverage'],
        include: ['app-web'],
        presets,
        rules: [],
      },
      stored: {
        version: 2,
        roots,
        presets,
        rules: [],
        exclude: ['dist', 'coverage'],
        include: ['app-web'],
      },
      excludeExplicit: true,
    });
    expect(writes).toHaveLength(1);
    expect(prints).toContain(
      '  ░ 将写入 3 个扫描根 · 2 个预设 · 排除 2 条 · 包含 1 条',
    );
    expect(prints.join('\n')).not.toContain('(内置安全护栏)');
    expectSummaryWithoutRawJson(prints);
  });

  test('已存在配置且确认覆盖: 覆盖确认默认否, 写入确认默认 Y', async () => {
    const { deps, writes, confirmCalls } = makeDeps({
      configExists: true,
      confirms: [true, true],
      asks: ['/root', '', '', ''],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]!.defaultYes).toBe(false);
    expect(confirmCalls[0]!.question).toContain('覆盖');
    expect(confirmCalls[1]!.defaultYes).toBe(true);
    expect(writes).toHaveLength(1);
  });

  test('根不存在或落在软链上: 逐个提示并净化控制字符后重问, 坏输入不进配置', async () => {
    const okRoot = resolve('/ok');
    const evilAbs = resolve('/evil\u001b[2Jroot\u202e');
    const tmpX = resolve('/tmp/x');
    const { deps, askCalls, prints } = makeDeps({
      rootExists: (path) => path !== evilAbs,
      rootLink: (path) => (path === tmpX ? '/tmp' : null),
      asks: ['/evil\u001b[2Jroot\u202e', '/tmp/x', '/ok', '', '', ''],
      confirms: [true],
    });

    const result = await runInit(deps);

    expect(result.state).toBe('written');
    expect(result.config?.roots).toEqual([okRoot]);
    expect(
      prints.some(
        (line) =>
          line.includes('  ✗ 根不存在: ') && line.includes('evil[2Jroot'),
      ),
    ).toBe(true);
    expect(prints).toContain(
      `  ✗ 根锚点链上有符号链接: /tmp (根: ${tmpX}); 删除侧要求真实路径, 请改写为不含符号链接的形态`,
    );
    expect(prints.some((line) => line.includes('\u001b'))).toBe(false);
    expect(prints.some((line) => line.includes('\u202e'))).toBe(false);
    // Q1 问了 3 次 (2 次报错重问) + Q2/Q3/Q4 各 1 次 = 6 次
    expect(askCalls).toHaveLength(6);
  });

  test('着色开关只改色码: 剥去 ANSI 后与降级态逐字一致', async () => {
    const script = { asks: ['', '', '', ''], confirms: [true] };
    const plain = makeDeps(script);
    const colored = makeDeps({ ...script, color: true });

    await runInit(plain.deps);
    await runInit(colored.deps);

    expect(colored.prints.some((line) => line.includes('\x1b['))).toBe(true);
    const strip = (line: string): string =>
      // eslint-disable-next-line no-control-regex
      line.replace(/\x1b\[[0-9;]*m/g, '');
    expect(colored.prints.map(strip)).toEqual(plain.prints);
  });
});

describe('runInit: 前置配置路径检查与落盘前 TOCTOU 复检 (SWEEPCLI-P0-3)', () => {
  test('前置拦截: 配置路径是既有目录或含符号链接时零询问直接拒绝', async () => {
    const dirCase = makeDeps({ configExists: true, configIsDirectory: true });
    expect(await runInit(dirCase.deps)).toEqual({ state: 'cancelled' });
    expect(dirCase.writes).toHaveLength(0);
    expect(dirCase.askCalls).toHaveLength(0);
    expect(dirCase.prints.some((l) => l.includes('配置路径是既有目录'))).toBe(
      true,
    );

    const linkCase = makeDeps({
      targetLink: () => '/var/evil\u001b[2Jlink\u202e',
    });
    expect(await runInit(linkCase.deps)).toEqual({ state: 'cancelled' });
    expect(linkCase.writes).toHaveLength(0);
    expect(linkCase.askCalls).toHaveLength(0);
    expect(
      linkCase.prints.some((l) =>
        l.includes('配置路径锚点链上有符号链接: /var/evil[2Jlink'),
      ),
    ).toBe(true);
    expect(linkCase.prints.some((l) => l.includes('\u001b'))).toBe(false);
  });

  test('落盘前 TOCTOU 复检: 检出软链时重问降为默认否, 恢复真身后照常落盘', async () => {
    let calls = 0;
    const { deps, writes, confirmCalls } = makeDeps({
      targetLink: () => {
        calls += 1;
        return calls === 2 ? '/var' : null;
      },
      asks: ['/root', '', '', ''],
      confirms: [true, true],
    });

    const result = await runInit(deps);
    expect(result.state).toBe('written');
    expect(writes).toHaveLength(1);
    expect(confirmCalls).toHaveLength(2);
    expect(confirmCalls[0]!.defaultYes).toBe(true);
    expect(confirmCalls[1]!.defaultYes).toBe(false);
  });
});

describe('runInit: cancelled 与 declined-overwrite 路径', () => {
  test('Q1 / Q2 / 确认被拒均返回 cancelled 且不落盘', async () => {
    for (const script of [
      { asks: [null] },
      { asks: ['/root', null] },
      { asks: ['/a', '', '', ''], confirms: [false] },
    ]) {
      const { deps, writes, prints } = makeDeps(script);
      expect(await runInit(deps)).toEqual({ state: 'cancelled' });
      expect(writes).toHaveLength(0);
      expect(prints).toContain('已取消, 未写入配置');
    }
  });

  test('拒绝覆盖 (默认否): 不落盘, 不再提问, finally 调 io.close', async () => {
    const { deps, writes, askCalls, prints, getCloseCalls } = makeDeps({
      configExists: true,
      confirms: [false],
    });

    const result = await runInit(deps);
    expect(result).toEqual({ state: 'declined-overwrite' });
    expect(writes).toHaveLength(0);
    expect(askCalls).toHaveLength(0);
    expect(prints).toEqual(['▍ SWEEP  初始化向导']);
    expect(getCloseCalls()).toBe(1);
  });
});

describe('runInitDefault (`sweep init --default`)', () => {
  test('生成 6 预设且省略 exclude 继承 32 条护栏, 输出结构化摘要且绝不含原始 JSON', async () => {
    const { deps, writes, prints, warns } = makeDefaultDeps({
      platform: 'linux',
    });

    const result = await runInitDefault(deps);

    expect(result.state).toBe('written');
    expect(result.excludeExplicit).toBe(false);
    expect(result.config?.exclude).toEqual([...DEFAULT_EXCLUDE]);
    expect(Object.keys(result.config?.presets ?? {})).toEqual([
      ...PRESET_NAMES,
    ]);
    expect(result.stored?.exclude).toBeUndefined();
    expect(writes).toHaveLength(1);
    expect(warns).toEqual([]);
    expect(prints[0]).toBe('▍ SWEEP  初始化配置');
    expect(prints.join('\n')).toContain('(内置安全护栏)');
    expect(prints.join('\n')).not.toContain('open -e');
    expectSummaryWithoutRawJson(prints);
  });

  test('已存在配置: 非 TTY 拒绝覆盖返 conflict; TTY 拒绝返 declined-overwrite; TTY 同意覆盖写盘', async () => {
    const nonTty = makeDefaultDeps({ exists: true, interactive: false });
    expect(await runInitDefault(nonTty.deps)).toEqual({ state: 'conflict' });
    expect(nonTty.writes).toHaveLength(0);
    expect(nonTty.warns.join('\n')).toContain('非交互模式下拒绝静默覆盖');

    const declined = makeDefaultDeps({
      exists: true,
      interactive: true,
      confirmOverwrite: async () => false,
    });
    expect(await runInitDefault(declined.deps)).toEqual({
      state: 'declined-overwrite',
    });
    expect(declined.writes).toHaveLength(0);

    const accepted = makeDefaultDeps({
      exists: true,
      interactive: true,
      confirmOverwrite: async () => true,
    });
    const res = await runInitDefault(accepted.deps);
    expect(res.state).toBe('written');
    expect(accepted.writes).toHaveLength(1);
    expectSummaryWithoutRawJson(accepted.prints);
  });

  test('前置拒绝: 既有目录或锚点软链返回 conflict 且不写盘', async () => {
    const dirCase = makeDefaultDeps({ isDir: true });
    expect(await runInitDefault(dirCase.deps)).toEqual({ state: 'conflict' });
    expect(dirCase.writes).toHaveLength(0);
    expect(dirCase.warns.join('\n')).toContain('配置路径是既有目录');

    const linkCase = makeDefaultDeps({ targetLink: '/var' });
    expect(await runInitDefault(linkCase.deps)).toEqual({ state: 'conflict' });
    expect(linkCase.writes).toHaveLength(0);
    expect(linkCase.warns.join('\n')).toContain('配置路径锚点链上有符号链接');
  });
});
