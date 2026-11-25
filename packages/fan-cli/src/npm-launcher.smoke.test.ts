/**
 * npm 启动器冒烟 (`@iyowei/fan-cli`): 验证 `bin/fan.mjs` 在 Bun 与纯 Node 下
 * 执行真实打包产物 (`dist/cli.js`), 覆盖 `--help` / `-V` / 非法参数退出码、
 * 清单 SHA-256 完整性防篡改与工作目录 `bunfig.toml` / `preload` 隔离。
 */
import { describe, expect, test } from 'bun:test';

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
const LAUNCHER = join(ROOT, 'bin', 'fan.mjs');
const DIST_CLI = join(ROOT, 'dist', 'cli.js');
const PKG_VERSION = (
  JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const realpathNative = realpathSync.native ?? realpathSync;

const run = (...args: string[]) =>
  spawnSync(process.execPath, [LAUNCHER, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
  });

const sha256 = (filePath: string) =>
  createHash('sha256').update(readFileSync(filePath)).digest('hex');

describe('npm 启动器 · fan 基础契约', () => {
  test('透传 -V / --help 与 update --help 且零退出', () => {
    const ver = run('-V');
    expect(ver.status, ver.stderr).toBe(0);
    expect(ver.stdout.trim()).toBe(PKG_VERSION);

    const help = run('--help');
    expect(help.status, help.stderr).toBe(0);
    expect(help.stdout).toContain('FAN');

    const upd = run('update', '--help');
    expect(upd.status, upd.stderr).toBe(0);
  });

  test('非法参数回传非零退出码 (1)', () => {
    const bad = run('--definitely-not-a-flag');
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('未知选项');
  });

  test.skipIf(!existsSync(DIST_CLI))(
    '构建态产物 dist/cli.js 经 node 与 bun 运行 bin/fan.mjs 均输出版本号',
    () => {
      for (const runner of ['bun', 'node']) {
        if (spawnSync(runner, ['-v'], { timeout: 10_000 }).status !== 0) {
          continue;
        }
        const res = spawnSync(runner, [LAUNCHER, '--version'], {
          encoding: 'utf8',
          timeout: 10_000,
        });
        expect(res.status, `${runner}: ${res.stderr}`).toBe(0);
        expect(res.stdout.trim(), runner).toBe(PKG_VERSION);
      }
    },
  );
});

interface FakePackage {
  root: string;
  distDir: string;
  cliPath: string;
  manifestPath: string;
  launcher: string;
  cleanup: () => void;
}

function makeFakePackage(): FakePackage {
  const root = realpathNative(mkdtempSync(join(tmpdir(), 'fan-pkg-')));
  mkdirSync(join(root, 'bin'), { recursive: true });
  mkdirSync(join(root, 'dist'), { recursive: true });
  copyFileSync(LAUNCHER, join(root, 'bin', 'fan.mjs'));
  copyFileSync(
    join(ROOT, 'bin', 'bunfig.toml'),
    join(root, 'bin', 'bunfig.toml'),
  );
  return {
    root,
    distDir: join(root, 'dist'),
    cliPath: join(root, 'dist', 'cli.js'),
    manifestPath: join(root, 'dist', 'manifest.json'),
    launcher: join(root, 'bin', 'fan.mjs'),
    cleanup: () => {
      rmSync(root, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    },
  };
}

function writeFakeDist(
  pkg: FakePackage,
  code: string,
  patch: Record<string, unknown> = {},
): void {
  writeFileSync(pkg.cliPath, code, 'utf8');
  const manifest = {
    schemaVersion: 1,
    commit: '0'.repeat(40),
    dirty: false,
    cliSha256: sha256(pkg.cliPath),
    builtAt: '2026-11-25T00:00:00.000Z',
    ...patch,
  };
  writeFileSync(pkg.manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

function stripPathEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = '';
  return env;
}

describe('npm 启动器 · 产物自证与工作目录隔离', () => {
  test('清单同源放行, 缺失 / 篡改 / schemaVersion 异常一律拒收', () => {
    const pkg = makeFakePackage();
    try {
      writeFakeDist(
        pkg,
        "process.stdout.write('FAN-OK\\n');process.exit(6);\n",
      );
      const ok = spawnSync(process.execPath, [pkg.launcher, '--help'], {
        encoding: 'utf8',
      });
      expect(ok.status).toBe(6);
      expect(ok.stdout).toContain('FAN-OK');

      writeFileSync(pkg.cliPath, "process.stdout.write('TAMPERED\\n');\n");
      const tampered = spawnSync(process.execPath, [pkg.launcher], {
        encoding: 'utf8',
      });
      expect(tampered.status).toBe(1);
      expect(tampered.stdout).not.toContain('TAMPERED');
      expect(tampered.stderr).toContain('摘要与清单记录不符');

      writeFakeDist(pkg, "process.stdout.write('BAD-SCHEMA\\n');\n", {
        schemaVersion: 2,
      });
      const badSchema = spawnSync(process.execPath, [pkg.launcher], {
        encoding: 'utf8',
      });
      expect(badSchema.status).toBe(1);
      expect(badSchema.stderr).toContain('schemaVersion');

      rmSync(pkg.manifestPath, { force: true });
      const missingManifest = spawnSync(process.execPath, [pkg.launcher], {
        encoding: 'utf8',
      });
      expect(missingManifest.status).toBe(1);
      expect(missingManifest.stderr).toContain('缺少产物清单');
    } finally {
      pkg.cleanup();
    }
  });

  test('纯 Node (PATH 无 bun) 与未隔离 Bun 均按契约分发运行', () => {
    const pkg = makeFakePackage();
    try {
      writeFakeDist(
        pkg,
        'process.stdout.write(`ARGV1=${process.argv[1]}|ISO=${process.env.CLIS_BUN_ISOLATED ?? ""}\\n`);\n',
      );

      const nodePathRes = spawnSync(
        'node',
        ['-e', 'process.stdout.write(process.execPath)'],
        { encoding: 'utf8' },
      );
      if (nodePathRes.status === 0) {
        const nodeExec = nodePathRes.stdout.trim();
        const nodeRes = spawnSync(nodeExec, [pkg.launcher], {
          encoding: 'utf8',
          env: stripPathEnv(process.env),
        });
        expect(nodeRes.status, nodeRes.stderr).toBe(0);
        expect(nodeRes.stdout).toContain(`ARGV1=${pkg.launcher}`);
      }

      const bunEnv = stripPathEnv(process.env);
      delete bunEnv.CLIS_BUN_ISOLATED;
      const bunRes = spawnSync(process.execPath, [pkg.launcher], {
        encoding: 'utf8',
        env: bunEnv,
      });
      expect(bunRes.status, bunRes.stderr).toBe(0);
      expect(bunRes.stdout).toContain('ISO=1');
    } finally {
      pkg.cleanup();
    }
  });

  test('工作目录含损坏 bunfig.toml 与恶意 preload 时仍安全隔离执行', () => {
    const dirtyCwd = realpathNative(mkdtempSync(join(tmpdir(), 'fan-dirty-')));
    try {
      writeFileSync(
        join(dirtyCwd, 'bunfig.toml'),
        'preload = ["./evil.js"]\n[[broken toml\n',
      );
      writeFileSync(
        join(dirtyCwd, 'evil.js'),
        "throw new Error('PRELOAD_HIJACKED');\n",
      );
      const viaNode = spawnSync('node', [LAUNCHER, '--version'], {
        cwd: dirtyCwd,
        encoding: 'utf8',
      });
      if (viaNode.error === undefined) {
        expect(viaNode.status, viaNode.stderr).toBe(0);
        expect(viaNode.stdout.trim()).toBe(PKG_VERSION);
        expect(viaNode.stderr).not.toContain('PRELOAD_HIJACKED');
      }

      if (process.platform !== 'win32') {
        const viaSh = spawnSync('/bin/sh', [join(ROOT, 'bin', 'fan'), '-V'], {
          cwd: dirtyCwd,
          encoding: 'utf8',
        });
        expect(viaSh.status, viaSh.stderr).toBe(0);
        expect(viaSh.stdout.trim()).toBe(PKG_VERSION);
        expect(viaSh.stderr).not.toContain('PRELOAD_HIJACKED');
      }
    } finally {
      rmSync(dirtyCwd, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  });
});
