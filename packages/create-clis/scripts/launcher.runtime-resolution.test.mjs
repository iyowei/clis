/**
 * 启动器运行时解析防劫持 (安全审计项 runtime-resolution:bare-name-cwd-precedence-windows)。
 * 三个入口 (bin/create-clis.mjs / bin/create-clis / bin/create-clis.cmd) 挑运行时都不许让
 * 「当前目录」进入解析面: Windows 上 CreateProcessW 与 libuv 的裸名搜索序都把当前目录排在
 * PATH 之前, 而生成器的调用现场恰是在用户自己的目录里执行。
 *
 * 覆盖面 (与兄弟包 packages/sweep-node-modules-cli/src/launcher.runtime-resolution.test.ts
 * 同款口径):
 * - win32 分支的 PATH 解析 (注入 platform 与探针): 只认绝对目录, 空条目与相对条目 (Windows 上
 *   均意为当前目录) 一律不解析; 引号包裹的目录条目剥引号后照常解析; 扩展名 .com / .exe,
 *   与 Node 实际走的 libuv 搜索同面.
 * - pickRuntime 的 win32 分支: 解析不出绝对路径时不因当前目录里有同名文件而选中.
 * - pickRuntime 的 POSIX 分支同法收紧: 按 PATH 解析绝对路径 (跳过空与相对条目), 逐候选探测
 *   (保持 execvp 首候选不可执行时继续搜索的语义).
 * - sh / cmd 两个启动器的解析形态静态钉住 (它们没有可注入的宿主, 只能以形态断言防回归).
 * - POSIX 宿主实跑对照: command -v 与 Node 裸名 spawn 都不命中 cwd 里的同名可执行探针.
 *
 * 为什么是 .mjs 而非 .ts: 被测对象是纯 JS 分发入口 (node 直跑, 不进 tsc 编译面), 用 .ts 测试
 * 就得给 bin/ 配类型投影 (bin/create-clis.d.mts), 而 files 白名单整目录收 bin/, 投影会多出一份
 * 发行面文件 (白名单契约是 bin 三件); .mjs 不进 tsc --noEmit 面 (allowJs 未开), 由 bun test 跑.
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
  pickRuntime,
  resolvePosixExecutables,
  resolveWin32Executable,
} from '../bin/create-clis.mjs';

const ROOT = join(import.meta.dir, '..');

/** 读源码形态 (两个 shell 启动器不可在 POSIX 宿主上实跑, 以形态断言防回归) */
const readLauncher = (relative) => readFileSync(join(ROOT, relative), 'utf8');

describe('win32 PATH 解析 (注入)', () => {
  test('只认绝对目录: 空条目与相对条目 (Windows 上均意为当前目录) 不解析', () => {
    const asked = [];
    const resolved = resolveWin32Executable(
      'bun',
      ';;.;relative;sub\\dir',
      (candidate) => {
        asked.push(candidate);
        return true;
      },
    );

    expect(resolved).toBeNull();
    // 探针一次都没被问过: 不是「问了没命中」, 而是根本没有候选进入解析面
    expect(asked).toEqual([]);
  });

  test('绝对目录命中: 扩展名顺序 .com 先于 .exe (与 libuv 搜索一致)', () => {
    const asked = [];
    const resolved = resolveWin32Executable('bun', 'C:\\tools', (candidate) => {
      asked.push(candidate);
      return true;
    });

    expect(resolved).toBe('C:\\tools\\bun.com');
    expect(asked).toEqual(['C:\\tools\\bun.com']);
  });

  test('多目录按序解析: 前序目录无候选时落到后序目录', () => {
    const resolved = resolveWin32Executable(
      'node',
      'C:\\a;D:\\b',
      (candidate) => candidate === 'D:\\b\\node.exe',
    );

    expect(resolved).toBe('D:\\b\\node.exe');
  });

  test('引号包裹的目录条目剥引号后照常解析 (与 libuv 同款处理)', () => {
    const resolved = resolveWin32Executable(
      'bun',
      '"C:\\Program Files\\bun";D:\\x',
      (candidate) => candidate === 'C:\\Program Files\\bun\\bun.exe',
    );

    expect(resolved).toBe('C:\\Program Files\\bun\\bun.exe');
  });

  test('全无候选: 返回 null', () => {
    expect(
      resolveWin32Executable('bun', 'C:\\a;D:\\b', () => false),
    ).toBeNull();
  });
});

describe('POSIX PATH 解析 (注入)', () => {
  test('只认绝对目录: 空条目与相对条目 (均意为当前目录) 不解析', () => {
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
      pathEnv: ';;.',
      fileProbe: () => true,
      probe: () => {
        probed += 1;
        return true;
      },
    });

    expect(runtime).toBeNull();
    expect(probed).toBe(0);
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
  test('sh 启动器: command -v 只按 PATH 解析, 不引入 where 类含当前目录的搜索', () => {
    const source = readLauncher('bin/create-clis');

    expect(source).toContain('command -v bun');
    expect(source).toContain('command -v node');
    expect(source).not.toMatch(/^\s*where\s/m);
  });

  test('cmd 启动器: for 的 PATH 展开修饰符 (只搜 PATH), 不落回 where 默认搜索或裸名赋值', () => {
    const source = readLauncher('bin/create-clis.cmd');

    expect(source).toContain('set "RUNNER=%%~$PATH:I"');
    expect(source).toContain('"%RUNNER%" "%ENTRY%" %*');
    // 防回归: where 的默认搜索含当前目录, 裸名赋值同理, 二者都不得回到解析链路
    expect(source).not.toMatch(/^\s*where\s/m);
    expect(source).not.toMatch(/set "RUNNER=(bun|node)"/);
  });

  test('npm 启动器: win32 分支走 resolveWin32Executable (形态不被摘掉)', () => {
    const source = readLauncher('bin/create-clis.mjs');

    expect(source).toContain("platform === 'win32'");
    expect(source).toContain(
      'resolveWin32Executable(name, pathEnv, fileProbe)',
    );
  });

  test('npm 启动器: POSIX 分支走 resolvePosixExecutables (形态不被摘掉)', () => {
    const source = readLauncher('bin/create-clis.mjs');

    expect(source).toContain(
      'resolvePosixExecutables(name, pathEnv, fileProbe)',
    );
  });
});

describe('POSIX 实跑对照 (当前目录不参与解析)', () => {
  test('command -v 与 Node 裸名 spawn 都不命中 cwd 里的同名可执行探针', () => {
    if (process.platform === 'win32') return;

    const probeName = 'create-clis-posix-probe';
    const dir = mkdtempSync(join(tmpdir(), 'create-clis-probe-'));
    const probe = join(dir, probeName);
    writeFileSync(probe, '#!/bin/sh\necho HIJACKED\n');
    chmodSync(probe, 0o755);
    try {
      // 探针在 cwd 里, 但不在 PATH 里: command -v 不得命中
      const viaSh = spawnSync('/bin/sh', ['-c', `command -v ${probeName}`], {
        cwd: dir,
        encoding: 'utf8',
      });
      expect(viaSh.stdout.trim()).toBe('');

      // Node 的裸名 spawn 同理 (libuv 在 POSIX 走 execvp, 只搜 PATH)
      const viaNode = spawnSync(
        process.execPath,
        [
          '-e',
          `const r = require('node:child_process').spawnSync(${JSON.stringify(probeName)}, []); process.stdout.write(String(r.error?.code));`,
        ],
        { cwd: dir, encoding: 'utf8' },
      );
      expect(viaNode.stdout).toBe('ENOENT');

      // 对照组: 把 cwd 挂进 PATH 后 command -v 命中该探针, 证明探针本身可被解析到,
      // 上面的「不命中」不是探针无效造成的
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
