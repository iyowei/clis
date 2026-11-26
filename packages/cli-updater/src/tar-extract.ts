/**
 * 纯 JS 安全 POSIX USTAR / PAX / GNU `.tgz` 解包器与 CLI 产物完整性自检:
 * 零外部依赖, 无位运算, 严格阻断 Zip-Slip、链接逃逸与高倍率 Gzip/Tar 解压炸弹。
 */
import { createHash } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve, sep } from 'node:path';
import { gunzipSync } from 'node:zlib';

/** 压缩态 `.tgz` 最大允许输入字节数 (64 MiB) */
export const MAX_TARBALL_COMPRESSED_BYTES = 64 * 1024 * 1024;
/** 解压后 tar 流与累计落盘文件最大允许字节数 (256 MiB, 防 Gzip Bomb OOM) */
export const MAX_TARBALL_UNCOMPRESSED_BYTES = 256 * 1024 * 1024;
/** 单个包允许的最大文件条目数 */
export const MAX_TARBALL_ENTRY_COUNT = 20_000;

export interface TarEntry {
  relPath: string;
  type: 'file' | 'dir';
  mode: number;
  data: Uint8Array;
}

function readTarString(buf: Uint8Array, start: number, len: number): string {
  let end = start;
  const max = Math.min(buf.length, start + len);
  while (end < max && buf[end] !== 0) {
    end += 1;
  }
  return Buffer.from(buf.subarray(start, end)).toString('utf8');
}

function readTarNumber(buf: Uint8Array, start: number, len: number): number {
  const first = buf[start] ?? 0;
  // GNU base-256 编码 (最高位为 1, 即 >= 128)
  if (first >= 128) {
    let val = first - 128;
    for (let i = 1; i < len; i += 1) {
      val = val * 256 + (buf[start + i] ?? 0);
    }
    return val;
  }
  const raw = readTarString(buf, start, len).trim();
  if (raw === '') return 0;
  const parsed = Number.parseInt(raw, 8);
  if (!Number.isFinite(parsed) || parsed < 0) {
    throw new Error(`Invalid tar octal field: "${raw}"`);
  }
  return parsed;
}

function verifyHeaderChecksum(header: Uint8Array): boolean {
  const expected = readTarNumber(header, 148, 8);
  let unsignedSum = 0;
  for (let i = 0; i < 512; i += 1) {
    unsignedSum += i >= 148 && i < 156 ? 0x20 : (header[i] ?? 0);
  }
  return unsignedSum === expected;
}

function isZeroBlock(block: Uint8Array): boolean {
  for (let i = 0; i < block.length; i += 1) {
    if (block[i] !== 0) return false;
  }
  return true;
}

function parsePaxRecords(data: Uint8Array): Record<string, string> {
  const out: Record<string, string> = {};
  const text = Buffer.from(data).toString('utf8');
  let cursor = 0;
  while (cursor < text.length) {
    const spaceIdx = text.indexOf(' ', cursor);
    if (spaceIdx <= cursor) break;
    const recLen = Number.parseInt(text.slice(cursor, spaceIdx), 10);
    if (!Number.isFinite(recLen) || recLen <= 0) break;
    const record = text.slice(spaceIdx + 1, cursor + recLen);
    const eqIdx = record.indexOf('=');
    if (eqIdx > 0) {
      const key = record.slice(0, eqIdx);
      const val = record.slice(eqIdx + 1).replace(/\n$/, '');
      out[key] = val;
    }
    cursor += recLen;
  }
  return out;
}

function sanitizeArchiveRelativePath(rawName: string): string | null {
  if (rawName.includes('\0')) {
    throw new Error('Unsafe archive entry contains NUL byte');
  }
  const slashNorm = rawName.replaceAll('\\', '/').replace(/^\.\//, '');
  if (slashNorm.startsWith('/') || /^[a-zA-Z]:/.test(slashNorm)) {
    throw new Error(`Unsafe absolute archive path: ${rawName}`);
  }
  const parts = slashNorm.split('/').filter((seg) => seg !== '' && seg !== '.');
  if (parts.includes('..')) {
    throw new Error(`Unsafe traversal archive path: ${rawName}`);
  }
  // npm pack 默认以 `package/` 为顶层目录, 剥离首段
  if (parts.length <= 1) return null;
  const rel = parts.slice(1).join('/');
  return rel === '' ? null : rel;
}

function hasAnyExecuteBit(mode: number): boolean {
  const perm = mode % 512;
  const ownerExec = Math.floor(perm / 64) % 2 === 1;
  const groupExec = Math.floor(perm / 8) % 2 === 1;
  const otherExec = perm % 2 === 1;
  return ownerExec || groupExec || otherExec;
}

/** 解析 USTAR / PAX / GNU tar 字节流 (剥离首层包目录并阻断路径穿越与链接逃逸) */
export function parseNpmTarArchive(tarBytes: Uint8Array): TarEntry[] {
  if (tarBytes.byteLength > MAX_TARBALL_UNCOMPRESSED_BYTES) {
    throw new Error(
      `Uncompressed tar exceeds safety limit (${tarBytes.byteLength} > ${MAX_TARBALL_UNCOMPRESSED_BYTES} bytes)`,
    );
  }
  const entries: TarEntry[] = [];
  let offset = 0;
  let totalPayloadBytes = 0;
  let nextPax: Record<string, string> | null = null;
  let nextLongName: string | null = null;

  while (offset + 512 <= tarBytes.length) {
    const header = tarBytes.subarray(offset, offset + 512);
    if (isZeroBlock(header)) break;
    if (!verifyHeaderChecksum(header)) {
      throw new Error(`Corrupt tar header checksum at offset ${offset}`);
    }

    const typeByte = header[156] ?? 0;
    const typeFlag = typeByte === 0 ? '0' : String.fromCharCode(typeByte);
    const mode = readTarNumber(header, 100, 8);
    let size = readTarNumber(header, 124, 12);
    const baseName = readTarString(header, 0, 100);
    const prefix = readTarString(header, 345, 155);
    let fullName = prefix !== '' ? `${prefix}/${baseName}` : baseName;

    const isMetaEntry =
      typeFlag === 'x' ||
      typeFlag === 'g' ||
      typeFlag === 'L' ||
      typeFlag === 'K';
    if (!isMetaEntry && nextPax !== null && typeof nextPax.size === 'string') {
      const paxSize = Number.parseInt(nextPax.size, 10);
      if (Number.isFinite(paxSize) && paxSize >= 0) size = paxSize;
    }

    offset += 512;
    const dataEnd = offset + size;
    if (dataEnd > tarBytes.length) {
      throw new Error('Truncated tar entry payload');
    }
    const payload = tarBytes.subarray(offset, dataEnd);
    const paddedBlocks = Math.ceil(size / 512) * 512;
    offset += paddedBlocks;

    if (typeFlag === 'x') {
      nextPax = parsePaxRecords(payload);
      continue;
    }
    if (typeFlag === 'g' || typeFlag === 'K') continue;
    if (typeFlag === 'L') {
      nextLongName = Buffer.from(payload).toString('utf8').replace(/\0+$/, '');
      continue;
    }

    if (nextPax !== null) {
      if (typeof nextPax.path === 'string' && nextPax.path !== '') {
        fullName = nextPax.path;
      }
      nextPax = null;
    }
    if (nextLongName !== null) {
      fullName = nextLongName;
      nextLongName = null;
    }

    if (fullName === 'pax_global_header') continue;

    if (typeFlag !== '0' && typeFlag !== '5') {
      throw new Error(
        `Unsupported or unsafe tar entry type "${typeFlag}" (${fullName})`,
      );
    }

    const relPath = sanitizeArchiveRelativePath(fullName);
    if (relPath === null) continue;

    if (entries.length >= MAX_TARBALL_ENTRY_COUNT) {
      throw new Error(
        `Archive exceeds maximum entry count (${MAX_TARBALL_ENTRY_COUNT})`,
      );
    }
    if (typeFlag === '0') {
      totalPayloadBytes += payload.byteLength;
      if (totalPayloadBytes > MAX_TARBALL_UNCOMPRESSED_BYTES) {
        throw new Error('Archive extracted payload exceeds safety limit');
      }
    }

    entries.push({
      relPath,
      type: typeFlag === '5' ? 'dir' : 'file',
      mode: mode % 512,
      data: typeFlag === '0' ? payload : new Uint8Array(0),
    });
  }

  return entries;
}

/** 解压 npm `.tgz` 字节流到目标空目录 (全路径校验 `resolve(destDir, ...)` 防逃逸 + 限额防压缩炸弹) */
export function extractNpmTarball(
  tgzBytes: Uint8Array,
  destDir: string,
): number {
  if (tgzBytes.byteLength > MAX_TARBALL_COMPRESSED_BYTES) {
    throw new Error(
      `Compressed tarball exceeds safety limit (${tgzBytes.byteLength} > ${MAX_TARBALL_COMPRESSED_BYTES} bytes)`,
    );
  }
  const tarBytes = gunzipSync(tgzBytes, {
    maxOutputLength: MAX_TARBALL_UNCOMPRESSED_BYTES,
  });
  const entries = parseNpmTarArchive(tarBytes);
  const absRoot = resolve(destDir);
  mkdirSync(absRoot, { recursive: true });
  const rootPrefix = absRoot.endsWith(sep) ? absRoot : `${absRoot}${sep}`;

  let fileCount = 0;
  for (const entry of entries) {
    const absTarget = resolve(absRoot, entry.relPath);
    if (!absTarget.startsWith(rootPrefix)) {
      throw new Error(`Archive target escapes destination: ${entry.relPath}`);
    }
    if (entry.type === 'dir') {
      mkdirSync(absTarget, { recursive: true });
      continue;
    }
    mkdirSync(dirname(absTarget), { recursive: true });
    writeFileSync(absTarget, entry.data);
    const safeMode = hasAnyExecuteBit(entry.mode) ? 0o755 : 0o644;
    try {
      chmodSync(absTarget, safeMode);
    } catch {
      // Windows 对 POSIX 权限位不敏感
    }
    fileCount += 1;
  }
  return fileCount;
}

function extractDeclaredBinPaths(binField: unknown): string[] {
  if (typeof binField === 'string') return [binField];
  if (
    typeof binField === 'object' &&
    binField !== null &&
    !Array.isArray(binField)
  ) {
    return Object.values(binField).filter(
      (v): v is string => typeof v === 'string',
    );
  }
  return [];
}

/**
 * 校验解包后的 CLI 包目录结构与构建产物自证 (`dist/cli.js` 或 `dist/<pkg>.js` + 可选 `dist/manifest.json` SHA-256)。
 */
export function verifyExtractedCliBundle(
  stagingDir: string,
  packageName: string,
  binField?: unknown,
): { ok: true; bundleRel: string } | { ok: false; reason: string } {
  const absRoot = resolve(stagingDir);
  const rootPrefix = absRoot.endsWith(sep) ? absRoot : `${absRoot}${sep}`;

  if (binField !== undefined) {
    const binPaths = extractDeclaredBinPaths(binField);
    for (const rel of binPaths) {
      const target = resolve(absRoot, rel);
      if (!target.startsWith(rootPrefix) || !existsSync(target)) {
        return { ok: false, reason: `missing bin entrypoint (${rel})` };
      }
    }
  }

  const unscoped = packageName.includes('/')
    ? packageName.slice(packageName.indexOf('/') + 1)
    : packageName;
  const bundleCandidates = ['cli.js', `${unscoped}.js`];
  let matchedBundle: string | undefined;
  for (const cand of bundleCandidates) {
    if (existsSync(join(absRoot, 'dist', cand))) {
      matchedBundle = cand;
      break;
    }
  }
  if (matchedBundle === undefined) {
    return {
      ok: false,
      reason: `missing dist/cli.js or dist/${unscoped}.js`,
    };
  }

  const manifestPath = join(absRoot, 'dist', 'manifest.json');
  if (existsSync(manifestPath)) {
    try {
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
        schemaVersion?: unknown;
        cliSha256?: unknown;
      };
      if (
        manifest.schemaVersion !== 1 ||
        typeof manifest.cliSha256 !== 'string'
      ) {
        return { ok: false, reason: 'invalid dist/manifest.json schema' };
      }
      const actualSha = createHash('sha256')
        .update(readFileSync(join(absRoot, 'dist', matchedBundle)))
        .digest('hex');
      if (actualSha !== manifest.cliSha256) {
        return {
          ok: false,
          reason: `dist/${matchedBundle} SHA-256 mismatch with dist/manifest.json`,
        };
      }
    } catch {
      return { ok: false, reason: 'corrupt dist/manifest.json' };
    }
  }

  return { ok: true, bundleRel: `dist/${matchedBundle}` };
}
