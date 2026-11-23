/**
 * 启动器运行时解析防劫持与入口判定自证单测 (模板骨架)。
 * `bin/{{BIN_NAME}}.mjs` 与 POSIX `bin/{{BIN_NAME}}` 显式跳过 PATH 空段、相对条目及 Windows
 * Git Bash `/usr/bin` 盘根相对路径; `bin/{{BIN_NAME}}.cmd` 经 `%%~$PATH:I` 仅搜 PATH 而不默认搜当前目录。
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
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isEntry,
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executables,
} from '../bin/{{BIN_NAME}}.mjs';

const ROOT = join(import.meta.dir, '..');

/** 读源码形态 (跨平台 shell 启动器以形态断言防回归) */
const readLauncher = (relative: string): string =>
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
    expect(isSupportedNodeVersion(undefined)).toBe(false);
  });
});

describe('win32 PATH 解析 (注入)', () => {
  test('只认盘符或 UNC 绝对目录: 拒绝空条目、相对条目与盘根相对路径', () => {
    const asked: string[] = [];
    const resolved = resolveWin32Executables(
      'bun',
      ';;.;relative;sub\\dir;/usr/bin;\\Windows;C:relative',
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

  test('先 trim 再剥外层双引号并按大小写去重', () => {
    const resolved = resolveWin32Executables(
      'bun',
      ' "C:\\Program Files\\bun" ; c:\\program files\\bun ; D:/alt ',
      (candidate) =>
        candidate.toLowerCase() === 'c:\\program files\\bun\\bun.exe' ||
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
  test('只认绝对目录并去重: 空条目与相对条目 (均意为当前目录) 不解析', () => {
    const asked: string[] = [];
    const resolved = resolvePosixExecutables(
      'bun',
      '::.:relative:/usr/bin:/usr/bin',
      (candidate) => {
        asked.push(candidate);
        return candidate === '/usr/bin/bun';
      },
    );

    expect(resolved).toEqual(['/usr/bin/bun']);
    expect(asked).toEqual(['/usr/bin/bun']);
  });
});

describe('pickRuntime 跨平台优先序与探测 (注入)', () => {
  test('默认优先序: bun 优先于 node', () => {
    const probed: string[] = [];
    const runtime = pickRuntime({
      platform: 'darwin',
      pathEnv: '/usr/local/bin',
      fileProbe: () => true,
      probe: (command) => {
        probed.push(command);
        return true;
      },
    });

    expect(runtime).toBe('/usr/local/bin/bun');
    expect(probed).toEqual(['/usr/local/bin/bun']);
  });

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

  test('win32: 前位候选 probe 失败时继续探测后续目录候选, bun 无候选时回退 node', () => {
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

describe('isEntry 入口同源判定', () => {
  test('正确识别同文件直接入口、拒绝空参数与异文件导入并兼容 win32 大小写折叠', () => {
    const launcherPath = join(ROOT, 'bin', '{{BIN_NAME}}.mjs');
    const launcherUrl = pathToFileURL(launcherPath).href;
    const thisTestPath = fileURLToPath(import.meta.url);
    const upperVirtual = join(
      tmpdir(),
      'CaseProbeVirtualDir_7f9a',
      '{{BIN_NAME}}.mjs',
    );
    const lowerVirtualUrl = pathToFileURL(
      join(tmpdir(), 'caseprobevirtualdir_7f9a', '{{BIN_NAME}}.mjs'),
    ).href;

    expect(isEntry('', launcherUrl, 'darwin')).toBe(false);
    expect(isEntry(launcherPath, launcherUrl, 'darwin')).toBe(true);
    expect(isEntry(thisTestPath, launcherUrl, 'darwin')).toBe(false);
    expect(isEntry(upperVirtual, lowerVirtualUrl, 'win32')).toBe(true);
    expect(isEntry(upperVirtual, lowerVirtualUrl, 'linux')).toBe(false);
  });
});

describe('三入口解析形态与 POSIX 防劫持实跑', () => {
  test('sh / cmd / mjs 启动器保留绝对路径解析与 Bun 配置隔离护栏', () => {
    const shSource = readLauncher('bin/{{BIN_NAME}}');
    expect(shSource).toContain('find_abs_exec');
    expect(shSource).toContain('40');
    expect(shSource).toContain('CDPATH=');
    expect(shSource).toContain('CLIS_BUN_ISOLATED=1');
    expect(shSource).toContain('--no-env-file');
    expect(shSource).toContain('bunfig.toml');
    expect(shSource).not.toMatch(/^\s*where\s/m);

    const cmdSource = readLauncher('bin/{{BIN_NAME}}.cmd');
    expect(cmdSource).toContain('bin\\{{BIN_NAME}}.mjs');
    if (!/^sweep$/i.test('{{BIN_NAME}}')) {
      expect(cmdSource).not.toMatch(/\bsweep\b/i);
    }
    expect(cmdSource).toContain('set "RUNNER=%%~$PATH:I"');
    expect(cmdSource).toContain('"%RUNNER%" "%ENTRY%" %*');
    expect(cmdSource).toContain('--no-env-file');
    expect(cmdSource).toContain('bunfig.toml');
    expect(cmdSource).toContain('{{BIN_NAME}}: bun or node not found in PATH');
    expect(cmdSource).not.toMatch(/^\s*where\s/m);

    const mjsSource = readLauncher('bin/{{BIN_NAME}}.mjs');
    expect(mjsSource).toContain("platform === 'win32'");
    expect(mjsSource).toContain(
      'resolveWin32Executables(name, pathEnv, fileProbe)',
    );
    expect(mjsSource).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
    expect(mjsSource).toContain('--no-env-file');
    expect(mjsSource).toContain('bunfig.toml');
    expect(mjsSource).toContain('CLIS_BUN_ISOLATED');
  });

  test('POSIX: bin/{{BIN_NAME}} 在 PATH 含空段或相对条目时绝不执行 cwd 里的恶意 ./bun', () => {
    if (process.platform === 'win32') return;

    const dir = mkdtempSync(join(tmpdir(), 'cli-launcher-probe-'));
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
          [join(ROOT, 'bin', '{{BIN_NAME}}'), '--version'],
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
