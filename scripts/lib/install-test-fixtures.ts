/**
 * 安装器 E2E 测试共享夹具 (tarball / STORED ZIP / 纯净无 Bun/Node PATH / 异步子进程)。
 */
import { spawn, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { crc32, gzipSync } from 'node:zlib';

function writeTarHeader(name: string, size: number, mode: number): Buffer {
  const hdr = Buffer.alloc(512, 0);
  const nameBytes = Buffer.from(name, 'utf8');
  nameBytes.copy(hdr, 0, 0, Math.min(nameBytes.length, 100));
  hdr.write(`${mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  hdr.write('0000000\0', 108, 'ascii');
  hdr.write('0000000\0', 116, 'ascii');
  hdr.write(`${size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  hdr.write('00000000000\0', 136, 'ascii');
  hdr.fill(0x20, 148, 156);
  hdr.write('0', 156, 'ascii');
  hdr.write('ustar\0', 257, 'ascii');
  hdr.write('00', 263, 'ascii');
  let sum = 0;
  for (let i = 0; i < 512; i += 1) sum += hdr[i] ?? 0;
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return hdr;
}

export function buildPkgTarball(files: Record<string, string>): {
  tgz: Buffer;
  integrity: string;
} {
  const chunks: Buffer[] = [];
  for (const [rel, content] of Object.entries(files)) {
    const data = Buffer.from(content, 'utf8');
    chunks.push(writeTarHeader(`package/${rel}`, data.length, 0o644));
    if (data.length > 0) {
      const rem = data.length % 512;
      chunks.push(
        rem === 0 ? data : Buffer.concat([data, Buffer.alloc(512 - rem, 0)]),
      );
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  const tgz = gzipSync(Buffer.concat(chunks));
  const hasher = new Bun.CryptoHasher('sha512');
  hasher.update(tgz);
  const integrity = `sha512-${hasher.digest('base64')}`;
  return { tgz, integrity };
}

/** 构造标准单文件 STORED ZIP (零外部命令依赖, 含 UNIX 0755 属性) */
export function buildSingleFileZip(
  entryName: string,
  content: Uint8Array,
): Buffer {
  const nameBuf = Buffer.from(entryName, 'utf8');
  const crcVal = crc32(content);

  const lfh = Buffer.alloc(30 + nameBuf.length, 0);
  lfh.writeUInt32LE(0x04034b50, 0);
  lfh.writeUInt16LE(20, 4);
  lfh.writeUInt32LE(crcVal, 14);
  lfh.writeUInt32LE(content.length, 18);
  lfh.writeUInt32LE(content.length, 22);
  lfh.writeUInt16LE(nameBuf.length, 26);
  nameBuf.copy(lfh, 30);

  const cdh = Buffer.alloc(46 + nameBuf.length, 0);
  cdh.writeUInt32LE(0x02014b50, 0);
  cdh.writeUInt16LE(0x031e, 4);
  cdh.writeUInt16LE(20, 6);
  cdh.writeUInt32LE(crcVal, 16);
  cdh.writeUInt32LE(content.length, 20);
  cdh.writeUInt32LE(content.length, 24);
  cdh.writeUInt16LE(nameBuf.length, 28);
  cdh.writeUInt32LE(0x81ed0000, 38);
  nameBuf.copy(cdh, 46);

  const cdOffset = lfh.length + content.length;
  const eocd = Buffer.alloc(22, 0);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(1, 8);
  eocd.writeUInt16LE(1, 10);
  eocd.writeUInt32LE(cdh.length, 12);
  eocd.writeUInt32LE(cdOffset, 16);

  return Buffer.concat([lfh, Buffer.from(content), cdh, eocd]);
}

const EXCLUDED_RUNTIME_BINS = new Set([
  'node',
  'bun',
  'bunx',
  'npm',
  'npx',
  'pnpm',
  'yarn',
  'deno',
  'corepack',
  'volta',
]);

export function buildHermeticPosixBin(
  tmpRoot: string,
  opts?: {
    oldNodeMajor?: number;
    includeRealBun?: boolean;
    includeRealNode?: string;
  },
): string {
  const dir = join(tmpRoot, 'hermetic-bin');
  mkdirSync(dir, { recursive: true });
  for (const sysDir of ['/bin', '/usr/bin']) {
    if (!existsSync(sysDir)) continue;
    for (const name of readdirSync(sysDir)) {
      if (EXCLUDED_RUNTIME_BINS.has(name) || existsSync(join(dir, name))) {
        continue;
      }
      const src = join(sysDir, name);
      try {
        const st = lstatSync(src);
        if (st.isFile() || st.isSymbolicLink()) {
          symlinkSync(src, join(dir, name));
        }
      } catch {
        // 忽略受保护文件
      }
    }
  }

  if (opts?.oldNodeMajor !== undefined) {
    const oldNode = join(dir, 'node');
    writeFileSync(
      oldNode,
      `#!/bin/sh\ncase "\${1:-}" in\n  -v|--version) echo "v${opts.oldNodeMajor}.19.0"; exit 0 ;;\n  *) exit 1 ;;\nesac\n`,
      'utf8',
    );
    chmodSync(oldNode, 0o755);
  }
  if (opts?.includeRealNode !== undefined) {
    symlinkSync(opts.includeRealNode, join(dir, 'node'));
  }
  if (opts?.includeRealBun === true) {
    symlinkSync(process.execPath, join(dir, 'bun'));
  }
  return dir;
}

export function makeCliFixtureTgz(opts: {
  binName: string;
  pkgName: string;
  version: string;
  withDeps?: boolean;
}): { tgz: Buffer; integrity: string } {
  const entryRel = `bin/${opts.binName}.mjs`;
  const distFile = opts.binName === 'create-clis' ? 'create-clis.js' : 'cli.js';
  const pkgJson: Record<string, unknown> = {
    name: opts.pkgName,
    version: opts.version,
    type: 'module',
    bin: { [opts.binName]: entryRel },
  };
  if (opts.withDeps === true) {
    pkgJson.dependencies = { 'fixture-dep': '1.0.0' };
  }

  const mjsBody = [
    '#!/usr/bin/env node',
    "import { readFileSync } from 'node:fs';",
    "import { dirname, join } from 'node:path';",
    "import { fileURLToPath, pathToFileURL } from 'node:url';",
    'const root = dirname(dirname(fileURLToPath(import.meta.url)));',
    `const dist = join(root, "dist", "${distFile}");`,
    'const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));',
    'if (pkg.dependencies && !process.argv.includes("--skip-dep-check")) {',
    '  await import(pathToFileURL(join(root, "node_modules", "fixture-dep", "index.js")).href);',
    '}',
    'await import(pathToFileURL(dist).href);',
  ].join('\n');

  const cliBody = `${[
    "const arg = process.argv[2] ?? '';",
    `if (arg === '--version' || arg === '-V') console.log('${opts.version} (isolated=' + (process.env.CLIS_BUN_ISOLATED || '0') + ')');`,
    `else if (arg === '--help' || arg === '-h') console.log('Usage: ${opts.binName}');`,
    `else console.log('${opts.binName}@${opts.version}');`,
  ].join('\n')}\n`;
  const cliHasher = new Bun.CryptoHasher('sha256');
  cliHasher.update(cliBody);
  const manifestJson = JSON.stringify(
    { schemaVersion: 1, cliSha256: cliHasher.digest('hex') },
    null,
    2,
  );

  return buildPkgTarball({
    'package.json': `${JSON.stringify(pkgJson, null, 2)}\n`,
    [entryRel]: `${mjsBody}\n`,
    'bin/bunfig.toml': 'telemetry = false\n',
    [`dist/${distFile}`]: cliBody,
    'dist/manifest.json': `${manifestJson}\n`,
  });
}

export function resolveHostNode22Plus(): string | undefined {
  const cand = spawnSync('node', ['-p', 'process.execPath'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  if (cand.status !== 0) return undefined;
  const exe = cand.stdout.trim();
  const ver = spawnSync(exe, ['-p', 'process.versions.node'], {
    encoding: 'utf8',
    timeout: 5000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const [maj, min] = ver.stdout.trim().split('.').map(Number);
  if (
    maj !== undefined &&
    min !== undefined &&
    (maj > 22 || (maj === 22 && min >= 18))
  ) {
    return exe;
  }
  return undefined;
}

export function runAsync(
  command: string,
  args: readonly string[],
  opts: {
    env: NodeJS.ProcessEnv;
    input?: string;
    timeoutMs?: number;
  },
): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolvePromise) => {
    const child = spawn(command, args, {
      env: opts.env,
      stdio: [opts.input !== undefined ? 'pipe' : 'ignore', 'pipe', 'pipe'],
    });
    const outChunks: Buffer[] = [];
    const errChunks: Buffer[] = [];
    child.stdout?.on('data', (d: Buffer) => outChunks.push(d));
    child.stderr?.on('data', (d: Buffer) => errChunks.push(d));

    const timer = setTimeout(() => {
      try {
        child.kill('SIGKILL');
      } catch {
        // ignore
      }
    }, opts.timeoutMs ?? 25_000);
    timer.unref?.();

    if (opts.input !== undefined && child.stdin !== null) {
      child.stdin.write(opts.input);
      child.stdin.end();
    }

    child.once('close', (code) => {
      clearTimeout(timer);
      resolvePromise({
        status: code,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: Buffer.concat(errChunks).toString('utf8'),
      });
    });
    child.once('error', (err) => {
      clearTimeout(timer);
      resolvePromise({
        status: 1,
        stdout: Buffer.concat(outChunks).toString('utf8'),
        stderr: err.message,
      });
    });
  });
}

export interface MockInstallerServer {
  url: () => string;
  getBunFetchHits: () => number;
  resetBunFetchHits: () => void;
  setCorruptBunSha: (corrupt: boolean) => void;
  getRequestedUrls: () => string[];
  resetRequestedUrls: () => void;
  getFixtureTgz: (tool: 'sweep' | 'fan') => Buffer;
  stop: () => void;
}

export function createMockInstallerServer(
  repoRoot: string,
): MockInstallerServer {
  const coddV1 = makeCliFixtureTgz({
    binName: 'codd',
    pkgName: '@iyowei/codd-cli',
    version: '1.4.1',
  });
  const sweepV1 = makeCliFixtureTgz({
    binName: 'sweep',
    pkgName: '@iyowei/sweep-cli',
    version: '0.4.0',
  });
  const fanV1 = makeCliFixtureTgz({
    binName: 'fan',
    pkgName: '@iyowei/fan-cli',
    version: '1.3.0',
  });
  const depV1 = buildPkgTarball({
    'package.json': JSON.stringify({ name: 'fixture-dep', version: '1.0.0' }),
    'index.js': 'export const depLoaded = true;\n',
  });
  const createClisV1 = makeCliFixtureTgz({
    binName: 'create-clis',
    pkgName: 'create-clis',
    version: '1.5.1',
    withDeps: true,
  });

  const bunStub = `#!/bin/sh\nif [ "\${1:-}" = "--version" ]; then echo "1.4.5"; exit 0; fi\nexec "${process.execPath}" "$@"\n`;
  const zipEntries = new Map<string, Buffer>();
  const shaLines: string[] = [];
  for (const name of [
    'bun-darwin-aarch64.zip',
    'bun-darwin-x64.zip',
    'bun-darwin-x64-baseline.zip',
    'bun-linux-aarch64.zip',
    'bun-linux-aarch64-musl.zip',
    'bun-linux-x64.zip',
    'bun-linux-x64-baseline.zip',
    'bun-linux-x64-musl.zip',
    'bun-linux-x64-musl-baseline.zip',
  ]) {
    const z = buildSingleFileZip(
      `${name.replace(/\.zip$/, '')}/bun`,
      Buffer.from(bunStub, 'utf8'),
    );
    zipEntries.set(name, z);
    const hasher = new Bun.CryptoHasher('sha256');
    hasher.update(z);
    shaLines.push(`${hasher.digest('hex')}  ${name}`);
  }
  const validShaSums = `${shaLines.join('\n')}\n`;

  let bunFetchHits = 0;
  let requestedUrls: string[] = [];
  let corruptSha = false;

  const server = Bun.serve({
    port: 0,
    fetch(req) {
      const url = new URL(req.url);
      let p = url.pathname.replaceAll('%40', '@');
      const origin = url.origin;
      requestedUrls.push(`${url.pathname}${url.search}`);

      if (p === '/custom-mirror/clis-install.sh') {
        p = '/install.sh';
      } else if (p.startsWith('/custom-bun/dl/') && p.endsWith('.zip')) {
        p = `/bun-rel/${p.split('/').pop()!}`;
      } else if (
        p === '/custom-checksums/bun-sums.txt' ||
        p === '/custom-bun/dl/SHASUMS256.txt'
      ) {
        p = '/bun-rel/SHASUMS256.txt';
      }

      if (p === '/install.sh') {
        return new Response(readFileSync(join(repoRoot, 'install.sh')), {
          headers: { 'content-type': 'text/plain; charset=utf-8' },
        });
      }
      if (p === '/bun-rel/SHASUMS256.txt') {
        bunFetchHits += 1;
        return new Response(
          corruptSha
            ? validShaSums.replace(/^[0-9a-f]{64}/gm, '0'.repeat(64))
            : validShaSums,
        );
      }
      if (p.startsWith('/bun-rel/') && p.endsWith('.zip')) {
        bunFetchHits += 1;
        const buf = zipEntries.get(p.slice('/bun-rel/'.length));
        return buf
          ? new Response(buf)
          : new Response('Not found', { status: 404 });
      }
      if (
        p === '/reg/@iyowei%2Fcodd-cli/latest' ||
        p === '/reg/@iyowei%2Fcodd-cli/1.4.1'
      ) {
        return Response.json({
          name: '@iyowei/codd-cli',
          version: '1.4.1',
          dist: {
            tarball: `${origin}/tar/codd.tgz`,
            integrity: coddV1.integrity,
          },
        });
      }
      if (p === '/tar/codd.tgz') return new Response(coddV1.tgz);
      if (p === '/reg/create-clis/latest' || p === '/reg/create-clis/1.5.1') {
        return Response.json({
          name: 'create-clis',
          version: '1.5.1',
          dist: {
            tarball: `${origin}/tar/create-clis.tgz`,
            integrity: createClisV1.integrity,
          },
        });
      }
      if (p === '/reg/create-clis') {
        return Response.json({
          name: 'create-clis',
          'dist-tags': { latest: '1.5.1' },
          versions: {
            '1.5.1': {
              name: 'create-clis',
              version: '1.5.1',
              dependencies: { 'fixture-dep': '1.0.0' },
              dist: {
                tarball: `${origin}/tar/create-clis.tgz`,
                integrity: createClisV1.integrity,
              },
            },
          },
        });
      }
      if (p === '/tar/create-clis.tgz') return new Response(createClisV1.tgz);
      if (p === '/reg/fixture-dep') {
        return Response.json({
          name: 'fixture-dep',
          'dist-tags': { latest: '1.0.0' },
          versions: {
            '1.0.0': {
              name: 'fixture-dep',
              version: '1.0.0',
              dist: {
                tarball: `${origin}/tar/fixture-dep.tgz`,
                integrity: depV1.integrity,
              },
            },
          },
        });
      }
      if (p === '/tar/fixture-dep.tgz') return new Response(depV1.tgz);
      return new Response('Not found', { status: 404 });
    },
  });

  return {
    url: () => server.url.toString().replace(/\/$/, ''),
    getBunFetchHits: () => bunFetchHits,
    resetBunFetchHits: () => {
      bunFetchHits = 0;
    },
    setCorruptBunSha: (corrupt) => {
      corruptSha = corrupt;
    },
    getRequestedUrls: () => requestedUrls,
    resetRequestedUrls: () => {
      requestedUrls = [];
    },
    getFixtureTgz: (tool) => (tool === 'sweep' ? sweepV1.tgz : fanV1.tgz),
    stop: () => {
      server.stop(true);
    },
  };
}
