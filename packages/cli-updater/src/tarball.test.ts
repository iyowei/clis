/**
 * npm tarball 完整性校验 (SRI / SHA-1)、安全 USTAR/PAX 解包与 Zip-Slip/Symlink 逃逸阻断单元测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { gzipSync } from 'node:zlib';

import {
  downloadAndVerifyTarball,
  extractNpmTarball,
  verifyExtractedCliBundle,
  verifyTarballDigest,
} from './tarball.ts';

interface BuildTarInputEntry {
  name: string;
  content?: string;
  type?: '0' | '2' | '5';
  mode?: number;
  linkName?: string;
  paxPath?: string;
  gnuLongName?: string;
}

function writeTarHeader(opts: {
  name: string;
  size: number;
  type: string;
  mode: number;
  linkName?: string;
}): Buffer {
  const hdr = Buffer.alloc(512, 0);
  const nameBuf = Buffer.from(opts.name, 'utf8');
  nameBuf.copy(hdr, 0, 0, Math.min(nameBuf.length, 100));
  hdr.write(`${opts.mode.toString(8).padStart(7, '0')}\0`, 100, 'ascii');
  hdr.write('0000000\0', 108, 'ascii');
  hdr.write('0000000\0', 116, 'ascii');
  hdr.write(`${opts.size.toString(8).padStart(11, '0')}\0`, 124, 'ascii');
  hdr.write('00000000000\0', 136, 'ascii');
  hdr.fill(0x20, 148, 156);
  hdr.write(opts.type, 156, 'ascii');
  if (opts.linkName !== undefined) {
    const linkBuf = Buffer.from(opts.linkName, 'utf8');
    linkBuf.copy(hdr, 157, 0, Math.min(linkBuf.length, 100));
  }
  hdr.write('ustar\0', 257, 'ascii');
  hdr.write('00', 263, 'ascii');

  let sum = 0;
  for (let i = 0; i < 512; i += 1) {
    sum += hdr[i] ?? 0;
  }
  hdr.write(`${sum.toString(8).padStart(6, '0')}\0 `, 148, 'ascii');
  return hdr;
}

function encodePaxRecord(key: string, val: string): Buffer {
  const suffix = ` ${key}=${val}\n`;
  let totalLen = Buffer.byteLength(suffix, 'utf8') + 2;
  for (let pass = 0; pass < 4; pass += 1) {
    const line = `${totalLen}${suffix}`;
    const byteLen = Buffer.byteLength(line, 'utf8');
    if (byteLen === totalLen) return Buffer.from(line, 'utf8');
    totalLen = byteLen;
  }
  return Buffer.from(`${totalLen}${suffix}`, 'utf8');
}

function padTarBlock(data: Buffer): Buffer {
  if (data.length === 0) return Buffer.alloc(0);
  const rem = data.length % 512;
  if (rem === 0) return data;
  return Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
}

function buildTestTgz(entries: readonly BuildTarInputEntry[]): Buffer {
  const chunks: Buffer[] = [];
  for (const item of entries) {
    const payload =
      item.content !== undefined
        ? Buffer.from(item.content, 'utf8')
        : Buffer.alloc(0);
    if (item.paxPath !== undefined) {
      const paxPayload = encodePaxRecord('path', item.paxPath);
      chunks.push(
        writeTarHeader({
          name: 'PaxHeader/entry',
          size: paxPayload.length,
          type: 'x',
          mode: 0o644,
        }),
        padTarBlock(paxPayload),
      );
    }
    if (item.gnuLongName !== undefined) {
      const longPayload = Buffer.from(`${item.gnuLongName}\0`, 'utf8');
      chunks.push(
        writeTarHeader({
          name: '././@LongLink',
          size: longPayload.length,
          type: 'L',
          mode: 0o644,
        }),
        padTarBlock(longPayload),
      );
    }
    chunks.push(
      writeTarHeader({
        name: item.name,
        size: item.type === '5' ? 0 : payload.length,
        type: item.type ?? '0',
        mode: item.mode ?? (item.type === '5' ? 0o755 : 0o644),
        linkName: item.linkName,
      }),
    );
    if (item.type !== '5' && payload.length > 0) {
      chunks.push(padTarBlock(payload));
    }
  }
  chunks.push(Buffer.alloc(1024, 0));
  return gzipSync(Buffer.concat(chunks));
}

const tempDirs: string[] = [];
function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'cli-updater-tar-'));
  tempDirs.push(dir);
  return dir;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    const dir = tempDirs.pop()!;
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('extractNpmTarball 安全解包', () => {
  test('正确剥离 package/ 前缀并还原常规文件、PAX 长路径与 GNU LongName', () => {
    const longPath = 'package/dist/nested/' + 'a'.repeat(110) + '/pax-file.txt';
    const gnuPath = 'package/dist/nested/' + 'b'.repeat(115) + '/gnu-file.txt';
    const tgz = buildTestTgz([
      { name: 'package/', type: '5', mode: 0o755 },
      {
        name: 'package/package.json',
        content: '{"name":"@iyowei/codd-cli","version":"1.5.0"}',
      },
      {
        name: 'package/bin/codd.mjs',
        content: '#!/usr/bin/env node\nconsole.log("ok");\n',
        mode: 0o755,
      },
      {
        name: 'package/dist/truncated',
        paxPath: longPath,
        content: 'pax-ok',
      },
      {
        name: 'package/dist/truncated2',
        gnuLongName: gnuPath,
        content: 'gnu-ok',
      },
    ]);

    const dest = makeTempDir();
    const count = extractNpmTarball(tgz, dest);
    expect(count).toBe(4);
    expect(readFileSync(join(dest, 'package.json'), 'utf8')).toContain('1.5.0');
    expect(
      readFileSync(
        join(dest, 'dist', 'nested', 'a'.repeat(110), 'pax-file.txt'),
        'utf8',
      ),
    ).toBe('pax-ok');
    expect(
      readFileSync(
        join(dest, 'dist', 'nested', 'b'.repeat(115), 'gnu-file.txt'),
        'utf8',
      ),
    ).toBe('gnu-ok');

    if (process.platform !== 'win32') {
      const binMode = statSync(join(dest, 'bin', 'codd.mjs')).mode % 512;
      expect(binMode).toBe(0o755);
    }
  });

  test('阻断 ../ 路径穿越、绝对路径、盘符路径与符号链接', () => {
    const cases: readonly BuildTarInputEntry[][] = [
      [{ name: 'package/../../evil.txt', content: 'pwn' }],
      [{ name: '/etc/passwd', content: 'pwn' }],
      [{ name: 'C:\\Windows\\system.ini', content: 'pwn' }],
      [{ name: 'package/bin/escape', type: '2', linkName: '/etc/passwd' }],
    ];

    for (const entries of cases) {
      const tgz = buildTestTgz(entries);
      const dest = makeTempDir();
      expect(() => extractNpmTarball(tgz, dest)).toThrow();
    }
  });

  test('拒绝校验和损坏的 tar 头部', () => {
    const hdr = writeTarHeader({
      name: 'package/package.json',
      size: 2,
      type: '0',
      mode: 0o644,
    });
    // 篡改一个字节破坏头校验和
    hdr[10] = ((hdr[10] ?? 0) + 1) % 256;
    const tgz = gzipSync(Buffer.concat([hdr, Buffer.alloc(1536, 0)]));
    const dest = makeTempDir();
    expect(() => extractNpmTarball(tgz, dest)).toThrow(/checksum/i);
    expect(existsSync(join(dest, 'package.json'))).toBe(false);
  });

  test('verifyExtractedCliBundle 兼容 create-clis (dist/create-clis.js) 并拦截篡改的 dist/manifest.json', () => {
    const cliCode = 'console.log("create-clis");\n';
    const goodSha = createHash('sha256').update(cliCode).digest('hex');
    const goodTgz = buildTestTgz([
      {
        name: 'package/package.json',
        content: JSON.stringify({
          name: 'create-clis',
          bin: { 'create-clis': 'bin/create-clis.mjs' },
        }),
      },
      { name: 'package/bin/create-clis.mjs', content: '#!/usr/bin/env node\n' },
      { name: 'package/dist/create-clis.js', content: cliCode },
      {
        name: 'package/dist/manifest.json',
        content: JSON.stringify({ schemaVersion: 1, cliSha256: goodSha }),
      },
    ]);
    const goodDir = makeTempDir();
    extractNpmTarball(goodTgz, goodDir);
    expect(
      verifyExtractedCliBundle(goodDir, 'create-clis', {
        'create-clis': 'bin/create-clis.mjs',
      }),
    ).toEqual({ ok: true, bundleRel: 'dist/create-clis.js' });

    const badTgz = buildTestTgz([
      { name: 'package/dist/create-clis.js', content: cliCode },
      {
        name: 'package/dist/manifest.json',
        content: JSON.stringify({
          schemaVersion: 1,
          cliSha256: '0'.repeat(64),
        }),
      },
    ]);
    const badDir = makeTempDir();
    extractNpmTarball(badTgz, badDir);
    expect(verifyExtractedCliBundle(badDir, 'create-clis').ok).toBe(false);
  });
});

describe('verifyTarballDigest 与 downloadAndVerifyTarball', () => {
  test('同时支持 SRI sha512/sha256 与 shasum sha1, 篡改立即拦截', async () => {
    const payload = Buffer.from('tarball-sample-bytes', 'utf8');
    const sha512 = `sha512-${createHash('sha512').update(payload).digest('base64')}`;
    const sha1 = createHash('sha1').update(payload).digest('hex');

    expect(verifyTarballDigest(payload, sha512, undefined).ok).toBe(true);
    expect(verifyTarballDigest(payload, undefined, sha1).ok).toBe(true);
    expect(verifyTarballDigest(payload, undefined, undefined).ok).toBe(false);

    const tampered = Buffer.from('tarball-tamper-bytes', 'utf8');
    expect(verifyTarballDigest(tampered, sha512, undefined).ok).toBe(false);
    expect(verifyTarballDigest(tampered, undefined, sha1).ok).toBe(false);

    let capturedAuth: string | null = null;
    const crossOriginDl = await downloadAndVerifyTarball({
      tarballUrl: 'https://cdn.example.com/pkg-1.0.0.tgz',
      integrity: sha512,
      authToken: 'secret-token',
      expectedRegistryBase: 'https://registry.example.com',
      fetchFn: async (_url, init) => {
        const headers = new Headers(init?.headers);
        capturedAuth = headers.get('authorization');
        return new Response(payload, { status: 200 });
      },
    });
    expect(crossOriginDl.ok).toBe(true);
    expect(capturedAuth).toBeNull();
  });
});
