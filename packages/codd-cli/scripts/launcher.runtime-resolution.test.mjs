/**
 * codd-cli 启动器运行时解析防劫持与三入口形态回归测试:
 * 覆盖 bin/codd.mjs、bin/codd、bin/codd.cmd 的 PATH 绝对化解析、Node 版本门限 (>=22.18)、
 * Windows IS_BUN 隔离防污染、POSIX 多级符号链接解析、独立 bin/bunfig.toml 隔离以及 POSIX 实跑对照。
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
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executable,
} from '../bin/codd.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readLauncher = (relative) => readFileSync(join(ROOT, relative), 'utf8');

describe('win32 / POSIX PATH 解析防劫持与 Node 版本校验', () => {
  test('win32 PATH 只认绝对目录, 跳过空与相对条目, .com 先于 .exe 且剥除引号', () => {
    const asked = [];
    expect(
      resolveWin32Executable('bun', ';;.;relative;sub\\dir', (candidate) => {
        asked.push(candidate);
        return true;
      }),
    ).toBeNull();
    expect(asked).toEqual([]);

    expect(resolveWin32Executable('bun', 'C:\\tools', () => true)).toBe(
      'C:\\tools\\bun.com',
    );
    expect(
      resolveWin32Executable(
        'bun',
        '"C:\\Program Files\\bun";D:\\x',
        (candidate) => candidate === 'C:\\Program Files\\bun\\bun.exe',
      ),
    ).toBe('C:\\Program Files\\bun\\bun.exe');
  });

  test('POSIX PATH 只认绝对目录并保持逐候选搜索语义', () => {
    const asked = [];
    expect(
      resolvePosixExecutables('bun', '::.:relative:/usr/bin', (candidate) => {
        asked.push(candidate);
        return candidate === '/usr/bin/bun';
      }),
    ).toEqual(['/usr/bin/bun']);
    expect(asked).toEqual(['/usr/bin/bun']);

    const probed = [];
    const runtime = pickRuntime({
      platform: 'darwin',
      pathEnv: '::.tools:/first:/second',
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

  test('pickRuntime 在 win32 不触发 cwd 劫持并支持 bun -> node 回退', () => {
    let probed = 0;
    expect(
      pickRuntime({
        platform: 'win32',
        pathEnv: ';;.',
        fileProbe: () => true,
        probe: () => {
          probed += 1;
          return true;
        },
      }),
    ).toBeNull();
    expect(probed).toBe(0);

    expect(
      pickRuntime({
        platform: 'win32',
        pathEnv: 'C:\\tools',
        fileProbe: (candidate) => candidate === 'C:\\tools\\node.exe',
        probe: () => true,
      }),
    ).toBe('C:\\tools\\node.exe');
  });

  test('isSupportedNodeVersion 严格校验 Node >= 22.18.0', () => {
    expect(isSupportedNodeVersion('v22.18.0')).toBe(true);
    expect(isSupportedNodeVersion('22.19.1')).toBe(true);
    expect(isSupportedNodeVersion('v24.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion('v20.18.0')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);
  });
});

describe('三入口与独立隔离配置静态形态钉住', () => {
  test('bin/bunfig.toml 独立极简隔离 (仅 env = false 与 preload = [], 无第三方镜像)', () => {
    const bunfig = readLauncher('bin/bunfig.toml');
    expect(bunfig).toContain('env = false');
    expect(bunfig).toContain('preload = []');
    expect(bunfig).not.toContain('npmmirror');
  });

  test('bin/codd 支持多级符号链接解析、只用 command -v 并引用独立 bin/bunfig.toml', () => {
    const source = readLauncher('bin/codd');
    expect(source).toContain('while [ -L "$target" ]');
    expect(source).toContain('command -v bun');
    expect(source).toContain('command -v node');
    expect(source).toContain('$root/bin/bunfig.toml');
    expect(source).not.toContain('assets/template');
    expect(source).not.toMatch(/^\s*where\s/m);
  });

  test('bin/codd.cmd 仅在 RUNNER 定义后才设 IS_BUN, 防止污染 node 回退', () => {
    const source = readLauncher('bin/codd.cmd');
    expect(source).toContain('set "BUNFIG=%ROOT%\\bin\\bunfig.toml"');
    expect(source).toContain(
      'for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"',
    );
    expect(source).toContain('if defined RUNNER set "IS_BUN=1"');
    expect(source).not.toMatch(/^\s*where\s/m);
    expect(source).not.toContain('assets\\template');
  });

  test('bin/codd.mjs 引用独立 bin/bunfig.toml、校验绝对 PATH 且缺失隔离配置拒绝启动', () => {
    const source = readLauncher('bin/codd.mjs');
    expect(source).toContain("join(root, 'bin', 'bunfig.toml')");
    expect(source).toContain(
      'resolveWin32Executable(name, pathEnv, fileProbe)',
    );
    expect(source).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain('isSupportedNodeVersion');
    expect(source).not.toContain('assets/template/podman/bunfig.toml');
  });
});

describe('POSIX 实跑对照 (当前目录不参与解析)', () => {
  test('command -v 与 Node 裸名 spawn 都不命中 cwd 里的同名可执行探针', () => {
    if (process.platform === 'win32') return;

    const probeName = 'codd-cli-posix-probe';
    const dir = mkdtempSync(join(tmpdir(), 'codd-cli-probe-'));
    const probe = join(dir, probeName);
    writeFileSync(probe, '#!/bin/sh\necho HIJACKED\n');
    chmodSync(probe, 0o755);
    try {
      const viaSh = spawnSync('/bin/sh', ['-c', `command -v ${probeName}`], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(viaSh.stdout.trim()).toBe('');

      const viaNode = spawnSync(
        process.execPath,
        [
          '-e',
          `const r = require('node:child_process').spawnSync(${JSON.stringify(probeName)}, []); process.stdout.write(String(r.error?.code));`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(viaNode.stdout).toBe('ENOENT');

      const viaPath = spawnSync('/bin/sh', ['-c', `command -v ${probeName}`], {
        cwd: dir,
        env: { ...process.env, PATH: `${dir}:${process.env.PATH ?? ''}` },
        encoding: 'utf8',
      });
      expect(viaPath.stdout.trim()).toBe(probe);
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
