/**
 * CLI 参数解析单测 (纯函数, 零 IO): 覆盖常规旗标、--flag=value、--version/-V、
 * 重复 --config 冲突、init/config 子命令互斥旗标与非法输入。
 */
import { describe, expect, test } from 'bun:test';

import { parseArgs } from './args.ts';

describe('parseArgs', () => {
  test('缺省与常用 sweep 旗标', () => {
    expect(parseArgs([])).toEqual({
      ok: true,
      options: {
        command: 'sweep',
        yes: false,
        force: false,
        exclude: [],
        include: [],
        help: false,
        version: false,
      },
    });

    expect(
      parseArgs([
        '--yes',
        '--force',
        '--exclude',
        'dist',
        '--exclude',
        'cache',
        '--include',
        'app',
        '--config',
        '/tmp/c.json',
      ]),
    ).toEqual({
      ok: true,
      options: {
        command: 'sweep',
        yes: true,
        force: true,
        exclude: ['dist', 'cache'],
        include: ['app'],
        config: '/tmp/c.json',
        help: false,
        version: false,
      },
    });
  });

  test('支持 --flag=value 赋值形式; 空值报缺值错误', () => {
    expect(
      parseArgs([
        '--exclude=vendor',
        '--include=web',
        '--config=/etc/sweep.json',
      ]),
    ).toEqual({
      ok: true,
      options: {
        command: 'sweep',
        yes: false,
        force: false,
        exclude: ['vendor'],
        include: ['web'],
        config: '/etc/sweep.json',
        help: false,
        version: false,
      },
    });

    expect(parseArgs(['--exclude='])).toEqual({
      ok: false,
      message: '参数 --exclude 缺少取值',
    });
    expect(parseArgs(['--config='])).toEqual({
      ok: false,
      message: '参数 --config 缺少取值',
    });
  });

  test('支持 --version 与 -V', () => {
    const longForm = parseArgs(['--version']);
    expect(longForm.ok && longForm.options.version).toBe(true);

    const shortForm = parseArgs(['-V']);
    expect(shortForm.ok && shortForm.options.version).toBe(true);
  });

  test('重复 --config 报冲突错误 (含 --config=path 混用)', () => {
    expect(parseArgs(['--config', 'a.json', '--config', 'b.json'])).toEqual({
      ok: false,
      message: '参数 --config 不能重复指定',
    });
    expect(parseArgs(['--config=a.json', '--config', 'b.json'])).toEqual({
      ok: false,
      message: '参数 --config 不能重复指定',
    });
  });

  test('init / config 子命令允许 --config 与 --help, 拒绝清理专属旗标', () => {
    expect(parseArgs(['init', '--config', 'c.json'])).toEqual({
      ok: true,
      options: {
        command: 'init',
        yes: false,
        force: false,
        exclude: [],
        include: [],
        config: 'c.json',
        help: false,
        version: false,
      },
    });
    expect(parseArgs(['config', '--config=c.json', '--help'])).toEqual({
      ok: true,
      options: {
        command: 'config',
        yes: false,
        force: false,
        exclude: [],
        include: [],
        config: 'c.json',
        help: true,
        version: false,
      },
    });

    for (const cmd of ['init', 'config']) {
      for (const bad of [
        ['--yes'],
        ['--force'],
        ['--exclude', 'x'],
        ['--include=y'],
      ]) {
        const res = parseArgs([cmd, ...bad]);
        expect(res.ok).toBe(false);
        if (!res.ok) expect(res.message).toContain(`子命令 ${cmd} 不支持参数`);
      }
    }
  });

  test('未知参数 / 缺值 / 多余位置参数一律判错', () => {
    expect(parseArgs(['--bogus']).ok).toBe(false);
    expect(parseArgs(['--exclude']).ok).toBe(false);
    expect(parseArgs(['--include', '--yes']).ok).toBe(false);
    expect(parseArgs(['init', 'extra']).ok).toBe(false);
    expect(parseArgs(['unknown-subcmd']).ok).toBe(false);
  });

  test('update 子命令原样透传后续参数给自更新引擎解析', () => {
    expect(parseArgs(['update', '--check', '--pm', 'bun'])).toEqual({
      ok: true,
      options: {
        command: 'update',
        yes: false,
        force: false,
        exclude: [],
        include: [],
        updateArgs: ['--check', '--pm', 'bun'],
        help: false,
        version: false,
      },
    });
  });

  test('非首位 update 返回清晰用法提示 (SWEEPCLI-P1-1)', () => {
    const withYes = parseArgs(['--yes', 'update']);
    expect(withYes.ok).toBe(false);
    if (!withYes.ok) expect(withYes.message).toContain('必须位于参数首位');

    const withCfg = parseArgs(['--config', 'c.json', 'update']);
    expect(withCfg.ok).toBe(false);
    if (!withCfg.ok) expect(withCfg.message).toContain('sweep-nm update');
  });
});
