/**
 * `@iyowei/wake` 原生网络原语: 本机 IPv4 网卡过滤、定向 UDP 魔术包广播、TCP 就绪探测与 ARP 邻接发现。
 * 全程零第三方依赖、零 shell 字符串拼接。
 */
import { execFile } from 'node:child_process';
import { createSocket } from 'node:dgram';
import { createConnection } from 'node:net';
import { networkInterfaces } from 'node:os';

import { WakeError } from './errors.ts';
import {
  buildMagicPacket,
  computeBroadcastIpv4,
  normalizeMac,
  parseIpv4Octets,
  sameIpv4Subnet,
} from './magic.ts';
import type {
  ArpNeighborEntry,
  LocalLanInterface,
  TcpProbeResult,
  UdpBurstResult,
} from './types.ts';

const VIRTUAL_IFACE_PREFIXES = [
  'utun',
  'tun',
  'tap',
  'wg',
  'tailscale',
  'zt',
  'docker',
  'br-',
  'veth',
  'vmnet',
  'vboxnet',
  'virbr',
  'lo',
  'gif',
  'stf',
  'llw',
  'awdl',
  'meta',
];

const BROADCAST_PORTS = [9, 7] as const;

function isLikelyVirtualInterface(name: string): boolean {
  const lower = name.toLowerCase();
  return VIRTUAL_IFACE_PREFIXES.some((prefix) => lower.startsWith(prefix));
}

/** 枚举本机外向 IPv4 网卡并标注虚拟/隧道接口 (优先真实物理局域网 NIC) */
export function listLocalLanInterfaces(
  readInterfaces: typeof networkInterfaces = networkInterfaces,
): LocalLanInterface[] {
  const all = readInterfaces();
  const out: LocalLanInterface[] = [];
  for (const [ifaceName, addrs] of Object.entries(all)) {
    if (!Array.isArray(addrs)) continue;
    for (const info of addrs) {
      if (info.family !== 'IPv4' || info.internal) continue;
      if (parseIpv4Octets(info.address) === null) continue;
      const broadcast =
        computeBroadcastIpv4(info.address, info.netmask) ?? '255.255.255.255';
      out.push({
        name: ifaceName,
        address: info.address,
        netmask: info.netmask,
        broadcast,
        isVirtual: isLikelyVirtualInterface(ifaceName),
      });
    }
  }
  return out.sort((a, b) => {
    if (a.isVirtual !== b.isVirtual) return a.isVirtual ? 1 : -1;
    return a.name.localeCompare(b.name);
  });
}

/** 为本机发包计算最佳目的广播列表与绑定源 IPv4 (避免 WireGuard 等虚拟网卡抢占广播路由) */
export function resolveBroadcastTargets(options: {
  host?: string;
  explicitBroadcasts?: readonly string[];
  interfaces: readonly LocalLanInterface[];
}): {
  destinations: string[];
  sourceAddresses: string[];
  matchedSubnet: boolean;
} {
  const lanIfaces = options.interfaces.filter((nic) => !nic.isVirtual);
  const candidateIfaces =
    lanIfaces.length > 0 ? lanIfaces : [...options.interfaces];

  const hostIsIpv4 =
    options.host !== undefined && parseIpv4Octets(options.host) !== null;
  const sameSubnetIfaces = hostIsIpv4
    ? candidateIfaces.filter((nic) =>
        sameIpv4Subnet(nic.address, options.host!, nic.netmask),
      )
    : [];

  const matchedSubnet = sameSubnetIfaces.length > 0;
  const activeIfaces = matchedSubnet ? sameSubnetIfaces : candidateIfaces;

  const destinations: string[] = [];
  const seenDest = new Set<string>();
  const addDest = (ip: string | undefined): void => {
    if (ip === undefined || parseIpv4Octets(ip) === null) return;
    if (!seenDest.has(ip)) {
      seenDest.add(ip);
      destinations.push(ip);
    }
  };

  for (const explicit of options.explicitBroadcasts ?? []) {
    addDest(explicit);
  }
  for (const nic of activeIfaces) {
    addDest(nic.broadcast);
  }
  if (hostIsIpv4) {
    addDest(options.host);
  }
  addDest('255.255.255.255');

  const sourceAddresses: string[] = [];
  const seenSrc = new Set<string>();
  for (const nic of activeIfaces) {
    if (!seenSrc.has(nic.address)) {
      seenSrc.add(nic.address);
      sourceAddresses.push(nic.address);
    }
  }

  return { destinations, sourceAddresses, matchedSubnet };
}

function sendPacketAsync(
  socket: ReturnType<typeof createSocket>,
  packet: Uint8Array,
  port: number,
  address: string,
): Promise<void> {
  return new Promise((resolve, reject) => {
    socket.send(packet, 0, packet.byteLength, port, address, (error) => {
      if (error !== null && error !== undefined) reject(error);
      else resolve();
    });
  });
}

async function trySendSinglePacket(
  socket: ReturnType<typeof createSocket>,
  packet: Uint8Array,
  port: number,
  dest: string,
  sourceAddress: string | undefined,
  warnings: string[],
): Promise<boolean> {
  try {
    await sendPacketAsync(socket, packet, port, dest);
    return true;
  } catch (error) {
    warnings.push(
      `${sourceAddress ?? 'default'} -> ${dest}:${String(port)}: ${(error as Error).message}`,
    );
    return false;
  }
}

async function sendOneRound(
  socket: ReturnType<typeof createSocket>,
  packets: readonly Uint8Array[],
  destinations: readonly string[],
  sourceAddress: string | undefined,
  warnings: string[],
): Promise<number> {
  const tasks: Array<readonly [Uint8Array, string, number]> = [];
  for (const packet of packets) {
    for (const dest of destinations) {
      for (const port of BROADCAST_PORTS) {
        tasks.push([packet, dest, port]);
      }
    }
  }
  let sent = 0;
  for (const [packet, dest, port] of tasks) {
    const ok = await trySendSinglePacket(
      socket,
      packet,
      port,
      dest,
      sourceAddress,
      warnings,
    );
    if (ok) sent += 1;
  }
  return sent;
}

async function sendBoundBurst(
  packets: readonly Uint8Array[],
  destinations: readonly string[],
  sourceAddress: string | undefined,
  repeatPerDestination: number,
): Promise<{ sent: number; warnings: string[] }> {
  const socket = createSocket({ type: 'udp4', reuseAddr: true });
  const warnings: string[] = [];
  let sent = 0;

  try {
    await new Promise<void>((resolve, reject) => {
      socket.once('error', reject);
      socket.bind(0, sourceAddress, () => {
        socket.removeListener('error', reject);
        resolve();
      });
    });
    socket.setBroadcast(true);

    for (let r = 0; r < repeatPerDestination; r += 1) {
      sent += await sendOneRound(
        socket,
        packets,
        destinations,
        sourceAddress,
        warnings,
      );
    }
  } finally {
    try {
      socket.close();
    } catch {
      // 忽略关闭竞争异常
    }
  }

  return { sent, warnings };
}

/** 经由本机 UDP socket 发送多轮 WoL 魔术包突刺 */
export async function sendUdpMagicBurst(options: {
  macs: readonly string[];
  destinations: readonly string[];
  sourceAddresses: readonly string[];
  repeatPerDestination: number;
  rounds: number;
  roundIntervalMs: number;
}): Promise<UdpBurstResult> {
  if (options.destinations.length === 0) {
    throw new WakeError('NETWORK_FAILED', '未找到可用的 IPv4 广播目的地址');
  }
  const packets = options.macs.map((mac) => buildMagicPacket(mac));
  const sources: Array<string | undefined> =
    options.sourceAddresses.length > 0
      ? [...options.sourceAddresses]
      : [undefined];

  let totalSent = 0;
  const warnings: string[] = [];

  for (let round = 0; round < options.rounds; round += 1) {
    for (const src of sources) {
      const outcome = await sendBoundBurst(
        packets,
        options.destinations,
        src,
        options.repeatPerDestination,
      );
      totalSent += outcome.sent;
      warnings.push(...outcome.warnings);
    }
    if (round + 1 < options.rounds && options.roundIntervalMs > 0) {
      await new Promise<void>((resolve) =>
        setTimeout(resolve, options.roundIntervalMs),
      );
    }
  }

  if (totalSent === 0) {
    throw new WakeError(
      'NETWORK_FAILED',
      `UDP 魔术包发送全部失败 (${warnings[0] ?? '未知套接字错误'})`,
    );
  }

  return {
    packetsSent: totalSent,
    destinations: [...options.destinations],
    sourceAddresses: [...options.sourceAddresses],
    warnings,
  };
}

/** 轻量级 TCP 握手探测目标端口是否已上线 (零 timer 泄漏) */
export function probeTcpPort(
  host: string,
  port: number,
  timeoutMs = 1_200,
): Promise<TcpProbeResult> {
  const start = Date.now();
  return new Promise((resolve) => {
    let settled = false;
    const socket = createConnection({ host, port });

    const finish = (reachable: boolean, reason?: string): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.removeAllListeners();
      try {
        socket.destroy();
      } catch {
        // 清理连接尽力而为
      }
      resolve({
        reachable,
        latencyMs: Math.max(0, Date.now() - start),
        ...(reason !== undefined ? { reason } : {}),
      });
    };

    const timer = setTimeout(
      () => {
        finish(false, `timeout after ${String(timeoutMs)}ms`);
      },
      Math.max(200, timeoutMs),
    );

    socket.once('connect', () => finish(true));
    socket.once('error', (error: NodeJS.ErrnoException) => {
      finish(false, error.code ?? error.message);
    });
  });
}

function execNoShell(
  cmd: string,
  args: readonly string[],
  timeoutMs: number,
): Promise<{ ok: boolean; stdout: string }> {
  return new Promise((resolve) => {
    execFile(
      cmd,
      [...args],
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (error, stdout) => {
        if (error !== null) {
          resolve({ ok: false, stdout: '' });
          return;
        }
        resolve({ ok: true, stdout: stdout ?? '' });
      },
    );
  });
}

function isUsefulNeighborMac(mac: string): boolean {
  if (mac === '00:00:00:00:00:00' || mac === 'ff:ff:ff:ff:ff:ff') {
    return false;
  }
  if (mac.startsWith('01:00:5e:') || mac.startsWith('33:33:')) return false;
  return true;
}

/** 解析 `ip -4 neigh show` 与 `arp -an` 输出 (纯确定性解析, 供 `wake init` 自动建议目标) */
export function parseArpTableOutput(raw: string): ArpNeighborEntry[] {
  const entries: ArpNeighborEntry[] = [];
  const seen = new Set<string>();

  for (const line of raw.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;

    // Linux `ip -4 neigh show`: 192.0.2.10 dev eth0 lladdr 00:11:22:33:44:55 REACHABLE
    const ipNeighMatch =
      /^(\d{1,3}(?:\.\d{1,3}){3})\s+dev\s+(\S+)\s+lladdr\s+([0-9a-fA-F:.-]+)(?:\s+(\S+))?/.exec(
        trimmed,
      );
    if (ipNeighMatch !== null) {
      const ip = ipNeighMatch[1]!;
      const iface = ipNeighMatch[2]!;
      const rawMac = ipNeighMatch[3]!;
      const state = ipNeighMatch[4];
      if (parseIpv4Octets(ip) === null) continue;
      try {
        const mac = normalizeMac(rawMac);
        if (!isUsefulNeighborMac(mac)) continue;
        const key = `${ip}|${mac}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({
          ip,
          mac,
          iface,
          ...(state !== undefined ? { state } : {}),
        });
      } catch {
        // 忽略格式异常的 MAC 行
      }
      continue;
    }

    // macOS / BSD `arp -an`: ? (192.0.2.10) at 00:11:22:33:44:55 on en0 ifscope [ethernet]
    const bsdArpMatch =
      /\((\d{1,3}(?:\.\d{1,3}){3})\)\s+at\s+([0-9a-fA-F:.-]+)\s+on\s+(\S+)/.exec(
        trimmed,
      );
    if (bsdArpMatch !== null) {
      const ip = bsdArpMatch[1]!;
      const rawMac = bsdArpMatch[2]!;
      const iface = bsdArpMatch[3]!;
      if (parseIpv4Octets(ip) === null) continue;
      try {
        const mac = normalizeMac(rawMac);
        if (!isUsefulNeighborMac(mac)) continue;
        const key = `${ip}|${mac}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ip, mac, iface });
      } catch {
        // 忽略 `(incomplete)` 等非 6 字节项
      }
      continue;
    }

    // Windows `arp -a`:  192.0.2.10   00-11-22-33-44-55   dynamic
    const winArpMatch =
      /^(\d{1,3}(?:\.\d{1,3}){3})\s+([0-9a-fA-F-]{17})\s+(\S+)/.exec(trimmed);
    if (winArpMatch !== null) {
      const ip = winArpMatch[1]!;
      const rawMac = winArpMatch[2]!;
      const state = winArpMatch[3]!;
      if (parseIpv4Octets(ip) === null) continue;
      try {
        const mac = normalizeMac(rawMac);
        if (!isUsefulNeighborMac(mac)) continue;
        const key = `${ip}|${mac}`;
        if (seen.has(key)) continue;
        seen.add(key);
        entries.push({ ip, mac, state });
      } catch {
        // 忽略异常条目
      }
    }
  }

  return entries;
}

/** 读取本机 ARP 邻接表发现近期通信过的局域网主机 */
export async function discoverArpNeighbors(
  options: { platform?: NodeJS.Platform; timeoutMs?: number } = {},
): Promise<ArpNeighborEntry[]> {
  const platform = options.platform ?? process.platform;
  const timeoutMs = options.timeoutMs ?? 2_500;

  if (platform === 'linux') {
    const ipRes = await execNoShell('ip', ['-4', 'neigh', 'show'], timeoutMs);
    if (ipRes.ok && ipRes.stdout.trim() !== '') {
      return parseArpTableOutput(ipRes.stdout);
    }
  }

  const arpArgs = platform === 'win32' ? ['-a'] : ['-an'];
  const arpRes = await execNoShell('arp', arpArgs, timeoutMs);
  if (arpRes.ok && arpRes.stdout.trim() !== '') {
    return parseArpTableOutput(arpRes.stdout);
  }
  return [];
}
