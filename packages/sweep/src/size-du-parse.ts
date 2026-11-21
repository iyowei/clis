/**
 * 内部模块 (`size-du.ts` 专用): 负责 `du -sk` 的 stdout 集合一致性判定与 stderr 失败归因解析。
 * 兼容 BSD (`du: <路径>: <原因>`) 与 GNU (`du: cannot access '<路径>': <原因>` / `LC_ALL=C` 下的 `$'\ooo'` 八进制 UTF-8 拼接串);
 * stdout 校验若检出重复路径或输入外路径即标记 `intact: false`, 供上游整批 fail-safe 拒信。
 * 红线: 不属于公开 API 面 (已在 tsconfig.build.json 与 scripts/build.ts 中排除出发行 .d.ts)。
 */
import type { UnmeasuredCode } from './codes.ts';

/**
 * 剥 stderr 行首的程序名前缀: 形态随实现与版本而异 (`du:` / `gdu:` /
 * 完整路径形态 `/usr/bin/du:`, Ubuntu coreutils 实测带路径, macOS coreutils 9.12 剥路径为裸名)。
 * 路径部分限定无空白无冒号, 防误伤含冒号的路径本体。
 */
export const PROG_PREFIX_RE = /^(?:\/[^\s:]*)?[a-z][a-z0-9_-]*:\s+/;

/** du 单路径失败的归因 (判别联合: missing 项进 gone 桶, 其余带未测到码) */
export type DuFailure =
  | { missing: true; reason: string }
  | { missing: false; code: UnmeasuredCode; reason: string };

/** 把 du 的英文错误短语转成中文人话原因与未测到码; 未知短语保留原文便于诊断 (已剥离 `du:` 前缀) */
export function describeDuFailure(detail: string): DuFailure {
  if (/no such file or directory/i.test(detail))
    return { missing: true, reason: '不存在' };
  if (/permission denied/i.test(detail))
    return {
      missing: false,
      code: 'SIZE_UNMEASURED_PERMISSION',
      reason: '权限不足, 无法读取',
    };
  if (/not a directory/i.test(detail))
    return {
      missing: false,
      code: 'SIZE_UNMEASURED_NOT_DIR',
      reason: '不是目录',
    };
  if (/too many levels of symbolic links/i.test(detail)) {
    return {
      missing: false,
      code: 'SIZE_UNMEASURED_LOOP',
      reason: '符号链接层级过深',
    };
  }
  return {
    missing: false,
    code: 'SIZE_UNMEASURED_OTHER',
    reason: `读取失败 (${detail})`,
  };
}

/** ANSI-C `$'...'` 常见单字符转义字节映射 */
const ANSI_C_ESCAPES: Record<string, number> = {
  '\\': 0x5c,
  "'": 0x27,
  '"': 0x22,
  a: 0x07,
  b: 0x08,
  f: 0x0c,
  n: 0x0a,
  r: 0x0d,
  t: 0x09,
  v: 0x0b,
  e: 0x1b,
  E: 0x1b,
};

/** 将字符串按 UTF-8 字节推入字节数组 */
function pushUtf8(bytes: number[], text: string): void {
  for (const byte of Buffer.from(text, 'utf8')) bytes.push(byte);
}

/** 解码 `$'...'` 中反斜杠后的单条转义序列, 返回消耗后的下一字符下标 */
function decodeAnsiCEscape(
  raw: string,
  index: number,
  bytes: number[],
): number {
  const ch = raw[index];
  if (ch === undefined) return index;
  const mapped = ANSI_C_ESCAPES[ch];
  if (mapped !== undefined) {
    bytes.push(mapped);
    return index + 1;
  }
  const oct = /^[0-7]{1,3}/.exec(raw.slice(index));
  if (oct !== null) {
    bytes.push(Number.parseInt(oct[0], 8) % 256);
    return index + oct[0].length;
  }
  if (ch === 'x') {
    const hex = /^[0-9a-fA-F]{1,2}/.exec(raw.slice(index + 1));
    if (hex !== null) {
      bytes.push(Number.parseInt(hex[0], 16));
      return index + 1 + hex[0].length;
    }
  }
  pushUtf8(bytes, ch);
  return index + 1;
}

/** 解码一段 `$'...'`, 返回闭合后下一字符下标; 未闭合返回 -1 */
function consumeAnsiCSegment(
  raw: string,
  start: number,
  bytes: number[],
): number {
  let index = start;
  while (index < raw.length) {
    const inner = raw[index];
    if (inner === "'") return index + 1;
    if (inner === '\\') {
      index = decodeAnsiCEscape(raw, index + 1, bytes);
      continue;
    }
    pushUtf8(bytes, inner ?? '');
    index += 1;
  }
  return -1;
}

/** 解码一段双引号 `"..."`, 返回闭合后下一字符下标; 未闭合返回 -1 */
function consumeDoubleQuoted(
  raw: string,
  start: number,
  bytes: number[],
): number {
  let index = start;
  while (index < raw.length) {
    const inner = raw[index];
    if (inner === '"') return index + 1;
    if (
      inner === '\\' &&
      index + 1 < raw.length &&
      '"\\$`'.includes(raw[index + 1] ?? '')
    ) {
      pushUtf8(bytes, raw[index + 1] ?? '');
      index += 2;
      continue;
    }
    pushUtf8(bytes, inner ?? '');
    index += 1;
  }
  return -1;
}

/**
 * 还原 GNU coreutils `shell-escape` 引用形态的路径 (如 `'...'`、`"$..."`、`'\''`、
 * `'/ws/'$'\344\270\255''/node_modules'`): 在原始字节层拼齐后按 UTF-8 解码,
 * 使 `LC_ALL=C` 下的中文与特殊字符路径准确还原为原始路径; 遇未闭合畸形串安全回退原文。
 */
export function unescapeGnuShellQuoted(raw: string): string {
  const bytes: number[] = [];
  let index = 0;
  while (index < raw.length) {
    const ch = raw[index];
    if (ch === '$' && raw[index + 1] === "'") {
      index = consumeAnsiCSegment(raw, index + 2, bytes);
      if (index === -1) return raw;
      continue;
    }
    if (ch === "'") {
      const end = raw.indexOf("'", index + 1);
      if (end === -1) return raw;
      pushUtf8(bytes, raw.slice(index + 1, end));
      index = end + 1;
      continue;
    }
    if (ch === '"') {
      index = consumeDoubleQuoted(raw, index + 1, bytes);
      if (index === -1) return raw;
      continue;
    }
    if (ch === '\\' && index + 1 < raw.length) {
      pushUtf8(bytes, raw[index + 1] ?? '');
      index += 2;
      continue;
    }
    pushUtf8(bytes, ch ?? '');
    index += 1;
  }
  return Buffer.from(bytes).toString('utf8');
}

/**
 * 解析 du stderr 行; 兼容 BSD 与 GNU 两发行形态 (含 `LC_ALL=C` 下的 `shell-escape` 拼接串)。
 * 无法解析时返回 null。
 */
export function parseDuErrorLine(
  line: string,
): { path: string; detail: string } | null {
  const body = line.replace(PROG_PREFIX_RE, '');
  const gnu =
    /^cannot\s+(?:access|read directory|stat|open)\s+(.+):\s+(.+)$/.exec(body);
  if (gnu !== null) {
    const rawPath = gnu[1];
    const detail = gnu[2];
    if (rawPath !== undefined && detail !== undefined) {
      const path =
        rawPath.startsWith("'") ||
        rawPath.startsWith('"') ||
        rawPath.startsWith("$'")
          ? unescapeGnuShellQuoted(rawPath)
          : rawPath;
      return { path, detail };
    }
  }
  const match = /^(.+):\s+(.+)$/.exec(body);
  if (match === null) return null;
  const path = match[1];
  const detail = match[2];
  if (path === undefined || detail === undefined) return null;
  return { path, detail };
}

/** 校验整段是否为非空纯十进制数字 (零正则开销) */
function isAsciiDigits(text: string): boolean {
  if (text.length === 0) return false;
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code < 48 || code > 57) return false;
  }
  return true;
}

/** 解析 `du -sk` 输出: 每行 `<KiB>\t<绝对路径>`; duplicated 标记同一路径多行 */
export function parseDuSizes(stdout: string): {
  sizes: Map<string, number>;
  duplicated: boolean;
} {
  const sizes = new Map<string, number>();
  let duplicated = false;
  let start = 0;
  const len = stdout.length;
  while (start < len) {
    let end = stdout.indexOf('\n', start);
    if (end === -1) end = len;
    const tab = stdout.indexOf('\t', start);
    if (tab > start && tab < end - 1) {
      const numPart = stdout.slice(start, tab);
      if (isAsciiDigits(numPart)) {
        const path = stdout.slice(tab + 1, end);
        if (sizes.has(path)) duplicated = true;
        sizes.set(path, Number(numPart) * 1024);
      }
    }
    start = end + 1;
  }
  return { sizes, duplicated };
}

/** stdout 与输入集合的一致性判定结果 (解析与判定合一, 供单测注入样本验证) */
export interface DuOutputAssessment {
  sizes: Map<string, number>;
  intact: boolean;
  duplicated: boolean;
  unexpected: boolean;
}

/** 解析 du 的 stdout 并判定与输入集合的一致性 (任一不符即整批 fail-safe 不可信) */
export function assessDuOutput(
  stdout: string,
  safeTargets: readonly string[],
  safeSet: ReadonlySet<string> = new Set(safeTargets),
): DuOutputAssessment {
  const parsed = parseDuSizes(stdout);
  let unexpected = false;
  for (const path of parsed.sizes.keys()) {
    if (!safeSet.has(path)) unexpected = true;
  }
  const intact =
    !parsed.duplicated &&
    parsed.sizes.size <= safeTargets.length &&
    !unexpected;
  return {
    sizes: parsed.sizes,
    intact,
    duplicated: parsed.duplicated,
    unexpected,
  };
}

/** 一致性判定失败的形态归类 (人话短语; 只述形态, 不含路径) */
export function describeDuAnomaly(assessment: DuOutputAssessment): string {
  const shapes: string[] = [];
  if (assessment.duplicated) shapes.push('同一路径多行');
  if (assessment.unexpected) shapes.push('含输入之外的路径');
  if (shapes.length === 0) shapes.push('行数与输入不符');
  return shapes.join(' / ');
}
