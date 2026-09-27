/**
 * install-git-hooks.mjs 的守卫契约测试 (C9 闭环, 见 ADR 0005 决策第 1 条):
 *
 * 一, 安装侧守卫: prepare 装钩子只允许发生在「本包自身的 git 仓库」, 其余落点
 * (vendor 进宿主仓库 / install-links 落进 node_modules / 非仓库目录) 一律不调 lefthook,
 * 以免 VCS 配置被写到宿主仓库. 手法: 临时目录树 + 按真实相对位置铺脚本 + PATH 前置假 lefthook.
 *
 * 二, 执行侧链: 生成的钩子必须带 bunx 兜底 (官方模板探测链不含 bunx, 且默认静默放行导致
 * 门禁悄悄失效), 且找不到 lefthook 时要响亮失败. 手法: 需要真 lefthook 生成钩子的用例
 * 以 hasLefthook 条件执行; 净化 PATH + 注入假 bunx, 断言钩子确实落到兜底分支并执行.
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const HERE = import.meta.dir;
const SCRIPT = resolve(HERE, 'install-git-hooks.mjs');

const hasGit =
  spawnSync('git', ['--version'], { stdio: 'ignore' }).status === 0;
const hasLefthook =
  spawnSync('lefthook', ['--version'], { stdio: 'ignore' }).status === 0;
const isWindows = process.platform === 'win32';

/** 本仓 lefthook.yml 的执行链兜底命令 (单一事实来源: 生成钩子与安装取用同读这一处) */
const readConfiguredLefthook = (): string => {
  const text = readFileSync(resolve(HERE, '..', 'lefthook.yml'), 'utf8');
  const value = /^lefthook:[ \t]*(\S.*)$/m.exec(text)?.[1];
  if (value === undefined) throw new Error('lefthook.yml 缺少 lefthook: 配置');
  return value.trim();
};

/** 现场清单 (每个用例自建自清) */
const sandboxes: string[] = [];

/** 建一个用例沙箱根 (mkdtemp 保证互不干扰) */
const makeSandbox = (): string => {
  const root = mkdtempSync(join(tmpdir(), 'sweep-hooks-'));
  sandboxes.push(root);
  return root;
};

/** 在目录内执行 git 命令 (夹具自建仓库用) */
const git = (cwd: string, args: string[]) =>
  spawnSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });

/**
 * 把被测脚本按真实相对位置 (<pkgRoot>/scripts/install-git-hooks.mjs) 铺进夹具,
 * 返回脚本的绝对路径 (脚本据此上溯一级认包根).
 */
const placeScript = (pkgRoot: string): string => {
  const dir = join(pkgRoot, 'scripts');
  mkdirSync(dir, { recursive: true });
  const target = join(dir, 'install-git-hooks.mjs');
  writeFileSync(target, readFileSync(SCRIPT));
  return target;
};

/**
 * 夹具环境: PATH 前置一个假 lefthook (只把参数记进日志), 日志路径经 env 传给假二进制.
 * 返回 { env, logPath }.
 */
const makeFakeLefthookEnv = (
  root: string,
  extraEnv: Record<string, string> = {},
) => {
  const binDir = join(root, 'fake-bin');
  mkdirSync(binDir, { recursive: true });
  const logPath = join(root, 'lefthook-calls.log');
  const fake = join(binDir, 'lefthook');
  writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
  chmodSync(fake, 0o755);
  const env: Record<string, string> = {
    ...process.env,
    PATH: `${binDir}:${process.env.PATH ?? ''}`,
  };
  // 基线环境不携带 CI (用例要的 CI 场景经 extraEnv 显式注入)
  delete env.CI;
  Object.assign(env, extraEnv);
  return { env, logPath };
};

/** 运行被测脚本 (cwd 取包根, 与包管理器跑 prepare 的现场一致) */
const runScript = (script: string, cwd: string, env: Record<string, string>) =>
  spawnSync(process.execPath, [script], { cwd, env, encoding: 'utf8' });

/** 读假 lefthook 的调用日志 (没被调用则为空串) */
const readCalls = (logPath: string): string =>
  existsSync(logPath) ? readFileSync(logPath, 'utf8') : '';

afterEach(() => {
  for (const dir of sandboxes.splice(0))
    rmSync(dir, { recursive: true, force: true });
});

describe.skipIf(!hasGit || isWindows)('install-git-hooks 守卫', () => {
  test('包根即 git 根 (本包检出态): 调 lefthook install', () => {
    const root = makeSandbox();
    const pkgRoot = join(root, 'pkg');
    mkdirSync(pkgRoot, { recursive: true });
    git(pkgRoot, ['init', '--quiet']);

    const script = placeScript(pkgRoot);
    const { env, logPath } = makeFakeLefthookEnv(root);
    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toContain('install');
  });

  test('包根是 git 根的临时克隆态 (git 依赖安装现场): 调 lefthook install', () => {
    const root = makeSandbox();
    const cloneDir = join(root, 'git-clone-abc');
    mkdirSync(cloneDir, { recursive: true });
    git(cloneDir, ['init', '--quiet']);

    const script = placeScript(cloneDir);
    const { env, logPath } = makeFakeLefthookEnv(root);
    const result = runScript(script, cloneDir, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toContain('install');
  });

  test('包目录 vendor 进宿主仓库 (无独立 .git): 不调 lefthook, 宿主仓库不被碰', () => {
    const root = makeSandbox();
    const hostRoot = join(root, 'host');
    mkdirSync(hostRoot, { recursive: true });
    git(hostRoot, ['init', '--quiet']);

    // 宿主仓库树内的包副本, 且不带自己的 .git (tarball 解压 / 导出式 vendor)
    const pkgRoot = join(hostRoot, 'vendor', 'sweep-node-modules');
    mkdirSync(pkgRoot, { recursive: true });
    const script = placeScript(pkgRoot);

    const { env, logPath } = makeFakeLefthookEnv(root);
    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toBe('');
    expect(existsSync(join(hostRoot, '.git', 'hooks', 'pre-commit'))).toBe(
      false,
    );
  });

  test('包目录落进宿主 node_modules (install-links 形态): 不调 lefthook', () => {
    const root = makeSandbox();
    const hostRoot = join(root, 'host');
    mkdirSync(hostRoot, { recursive: true });
    git(hostRoot, ['init', '--quiet']);

    const pkgRoot = join(
      hostRoot,
      'node_modules',
      '@iyowei',
      'sweep-node-modules',
    );
    mkdirSync(pkgRoot, { recursive: true });
    const script = placeScript(pkgRoot);

    const { env, logPath } = makeFakeLefthookEnv(root);
    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toBe('');
  });

  test('不在任何 git 仓库内: 不调 lefthook', () => {
    const root = makeSandbox();
    const pkgRoot = join(root, 'plain');
    mkdirSync(pkgRoot, { recursive: true });

    const script = placeScript(pkgRoot);
    const { env, logPath } = makeFakeLefthookEnv(root);
    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toBe('');
  });

  test('CI 环境变量在场: 一律不调 lefthook (即使包根即 git 根)', () => {
    const root = makeSandbox();
    const pkgRoot = join(root, 'pkg');
    mkdirSync(pkgRoot, { recursive: true });
    git(pkgRoot, ['init', '--quiet']);

    const script = placeScript(pkgRoot);
    const { env, logPath } = makeFakeLefthookEnv(root, { CI: 'true' });
    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(readCalls(logPath)).toBe('');
  });

  test('lefthook 不可用 (PATH 只有 git, 无 lefthook/bunx): 跳过但不阻断安装', () => {
    const root = makeSandbox();
    const pkgRoot = join(root, 'pkg');
    mkdirSync(pkgRoot, { recursive: true });
    git(pkgRoot, ['init', '--quiet']);

    const script = placeScript(pkgRoot);

    // PATH 只保留 git: 关掉全局 lefthook / bunx 的干扰, 同时保证脚本内的 git 探测可用
    const gitPath = spawnSync('which', ['git'], {
      encoding: 'utf8',
    }).stdout.trim();
    const binDir = join(root, 'only-git-bin');
    mkdirSync(binDir, { recursive: true });
    symlinkSync(gitPath, join(binDir, 'git'));

    const env: Record<string, string> = { ...process.env, PATH: binDir };
    delete env.CI;

    const result = runScript(script, pkgRoot, env);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain('未找到 lefthook');
  });
});

// ---------------------------------------------------------------------------
// 二, 执行侧链: 生成的钩子必须带 bunx 兜底, 找不到 lefthook 时响亮失败
// ---------------------------------------------------------------------------

describe('lefthook.yml 执行链配置 (C9 收口)', () => {
  test('lefthook.yml 配好执行链兜底与响亮失败键', () => {
    const text = readFileSync(resolve(HERE, '..', 'lefthook.yml'), 'utf8');
    expect(readConfiguredLefthook()).toContain('bunx lefthook@');
    expect(text).toMatch(/^assert_lefthook_installed:\s*true$/m);
  });
});

/** 建一个已装钩子的临时仓库 (配置头部由调用方给, 便于对照有无 lefthook: 配置) */
const makeHookRepo = (root: string, configHead: string) => {
  const dir = join(root, 'repo');
  mkdirSync(dir, { recursive: true });
  git(dir, ['init', '--quiet']);
  writeFileSync(
    join(dir, 'lefthook.yml'),
    `${configHead}\npre-commit:\n  commands:\n    marker:\n      run: echo hook-marker-ran\n`,
  );
  const install = spawnSync('lefthook', ['install'], {
    cwd: dir,
    encoding: 'utf8',
    env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
  });
  return { dir, install };
};

/** 净化 PATH (不含全局 lefthook; 只留系统基础目录, 可选前置注入 bin) */
const cleanPathEnv = (injectedBin: string | null): Record<string, string> => {
  const env: Record<string, string> = {
    ...process.env,
    PATH:
      injectedBin === null ? '/usr/bin:/bin' : `${injectedBin}:/usr/bin:/bin`,
  };
  delete env.CI;
  delete env.LEFTHOOK_BIN;
  return env;
};

/** 直接执行仓库里的 pre-commit 钩子 */
const runHook = (dir: string, env: Record<string, string>) =>
  spawnSync('sh', ['.git/hooks/pre-commit'], {
    cwd: dir,
    env,
    encoding: 'utf8',
  });

describe.skipIf(!hasGit || !hasLefthook || isWindows)(
  '钩子执行链 (模板实测)',
  () => {
    test('生成的钩子: 探测顺序为 LEFTHOOK_BIN → bunx 兜底 → PATH, 且失败退非零', () => {
      const root = makeSandbox();
      const configured = readConfiguredLefthook();
      const { dir } = makeHookRepo(
        root,
        `lefthook: ${configured}\nassert_lefthook_installed: true`,
      );

      const hook = readFileSync(join(dir, '.git/hooks/pre-commit'), 'utf8');
      const binAt = hook.indexOf('"$LEFTHOOK_BIN" "$@"');
      const fallbackAt = hook.indexOf(`${configured} "$@"`);
      const pathAt = hook.indexOf('elif lefthook -h');

      expect(hook).toContain(`elif test -n "${configured}"`);
      expect(binAt).toBeGreaterThan(-1);
      expect(fallbackAt).toBeGreaterThan(binAt);
      expect(pathAt).toBeGreaterThan(fallbackAt);
      expect(hook).toContain("Can't find lefthook in PATH");
      expect(hook).toContain('exit 1');
    });

    test('净化 PATH (无 lefthook) 触发钩子: 落 bunx 兜底分支并真正执行', () => {
      const root = makeSandbox();
      const configured = readConfiguredLefthook();
      const { dir } = makeHookRepo(
        root,
        `lefthook: ${configured}\nassert_lefthook_installed: true`,
      );

      // 注入假 bunx (记录参数并成功退出), 代表兜底通道被真正走到
      const binDir = join(root, 'fake-bunx-bin');
      mkdirSync(binDir, { recursive: true });
      const logPath = join(root, 'bunx-calls.log');
      const fake = join(binDir, 'bunx');
      writeFileSync(fake, `#!/bin/sh\necho "$@" >> "${logPath}"\nexit 0\n`);
      chmodSync(fake, 0o755);

      const env = cleanPathEnv(binDir);
      expect(
        spawnSync('sh', ['-c', 'command -v lefthook'], {
          env,
          encoding: 'utf8',
        }).stdout,
      ).toBe('');

      const result = runHook(dir, env);

      const calls = readCalls(logPath);
      expect(calls).toContain('run pre-commit');
      expect(calls).toContain(configured.split(/\s+/)[1] ?? '');
      expect(result.status).toBe(0);
    });

    test('无 lefthook 且未配兜底命令: 钩子退非零 (响亮失败, 不静默放行)', () => {
      const root = makeSandbox();
      // 用真 lefthook 的临时副本装钩子 (探测链会写入副本的绝对路径), 装完即删副本:
      // 这样 PATH 净化之外, 连「install 时的绝对路径」这一跳也失效, 才真正复现「本机无任何 lefthook」
      const copyPath = join(root, 'lh-copy-lefthook');
      const realLefthook = spawnSync('sh', ['-c', 'command -v lefthook'], {
        encoding: 'utf8',
      }).stdout.trim();
      copyFileSync(realLefthook, copyPath);
      chmodSync(copyPath, 0o755);

      const dir = join(root, 'repo');
      mkdirSync(dir, { recursive: true });
      git(dir, ['init', '--quiet']);
      writeFileSync(
        join(dir, 'lefthook.yml'),
        'assert_lefthook_installed: true\npre-commit:\n  commands:\n    marker:\n      run: echo hook-marker-ran\n',
      );
      spawnSync(copyPath, ['install'], {
        cwd: dir,
        encoding: 'utf8',
        env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null' },
      });
      rmSync(copyPath, { force: true });

      const result = runHook(dir, cleanPathEnv(null));

      expect(result.status).not.toBe(0);
      expect(`${result.stdout}${result.stderr}`).toContain(
        "Can't find lefthook in PATH",
      );
    });
  },
);
