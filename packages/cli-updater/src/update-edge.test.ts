/**
 * `runSelfUpdate` 进阶边界回归单测:
 * 覆盖 401/403 鉴权失败、`--force` 跳过查询直装 `@latest`、跨安装器 `--pm` 双副本阴影警示、
 * 子进程信号中断透传、升级后版本/PATH 轻复核、非 3 段 SemVer 响应、Windows/pnpm 失败文案、
 * Deno 临时运行指引与 `<prefix>/lib/node_modules` 动态实查复核。
 */
import { describe, expect, test } from 'bun:test';

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

const npmGlobalMeta: PackageMeta = {
  name: '@iyowei/sweep-node-modules-cli',
  version: '0.3.0',
  isPrivate: false,
  rawPackageRoot:
    '/opt/homebrew/lib/node_modules/@iyowei/sweep-node-modules-cli',
  packageRoot: '/opt/homebrew/lib/node_modules/@iyowei/sweep-node-modules-cli',
};

describe('runSelfUpdate 鉴权与 --force 容错', () => {
  test('HTTP 401/403 返回清晰鉴权失败提示且退出 1', async () => {
    const { io, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: [],
      io,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: false,
          code: 'auth',
          status: 401,
          message: `访问包注册表 ${reg} 鉴权失败 (HTTP 401)`,
        }),
      },
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('鉴权失败');
    expect(err.join('\n')).toContain('--force');
  });

  test('--force 在查询失败且 targetPm 已知时打印警示并直装 @latest; --force --check 保持零副作用', async () => {
    let executed: CommandSpec | null = null;
    const { io: io1, out: out1, err: err1 } = captureIo();
    const forceCode = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: ['--force'],
      io: io1,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/npm',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async () => ({
          ok: false,
          code: 'auth',
          status: 403,
          message: '鉴权失败 (HTTP 403)',
        }),
        execPlan: (plan) => {
          executed = plan;
          return { status: 0 };
        },
      },
    });
    expect(forceCode).toBe(0);
    expect(executed).not.toBeNull();
    expect(executed!.displayCommand).toBe(
      'npm install -g @iyowei/sweep-node-modules-cli@latest',
    );
    expect(err1.join('\n')).toContain('远端版本查询失败');
    expect(out1.join('\n')).toContain('强制重装模式 (--force)');
    expect(out1.join('\n')).toContain('至 latest ✓');

    // --force --check 绝不执行安装
    let checkCalls = 0;
    const { io: io2 } = captureIo();
    const checkCode = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: ['--force', '--check'],
      io: io2,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/npm',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async () => ({
          ok: false,
          code: 'network',
          message: 'timeout',
        }),
        execPlan: () => {
          checkCalls += 1;
          return { status: 0 };
        },
      },
    });
    expect(checkCode).toBe(1);
    expect(checkCalls).toBe(0);
  });
});

describe('runSelfUpdate 体验收口与轻复核', () => {
  test('--pm 跨安装器覆盖全局与源码态均打印双副本 PATH 阴影警示', async () => {
    const { io: io1, out: out1 } = captureIo();
    const code1 = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: ['--pm', 'bun', '--check'],
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
      },
    });
    expect(code1).toBe(0);
    expect(out1.join('\n')).toContain('双份副本');
    expect(out1.join('\n')).toContain('遮蔽新版本');

    const srcMeta: PackageMeta = {
      name: '@iyowei/codd-cli',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot: '/Users/dev/clis/packages/codd-cli',
      packageRoot: '/Users/dev/clis/packages/codd-cli',
    };
    const { io: io2, out: out2 } = captureIo();
    const code2 = await runSelfUpdate({
      binName: 'codd',
      meta: srcMeta,
      argv: ['--pm', 'bun', '--check'],
      io: io2,
      deps: {
        platform: 'darwin',
        env: {},
        pathExists: (p) => p.endsWith('src/cli.ts'),
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
      },
    });
    expect(code2).toBe(0);
    expect(out2.join('\n')).toContain('版本阴影');
  });

  test('非 3 段 SemVer 响应不误报「已是最新版本 ✓」, 明确提示 --force', async () => {
    let calls = 0;
    const { io: io1, out: out1 } = captureIo();
    const code1 = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: [],
      io: io1,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/npm',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '2026.11',
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
    expect(out1.join('\n')).not.toContain('已是最新版本');
    expect(out1.join('\n')).toContain('无法按标准 SemVer 比较');
    expect(out1.join('\n')).toContain('--force');
  });

  test('子进程被信号中断时透传 signal 文案, 不误报退出码 1', async () => {
    const { io, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: [],
      io,
      deps: {
        platform: 'darwin',
        env: { PATH: '/usr/local/bin' },
        isFile: (p) => p === '/usr/local/bin/npm',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.4.0',
          registry: reg,
        }),
        execPlan: () => ({ status: null, signal: 'SIGINT' }),
      },
    });
    expect(code).toBe(1);
    expect(err.join('\n')).toContain('信号中断 (SIGINT)');
    expect(err.join('\n')).not.toContain('退出码 1');
  });
});

describe('runSelfUpdate 轻复核与平台失败提示', () => {
  test('升级 status === 0 后轻复核: 原目录版本未变及 PATH 仍指向旧路径时输出核查提示', async () => {
    const { io, out } = captureIo();
    const code = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: npmGlobalMeta,
      argv: ['--pm', 'bun'],
      io,
      deps: {
        platform: 'darwin',
        env: { PATH: '/opt/homebrew/bin:/Users/dev/.bun/bin' },
        isFile: (p) =>
          p === '/Users/dev/.bun/bin/bun' || p === '/opt/homebrew/bin/sweep-nm',
        pathExists: () => false,
        readText: (p) =>
          p.endsWith('package.json')
            ? JSON.stringify({
                name: npmGlobalMeta.name,
                version: '0.3.0',
              })
            : null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.4.0',
          registry: reg,
        }),
        execPlan: () => ({ status: 0 }),
      },
    });
    expect(code).toBe(0);
    expect(out.join('\n')).toContain('原安装目录');
    expect(out.join('\n')).toContain('仍为 v0.3.0');

    // 跨 PM 安装后 PATH 仍优先命中旧 PM 的 shim 目录时发出 PATH 阴影复核提示
    const bunMeta: PackageMeta = {
      name: '@iyowei/sweep-node-modules-cli',
      version: '0.3.0',
      isPrivate: false,
      rawPackageRoot:
        '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-node-modules-cli',
      packageRoot:
        '/Users/dev/.bun/install/global/node_modules/@iyowei/sweep-node-modules-cli',
    };
    const { io: ioPath, out: outPath } = captureIo();
    const pathCode = await runSelfUpdate({
      binName: 'sweep-nm',
      meta: bunMeta,
      argv: ['--pm', 'npm'],
      io: ioPath,
      deps: {
        platform: 'darwin',
        env: { PATH: '/Users/dev/.bun/bin:/usr/local/bin' },
        isFile: (p) =>
          p === '/usr/local/bin/npm' || p === '/Users/dev/.bun/bin/sweep-nm',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '0.4.0',
          registry: reg,
        }),
        execPlan: () => ({ status: 0 }),
      },
    });
    expect(pathCode).toBe(0);
    expect(outPath.join('\n')).toContain('仍指向旧路径');
    expect(outPath.join('\n')).toContain('/Users/dev/.bun/bin/sweep-nm');
  });

  test('Windows 失败提示点明自身 shim 占锁, pnpm 失败补充 PNPM_HOME / pnpm setup', async () => {
    const pnpmWinMeta: PackageMeta = {
      name: 'create-clis',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot:
        'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\create-clis',
      packageRoot:
        'C:\\Users\\dev\\AppData\\Local\\pnpm\\global\\5\\node_modules\\create-clis',
    };
    const { io, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'create-clis',
      meta: pnpmWinMeta,
      argv: [],
      io,
      deps: {
        platform: 'win32',
        env: { PATH: 'C:\\tools' },
        isFile: (p) => p === 'C:\\tools\\pnpm.exe',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
        execPlan: () => ({ status: 1 }),
      },
    });
    expect(code).toBe(1);
    const errText = err.join('\n');
    expect(errText).toContain('自身可执行/shim 文件可能被系统锁定');
    expect(errText).toContain('PNPM_HOME');
    expect(errText).toContain('pnpm setup');
  });

  test('Deno 临时运行输出 deno run 指引, 且自定义 <prefix>/lib/node_modules 经动态实查复核为 pnpm', async () => {
    const denoMeta: PackageMeta = {
      name: 'create-clis',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot:
        '/Users/dev/Library/Caches/deno/npm/registry.npmjs.org/create-clis/1.0.0',
      packageRoot:
        '/Users/dev/Library/Caches/deno/npm/registry.npmjs.org/create-clis/1.0.0',
    };
    const { io: io1, out: out1 } = captureIo();
    const denoCode = await runSelfUpdate({
      binName: 'create-clis',
      meta: denoMeta,
      argv: [],
      io: io1,
      deps: {
        env: {},
        argvEntry: '',
        pathExists: () => false,
        readText: () => null,
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
      },
    });
    expect(denoCode).toBe(0);
    expect(out1.join('\n')).toContain('deno run -A npm:create-clis@latest');

    const customLibMeta: PackageMeta = {
      name: 'create-clis',
      version: '1.0.0',
      isPrivate: false,
      rawPackageRoot: '/srv/custom/lib/node_modules/create-clis',
      packageRoot: '/srv/custom/lib/node_modules/create-clis',
    };
    const { io: io2, out: out2 } = captureIo();
    const customCode = await runSelfUpdate({
      binName: 'create-clis',
      meta: customLibMeta,
      argv: ['--check'],
      io: io2,
      deps: {
        env: {},
        argvEntry: '',
        pathExists: () => false,
        readText: () => null,
        probeRoots: () => ({ pnpm: '/srv/custom/lib/node_modules' }),
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.1.0',
          registry: reg,
        }),
      },
    });
    expect(customCode).toBe(0);
    expect(out2.join('\n')).toContain('pnpm 全局安装');
    expect(out2.join('\n')).toContain('pnpm add -g create-clis@1.1.0');
  });
});
