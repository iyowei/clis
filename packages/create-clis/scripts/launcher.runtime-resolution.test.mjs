/**
 * 启动器运行时解析防劫持与进程模型单测 (X-P0-1)。
 * 三个入口 (bin/create-clis.mjs / bin/create-clis / bin/create-clis.cmd) 挑运行时都不许让
 * 「当前目录」或 Windows 盘根相对路径 (`/usr/bin`) 进入解析面; 同时覆盖:
 * - win32 返回全部候选数组并逐一 probe (前位旧版 Node 18 / 损坏 shim 失败时继续后续 PATH);
 * - isSupportedNodeVersion (>= 22.18.0) 版本门禁;
 * - POSIX 壳按绝对 PATH 解析、40 跳软链上限、CDPATH 隔离与 CLIS_BUN_ISOLATED=1 透传;
 * - POSIX 宿主实跑对照: PATH 含空段或 `.` 时不命中 cwd 恶意探针, 软链循环触发 40 跳拦截。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executables,
} from '../bin/create-clis.mjs';

const ROOT = join(import.meta.dir, '..');

/** 读源码形态 (用于跨平台静态形态断言防回归) */
const readLauncher = (relative) => readFileSync(join(ROOT, relative), 'utf8');

describe('isSupportedNodeVersion (>= 22.18.0)', () => {
  test('接受 >= 22.18.0, 拒绝更低主/次版本与畸形串', () => {
    expect(isSupportedNodeVersion('v22.18.0')).toBe(true);
    expect(isSupportedNodeVersion('22.18.1')).toBe(true);
    expect(isSupportedNodeVersion('v22.19.0\n')).toBe(true);
    expect(isSupportedNodeVersion('v23.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v24.1.0')).toBe(true);

    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion('v20.19.0')).toBe(false);
    expect(isSupportedNodeVersion('v18.20.0')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
    expect(isSupportedNodeVersion('not-a-version')).toBe(false);
    expect(isSupportedNodeVersion(null)).toBe(false);
  });
});

describe('win32 PATH 解析 (注入)', () => {
  test('只认盘符/UNC 绝对目录: 空条目、相对条目与 MSYS2 盘根相对路径 (/usr/bin) 全部拒绝', () => {
    const asked = [];
    const resolved = resolveWin32Executables(
      'bun',
      ';;.;relative;sub\\dir;/usr/bin;\\usr\\bin;C:relative;\\\\onlyhost',
      (candidate) => {
        asked.push(candidate);
        return true;
      },
    );

    expect(resolved).toEqual([]);
    // 探针一次都没被问过: 根本没有候选进入解析面
    expect(asked).toEqual([]);
  });

  test('绝对目录 (盘符正反斜杠与 UNC) 均解析, 返回全部候选且 .com 先于 .exe', () => {
    const asked = [];
    const resolved = resolveWin32Executables(
      'bun',
      'C:\\tools;D:/alt;\\\\server\\share\\bin',
      (candidate) => {
        asked.push(candidate);
        return true;
      },
    );

    expect(resolved).toEqual([
      'C:\\tools\\bun.com',
      'C:\\tools\\bun.exe',
      'D:\\alt\\bun.com',
      'D:\\alt\\bun.exe',
      '\\\\server\\share\\bin\\bun.com',
      '\\\\server\\share\\bin\\bun.exe',
    ]);
    expect(asked).toEqual(resolved);
  });

  test('多目录按序解析: 前序目录无候选时落到后序目录', () => {
    const resolved = resolveWin32Executables(
      'node',
      'C:\\a;D:\\b',
      (candidate) => candidate === 'D:\\b\\node.exe',
    );

    expect(resolved).toEqual(['D:\\b\\node.exe']);
  });

  test('引号包裹的目录条目剥引号后照常解析 (与 libuv 同款处理)', () => {
    const resolved = resolveWin32Executables(
      'bun',
      '"C:\\Program Files\\bun";D:\\x',
      (candidate) => candidate === 'C:\\Program Files\\bun\\bun.exe',
    );

    expect(resolved).toEqual(['C:\\Program Files\\bun\\bun.exe']);
  });

  test('全无候选: 返回空数组', () => {
    expect(resolveWin32Executables('bun', 'C:\\a;D:\\b', () => false)).toEqual(
      [],
    );
  });
});

describe('POSIX PATH 解析 (注入)', () => {
  test('只认 `/` 开头绝对目录: 空条目与相对条目 (均意为当前目录) 不解析', () => {
    const asked = [];
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

describe('pickRuntime 的 win32 分支 (注入)', () => {
  test('解析不出绝对路径时不因当前目录里有同名文件而选中 (探测环节不被触发)', () => {
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

  test('首候选 probe 失败 (如前位是旧版 Node 18 或损坏 shim) 时继续尝试后续 PATH 候选', () => {
    const probed = [];
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: 'C:\\old-node;D:\\node22',
      fileProbe: (candidate) =>
        candidate === 'C:\\old-node\\node.exe' ||
        candidate === 'D:\\node22\\node.exe',
      probe: (command) => {
        probed.push(command);
        return command === 'D:\\node22\\node.exe';
      },
    });

    expect(runtime).toBe('D:\\node22\\node.exe');
    expect(probed).toEqual(['C:\\old-node\\node.exe', 'D:\\node22\\node.exe']);
  });

  test('命中 PATH 里的绝对路径, 并以该绝对路径去探测与执行', () => {
    const probed = [];
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: 'C:\\tools',
      fileProbe: (candidate) => candidate === 'C:\\tools\\bun.exe',
      probe: (command) => {
        probed.push(command);
        return true;
      },
    });

    expect(runtime).toBe('C:\\tools\\bun.exe');
    expect(probed).toEqual(['C:\\tools\\bun.exe']);
  });

  test('bun 解析不出时回退 node', () => {
    const runtime = pickRuntime({
      platform: 'win32',
      pathEnv: 'C:\\tools',
      fileProbe: (candidate) => candidate === 'C:\\tools\\node.exe',
      probe: () => true,
    });

    expect(runtime).toBe('C:\\tools\\node.exe');
  });
});

describe('pickRuntime 的 POSIX 分支 (注入)', () => {
  test('按 PATH 解析绝对路径 (跳过空与相对条目) 并以绝对路径探测', () => {
    const probed = [];
    const runtime = pickRuntime({
      platform: 'darwin',
      pathEnv: '/opt/homebrew/bin::.tools:/usr/bin',
      fileProbe: (candidate) => candidate === '/usr/bin/node',
      probe: (command) => {
        probed.push(command);
        return true;
      },
    });

    expect(runtime).toBe('/usr/bin/node');
    expect(probed).toEqual(['/usr/bin/node']);
  });

  test('首候选探测失败时继续后续候选 (execvp 继续搜索语义)', () => {
    const probed = [];
    const runtime = pickRuntime({
      platform: 'darwin',
      pathEnv: '/first:/second',
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
  test('sh 启动器: 仅按绝对 PATH 扫描、软链 40 跳上限、CDPATH 隔离并透传 CLIS_BUN_ISOLATED=1', () => {
    const source = readLauncher('bin/create-clis');

    expect(source).toContain('IFS=:');
    expect(source).toContain('/*)');
    expect(source).toContain('-gt 40');
    expect(source).toContain('CDPATH=');
    expect(source).toContain('CLIS_BUN_ISOLATED=1');
    expect(source).not.toContain('command -v');
    expect(source).not.toMatch(/^\s*where\s/m);
  });

  test('cmd 启动器: for PATH 展开、单行置位 IS_BUN 与 CLIS_BUN_ISOLATED 且纯 ASCII 报错', () => {
    const source = readLauncher('bin/create-clis.cmd');

    expect(source).toContain('set "RUNNER=%%~$PATH:I"');
    expect(source).toContain('if defined RUNNER set "IS_BUN=1"');
    expect(source).toContain('if defined IS_BUN set "CLIS_BUN_ISOLATED=1"');
    expect(source).toContain(
      'if defined IS_BUN "%RUNNER%" "--config=%BUNFIG%" --no-env-file "%ENTRY%" %*',
    );
    expect(source).toContain('"%RUNNER%" "%ENTRY%" %*');
    expect(source).not.toMatch(/^\s*where\s/m);
    expect(source).not.toMatch(/set "RUNNER=(bun|node)"/);
    expect(source).not.toMatch(/set "RUNNER=%%~\$PATH:I"\s*&/);
  });

  test('npm 启动器: 全候选 win32 解析、Node 版本门禁、同进程 import 与信号收口', () => {
    const source = readLauncher('bin/create-clis.mjs');

    expect(source).toContain("platform === 'win32'");
    expect(source).toContain(
      'resolveWin32Executables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain('process.env.PATH ?? process.env.Path');
    expect(source).toContain('isSupportedNodeVersion');
    expect(source).toContain('CLIS_BUN_ISOLATED');
    expect(source).toContain('pathToFileURL(entry).href');
    expect(source).toContain('process.kill(process.pid, result.signal)');
    expect(source).toContain('bunfig.toml');
    expect(source).toContain('--no-env-file');
  });
});

describe('POSIX 实跑对照 (防 cwd 劫持与软链环拦截)', () => {
  test('bin/create-clis 在 PATH 含空段/相对段时不命中 cwd 恶意 bun/node, 并拦截 >40 跳软链循环', () => {
    if (process.platform === 'win32') return;
    if (!existsSync(join(ROOT, 'dist', 'create-clis.js'))) return;

    const dir = mkdtempSync(join(tmpdir(), 'create-clis-sh-guard-'));
    try {
      for (const decoy of ['bun', 'node']) {
        const probe = join(dir, decoy);
        writeFileSync(probe, '#!/bin/sh\necho HIJACKED\nexit 99\n');
        chmodSync(probe, 0o755);
      }

      const launcher = join(ROOT, 'bin', 'create-clis');
      const res = spawnSync(launcher, ['--version'], {
        cwd: dir,
        encoding: 'utf8',
        env: {
          ...process.env,
          PATH: `:.:./:${process.env.PATH ?? ''}`,
        },
      });
      expect(res.status, `stderr=${res.stderr}`).toBe(0);
      expect(res.stdout).not.toContain('HIJACKED');
      expect(res.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

      // 软链环测试: a -> b -> a 经 `/bin/sh -c <script> <loopA>` 直接注入 $0, 绕过内核 ELOOP,
      // 真实触发脚本内 `while [ -L "$target" ]` 的 40 跳熔断上限 (无上限时会永久死循环)
      const loopA = join(dir, 'loop-a');
      const loopB = join(dir, 'loop-b');
      symlinkSync(loopB, loopA);
      symlinkSync(loopA, loopB);
      const deep = spawnSync(
        '/bin/sh',
        ['-c', readLauncher('bin/create-clis'), loopA, '--version'],
        {
          cwd: dir,
          encoding: 'utf8',
          timeout: 5_000,
        },
      );
      expect(deep.status).toBe(1);
      expect(deep.stderr).toContain('40');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
