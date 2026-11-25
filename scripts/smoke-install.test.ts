/**
 * `smoke-install.ts` 纯函数与工作区发现单测:
 * 验证 bin 字段解析、纯 Node PATH 剥离 bun、跨 OS npm/bun 装包路径定位，以及工作区 CLI 枚举。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { chmodSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildNodeOnlyPath,
  preparePoisonedCwd,
  resolveBinEntries,
  resolveBunLocalShim,
  resolveCliPackages,
  resolveNpmGlobalShim,
  resolveNpmInstalledPackageDir,
  splitPathList,
} from './lib/smoke-install-paths.ts';
import { makeTmpRoot } from './lib/tmp-root.ts';
import type { WorkspacePackage } from './lib/workspace.ts';
import { assertShimContract } from './smoke-install.ts';

function fakePkg(
  name: string,
  dir: string,
  bin: unknown,
  version = '1.0.0',
): WorkspacePackage {
  return {
    name,
    dir,
    manifest: { name, version, bin },
  };
}

describe('resolveBinEntries', () => {
  test('支持字符串 bin 与对象多 bin, 按 key 稳定排序', () => {
    expect(
      resolveBinEntries(
        fakePkg('@acme/demo-cli', 'packages/demo-cli', 'bin/demo.mjs'),
      ),
    ).toEqual([{ name: 'demo-cli', relPath: 'bin/demo.mjs' }]);

    expect(
      resolveBinEntries(
        fakePkg('create-demo', 'packages/create-demo', {
          zeta: 'bin/zeta.mjs',
          alpha: 'bin/alpha.mjs',
        }),
      ),
    ).toEqual([
      { name: 'alpha', relPath: 'bin/alpha.mjs' },
      { name: 'zeta', relPath: 'bin/zeta.mjs' },
    ]);
  });

  test('无 bin 或空值返回空数组', () => {
    expect(
      resolveBinEntries(fakePkg('@acme/lib', 'packages/lib', undefined)),
    ).toEqual([]);
    expect(resolveBinEntries(fakePkg('@acme/lib', 'packages/lib', ''))).toEqual(
      [],
    );
  });
});

describe('buildNodeOnlyPath & splitPathList', () => {
  test('POSIX: 去除含 bun 的目录并置顶纯净 node 目录', () => {
    const bunDirs = new Set(['/home/u/.bun/bin', '/opt/mixed/bin']);
    const result = buildNodeOnlyPath(
      '/home/u/.bun/bin:/usr/local/bin:/opt/mixed/bin:/usr/bin:/bin:',
      '/tmp/node-only',
      'linux',
      (dir) => bunDirs.has(dir),
    );
    expect(result).toBe('/tmp/node-only:/usr/local/bin:/usr/bin:/bin');
  });

  test('win32: 剥离引号、大小写去重并排除含 bun 的目录', () => {
    const raw =
      '"C:\\Users\\ci\\.bun\\bin";C:\\hosted\\node;C:\\Windows\\System32;c:\\hosted\\node;';
    expect(splitPathList(raw, 'win32')).toEqual([
      'C:\\Users\\ci\\.bun\\bin',
      'C:\\hosted\\node',
      'C:\\Windows\\System32',
      'c:\\hosted\\node',
    ]);
    const next = buildNodeOnlyPath(raw, 'C:\\tmp\\node-only', 'win32', (dir) =>
      dir.toLowerCase().includes('.bun'),
    );
    expect(next).toBe(
      'C:\\tmp\\node-only;C:\\hosted\\node;C:\\Windows\\System32',
    );
  });
});

describe('装包目录与 shim 路径推导 (POSIX / win32)', () => {
  test('npm 全局前缀包路径与 shim 命名', () => {
    expect(
      resolveNpmInstalledPackageDir('/p', '@acme/tool-cli', 'darwin'),
    ).toBe(join('/p', 'lib', 'node_modules', '@acme', 'tool-cli'));
    expect(resolveNpmInstalledPackageDir('/p', '@acme/tool-cli', 'win32')).toBe(
      join('/p', 'node_modules', '@acme', 'tool-cli'),
    );

    expect(resolveNpmGlobalShim('/p', 'tool', 'linux')).toEqual({
      executable: join('/p', 'bin', 'tool'),
      companionFiles: [],
    });
    expect(resolveNpmGlobalShim('/p', 'tool', 'win32')).toEqual({
      executable: join('/p', 'tool.cmd'),
      companionFiles: [join('/p', 'tool.ps1')],
    });
  });

  test('bun 本地安装 shim 在 win32 下按 .exe → .cmd → .bunx 探测', () => {
    expect(resolveBunLocalShim('/host', 'tool', 'darwin')).toBe(
      join('/host', 'node_modules', '.bin', 'tool'),
    );
    expect(
      resolveBunLocalShim('/host', 'tool', 'win32', (p) =>
        p.endsWith('tool.cmd'),
      ),
    ).toBe(join('/host', 'node_modules', '.bin', 'tool.cmd'));
    expect(
      resolveBunLocalShim('/host', 'tool', 'win32', (p) =>
        p.endsWith('tool.exe'),
      ),
    ).toBe(join('/host', 'node_modules', '.bin', 'tool.exe'));
  });
});

describe('真实工作区 CLI 发现', () => {
  test('从根仓库 workspaces 动态发现至少 1 个 CLI 包且每个含有效 bin', () => {
    const targets = resolveCliPackages(resolve(import.meta.dir, '..'));
    expect(targets.length).toBeGreaterThanOrEqual(1);
    for (const target of targets) {
      expect(target.bins.length).toBeGreaterThanOrEqual(1);
      expect(target.version.length).toBeGreaterThan(0);
    }
  });
});

const tempRoots: string[] = [];
afterEach(() => {
  for (const dir of tempRoots.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});

function createStubShim(dir: string, scriptBody: string): string {
  mkdirSync(dir, { recursive: true });
  const scriptPath = join(dir, 'stub.mjs');
  writeFileSync(scriptPath, `#!/usr/bin/env node\n${scriptBody}\n`);
  if (process.platform === 'win32') {
    const cmdPath = join(dir, 'stub.cmd');
    writeFileSync(cmdPath, `@echo off\r\nnode "${scriptPath}" %*\r\n`);
    return cmdPath;
  }
  chmodSync(scriptPath, 0o755);
  return scriptPath;
}

describe('assertShimContract 最小模板与异常守卫', () => {
  test('最小模板风格 CLI (--version/-V/--help/-h 合法且未知参数退 0) 放行', () => {
    const sandbox = makeTmpRoot('smoke-contract-ok-');
    tempRoots.push(sandbox);
    const dirtyCwd = preparePoisonedCwd(sandbox);
    const executable = createStubShim(
      join(sandbox, 'bin'),
      [
        "const arg = process.argv[2] ?? '';",
        "if (arg === '--version' || arg === '-V') console.log('1.2.3');",
        "else if (arg === '--help' || arg === '-h') console.log('usage: stub');",
        "else console.log('Hello, world!');",
      ].join('\n'),
    );
    expect(() =>
      assertShimContract({
        executable,
        pkgName: 'stub-cli',
        version: '1.2.3',
        binName: 'stub',
        modeLabel: 'node',
        dirtyCwd,
        env: process.env,
      }),
    ).not.toThrow();
  });

  test('版本失配、帮助为空或检测到 bunfig 劫持 stderr 时抛错', () => {
    const sandbox = makeTmpRoot('smoke-contract-bad-');
    tempRoots.push(sandbox);
    const dirtyCwd = preparePoisonedCwd(sandbox);
    const wrongVer = createStubShim(
      join(sandbox, 'wrong-ver'),
      "console.log('9.9.9');",
    );
    expect(() =>
      assertShimContract({
        executable: wrongVer,
        pkgName: 'stub-cli',
        version: '1.2.3',
        binName: 'stub',
        modeLabel: 'node',
        dirtyCwd,
        env: process.env,
      }),
    ).toThrow(/期望输出 1\.2\.3/);

    const emptyHelp = createStubShim(
      join(sandbox, 'empty-help'),
      [
        "const arg = process.argv[2] ?? '';",
        "if (arg === '--version' || arg === '-V') console.log('1.2.3');",
      ].join('\n'),
    );
    expect(() =>
      assertShimContract({
        executable: emptyHelp,
        pkgName: 'stub-cli',
        version: '1.2.3',
        binName: 'stub',
        modeLabel: 'node',
        dirtyCwd,
        env: process.env,
      }),
    ).toThrow();

    const hijacked = createStubShim(
      join(sandbox, 'hijacked'),
      [
        "const arg = process.argv[2] ?? '';",
        "console.error('PRELOAD_HIJACKED');",
        "if (arg === '--version' || arg === '-V') console.log('1.2.3');",
        "else console.log('usage: stub');",
      ].join('\n'),
    );
    expect(() =>
      assertShimContract({
        executable: hijacked,
        pkgName: 'stub-cli',
        version: '1.2.3',
        binName: 'stub',
        modeLabel: 'node',
        dirtyCwd,
        env: process.env,
      }),
    ).toThrow(/未隔离工作目录/);
  });
});
