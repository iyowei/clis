/**
 * `bin/wake.mjs` 运行时解析与路径边界纯函数单测。
 */
import { describe, expect, test } from 'bun:test';

import {
  isEntry,
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executables,
} from '../bin/wake.mjs';

describe('wake 启动器纯函数运行时挑选', () => {
  test('Node 最低版本门槛 (>= 22.18.0)', () => {
    expect(isSupportedNodeVersion('v22.18.0')).toBe(true);
    expect(isSupportedNodeVersion('24.1.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion('v20.11.0')).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
  });

  test('POSIX 仅解析绝对 PATH 目录且跳过相对与重复项', () => {
    const existing = new Set(['/usr/local/bin/bun', '/usr/bin/node']);
    expect(
      resolvePosixExecutables(
        'bun',
        '.:/usr/local/bin::/usr/local/bin:/usr/bin',
        (p) => existing.has(p),
      ),
    ).toEqual(['/usr/local/bin/bun']);
  });

  test('Win32 严格校验盘符/UNC 绝对目录与可执行后缀', () => {
    const existing = new Set([
      'C:\\Program Files\\bun\\bun.exe',
      '\\\\srv\\tools\\node.exe',
    ]);
    expect(
      resolveWin32Executables(
        'bun',
        '/usr/bin;.;C:\\Program Files\\bun;C:\\Program Files\\bun',
        (p) => existing.has(p),
      ),
    ).toEqual(['C:\\Program Files\\bun\\bun.exe']);
  });

  test('pickRuntime 优先选择可用 Bun, 其次合格 Node', () => {
    const files = new Set(['/bad/bun', '/good/bun', '/sys/node']);
    const picked = pickRuntime({
      platform: 'linux',
      pathEnv: '/bad:/good:/sys',
      fileProbe: (p) => files.has(p),
      probe: (cmd) => cmd === '/good/bun' || cmd === '/sys/node',
    });
    expect(picked).toBe('/good/bun');

    const nodeFallback = pickRuntime({
      platform: 'linux',
      pathEnv: '/sys',
      fileProbe: (p) => files.has(p),
      probe: (cmd) => cmd === '/sys/node',
    });
    expect(nodeFallback).toBe('/sys/node');
  });

  test('isEntry 匹配当前入口脚本 URL', () => {
    expect(
      isEntry(
        '/repo/packages/wake-cli/bin/wake.mjs',
        'file:///repo/packages/wake-cli/bin/wake.mjs',
        'linux',
      ),
    ).toBe(true);
    expect(
      isEntry(
        '/repo/other.mjs',
        'file:///repo/packages/wake-cli/bin/wake.mjs',
        'linux',
      ),
    ).toBe(false);
  });
});
