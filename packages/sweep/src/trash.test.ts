/**
 * 零依赖跨平台回收站 (`trash`) 专项测试:
 * - macOS: 桩测 `/usr/bin/trash -s` 与缺失降级 `/usr/bin/osascript` (argv 防注入, 不污染宿主机真实废纸篓);
 * - Linux: 纯 TS Freedesktop XDG Trash 真实文件系统实测 (files/ + info/*.trashinfo + 重名冲突 + EXDEV 清理);
 * - Windows: 纯桩测试 (仅经桩/逻辑测试, 未在 Windows 真机实测);
 * - 红线 2 反证: 三端失败经 removeTargets / removeBatch / createSweeper().run() 断言磁盘原文件 100% 完好、绝不降级 rm。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { type Stats, existsSync } from 'node:fs';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  realpath,
  rm,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeBatch, removeTargets } from './delete.ts';
import { summarizeReport } from './summary.ts';
import { createSweeper } from './sweep.ts';
import {
  MACOS_OSASCRIPT_BIN,
  MACOS_TRASH_BIN,
  type TrashDeps,
  WIN32_TRASH_MAX_PATH,
  encodeXdgTrashPath,
  formatTrashDeletionDate,
  moveToTrash,
  resolveWindowsPowerShell,
  resolveXdgTrashDir,
} from './trash.ts';

const dirs: string[] = [];

async function makeTempDir(): Promise<string> {
  const raw = await mkdtemp(join(tmpdir(), 'sweep-lab-trash-'));
  const real = await realpath(raw);
  dirs.push(real);
  return real;
}

afterEach(async () => {
  await Promise.all(
    dirs.map((dir) => rm(dir, { recursive: true, force: true })),
  );
  dirs.length = 0;
});

describe('trash 工具纯函数', () => {
  test('encodeXdgTrashPath / formatTrashDeletionDate / resolveXdgTrashDir / resolveWindowsPowerShell', () => {
    expect(encodeXdgTrashPath('/home/u/我的 项目/a b#1.log')).toBe(
      '/home/u/%E6%88%91%E7%9A%84%20%E9%A1%B9%E7%9B%AE/a%20b%231.log',
    );
    expect(formatTrashDeletionDate(new Date(2026, 10, 5, 8, 9, 3))).toBe(
      '2026-11-05T08:09:03',
    );
    expect(resolveXdgTrashDir({ XDG_DATA_HOME: '/data/xdg' }, '/home/u')).toBe(
      join('/data/xdg', 'Trash'),
    );
    expect(resolveXdgTrashDir({ XDG_DATA_HOME: 'relative' }, '/home/u')).toBe(
      join('/home/u', '.local', 'share', 'Trash'),
    );
    expect(resolveXdgTrashDir({}, '/home/u')).toBe(
      join('/home/u', '.local', 'share', 'Trash'),
    );
    expect(
      resolveWindowsPowerShell({ SystemRoot: 'D:\\Windows' }, () => true),
    ).toBe('D:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe');
    expect(resolveWindowsPowerShell({}, () => false)).toBeNull();
  });
});

describe('trash macOS 桩测试 (不污染真实废纸篓)', () => {
  test('主路径 /usr/bin/trash -s 成功与失败返回', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    const target = '/tmp/proj/node_modules';

    const ok = await moveToTrash(target, {
      platform: 'darwin',
      existsSync: (p) => p === MACOS_TRASH_BIN,
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(ok).toEqual({ ok: true, target, backend: 'macos-trash' });
    expect(calls).toEqual([{ file: MACOS_TRASH_BIN, args: ['-s', target] }]);

    const fail = await moveToTrash(target, {
      platform: 'darwin',
      existsSync: (p) => p === MACOS_TRASH_BIN,
      execFile: async () => ({ code: 1, stdout: '', stderr: 'not permitted' }),
    });
    expect(fail).toMatchObject({
      ok: false,
      target,
      code: 'TRASH_FAILED',
    });
  });

  test('/usr/bin/trash 缺失时降级 /usr/bin/osascript 且经 on run argv 独立传参防注入', async () => {
    const calls: { file: string; args: readonly string[] }[] = [];
    // 含双引号、反引号与换行的对抗性路径: 绝不能拼进 AppleScript 源码字符串
    const hostileTarget = '/tmp/a "quote" `cmd`\n/evil.log';

    const ok = await moveToTrash(hostileTarget, {
      platform: 'darwin',
      existsSync: (p) => p === MACOS_OSASCRIPT_BIN,
      execFile: async (file, args) => {
        calls.push({ file, args });
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(ok).toEqual({
      ok: true,
      target: hostileTarget,
      backend: 'macos-osascript',
    });
    expect(calls).toHaveLength(1);
    const call = calls[0]!;
    expect(call.file).toBe(MACOS_OSASCRIPT_BIN);
    expect(call.args).toContain('on run argv');
    expect(call.args.at(-2)).toBe('--');
    expect(call.args.at(-1)).toBe(hostileTarget);
    // 确保源码脚本参数 (-e 后) 不包含注入路径
    for (let i = 0; i < call.args.length - 2; i += 1) {
      expect(call.args[i]).not.toContain('quote');
      expect(call.args[i]).not.toContain('evil.log');
    }

    const bothMissing = await moveToTrash(hostileTarget, {
      platform: 'darwin',
      existsSync: () => false,
    });
    expect(bothMissing).toMatchObject({
      ok: false,
      code: 'TRASH_FAILED',
      errno: 'ENOENT',
    });
  });
});

describe('trash Linux XDG Trash (真实文件系统实测)', () => {
  test('准确写入 files/ 与 RFC2396 info/*.trashinfo, 同名冲突递增 .2 / .3', async () => {
    const root = await makeTempDir();
    const xdgDataHome = join(root, 'xdg-data');
    const fixedDate = new Date(2026, 10, 20, 14, 30, 5);
    const deps: TrashDeps = {
      platform: 'linux',
      env: { XDG_DATA_HOME: xdgDataHome },
      homedir: () => root,
      now: () => fixedDate,
    };

    const p1 = join(root, '中文 目录', 'dup.log');
    const p2 = join(root, 'sub-2', 'dup.log');
    const p3 = join(root, 'sub-3', 'dup.log');
    await mkdir(join(root, '中文 目录'), { recursive: true });
    await mkdir(join(root, 'sub-2'), { recursive: true });
    await mkdir(join(root, 'sub-3'), { recursive: true });
    await writeFile(p1, 'v1', 'utf8');
    await writeFile(p2, 'v2', 'utf8');
    await writeFile(p3, 'v3', 'utf8');

    const r1 = await moveToTrash(p1, deps);
    const r2 = await moveToTrash(p2, deps);
    const r3 = await moveToTrash(p3, deps);

    expect(r1).toEqual({ ok: true, target: p1, backend: 'linux-xdg-trash' });
    expect(r2).toEqual({ ok: true, target: p2, backend: 'linux-xdg-trash' });
    expect(r3).toEqual({ ok: true, target: p3, backend: 'linux-xdg-trash' });
    expect(existsSync(p1)).toBe(false);
    expect(existsSync(p2)).toBe(false);
    expect(existsSync(p3)).toBe(false);

    const filesDir = join(xdgDataHome, 'Trash', 'files');
    const infoDir = join(xdgDataHome, 'Trash', 'info');
    expect(await readFile(join(filesDir, 'dup.log'), 'utf8')).toBe('v1');
    expect(await readFile(join(filesDir, 'dup.log.2'), 'utf8')).toBe('v2');
    expect(await readFile(join(filesDir, 'dup.log.3'), 'utf8')).toBe('v3');

    const info1 = await readFile(join(infoDir, 'dup.log.trashinfo'), 'utf8');
    expect(info1).toBe(
      `[Trash Info]\nPath=${encodeXdgTrashPath(p1)}\nDeletionDate=2026-11-20T14:30:05\n`,
    );
    expect(existsSync(join(infoDir, 'dup.log.2.trashinfo'))).toBe(true);
    expect(existsSync(join(infoDir, 'dup.log.3.trashinfo'))).toBe(true);
  });

  test('EXDEV 跨设备错误: 清理占位 .trashinfo, 返回 ok: false 且原文件完好', async () => {
    const root = await makeTempDir();
    const xdgDataHome = join(root, 'xdg-exdev');
    const victim = join(root, 'precious.log');
    await writeFile(victim, 'must-survive', 'utf8');

    const outcome = await moveToTrash(victim, {
      platform: 'linux',
      env: { XDG_DATA_HOME: xdgDataHome },
      homedir: () => root,
      rename: async () => {
        const err = Object.assign(new Error('cross-device link'), {
          code: 'EXDEV',
        });
        throw err;
      },
    });

    expect(outcome).toMatchObject({
      ok: false,
      target: victim,
      code: 'TRASH_FAILED',
      errno: 'EXDEV',
    });
    expect(await readFile(victim, 'utf8')).toBe('must-survive');
    const leftoverInfos = await readdir(join(xdgDataHome, 'Trash', 'info'));
    expect(leftoverInfos).toEqual([]);
  });
});

describe('trash Windows 桩测试 (仅经桩/逻辑测试, 未在 Windows 真机实测)', () => {
  test('路径 >= 260 字符前置拦截, 零调用 PowerShell', async () => {
    let execCalled = false;
    const exact260 = `C:\\${'a'.repeat(WIN32_TRASH_MAX_PATH - 3)}`;
    expect(exact260.length).toBe(260);

    const blocked = await moveToTrash(exact260, {
      platform: 'win32',
      execFile: async () => {
        execCalled = true;
        return { code: 0, stdout: '', stderr: '' };
      },
    });
    expect(blocked).toMatchObject({
      ok: false,
      target: exact260,
      code: 'TRASH_FAILED',
      errno: 'ENAMETOOLONG',
    });
    expect(execCalled).toBe(false);
  });

  test('递归剥离 Read-Only 属性 (跳过符号链接) 并通过 SWEEP_TRASH_TARGET 环境变量防注入', async () => {
    const dirTarget = 'C:\\ws\\proj $(calc); rm\\target';
    const fileTarget = 'C:\\ws\\a\'b"c.log';
    const chmodCalls: { path: string; mode: number }[] = [];
    const execCalls: {
      file: string;
      args: readonly string[];
      env?: NodeJS.ProcessEnv;
    }[] = [];

    const makeStat = (kind: 'dir' | 'file' | 'link'): Stats =>
      ({
        isDirectory: () => kind === 'dir',
        isFile: () => kind === 'file',
        isSymbolicLink: () => kind === 'link',
      }) as Stats;

    const childFile = join(dirTarget, 'readonly.txt');
    const childLink = join(dirTarget, 'link-out');

    const baseDeps: TrashDeps = {
      platform: 'win32',
      env: { SystemRoot: 'C:\\Windows' },
      existsSync: () => true,
      chmod: async (p, mode) => {
        chmodCalls.push({ path: String(p), mode: Number(mode) });
      },
      execFile: async (file, args, env) => {
        execCalls.push({ file, args, env });
        return { code: 0, stdout: '', stderr: '' };
      },
    };

    const dirRes = await moveToTrash(dirTarget, {
      ...baseDeps,
      lstat: (async (p: unknown) => {
        const s = String(p);
        if (s === dirTarget) return makeStat('dir');
        if (s === childLink) return makeStat('link');
        return makeStat('file');
      }) as NonNullable<TrashDeps['lstat']>,
      readdir: (async (p: unknown) => {
        if (String(p) === dirTarget) {
          return [
            { name: 'readonly.txt', isSymbolicLink: () => false },
            { name: 'link-out', isSymbolicLink: () => true },
          ];
        }
        return [];
      }) as unknown as NonNullable<TrashDeps['readdir']>,
    });

    expect(dirRes).toEqual({
      ok: true,
      target: dirTarget,
      backend: 'win32-powershell-vb',
    });
    expect(chmodCalls).toEqual([
      { path: dirTarget, mode: 0o777 },
      { path: childFile, mode: 0o666 },
    ]);
    expect(execCalls[0]?.args.join(' ')).toContain('DeleteDirectory');
    expect(execCalls[0]?.args.join(' ')).toContain('$env:SWEEP_TRASH_TARGET');
    expect(execCalls[0]?.args.join(' ')).not.toContain('$(calc)');
    expect(execCalls[0]?.env?.SWEEP_TRASH_TARGET).toBe(dirTarget);

    const fileRes = await moveToTrash(fileTarget, {
      ...baseDeps,
      lstat: (async () => makeStat('file')) as unknown as NonNullable<
        TrashDeps['lstat']
      >,
    });
    expect(fileRes).toEqual({
      ok: true,
      target: fileTarget,
      backend: 'win32-powershell-vb',
    });
    expect(execCalls[1]?.args.join(' ')).toContain('DeleteFile');
    expect(execCalls[1]?.env?.SWEEP_TRASH_TARGET).toBe(fileTarget);
  });

  test('不支持的平台报错 TRASH_FAILED', async () => {
    const res = await moveToTrash('/tmp/x', { platform: 'freebsd' });
    expect(res).toMatchObject({ ok: false, code: 'TRASH_FAILED' });
  });
});

describe('红线 2 反证: 三端回收站失败绝不降级永久删除 (原文件 100% 完好)', () => {
  const failingPlatforms: {
    name: string;
    deps: (root: string) => TrashDeps;
  }[] = [
    {
      name: 'macOS',
      deps: () => ({
        platform: 'darwin',
        existsSync: () => true,
        execFile: async () => ({ code: 1, stdout: '', stderr: 'trash err' }),
      }),
    },
    {
      name: 'Linux',
      deps: (root) => ({
        platform: 'linux',
        env: { XDG_DATA_HOME: join(root, 'xdg') },
        homedir: () => root,
        rename: async () => {
          throw Object.assign(new Error('cross-device'), { code: 'EXDEV' });
        },
      }),
    },
    {
      name: 'Windows (桩)',
      deps: () => ({
        platform: 'win32',
        env: { SystemRoot: 'C:\\Windows' },
        existsSync: () => true,
        execFile: async () => ({ code: 1, stdout: '', stderr: 'ps error' }),
      }),
    },
  ];

  for (const item of failingPlatforms) {
    test(`${item.name} 失败: removeTargets / removeBatch / createSweeper().run() 均保留磁盘原文件`, async () => {
      const root = await makeTempDir();
      const target = join(root, 'app', 'keep.log');
      await mkdir(join(root, 'app'), { recursive: true });
      await writeFile(target, 'critical-user-data', 'utf8');
      const trashDeps = item.deps(root);

      // 1. removeTargets 入口
      const r1 = await removeTargets([target], {
        roots: [{ configured: root, real: root }],
        actions: new Map([[target, 'trash']]),
        allowGeneralTargets: true,
        trashDeps,
      });
      expect(r1.removed).toEqual([]);
      expect(r1.trashed).toEqual([]);
      expect(r1.failed[0]).toMatchObject({
        target,
        code: 'TRASH_FAILED',
        partialRisk: false,
      });
      expect(await readFile(target, 'utf8')).toBe('critical-user-data');

      // 2. removeBatch 入口
      const r2 = await removeBatch([target], {
        roots: [root],
        actions: new Map([[target, 'trash']]),
        allowGeneralTargets: true,
        trashDeps,
      });
      expect(r2.status).toBe('executed');
      if (r2.status === 'executed') {
        expect(r2.removal.removed).toEqual([]);
        expect(r2.removal.trashed).toEqual([]);
        expect(r2.removal.failed[0]).toMatchObject({
          target,
          code: 'TRASH_FAILED',
          partialRisk: false,
        });
      }
      expect(await readFile(target, 'utf8')).toBe('critical-user-data');

      // 3. createSweeper().run() 入口
      const sweeper = createSweeper({
        roots: [root],
        exclude: [],
        presets: {},
        rules: [
          { name: '日志回收', kind: 'file', match: '*.log', action: 'trash' },
        ],
        trashDeps,
      });
      const report = await sweeper.run();
      const summary = summarizeReport(report);
      expect(report.status).toBe('executed');
      expect(report.removal?.removed).toEqual([]);
      expect(report.removal?.trashed).toEqual([]);
      expect(report.releasedBytes).toBe(0);
      expect(summary.failed).toBe(1);
      expect(summary.succeeded).toBe(0);
      expect(report.entries[0]?.outcome).toMatchObject({
        kind: 'failed',
        failure: {
          target,
          code: 'TRASH_FAILED',
          partialRisk: false,
        },
      });
      expect(await readFile(target, 'utf8')).toBe('critical-user-data');
    });
  }
});
