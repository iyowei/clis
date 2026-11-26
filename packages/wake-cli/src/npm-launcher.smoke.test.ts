/**
 * npm 启动器冒烟 (`@iyowei/wake-cli`): 验证 `bin/wake.mjs` 在 Bun 与纯 Node 下
 * 执行真实打包产物 (`dist/cli.js`), 清单 SHA-256 防篡改与工作目录隔离。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const LAUNCHER = join(ROOT, 'bin', 'wake.mjs');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const PKG_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const realpathNative = realpathSync.native ?? realpathSync;
const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'wake-smoke-home-'));
afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function isolatedEnv(base: NodeJS.ProcessEnv = process.env): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...base,
    NO_COLOR: '1',
    HOME: ISOLATED_HOME,
    USERPROFILE: ISOLATED_HOME,
    APPDATA: join(ISOLATED_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(ISOLATED_HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(ISOLATED_HOME, '.config'),
    CLIS_TEST_OS_LOCALE: 'zh-CN',
  };
  delete env.WAKE_LANG;
  delete env.CLIS_LANG;
  return env;
}

const run = (...args: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedEnv(),
    timeout: 20_000,
  });

const sha256 = (filePath: string) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

function resolveRunnerExec(runner: string): string | null {
  const res = spawnSync(
    runner,
    ['-e', 'process.stdout.write(process.execPath)'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  if (res.status !== 0) return null;
  const execPath = res.stdout.trim();
  return execPath !== '' ? execPath : null;
}

describe('npm 启动器 · wake 基础契约', () => {
  test('透传 -V / --help 与 update --help 且零退出', () => {
    const ver = run('-V');
    expect(ver.status, ver.stderr).toBe(0);
    expect(ver.stdout.trim()).toBe(PKG_VERSION);

    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('WAKE');

    const upd = run('update', '--help');
    expect(upd.status, upd.stderr).toBe(0);
  });

  test('非法参数回传非零退出码 (1)', () => {
    const bad = run('--definitely-not-a-flag');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('未知选项');
  });

  test.skipIf(!existsSync(DIST_CLI))(
    '构建态产物 dist/cli.js 经 node 与 bun 运行 bin/wake.mjs 均输出版本号',
    () => {
      for (const runner of ['bun', 'node']) {
        const execPath = resolveRunnerExec(runner);
        if (execPath === null) continue;
        const res = spawnSync(execPath, [LAUNCHER, '--version'], {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: isolatedEnv(),
          timeout: 20_000,
        });
        expect(res.status, `${runner}: ${res.stderr}`).toBe(0);
        expect(res.stdout.trim(), runner).toBe(PKG_VERSION);
      }
    },
  );
});

describe('npm 启动器 · 产物自证与工作目录隔离', () => {
  test('清单篡改与缺失一律拒收, 工作目录损坏 bunfig.toml 不影响运行', () => {
    const pkgRoot = realpathNative(mkdtempSync(join(tmpdir(), 'wake-pkg-')));
    const dirtyCwd = realpathNative(mkdtempSync(join(tmpdir(), 'wake-dirty-')));
    try {
      mkdirSync(join(pkgRoot, 'bin'), { recursive: true });
      mkdirSync(join(pkgRoot, 'dist'), { recursive: true });
      copyFileSync(LAUNCHER, join(pkgRoot, 'bin', 'wake.mjs'));
      copyFileSync(
        join(ROOT, 'bin', 'bunfig.toml'),
        join(pkgRoot, 'bin', 'bunfig.toml'),
      );
      const cliPath = join(pkgRoot, 'dist', 'cli.js');
      const manifestPath = join(pkgRoot, 'dist', 'manifest.json');
      writeFileSync(cliPath, "process.stdout.write('WAKE-OK\\n');\n");
      writeFileSync(
        manifestPath,
        `${JSON.stringify({
          schemaVersion: 1,
          commit: '0'.repeat(40),
          dirty: false,
          cliSha256: sha256(cliPath),
          builtAt: '2026-11-27T00:00:00.000Z',
        })}\n`,
      );

      const ok = spawnSync(
        process.execPath,
        [join(pkgRoot, 'bin', 'wake.mjs')],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: isolatedEnv(),
          timeout: 20_000,
        },
      );
      expect(ok.status).toBe(0);
      expect(ok.stdout).toContain('WAKE-OK');

      writeFileSync(cliPath, "process.stdout.write('TAMPERED\\n');\n");
      const tampered = spawnSync(
        process.execPath,
        [join(pkgRoot, 'bin', 'wake.mjs')],
        {
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: isolatedEnv(),
          timeout: 20_000,
        },
      );
      expect(tampered.status).toBe(1);
      expect(tampered.stderr).toContain('摘要与清单记录不符');

      writeFileSync(
        join(dirtyCwd, 'bunfig.toml'),
        'preload = ["./evil.js"]\n[[broken toml\n',
      );
      writeFileSync(
        join(dirtyCwd, 'evil.js'),
        "throw new Error('PRELOAD_HIJACKED');\n",
      );
      const nodeExec = resolveRunnerExec('node');
      if (nodeExec !== null) {
        const cleanViaNode = spawnSync(nodeExec, [LAUNCHER, '--version'], {
          cwd: dirtyCwd,
          encoding: 'utf8',
          stdio: ['ignore', 'pipe', 'pipe'],
          env: isolatedEnv(),
          timeout: 20_000,
        });
        expect(cleanViaNode.status, cleanViaNode.stderr).toBe(0);
        expect(cleanViaNode.stdout.trim()).toBe(PKG_VERSION);
        expect(cleanViaNode.stderr).not.toContain('PRELOAD_HIJACKED');
      }

      if (process.platform !== 'win32') {
        const cleanViaSh = spawnSync(
          '/bin/sh',
          [join(ROOT, 'bin', 'wake'), '-V'],
          {
            cwd: dirtyCwd,
            encoding: 'utf8',
            stdio: ['ignore', 'pipe', 'pipe'],
            env: isolatedEnv(),
            timeout: 20_000,
          },
        );
        expect(cleanViaSh.status, cleanViaSh.stderr).toBe(0);
        expect(cleanViaSh.stdout.trim()).toBe(PKG_VERSION);
        expect(cleanViaSh.stderr).not.toContain('PRELOAD_HIJACKED');
      }
    } finally {
      rmSync(pkgRoot, { recursive: true, force: true });
      rmSync(dirtyCwd, { recursive: true, force: true });
    }
  });
});
