/**
 * `@iyowei/wake-cli` 参数解析器单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { VALUE_FLAGS, parseArgs } from './args.ts';

describe('wake-cli parseArgs', () => {
  test('默认无参走默认目标 wake 命令', () => {
    const res = parseArgs([], 'zh');
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.options.command).toBe('wake');
      expect(res.options.target).toBeUndefined();
      expect(res.options.wait).toBe(true);
    }
  });

  test('支持位置目标与可重复 --mac/--relay/--broadcast 及等号写法', () => {
    const res = parseArgs(
      [
        'workstation',
        '-m',
        '00:11:22:33:44:55,AA-BB-CC-DD-EE-FF',
        '--host=192.0.2.10',
        '-p',
        '2222',
        '--relay',
        'bastion-a',
        '-r',
        'bastion-b',
        '-b',
        '192.0.2.255',
        '-t',
        '30',
        '--force',
        '--json',
      ],
      'en',
    );
    expect(res.ok).toBe(true);
    if (res.ok) {
      expect(res.options.command).toBe('wake');
      expect(res.options.target).toBe('workstation');
      expect(res.options.macs).toEqual([
        '00:11:22:33:44:55',
        'aa:bb:cc:dd:ee:ff',
      ]);
      expect(res.options.host).toBe('192.0.2.10');
      expect(res.options.port).toBe(2222);
      expect(res.options.relays).toEqual(['bastion-a', 'bastion-b']);
      expect(res.options.broadcast).toEqual(['192.0.2.255']);
      expect(res.options.waitTimeoutMs).toBe(30_000);
      expect(res.options.force).toBe(true);
      expect(res.options.json).toBe(true);
    }
  });

  test('校验冲突旗标、缺失参数值、多余位置参数与子命令边界', () => {
    expect(
      parseArgs(['workstation', '--local-only', '--no-local-fallback'], 'zh')
        .ok,
    ).toBe(false);
    expect(parseArgs(['list', '--mac', '00:11:22:33:44:55'], 'zh').ok).toBe(
      false,
    );
    expect(parseArgs(['doctor', '--host', '192.0.2.10'], 'zh').ok).toBe(false);
    expect(parseArgs(['-m'], 'zh').ok).toBe(false);
    expect(parseArgs(['a', 'b'], 'zh').ok).toBe(false);
    expect(parseArgs(['--unknown-flag'], 'zh').ok).toBe(false);
  });

  test('VALUE_FLAGS 覆盖所有携带参数值的选项以便 stripLangArgs 精确跳过', () => {
    for (const flag of [
      '-c',
      '--config',
      '-m',
      '--mac',
      '-H',
      '--host',
      '-p',
      '--port',
      '-b',
      '--broadcast',
      '-r',
      '--relay',
      '-t',
      '--timeout',
      '--name',
      '--lang',
    ]) {
      expect(VALUE_FLAGS.has(flag)).toBe(true);
    }
  });
});
