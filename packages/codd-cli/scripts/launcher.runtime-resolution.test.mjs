/**
 * codd-cli 启动器运行时解析防劫持与三入口形态回归测试:
 * 覆盖 bin/codd.mjs、bin/codd、bin/codd.cmd 的盘符/UNC 绝对 PATH 解析、多候选顺延、Node 版本门限 (>=22.18)、
 * CLIS_BUN_ISOLATED 隔离、POSIX 40 跳软链上限与绝对 PATH 扫描以及 POSIX 实跑对照。
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
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

import {
  isEntry,
  isSupportedNodeVersion,
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executables,
} from '../bin/codd.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const readLauncher = (rel) => readFileSync(join(ROOT, rel), 'utf8');

describe('win32 / POSIX PATH 解析防劫持与 Node 版本校验', () => {
  test('win32 PATH 仅认盘符与 UNC 绝对目录, 拒 /usr/bin 盘根相对路径并返回全部候选', () => {
    const asked = [];
    expect(
      resolveWin32Executables(
        'bun',
        ';;.;relative;sub\\dir;/usr/bin;\\tools',
        (candidate) => {
          asked.push(candidate);
          return true;
        },
      ),
    ).toEqual([]);
    expect(asked).toEqual([]);

    expect(
      resolveWin32Executables(
        'bun',
        'C:\\tools;\\\\srv\\share\\bin',
        () => true,
      ),
    ).toEqual([
      'C:\\tools\\bun.com',
      'C:\\tools\\bun.exe',
      '\\\\srv\\share\\bin\\bun.com',
      '\\\\srv\\share\\bin\\bun.exe',
    ]);

    expect(
      resolveWin32Executables(
        'bun',
        '"C:\\Program Files\\bun";D:\\x',
        (candidate) => candidate === 'C:\\Program Files\\bun\\bun.exe',
      ),
    ).toEqual(['C:\\Program Files\\bun\\bun.exe']);
  });

  test(
    'pickRuntime 在 win32 首候选 probe 失败时继续顺延至后续候选, 且支持 names=[' +
      "'bun'] 仅探 bun",
    () => {
      const probed = [];
      const picked = pickRuntime({
        platform: 'win32',
        pathEnv: 'C:\\old;C:\\good',
        fileProbe: (candidate) =>
          candidate === 'C:\\old\\node.exe' ||
          candidate === 'C:\\good\\node.exe',
        probe: (cmd) => {
          probed.push(cmd);
          return cmd === 'C:\\good\\node.exe';
        },
      });
      expect(picked).toBe('C:\\good\\node.exe');
      expect(probed).toEqual(['C:\\old\\node.exe', 'C:\\good\\node.exe']);

      const bunOnlyProbed = [];
      const none = pickRuntime({
        platform: 'win32',
        pathEnv: 'C:\\good',
        names: ['bun'],
        fileProbe: (candidate) => candidate === 'C:\\good\\node.exe',
        probe: (cmd) => {
          bunOnlyProbed.push(cmd);
          return true;
        },
      });
      expect(none).toBeNull();
      expect(bunOnlyProbed).toEqual([]);
    },
  );

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

  test('pickRuntime 在 win32 不触发 cwd 劫持, isEntry 支持相对入口路径归一, 严格校验 Node >= 22.18', () => {
    let probed = 0;
    expect(
      pickRuntime({
        platform: 'win32',
        pathEnv: ';;.;/usr/bin',
        fileProbe: () => true,
        probe: () => {
          probed += 1;
          return true;
        },
      }),
    ).toBeNull();
    expect(probed).toBe(0);

    const selfPath = join(ROOT, 'bin', 'codd.mjs');
    const relSelf = relative(process.cwd(), selfPath);
    expect(isEntry(relSelf, pathToFileURL(selfPath).href)).toBe(true);

    expect(isSupportedNodeVersion('v22.18.0')).toBe(true);
    expect(isSupportedNodeVersion('22.19.1')).toBe(true);
    expect(isSupportedNodeVersion('v24.0.0')).toBe(true);
    expect(isSupportedNodeVersion('v22.17.9')).toBe(false);
    expect(isSupportedNodeVersion('v20.18.0')).toBe(false);
    expect(isSupportedNodeVersion('')).toBe(false);

    const prevPATH = process.env.PATH;
    const prevPath = process.env.Path;
    process.env.PATH = '';
    process.env.Path = 'C:\\tools';
    try {
      expect(
        pickRuntime({
          platform: 'win32',
          fileProbe: (candidate) => candidate === 'C:\\tools\\bun.exe',
          probe: () => true,
        }),
      ).toBe('C:\\tools\\bun.exe');
    } finally {
      if (prevPATH === undefined) delete process.env.PATH;
      else process.env.PATH = prevPATH;
      if (prevPath === undefined) delete process.env.Path;
      else process.env.Path = prevPath;
    }
  });
});

describe('三入口与独立隔离配置静态形态钉住', () => {
  test('bin/bunfig.toml 独立极简隔离 (仅 env = false 与 preload = [], 无第三方镜像)', () => {
    const bunfig = readLauncher('bin/bunfig.toml');
    expect(bunfig).toContain('env = false');
    expect(bunfig).toContain('preload = []');
    expect(bunfig).not.toContain('npmmirror');
  });

  test('bin/codd 设 CDPATH=、40 跳软链上限、绝对 PATH 扫描与 CLIS_BUN_ISOLATED=1', () => {
    const source = readLauncher('bin/codd');
    expect(source).toContain('CDPATH=');
    expect(source).toContain('while [ -L "$target" ]');
    expect(source).toContain('-ge 40');
    expect(source).toContain('find_in_abs_path');
    expect(source).toContain('CLIS_BUN_ISOLATED=1');
    expect(source).toContain('$root/bin/bunfig.toml');
    expect(source).not.toContain('command -v');
    expect(source).not.toContain('assets/template');
    expect(source).not.toMatch(/^\s*where\s/m);
  });

  test('bin/codd.cmd 仅在 RUNNER 定义后设 IS_BUN 与 CLIS_BUN_ISOLATED 且纯 ASCII 报错', () => {
    const source = readLauncher('bin/codd.cmd');
    expect(source).toContain('set "BUNFIG=%ROOT%\\bin\\bunfig.toml"');
    expect(source).toContain(
      'for %%I in (bun.com bun.exe) do if not defined RUNNER set "RUNNER=%%~$PATH:I"',
    );
    expect(source).toContain('if defined RUNNER set "IS_BUN=1"');
    expect(source).toContain('set "CLIS_BUN_ISOLATED=1"');
    expect(source).toContain('bun or node not found in PATH');
    expect(source).not.toMatch(/^\s*where\s/m);
    expect(source).not.toContain('assets\\template');
  });

  test('bin/codd.mjs 使用 resolveWin32Executables、盘符/UNC 严判、CLIS_BUN_ISOLATED 与 SIGINT 保护', () => {
    const source = readLauncher('bin/codd.mjs');
    expect(source).toContain("join(root, 'bin', 'bunfig.toml')");
    expect(source).toContain(
      'resolveWin32Executables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
    expect(source).toContain('WIN32_ABS_DIR_RE');
    expect(source).toContain('CLIS_BUN_ISOLATED');
    expect(source).toContain('process.env.Path');
    expect(source).toContain("process.on('SIGINT'");
    expect(source).toContain('isSupportedNodeVersion');
    expect(source).toContain('realpathSync.native ?? realpathSync');
    expect(source).not.toContain('assets/template/podman/bunfig.toml');
  });
});

describe('POSIX 实跑对照 (当前目录不参与解析)', () => {
  test('bin/codd 与 Node 裸名 spawn 都不命中 cwd 里的恶意同名可执行探针', () => {
    if (process.platform === 'win32') return;

    const probeName = 'codd-cli-posix-probe';
    const dir = mkdtempSync(join(tmpdir(), 'codd-cli-probe-'));
    const probe = join(dir, probeName);
    writeFileSync(probe, '#!/bin/sh\necho HIJACKED\n');
    chmodSync(probe, 0o755);
    try {
      const viaNode = spawnSync(
        process.execPath,
        [
          '-e',
          `const r = require('node:child_process').spawnSync(${JSON.stringify(probeName)}, []); process.stdout.write(String(r.error?.code));`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(viaNode.stdout).toBe('ENOENT');

      // 构造含空段与 '.' 的危险 PATH, 验证 bin/codd 忽略 cwd 内的假 bun
      const fakeBun = join(dir, 'bun');
      writeFileSync(fakeBun, '#!/bin/sh\necho HIJACKED_BUN\nexit 99\n');
      chmodSync(fakeBun, 0o755);
      const viaLauncher = spawnSync(
        '/bin/sh',
        [join(ROOT, 'bin/codd'), '--version'],
        {
          cwd: dir,
          env: {
            ...process.env,
            PATH: `:${dir === '' ? '' : '.'}:${process.env.PATH ?? ''}`,
          },
          encoding: 'utf8',
        },
      );
      expect(viaLauncher.stdout).not.toContain('HIJACKED_BUN');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
