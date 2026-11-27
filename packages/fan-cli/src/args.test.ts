/**
 * `args.ts` 单元测试: 子命令路由、转速参数、`--once` / `--no-save`、`apply`、`persist`、`--fan` / `--watch` / `--json` 与错误拦截。
 */
import { describe, expect, test } from 'bun:test';

import { type CliOptions, parseArgs } from './args.ts';

function expectParsed(
  argv: readonly string[],
  overrides: Partial<CliOptions> = {},
) {
  expect(parseArgs(argv)).toEqual({
    ok: true,
    options: {
      command: 'status',
      speed: undefined,
      persistAction: undefined,
      fanIndex: undefined,
      fixed: false,
      once: false,
      json: false,
      watchSeconds: undefined,
      help: false,
      version: false,
      ...overrides,
    },
  });
}

describe('parseArgs 正常路由', () => {
  test('缺省为 status, 支持 status / max / min / auto / set / apply 与 --fixed', () => {
    expectParsed([]);
    expectParsed(['max', '--fan', '1', '--json'], {
      command: 'max',
      fanIndex: 1,
      json: true,
    });
    expectParsed(['set', '--fan=0', '60%'], {
      command: 'set',
      speed: '60%',
      fanIndex: 0,
    });
    expectParsed(['set', '3000', '--fixed'], {
      command: 'set',
      speed: '3000',
      fixed: true,
    });
    expectParsed(['min', '--fixed'], {
      command: 'min',
      fixed: true,
    });
    expectParsed(['apply'], { command: 'apply' });
  });

  test('支持 --once / --no-save 与 persist [status|install|uninstall]', () => {
    expectParsed(['set', '50%', '--once'], {
      command: 'set',
      speed: '50%',
      once: true,
    });
    expectParsed(['max', '--no-save'], { command: 'max', once: true });
    expectParsed(['persist'], { command: 'persist', persistAction: 'status' });
    expectParsed(['persist', 'install', '--json'], {
      command: 'persist',
      persistAction: 'install',
      json: true,
    });
    expectParsed(['persist', 'uninstall'], {
      command: 'persist',
      persistAction: 'uninstall',
    });
  });

  test('支持 -w / --watch 缺省间隔与自定义秒数', () => {
    expectParsed(['status', '-w'], { watchSeconds: 1 });
    expectParsed(['status', '--watch=0.5'], { watchSeconds: 0.5 });
    expectParsed(['-w', '2'], { watchSeconds: 2 });
  });

  test('支持 update 透传与 -V / -h', () => {
    expect(parseArgs(['update', '--check'])).toEqual({
      ok: true,
      options: {
        command: 'update',
        fixed: false,
        once: false,
        json: false,
        updateArgs: ['--check'],
        help: false,
        version: false,
      },
    });
    expect(parseArgs(['-V']).ok && parseArgs(['-V'])).toMatchObject({
      options: { version: true },
    });
    expect(parseArgs(['-h']).ok && parseArgs(['-h'])).toMatchObject({
      options: { help: true },
    });
    expect(parseArgs(['status', 'update', '-h'])).toMatchObject({
      ok: true,
      options: { help: true },
    });
  });
});

describe('parseArgs 错误拦截', () => {
  test('拒绝缺失转速、未知选项、无效组合 (--once / --fan / --watch / persist) 与非首位置 update', () => {
    expect(parseArgs(['set']).ok).toBe(false);
    expect(parseArgs(['max', '-w']).ok).toBe(false);
    expect(parseArgs(['max', '--fixed']).ok).toBe(false);
    expect(parseArgs(['auto', '--fixed']).ok).toBe(false);
    expect(parseArgs(['status', '--fixed']).ok).toBe(false);
    expect(parseArgs(['status', '--once']).ok).toBe(false);
    expect(parseArgs(['apply', '--no-save']).ok).toBe(false);
    expect(parseArgs(['apply', '--fan', '0']).ok).toBe(false);
    expect(parseArgs(['persist', '--fan', '0']).ok).toBe(false);
    expect(parseArgs(['persist', 'bogus']).ok).toBe(false);
    expect(parseArgs(['--fan', 'abc']).ok).toBe(false);
    expect(parseArgs(['--unknown']).ok).toBe(false);
    expect(parseArgs(['status', 'update']).ok).toBe(false);

    const badWatchZero = parseArgs(['status', '-w', '0']);
    const badWatchEqZero = parseArgs(['status', '--watch=0']);
    const badWatchNeg = parseArgs(['status', '-w', '-1']);
    const badWatchHuge = parseArgs(['status', '-w', '1e20']);
    expect(badWatchZero).toEqual(badWatchEqZero);
    expect(badWatchZero.ok).toBe(false);
    expect(badWatchNeg.ok).toBe(false);
    expect(badWatchHuge.ok).toBe(false);

    // 负数转速参数应作为 speed 交给转速校验, 而非误报未知选项
    expectParsed(['set', '-100'], { command: 'set', speed: '-100' });
  });
});
