/**
 * 独立脚本安装 (`standalone` origin) `cli-updater` 完整自更新、依赖补装与失败回滚单元测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import { STANDALONE_MARKER_FILE } from './detect.ts';
import { type UpdateIO, runSelfUpdate } from './update.ts';

function buildMinimalTgz(files: Record<string, string>): Buffer {
  const chunks: Buffer[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    const hdr = Buffer.alloc(512, 0);
    const fullName = `package/${rel}`;
    hdr.write(fullName, 0, Math.min(Buffer.byteLength(fullName), 100), 'utf8');
    hdr.write('0000644\0', 100, 'ascii');
    hdr.write('0000000\0', 108, 'ascii');
    hdr.write('0000000\0', 116, 'ascii');
    hdr.write(`${data.length.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
    hdr.write('00000000000\0', 136, 'ascii');
    hdr.fill(0x20, 148, 156);
    hdr.write('0', 156, 'ascii');
    hdr.write('ustar\0', 257, 'ascii');
    hdr.write('00', 263, 'ascii');
    let sum = 0;
    for (let i = 0; i < 512; i += 1) sum += hdr[i] ?? 0;
    hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
    chunks.push(hdr);
    if (data.length > 0) {
      const rem = data.length % 512;
      chunks.push(
        rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem, 0)]),
      );
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

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

const tempRoots: string[] = [];
function setupStandaloneTree(opts: {
  tool: string;
  packageName: string;
  version: string;
  withIsolatedBun?: boolean;
}): {
  dataDir: string;
  appDir: string;
  runtimeDir: string;
  binPath: string;
} {
  const dataDir = mkdtempSync(join(tmpdir(), 'clis-standalone-test-'));
  tempRoots.push(dataDir);
  const appDir = join(dataDir, 'apps', opts.tool);
  const runtimeDir = join(dataDir, 'runtime');
  const binPath = join(dataDir, 'bin', opts.tool);
  mkdirSync(join(appDir, 'dist'), { recursive: true });
  mkdirSync(join(appDir, 'bin'), { recursive: true });
  mkdirSync(runtimeDir, { recursive: true });
  writeFileSync(
    join(appDir, 'package.json'),
    JSON.stringify({ name: opts.packageName, version: opts.version }, null, 2),
  );
  writeFileSync(join(appDir, 'dist', 'cli.js'), `// v${opts.version}\n`);
  writeFileSync(
    join(appDir, STANDALONE_MARKER_FILE),
    JSON.stringify({
      schemaVersion: 1,
      method: 'script',
      tool: opts.tool,
      packageName: opts.packageName,
      dataDir,
      appDir,
      runtimeDir,
      binPath,
      version: opts.version,
    }),
  );
  if (opts.withIsolatedBun === true) {
    const exeName = process.platform === 'win32' ? 'bun.exe' : 'bun';
    writeFileSync(join(runtimeDir, exeName), 'stub-bun');
  }
  return { dataDir, appDir, runtimeDir, binPath };
}

afterEach(() => {
  while (tempRoots.length > 0) {
    rmSync(tempRoots.pop()!, { recursive: true, force: true });
  }
});

describe('standalone 脚本安装态 self-update 闭环', () => {
  test('--check 展示独立脚本安装来源与升级提示', async () => {
    const tree = setupStandaloneTree({
      tool: 'codd',
      packageName: '@iyowei/codd-cli',
      version: '1.4.0',
    });
    const { io, out, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'codd',
      locale: 'zh',
      argv: ['--check'],
      meta: {
        name: '@iyowei/codd-cli',
        version: '1.4.0',
        isPrivate: false,
        rawPackageRoot: tree.appDir,
        packageRoot: tree.appDir,
      },
      io,
      deps: {
        fetchLatest: async () => ({
          ok: true,
          version: '1.5.0',
          registry: 'https://registry.npmjs.org',
        }),
      },
    });
    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('独立脚本安装');
    expect(out.join('\n')).toContain('运行 codd update 即可在线升级');
  });

  test('在线下载 tarball、校验 SRI SHA-512、原子切换版本并保留更新后安装标记', async () => {
    const tree = setupStandaloneTree({
      tool: 'codd',
      packageName: '@iyowei/codd-cli',
      version: '1.4.0',
    });
    const tgz = buildMinimalTgz({
      'package.json': JSON.stringify({
        name: '@iyowei/codd-cli',
        version: '1.5.0',
      }),
      'dist/cli.js': 'console.log("codd-1.5.0");\n',
      'bin/bunfig.toml': 'telemetry = false\n',
    });
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;

    const fetchFn = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/latest') || url.endsWith('/1.5.0')) {
        return new Response(
          JSON.stringify({
            name: '@iyowei/codd-cli',
            version: '1.5.0',
            dist: {
              tarball: 'https://mock.registry.local/codd-cli-1.5.0.tgz',
              integrity,
            },
          }),
          { status: 200 },
        );
      }
      if (url === 'https://mock.registry.local/codd-cli-1.5.0.tgz') {
        return new Response(tgz, { status: 200 });
      }
      return new Response('Not found', { status: 404 });
    };

    const { io, out, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'codd',
      locale: 'zh',
      argv: ['--registry', 'https://mock.registry.local'],
      meta: {
        name: '@iyowei/codd-cli',
        version: '1.4.0',
        isPrivate: false,
        rawPackageRoot: tree.appDir,
        packageRoot: tree.appDir,
      },
      io,
      deps: {
        fetchLatest: async () => ({
          ok: true,
          version: '1.5.0',
          registry: 'https://mock.registry.local',
        }),
        fetchFn,
      },
    });

    expect(code).toBe(0);
    expect(err).toEqual([]);
    expect(out.join('\n')).toContain('升级完成');
    expect(readFileSync(join(tree.appDir, 'dist', 'cli.js'), 'utf8')).toContain(
      'codd-1.5.0',
    );
    const updatedPkg = JSON.parse(
      readFileSync(join(tree.appDir, 'package.json'), 'utf8'),
    ) as { version: string };
    expect(updatedPkg.version).toBe('1.5.0');
    const updatedMarker = JSON.parse(
      readFileSync(join(tree.appDir, STANDALONE_MARKER_FILE), 'utf8'),
    ) as { method: string; version: string };
    expect(updatedMarker.method).toBe('script');
    expect(updatedMarker.version).toBe('1.5.0');
    expect(existsSync(join(tree.dataDir, 'apps'))).toBe(true);
  });
});

describe('standalone 依赖补装、完整性拒止与失败回滚', () => {
  test('存在 dependencies (如 create-clis, 产物为 dist/create-clis.js) 时识别 CREATE_CLIS_REGISTRY 并用隔离 Bun 补装依赖, 失败完好回退', async () => {
    const tree = setupStandaloneTree({
      tool: 'create-clis',
      packageName: 'create-clis',
      version: '1.5.0',
      withIsolatedBun: true,
    });
    const cliJs = 'console.log("create-clis-1.6.0");\n';
    const cliSha = createHash('sha256').update(cliJs).digest('hex');
    const tgz = buildMinimalTgz({
      'package.json': JSON.stringify({
        name: 'create-clis',
        version: '1.6.0',
        bin: { 'create-clis': 'bin/create-clis.mjs' },
        dependencies: { prettier: '3.9.9' },
      }),
      'bin/create-clis.mjs': '#!/usr/bin/env node\n',
      'dist/create-clis.js': cliJs,
      'dist/manifest.json': JSON.stringify({
        schemaVersion: 1,
        cliSha256: cliSha,
      }),
    });
    const integrity = `sha512-${createHash('sha512').update(tgz).digest('base64')}`;
    const fetchFn = async (
      input: string | URL | Request,
    ): Promise<Response> => {
      const url = typeof input === 'string' ? input : input.toString();
      if (url.endsWith('/1.6.0')) {
        return new Response(
          JSON.stringify({
            name: 'create-clis',
            version: '1.6.0',
            dist: {
              tarball: 'https://mock.registry.local/create-clis-1.6.0.tgz',
              integrity,
            },
          }),
          { status: 200 },
        );
      }
      return new Response(tgz, { status: 200 });
    };

    const spawnCalls: Array<{
      cmd: string;
      args: readonly string[];
      cwd?: string;
    }> = [];
    const { io: failIo, err: failErr } = captureIo();
    const failCode = await runSelfUpdate({
      binName: 'create-clis',
      locale: 'zh',
      argv: [],
      meta: {
        name: 'create-clis',
        version: '1.5.0',
        isPrivate: false,
        rawPackageRoot: tree.appDir,
        packageRoot: tree.appDir,
      },
      io: failIo,
      deps: {
        env: { CREATE_CLIS_REGISTRY: 'https://mock.registry.local' },
        fetchLatest: async (_pkg, reg) => ({
          ok: true,
          version: '1.6.0',
          registry: reg,
        }),
        fetchFn,
        isFile: (p) => p.endsWith('/bun') || p.endsWith('\\bun.exe'),
        spawnFn: (cmd, args, opts) => {
          spawnCalls.push({ cmd, args, cwd: opts.cwd });
          return {
            pid: 1,
            output: ['', '', 'network down'],
            stdout: '',
            stderr: 'network down',
            status: 1,
            signal: null,
          };
        },
      },
    });

    expect(failCode).toBe(1);
    expect(failErr.join('\n')).toContain('安装新版本运行时依赖失败');
    expect(spawnCalls).toHaveLength(1);
    expect(spawnCalls[0]?.args).toContain('--production');
    expect(spawnCalls[0]?.args).toContain('--ignore-scripts');
    expect(spawnCalls[0]?.args).toContain(
      '--registry=https://mock.registry.local',
    );
    // 旧目录未被破坏
    expect(readFileSync(join(tree.appDir, 'dist', 'cli.js'), 'utf8')).toContain(
      'v1.5.0',
    );
  });

  test('tarball integrity 校验失败时中止并不替换旧安装目录', async () => {
    const tree = setupStandaloneTree({
      tool: 'codd',
      packageName: '@iyowei/codd-cli',
      version: '1.4.0',
    });
    const tgz = buildMinimalTgz({
      'package.json': JSON.stringify({
        name: '@iyowei/codd-cli',
        version: '1.5.0',
      }),
      'dist/cli.js': 'console.log("tampered");\n',
    });
    const wrongIntegrity = `sha512-${Buffer.alloc(64, 0xaa).toString('base64')}`;

    const { io, err } = captureIo();
    const code = await runSelfUpdate({
      binName: 'codd',
      locale: 'zh',
      argv: ['--registry', 'https://mock.registry.local'],
      meta: {
        name: '@iyowei/codd-cli',
        version: '1.4.0',
        isPrivate: false,
        rawPackageRoot: tree.appDir,
        packageRoot: tree.appDir,
      },
      io,
      deps: {
        fetchLatest: async () => ({
          ok: true,
          version: '1.5.0',
          registry: 'https://mock.registry.local',
        }),
        fetchFn: async (input) => {
          const url = typeof input === 'string' ? input : input.toString();
          if (url.endsWith('/1.5.0')) {
            return new Response(
              JSON.stringify({
                name: '@iyowei/codd-cli',
                version: '1.5.0',
                dist: {
                  tarball: 'https://mock.registry.local/bad.tgz',
                  integrity: wrongIntegrity,
                },
              }),
              { status: 200 },
            );
          }
          return new Response(tgz, { status: 200 });
        },
      },
    });

    expect(code).toBe(1);
    expect(err.join('\n')).toContain('完整性校验失败');
    expect(readFileSync(join(tree.appDir, 'dist', 'cli.js'), 'utf8')).toContain(
      'v1.4.0',
    );
  });
});
