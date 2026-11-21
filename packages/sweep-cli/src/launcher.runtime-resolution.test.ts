/**
 * 启动器运行时解析防劫持 (X-P0-1 / SWEEPCLI-P0-5 / runtime-resolution:bare-name-cwd-precedence-windows)。
 * 三个入口 (bin/sweep.mjs / bin/sweep / bin/sweep.cmd) 挑运行时都不许让「当前目录」
 * 进入解析面, 且拦截 Windows Git Bash 注入的 `/usr/bin` 盘根相对路径与 POSIX `PATH=":$PATH"` 空段劫持。
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
} from '../bin/sweep.mjs';

const ROOT = join(import.meta.dir, '..');

/** 读源码形态 (跨平台 shell 启动器以形态断言防回归) */
const readLauncher = (relative: string) =>
  readFileSync(join(ROOT, relative), 'utf8');

describe('Node 版本门禁 (isSupportedNodeVersion >= 22.18.0)', () => {
  test('正确判定临界版本与非法输入', () => {
    expect(isSupportedNodeVersion('v22.18.0\n')).toBe(true);
    expect(isSupportedNodeVersion('22.19.1')).toBe(true);
    expect(isSupportedNodeVersion('v24.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion('v20.19.0')).toBe(false);
    expect(isSupportedNodeVersion('invalid')).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
  });
});

describe('win32 PATH 解析 (注入)', () => {
  test('只认盘符或 UNC 绝对目录: 拒绝空条目、相对条目与 Git Bash 注入的 /usr/bin 盘根相对路径', () => {
    const asked: string[] = [];
    const resolved = resolveWin32Executables(
      'bun',
      ';;.;relative;sub\\dir;/usr/bin;\\Windows',
      (candidate) => {
        asked.push(candidate);
        return true;
      },
    );

    expect(resolved).toEqual([]);
    expect(asked).toEqual([]);
  });

  test('绝对目录与 UNC 路径返回全部候选: 扩展名顺序 .com 先于 .exe', () => {
    const resolved = resolveWin32Executables(
      'bun',
      'C:\\tools;\\\\server\\share\\bin',
      () => true,
    );

    expect(resolved).toEqual([
      'C:\\tools\\bun.com',
      'C:\\tools\\bun.exe',
      '\\\\server\\share\\bin\\bun.com',
      '\\\\server\\share\\bin\\bun.exe',
    ]);
  });

  test('先 trim 再剥外层双引号, 兼容含前后空白与引号的 PATH 条目', () => {
    const resolved = resolveWin32Executables(
      'bun',
      ' "C:\\Program Files\\bun" ; D:/alt ',
      (candidate) =>
        candidate === 'C:\\Program Files\\bun\\bun.exe' ||
        candidate === 'D:\\alt\\bun.exe',
    );

    expect(resolved).toEqual([
      'C:\\Program Files\\bun\\bun.exe',
      'D:\\alt\\bun.exe',
    ]);
  });

  test('全无候选: 返回空数组', () => {
    expect(resolveWin32Executables('bun', 'C:\\a;D:\\b', () => false)).toEqual(
      [],
    );
  });
});

describe('POSIX PATH 解析 (注入)', () => {
  test('只认绝对目录: 空条目与相对条目 (均意为当前目录) 不解析', () => {
    const asked: string[] = [];
    const resolved = resolvePosixExecutables(
      'bun',
      '::.:relative:/usr/bin',
      (candidate) => {
        asked.push(candidate);
        return candidate === '/usr/bin/bun';
      },
    );

    expect(resolved).toEqual(['/usr/bin/bun']);
    expect(asked).toEqual(['/usr/bin/bun']);
  });
});

describe('pickRuntime 跨平台探测 (注入)', () => {
  test('win32: 解析不出绝对路径时不触发探测', () => {
    let probed = 0;
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: ';;.;/usr/bin',
      fileProbe: () => true,
      probe: () => {
        probed += 1;
        return true;
      },
    });

    expect(runtime).toBeNull();
    expect(probed).toBe(0);
  });

  test('win32: 前位候选 probe 失败时继续探测后续目录候选 (不早退)', () => {
    const probed: string[] = [];
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: 'C:\\old-node;D:\\good-node',
      fileProbe: (candidate) => candidate.endsWith('node.exe'),
      probe: (command) => {
        probed.push(command);
        return command === 'D:\\good-node\\node.exe';
      },
    });

    expect(runtime).toBe('D:\\good-node\\node.exe');
    expect(probed).toEqual([
      'C:\\old-node\\node.exe',
      'D:\\good-node\\node.exe',
    ]);
  });

  test('win32: bun 解析不出时回退 node', () => {
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: 'C:\\tools',
      fileProbe: (candidate) => candidate === 'C:\\tools\\node.exe',
      probe: () => true,
    });

    expect(runtime).toBe('C:\\tools\\node.exe');
  });

  test('POSIX: 跳过空与相对条目, 首候选探测失败时继续后续候选', () => {
    const probed: string[] = [];
    const runtime = pickRuntime({
      platform: 'darwin',
      pathEnv: ':/first:.:/second',
      fileProbe: (candidate) =>
        candidate === '/first/bun' || candidate === '/second/bun',
      probe: (command) => {
        probed.push(command);
        return command === '/second/bun';
      },
    });

    expect(runtime).toBe('/second/bun');
    expect(probed).toEqual(['/first/bun', '/second/bun']);
  });
});

describe('三入口解析形态 (静态钉住)', () => {
  test('sh 启动器: 仅扫 / 开头绝对 PATH 目录、含 40 跳软链上限、清 CDPATH 并导出 CLIS_BUN_ISOLATED=1', () => {
    const source = readLauncher('bin/sweep');

    expect(source).toContain('find_abs_exec');
    expect(source).toContain('40');
    expect(source).toContain('CDPATH=');
    expect(source).toContain('CLIS_BUN_ISOLATED=1');
    expect(source).toContain('--no-env-file');
    expect(source).toContain('bunfig.toml');
    expect(source).not.toMatch(/^\s*where\s/m);
  });

  test('cmd 启动器: PATH 展开修饰符、无 where 且缺失报错为纯 ASCII (SWEEPCLI-P0-5)', () => {
    const source = readLauncher('bin/sweep.cmd');

    expect(source).toContain('set "RUNNER=%%~$PATH:I"');
    expect(source).toContain('"%RUNNER%" "%ENTRY%" %*');
    expect(source).toContain('--no-env-file');
    expect(source).toContain('bunfig.toml');
    expect(source).toContain('sweep: bun or node not found in PATH');
    expect(source).not.toMatch(/^\s*where\s/m);
    expect(source).not.toMatch(/set "RUNNER=(bun|node)"/);
  });

  test('npm 启动器: win32 与 POSIX 分别走 resolveWin32Executables / resolvePosixExecutables', () => {
    const source = readLauncher('bin/sweep.mjs');

    expect(source).toContain("platform === 'win32'");
    expect(source).toContain(
      'resolveWin32Executables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain('--no-env-file');
    expect(source).toContain('bunfig.toml');
    expect(source).toContain('CLIS_BUN_ISOLATED');
  });
});

describe('POSIX 实跑对照 (PATH 含空段或相对条目不命中 cwd 恶意程序)', () => {
  test('bin/sweep 在 PATH=":$PATH" 与 PATH=".:$PATH" 下绝不执行 cwd 里的恶意 ./bun', () => {
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'sweep-probe-'));
    const evilBun = join(dir, 'bun');
    writeFileSync(evilBun, '#!/bin/sh\necho CWD_BUN_HIJACKED\nexit 99\n');
    chmodSync(evilBun, 0o755);
    try {
      for (const badPath of [
        `:${process.env.PATH ?? ''}`,
        `.:${process.env.PATH ?? ''}`,
      ]) {
        const res = spawnSync(
          '/bin/sh',
          [join(ROOT, 'bin', 'sweep'), '--version'],
          {
            cwd: dir,
            env: { ...process.env, PATH: badPath },
            encoding: 'utf8',
          },
        );
        expect(res.status, res.stderr).toBe(0);
        expect(res.stdout).not.toContain('CWD_BUN_HIJACKED');
      }
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
