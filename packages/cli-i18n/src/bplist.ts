/**
 * 零依赖、零位运算的 macOS `.GlobalPreferences.plist` 语言提取器:
 * 同时兼容 `bplist00` 二进制格式与 XML plist 格式, 直接从根字典读取 `AppleLanguages` 首项或 `AppleLocale`。
 */

const BPLIST_MAGIC = 'bplist00';
const TRAILER_SIZE = 32;
const MAX_OBJECTS = 16_384;

function readUIntBE(
  buf: Uint8Array,
  offset: number,
  byteLen: number,
): number | null {
  if (
    offset < 0 ||
    byteLen < 1 ||
    byteLen > 8 ||
    offset + byteLen > buf.length
  ) {
    return null;
  }
  let val = 0;
  for (let i = 0; i < byteLen; i += 1) {
    val = val * 256 + buf[offset + i]!;
  }
  return Number.isSafeInteger(val) ? val : null;
}

function isValidRefSize(size: number): boolean {
  return size === 1 || size === 2 || size === 4 || size === 8;
}

interface BplistContext {
  buf: Uint8Array;
  offsetIntSize: number;
  objectRefSize: number;
  numObjects: number;
  topObject: number;
  offsetTableStart: number;
  trailerStart: number;
}

function parseTrailer(buf: Uint8Array): BplistContext | null {
  if (buf.length < 8 + TRAILER_SIZE) return null;
  const magic = Buffer.from(buf.subarray(0, 8)).toString('ascii');
  if (magic !== BPLIST_MAGIC) return null;

  const trailerStart = buf.length - TRAILER_SIZE;
  const offsetIntSize = buf[trailerStart + 6]!;
  const objectRefSize = buf[trailerStart + 7]!;
  if (!isValidRefSize(offsetIntSize) || !isValidRefSize(objectRefSize)) {
    return null;
  }

  const numObjects = readUIntBE(buf, trailerStart + 8, 8);
  const topObject = readUIntBE(buf, trailerStart + 16, 8);
  const offsetTableStart = readUIntBE(buf, trailerStart + 24, 8);
  if (
    numObjects === null ||
    topObject === null ||
    offsetTableStart === null ||
    numObjects <= 0 ||
    numObjects > MAX_OBJECTS ||
    topObject >= numObjects ||
    offsetTableStart < 8 ||
    offsetTableStart + numObjects * offsetIntSize > trailerStart
  ) {
    return null;
  }

  return {
    buf,
    offsetIntSize,
    objectRefSize,
    numObjects,
    topObject,
    offsetTableStart,
    trailerStart,
  };
}

function getObjectOffset(ctx: BplistContext, ref: number): number | null {
  if (ref < 0 || ref >= ctx.numObjects) return null;
  const pos = ctx.offsetTableStart + ref * ctx.offsetIntSize;
  const objOffset = readUIntBE(ctx.buf, pos, ctx.offsetIntSize);
  if (
    objOffset === null ||
    objOffset < 8 ||
    objOffset >= ctx.offsetTableStart
  ) {
    return null;
  }
  return objOffset;
}

function readCount(
  buf: Uint8Array,
  pos: number,
  lowNibble: number,
): { count: number; nextPos: number } | null {
  if (lowNibble < 15) {
    return { count: lowNibble, nextPos: pos };
  }
  if (pos >= buf.length) return null;
  const intMarker = buf[pos]!;
  const intType = Math.floor(intMarker / 16);
  const intPow = intMarker % 16;
  if (intType !== 1 || intPow > 3) return null;
  const byteLen = 2 ** intPow;
  const count = readUIntBE(buf, pos + 1, byteLen);
  if (count === null || count < 0) return null;
  return { count, nextPos: pos + 1 + byteLen };
}

function readStringAt(ctx: BplistContext, ref: number): string | null {
  const offset = getObjectOffset(ctx, ref);
  if (offset === null) return null;
  const marker = ctx.buf[offset]!;
  const kind = Math.floor(marker / 16);
  const low = marker % 16;
  const lenInfo = readCount(ctx.buf, offset + 1, low);
  if (lenInfo === null) return null;
  const { count, nextPos } = lenInfo;

  if (kind === 5) {
    if (nextPos + count > ctx.offsetTableStart) return null;
    return Buffer.from(ctx.buf.subarray(nextPos, nextPos + count)).toString(
      'ascii',
    );
  }
  if (kind === 6) {
    const byteLen = count * 2;
    if (nextPos + byteLen > ctx.offsetTableStart) return null;
    return new TextDecoder('utf-16be').decode(
      ctx.buf.subarray(nextPos, nextPos + byteLen),
    );
  }
  return null;
}

function readFirstStringFromArray(
  ctx: BplistContext,
  ref: number,
): string | null {
  const offset = getObjectOffset(ctx, ref);
  if (offset === null) return null;
  const marker = ctx.buf[offset]!;
  if (Math.floor(marker / 16) !== 10) return null;
  const lenInfo = readCount(ctx.buf, offset + 1, marker % 16);
  if (lenInfo === null || lenInfo.count === 0) return null;
  const { count, nextPos } = lenInfo;
  if (nextPos + count * ctx.objectRefSize > ctx.offsetTableStart) return null;

  for (let i = 0; i < count; i += 1) {
    const elemRef = readUIntBE(
      ctx.buf,
      nextPos + i * ctx.objectRefSize,
      ctx.objectRefSize,
    );
    if (elemRef === null) continue;
    const str = readStringAt(ctx, elemRef)?.trim();
    if (str !== undefined && str !== '') return str;
  }
  return null;
}

function extractFromBinaryPlist(buf: Uint8Array): string | null {
  const ctx = parseTrailer(buf);
  if (ctx === null) return null;
  const topOffset = getObjectOffset(ctx, ctx.topObject);
  if (topOffset === null) return null;
  const marker = ctx.buf[topOffset]!;
  if (Math.floor(marker / 16) !== 13) return null;

  const lenInfo = readCount(ctx.buf, topOffset + 1, marker % 16);
  if (lenInfo === null) return null;
  const { count, nextPos } = lenInfo;
  const refsSpan = count * 2 * ctx.objectRefSize;
  if (nextPos + refsSpan > ctx.offsetTableStart) return null;

  let appleLocaleFallback: string | null = null;
  const valStart = nextPos + count * ctx.objectRefSize;

  for (let i = 0; i < count; i += 1) {
    const keyRef = readUIntBE(
      ctx.buf,
      nextPos + i * ctx.objectRefSize,
      ctx.objectRefSize,
    );
    const valRef = readUIntBE(
      ctx.buf,
      valStart + i * ctx.objectRefSize,
      ctx.objectRefSize,
    );
    if (keyRef === null || valRef === null) continue;
    const key = readStringAt(ctx, keyRef);
    if (key === 'AppleLanguages') {
      const primary = readFirstStringFromArray(ctx, valRef);
      if (primary !== null) return primary;
    } else if (key === 'AppleLocale') {
      const loc = readStringAt(ctx, valRef)?.trim();
      if (loc !== undefined && loc !== '') appleLocaleFallback = loc;
    }
  }
  return appleLocaleFallback;
}

function extractFromXmlPlist(buf: Uint8Array): string | null {
  const head = Buffer.from(buf.subarray(0, Math.min(buf.length, 64))).toString(
    'utf8',
  );
  if (!head.includes('<?xml') && !head.includes('<plist')) return null;
  const xml = Buffer.from(buf).toString('utf8');
  const langMatch =
    /<key>\s*AppleLanguages\s*<\/key>\s*<array>\s*<string>([^<]+)<\/string>/i.exec(
      xml,
    );
  if (langMatch?.[1] !== undefined && langMatch[1].trim() !== '') {
    return langMatch[1].trim();
  }
  const localeMatch =
    /<key>\s*AppleLocale\s*<\/key>\s*<string>([^<]+)<\/string>/i.exec(xml);
  if (localeMatch?.[1] !== undefined && localeMatch[1].trim() !== '') {
    return localeMatch[1].trim();
  }
  return null;
}

/** 从 macOS `.GlobalPreferences.plist` 字节流提取首选语言标签 (支持 bplist00 与 XML) */
export function extractMacPreferredLanguage(buf: Uint8Array): string | null {
  return extractFromBinaryPlist(buf) ?? extractFromXmlPlist(buf);
}
