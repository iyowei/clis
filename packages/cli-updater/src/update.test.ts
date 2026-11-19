/**
 * `update` 子命令参数解析与 `runSelfUpdate` 完整状态机单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { parseUpdateArgs } from './args.ts';
import { type CommandSpec } from './executor.ts';
import { type PackageMeta, type UpdateIO, runSelfUpdate } from './update.ts';

function captureIo(): { io: UpdateIO; out: string[]; err: string[] } {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => out.push(line),
      err: (line) => err.push(line),
    },
    out,
    err,
  };
}

describe('parseUpdateArgs 参数解析', () => {
  test('支持 --check / --force / --pm / --registry / --help 及内联赋值', () => {
    expect(
      parseUpdateArgs([
        '--check',
        '--force',
        '--pm=pnpm',
        '--registry',
        'https://registry.npmmirror.com',
      ]),
    ).toEqual({
      ok: true,
      options: {
        check: true,
        force: true,
        pm: 'pnpm',
        registry: 'https://registry.npmmirror.com',
        help: false,
      },
    });
    expect(parseUpdateArgs(['-h'])).toEqual({
      ok: true,
      options: { check: false, force: false, help: true },
    });
  });

  test('拒绝未知参数、非法管理器、缺值与非法 registry 协议', () => {
    expect(parseUpdateArgs(['--bogus']).ok).toBe(false);
    expect(parseUpdateArgs(['--pm']).ok).toBe(false);
    expect(parseUpdateArgs(['--pm', 'pip']).ok).toBe(false);
    expect(parseUpdateArgs(['--registry=']).ok).toBe(false);
    expect(parseUpdateArgs(['--registry', 'ftp://example.com']).ok).toBe(false);
  });
});

describe('runSelfUpdate 全状态机验证', () => {
  const bunMeta: PackageMeta = {
    name: '@iyowei/sweep-node-modules-cli',
    version: '0.3.0',
    isPrivate: false,
    rawPackageRoot:
      '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-node-modules-cli',
    packageRoot:
      '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-node-modules-cli',
  };

  test('bun 全局安装发现新版本 → --check 零副作用汇报; 默认执行 bun add -g', async () => {
    let executed: CommandSpec | null = null;
    const { io: io1, out: out1 } = captureIo();
    const checkCode = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: bunMeta,
      argv: ['--check'],
      io: io1,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.4.0',
          registry: reg,
        }),
        execPlan: (plan) => {
          executed = plan;
          return { status: 0 };
        },
      },
    });
    expect(checkCode).toBe(0);
    expect(executed).toBeNull();
    expect(out1.join('\n')).toContain('发现新版本: v0.3.0 → v0.4.0');
    expect(out1.join('\n')).toContain(
      'bun add -g @iyowei/sweep-node-modules-cli@0.4.0',
    );

    const { io: io2, out: out2 } = captureIo();
    const updateCode = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: bunMeta,
      argv: [],
      io: io2,
      deps: {
        platform: 'darwin',
        env: { PATH: process.env.PATH },
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.4.0',
          registry: reg,
        }),
        execPlan: (plan) => {
          executed = plan;
          return { status: 0 };
        },
      },
    });
    expect(updateCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.displayCommand).toBe(
      'bun add -g @iyowei/sweep-node-modules-cli@0.4.0',
    );
    expect(out2.join('\n')).toContain('已通过 bun 更新');
  });

  test('已是最新版本时退出码 0 不触发包管理器; --force 强制重装', async () => {
    let calls = 0;
    const { io: io1, out: out1 } = captureIo();
    const code1 = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: bunMeta,
      argv: [],
      io: io1,
      deps: {
        platform: 'darwin',
        env: { PATH: process.env.PATH },
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.3.0',
          registry: reg,
        }),
        execPlan: () => {
          calls += 1;
          return { status: 0 };
        },
      },
    });
    expect(code1).toBe(0);
    expect(calls).toBe(0);
    expect(out1.join('\n')).toContain('已是最新版本: v0.3.0');

    const { io: io2 } = captureIo();
    const code2 = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: bunMeta,
      argv: ['--force'],
      io: io2,
      deps: {
        platform: 'darwin',
        env: { PATH: process.env.PATH },
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.3.0',
          registry: reg,
        }),
        execPlan: () => {
          calls += 1;
          return { status: 0 };
        },
      },
    });
    expect(code2).toBe(0);
    expect(calls).toBe(1);
  });
});

describe('runSelfUpdate 非全局与异常边界', () => {
  test('源码开发态与 npx/bunx 临时态不覆盖全局, 清晰给出对应更新命令', async () => {
    const srcMeta: PackageMeta = {
      name: '@iyowei/codd-cli',
      version: '1.0.0',
      isPrivate: true,
      rawPackageRoot: '/Users/dev/clis/packages/codd-cli',
      packageRoot: '/Users/dev/clis/packages/codd-cli',
    };
    const { io: io1, out: out1 } = captureIo();
    const srcCode = await runSelfUpdate({
      binName: 'codd',
      meta: srcMeta,
      argv: [],
      io: io1,
      deps: {
        pathExists: (p) =>
          p.endsWith('src/cli.ts') || p.endsWith('src\\cli.ts'),
        readText: () => null,
      },
    });
    expect(srcCode).toBe(0);
    expect(out1.join('\n')).toContain('本地源码工作树');
    expect(out1.join('\n')).toContain(
      'git pull && bun install && bun run build',
    );

    const npxMeta: PackageMeta = {
      name: 'create-clis',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot: '/Users/dev/.npm/_npx/1234/node_modules/create-clis',
      packageRoot: '/Users/dev/.npm/_npx/1234/node_modules/create-clis',
    };
    const { io: io2, out: out2 } = captureIo();
    const npxCode = await runSelfUpdate({
      binName: 'create-clis',
      meta: npxMeta,
      argv: [],
      io: io2,
      deps: {
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
      },
    });
    expect(npxCode).toBe(0);
    expect(out2.join('\n')).toContain('npx create-clis@latest');
  });

  test('未知安装路径拒绝盲装 (退出 1), 传 --pm 可显式更新', async () => {
    const unknownMeta: PackageMeta = {
      name: 'create-clis',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot: '/opt/custom/create-clis',
      packageRoot: '/opt/custom/create-clis',
    };
    const { io: io1, err: err1 } = captureIo();
    const code1 = await runSelfUpdate({
      binName: 'create-clis',
      meta: unknownMeta,
      argv: [],
      io: io1,
      deps: {
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
      },
    });
    expect(code1).toBe(1);
    expect(err1.join('\n')).toContain('--pm');
  });

  test('404 未发布私有包返回清晰错误 (退出 1); --help 返回 0', async () => {
    const privateGlobalMeta: PackageMeta = {
      name: '@iyowei/codd-cli',
      version: '1.0.0',
      isPrivate: true,
      rawPackageRoot:
        '/Users/dev/.bun/install/global/node_modules/@iyowei/codd-cli',
      packageRoot:
        '/Users/dev/.bun/install/global/node_modules/@iyowei/codd-cli',
    };
    const { io: io1, err: err1 } = captureIo();
    const code1 = await runSelfUpdate({
      binName: 'codd',
      meta: privateGlobalMeta,
      argv: [],
      io: io1,
      deps: {
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async () => ({
          ok: false,
          code: 'not-found',
          status: 404,
          message: '404',
        }),
      },
    });
    expect(code1).toBe(1);
    expect(err1.join('\n')).toContain('尚未在');

    const { io: io2, out: out2 } = captureIo();
    const helpCode = await runSelfUpdate({
      binName: 'codd',
      meta: privateGlobalMeta,
      argv: ['--help'],
      io: io2,
    });
    expect(helpCode).toBe(0);
    expect(out2.join('\n')).toContain('codd update');
  });
});
