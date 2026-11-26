/**
 * `@iyowei/wake` 纯函数原语: MAC 地址归一化、102 字节魔术包构造、算术广播计算与输入边界校验。
 * 全程不使用位运算符, 严格遵守仓库静态规则。
 */
import { WakeError } from './errors.ts';

const BARE_HEX_RE = /^[0-9a-fA-F]{12}$/;
const TARGET_NAME_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,63}$/;
const UNSAFE_SHELL_RE = /[;&|$`<>\\()[\]{}!*?~'"\s]/;
const CTRL_RE = /\p{Cc}/u;

/** 归一化 MAC 地址为小写冒号分隔格式 (`aa:bb:cc:dd:ee:ff`) */
export function normalizeMac(raw: string): string {
  const trimmed = raw.trim();
  if (trimmed === '') {
    throw new WakeError('INVALID_MAC', 'MAC 地址不能为空');
  }
  const stripped = trimmed.replace(/[:.-]/g, '');
  if (!BARE_HEX_RE.test(stripped)) {
    throw new WakeError(
      'INVALID_MAC',
      `无效的 MAC 地址: ${trimmed} (期望 6 字节十六进制, 如 aa:bb:cc:dd:ee:ff)`,
    );
  }
  const lower = stripped.toLowerCase();
  const octets: string[] = [];
  for (let i = 0; i < 12; i += 2) {
    octets.push(lower.slice(i, i + 2));
  }
  return octets.join(':');
}

/** 批量去重并归一化 MAC 列表 (保持首次出现顺序) */
export function normalizeMacList(rawMacs: readonly string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of rawMacs) {
    const normalized = normalizeMac(item);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  if (out.length === 0) {
    throw new WakeError('INVALID_MAC', '至少需要一个有效的 MAC 地址');
  }
  return out;
}

/** 将已归一化或合法的 MAC 解析为 6 字节数值数组 */
export function macToBytes(raw: string): number[] {
  const normalized = normalizeMac(raw);
  return normalized.split(':').map((pair) => Number.parseInt(pair, 16));
}

/** 构造标准 AMD 102 字节 Wake-on-LAN 魔术包 (`6 x 0xff` + `16 x 6B MAC`) */
export function buildMagicPacket(rawMac: string): Uint8Array {
  const macBytes = macToBytes(rawMac);
  const packet = new Uint8Array(102);
  for (let i = 0; i < 6; i += 1) {
    packet[i] = 0xff;
  }
  for (let rep = 0; rep < 16; rep += 1) {
    const offset = 6 + rep * 6;
    for (let b = 0; b < 6; b += 1) {
      packet[offset + b] = macBytes[b]!;
    }
  }
  return packet;
}

/** 解析点分十进制 IPv4 为四段整数, 不合法返回 null */
export function parseIpv4Octets(
  raw: string,
): [number, number, number, number] | null {
  const trimmed = raw.trim();
  const parts = trimmed.split('.');
  if (parts.length !== 4) return null;
  const nums: number[] = [];
  for (const part of parts) {
    if (!/^\d{1,3}$/.test(part)) return null;
    if (part.length > 1 && part.startsWith('0')) return null;
    const value = Number(part);
    if (!Number.isInteger(value) || value < 0 || value > 255) return null;
    nums.push(value);
  }
  return [nums[0]!, nums[1]!, nums[2]!, nums[3]!];
}

const VALID_MASK_OCTETS = new Set<number>([
  0, 128, 192, 224, 240, 248, 252, 254, 255,
]);

/** 校验连续前缀 IPv4 子网掩码并提取每段字节 */
export function parseIpv4NetmaskOctets(
  netmask: string,
): [number, number, number, number] | null {
  const octets = parseIpv4Octets(netmask);
  if (octets === null) return null;
  let seenNonFull = false;
  for (const octet of octets) {
    if (!VALID_MASK_OCTETS.has(octet)) return null;
    if (seenNonFull && octet !== 0) return null;
    if (octet !== 255) seenNonFull = true;
  }
  return octets;
}

/** 使用算术整除计算 IPv4 定向广播地址 (不合法则返回 null) */
export function computeBroadcastIpv4(
  ip: string,
  netmask: string,
): string | null {
  const ipOctets = parseIpv4Octets(ip);
  const maskOctets = parseIpv4NetmaskOctets(netmask);
  if (ipOctets === null || maskOctets === null) return null;
  const out: number[] = [];
  for (let i = 0; i < 4; i += 1) {
    const m = maskOctets[i]!;
    const a = ipOctets[i]!;
    if (m === 255) {
      out.push(a);
    } else if (m === 0) {
      out.push(255);
    } else {
      const span = 256 - m;
      out.push(Math.floor(a / span) * span + span - 1);
    }
  }
  return out.join('.');
}

/** 判断两个 IPv4 地址在给定掩码下是否属于同一子网 */
export function sameIpv4Subnet(
  ipA: string,
  ipB: string,
  netmask: string,
): boolean {
  const a = parseIpv4Octets(ipA);
  const b = parseIpv4Octets(ipB);
  const m = parseIpv4NetmaskOctets(netmask);
  if (a === null || b === null || m === null) return false;
  for (let i = 0; i < 4; i += 1) {
    const mask = m[i]!;
    if (mask === 0) continue;
    const span = 256 - mask;
    if (Math.floor(a[i]! / span) !== Math.floor(b[i]! / span)) return false;
  }
  return true;
}

/** 校验目标名称 (字母数字开头, 允许 `._-`, 最长 64) */
export function validateTargetName(raw: string): string {
  const trimmed = raw.trim();
  if (!TARGET_NAME_RE.test(trimmed)) {
    throw new WakeError(
      'INVALID_TARGET',
      `无效的目标名称: ${raw.trim()} (仅允许字母数字开头及 . _ - 字符, 最长 64 位)`,
    );
  }
  return trimmed;
}

/** 校验安全主机名或 IP 地址 (禁止前导 `-`、空白、控制字符与 shell 元字符) */
export function validateSafeHost(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('-') ||
    trimmed.length > 253 ||
    CTRL_RE.test(trimmed) ||
    UNSAFE_SHELL_RE.test(trimmed)
  ) {
    throw new WakeError('INVALID_HOST', `非法的主机地址: ${trimmed || '(空)'}`);
  }
  return trimmed;
}

/** 校验显式广播地址 (必须为合法点分十进制 IPv4) */
export function validateBroadcastIpv4(raw: string): string {
  const trimmed = raw.trim();
  if (parseIpv4Octets(trimmed) === null) {
    throw new WakeError(
      'INVALID_BROADCAST',
      `无效的 IPv4 广播地址: ${trimmed}`,
    );
  }
  return trimmed;
}

/** 校验安全 SSH 中继名称或 host (`user@host` / SSH alias / IP) */
export function validateSafeRelay(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed === '' ||
    trimmed.startsWith('-') ||
    trimmed.length > 255 ||
    CTRL_RE.test(trimmed) ||
    UNSAFE_SHELL_RE.test(trimmed) ||
    !/^[a-zA-Z0-9._:@-]+$/.test(trimmed)
  ) {
    throw new WakeError(
      'INVALID_RELAY',
      `非法的 SSH 中继标识: ${trimmed || '(空)'}`,
    );
  }
  return trimmed;
}

/** 校验 TCP 探测端口号 (`1..65535`) */
export function validatePort(raw: unknown, fallback = 22): number {
  if (raw === undefined) return fallback;
  const num = typeof raw === 'number' ? raw : Number(String(raw).trim());
  if (!Number.isInteger(num) || num < 1 || num > 65535) {
    throw new WakeError(
      'INVALID_PORT',
      `无效的端口号: ${String(raw)} (期望 1-65535 整数)`,
    );
  }
  return num;
}
