/**
 * 启动器运行时解析防劫持测试 (`bin/fan`, `bin/fan.cmd`, `bin/fan.mjs`):
 * 拦截 PATH 空段/相对条目劫持 cwd 恶意 `bun`/`node`、检查隔离 `bin/bunfig.toml` 与 `--no-env-file`。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executables,
} from '../bin/fan.mjs';

const ROOT = join(import.meta.dir, '..');
const readLauncher = (rel: string) => readFileSync(join(ROOT, rel), 'utf8');

describe('Node 版本门禁 (>= 22.18.0)', () => {
  test('临界版本校验', () => {
    expect(isSupportedNodeVersion('v22.18.0\n')).toBe(true);
    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
  });
});

describe('win32 & POSIX PATH 解析', () => {
  test('win32 拒绝空段、相对与 /usr/bin 盘根相对条目', () => {
    expect(
      resolveWin32Executables('bun', ';;.;relative;/usr/bin', () => true),
    ).toEqual([]);
  });

  test('POSIX 仅接受绝对路径并优先 bun 后 node', () => {
    expect(
      resolvePosixExecutables(
        'bun',
        '::.:relative:/opt/bin',
        (p) => p === '/opt/bin/bun',
      ),
    ).toEqual(['/opt/bin/bun']);
    expect(
      pickRuntime({
        platform: 'darwin',
        pathEnv: ':/usr/local/bin',
        fileProbe: (p) => p === '/usr/local/bin/node',
        probe: () => true,
      }),
    ).toBe('/usr/local/bin/node');
  });
});

describe('三入口静态防线与 POSIX 实跑对照', () => {
  test('bin/fan、bin/fan.cmd、bin/fan.mjs 具备路径防劫持与 bunfig 隔离', () => {
    const sh = readLauncher('bin/fan');
    expect(sh).toContain('find_abs_exec');
    expect(sh).toContain('CLIS_BUN_ISOLATED=1');
    expect(sh).toContain('bunfig.toml');

    const cmd = readLauncher('bin/fan.cmd');
    expect(cmd).toContain('set "RUNNER=%%~$PATH:I"');
    expect(cmd).toContain('--no-env-file');

    const mjs = readLauncher('bin/fan.mjs');
    expect(mjs).toContain('resolveWin32Executables');
    expect(mjs).toContain('resolvePosixExecutables');
    expect(mjs).toContain('CLIS_BUN_ISOLATED');
  });

  test('bin/fan 在 PATH=":$PATH" 下绝不执行 cwd 中的恶意 ./bun', () => {
    if (process.platform === 'win32') return;
    const dir = mkdtempSync(join(tmpdir(), 'fan-probe-'));
    const evil = join(dir, 'bun');
    writeFileSync(evil, '#!/bin/sh\necho CWD_HIJACKED\nexit 99\n');
    chmodSync(evil, 0o755);
    try {
      const res = spawnSync(
        '/bin/sh',
        [join(ROOT, 'bin', 'fan'), '--version'],
        {
          cwd: dir,
          env: { ...process.env, PATH: `.:${process.env.PATH ?? ''}` },
          encoding: 'utf8',
        },
      );
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout).not.toContain('CWD_HIJACKED');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
