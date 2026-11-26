/**
 * `@iyowei/wake` 内部 SSH 中继发包与健康探测模块 (严禁由 package root 公开暴露)。
 *
 * 安全契约:
 * 1. 所有经 SSH 传向远端 shell 拼接的参数必须严格通过 `SAFE_REMOTE_TOKEN_RE` 校验;
 * 2. 一律使用 `execFile('ssh', ..., { shell: false })` + `--` 分隔符, 杜绝本地与远端命令注入;
 * 3. `BatchMode=yes` 保证无人值守或离线场景快速故障转移, 绝不挂起等待密码输入。
 */
import { execFile } from 'node:child_process';

import { sanitizeLine } from './display.ts';
import {
  normalizeMacList,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from './magic.ts';
import type { WakeDoctorRelayResult } from './types.ts';

const SAFE_REMOTE_TOKEN_RE = /^[a-zA-Z0-9._:@-]+$/;

function assertSafeRemoteToken(token: string, context: string): string {
  if (!SAFE_REMOTE_TOKEN_RE.test(token)) {
    throw new Error(`拒绝不安全的远程 SSH 参数 (${context}): ${token}`);
  }
  return token;
}

/** 构造发往中继节点上 `wake` 的安全命令行参数列表 */
export function buildRemoteWakeArgs(options: {
  targetName?: string;
  macs?: readonly string[];
  host?: string;
  port?: number;
  broadcast?: readonly string[];
}): string[] {
  const args: string[] = ['wake'];

  if (options.macs !== undefined && options.macs.length > 0) {
    const cleanMacs = normalizeMacList(options.macs);
    for (const mac of cleanMacs) {
      args.push('--mac', assertSafeRemoteToken(mac, 'mac'));
    }
    if (options.host !== undefined) {
      args.push(
        '--host',
        assertSafeRemoteToken(validateSafeHost(options.host), 'host'),
      );
    }
    if (options.port !== undefined) {
      args.push('--port', String(validatePort(options.port)));
    }
    for (const bcast of options.broadcast ?? []) {
      args.push(
        '--broadcast',
        assertSafeRemoteToken(validateBroadcastIpv4(bcast), 'broadcast'),
      );
    }
  } else if (options.targetName !== undefined) {
    args.push(
      assertSafeRemoteToken(validateTargetName(options.targetName), 'target'),
    );
  } else {
    throw new Error('中继调用缺少目标名或 MAC 地址');
  }

  args.push('--local-only', '--no-wait', '--force', '--json');
  return args;
}

interface ExecResult {
  code: number;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

function runSshExec(
  relay: string,
  remoteArgs: readonly string[],
  timeoutMs: number,
): Promise<ExecResult> {
  const safeRelay = validateSafeRelay(relay);
  const safeArgs = remoteArgs.map((arg) =>
    assertSafeRemoteToken(arg, 'remoteArg'),
  );
  const connectSec = Math.max(2, Math.min(15, Math.ceil(timeoutMs / 1000)));
  const sshArgs = [
    '-o',
    'BatchMode=yes',
    '-o',
    `ConnectTimeout=${String(connectSec)}`,
    '-o',
    'ServerAliveInterval=3',
    '-o',
    'ServerAliveCountMax=2',
    '--',
    safeRelay,
    ...safeArgs,
  ];

  return new Promise((resolve) => {
    execFile(
      'ssh',
      sshArgs,
      {
        encoding: 'utf8',
        timeout: timeoutMs,
        windowsHide: true,
        env: { ...process.env, LC_ALL: 'C', LANG: 'C' },
      },
      (error, stdout, stderr) => {
        if (error === null) {
          resolve({
            code: 0,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            timedOut: false,
          });
          return;
        }
        const errObj = error as NodeJS.ErrnoException & {
          killed?: boolean;
          code?: number | string;
        };
        const numericCode = typeof errObj.code === 'number' ? errObj.code : 1;
        resolve({
          code: numericCode,
          stdout: stdout ?? '',
          stderr: stderr ?? errObj.message ?? '',
          timedOut: errObj.killed === true,
        });
      },
    );
  });
}

function extractRelayReason(res: ExecResult): string {
  if (res.timedOut) return 'SSH 中继响应超时';
  const cleaned = sanitizeLine(res.stderr || res.stdout);
  if (cleaned !== '') return cleaned;
  return `SSH 退出码 ${String(res.code)}`;
}

/** 通过指定 SSH 中继执行一次无等待的本地 WoL 唤醒 */
export async function runSshRelayWake(options: {
  relay: string;
  remoteArgs: readonly string[];
  timeoutMs: number;
}): Promise<{
  ok: boolean;
  packetsSent?: number;
  destinations?: string[];
  reason?: string;
}> {
  const res = await runSshExec(
    options.relay,
    options.remoteArgs,
    options.timeoutMs,
  );
  if (res.code !== 0) {
    return { ok: false, reason: extractRelayReason(res) };
  }

  try {
    const parsed = JSON.parse(res.stdout) as {
      packetsSent?: unknown;
      destinations?: unknown;
    };
    const packetsSent =
      typeof parsed.packetsSent === 'number' ? parsed.packetsSent : 1;
    const destinations = Array.isArray(parsed.destinations)
      ? parsed.destinations.filter((d): d is string => typeof d === 'string')
      : [];
    return {
      ok: true,
      packetsSent,
      destinations,
    };
  } catch {
    return {
      ok: true,
      packetsSent: 1,
      destinations: [],
    };
  }
}

/** 探测单个 SSH 中继的连通性与远端 `wake` CLI 安装状态 */
export async function probeSshRelay(options: {
  relay: string;
  timeoutMs: number;
}): Promise<WakeDoctorRelayResult> {
  const res = await runSshExec(
    options.relay,
    ['wake', '-V'],
    options.timeoutMs,
  );
  if (res.code === 0) {
    const ver = sanitizeLine(res.stdout);
    return {
      relay: options.relay,
      reachable: true,
      remoteWakeAvailable: ver !== '',
      ...(ver !== '' ? { remoteWakeVersion: ver } : {}),
    };
  }
  const reason = extractRelayReason(res);
  const sshReachable = res.code !== 255 && !res.timedOut;
  return {
    relay: options.relay,
    reachable: sshReachable,
    remoteWakeAvailable: false,
    reason,
  };
}
