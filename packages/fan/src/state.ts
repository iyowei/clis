/**
 * 持久化预设状态读写 (`state.json` v1):
 * 支持安全无符号链接写盘、跨风扇条目合并, 并在非 root 用户调用时通过 `/usr/bin/sudo /usr/bin/python3`
 * 以 `0755`/`0644` 权限写入系统目录, 使普通用户与开机 `LaunchDaemon` 共享同一份状态源。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { FanError } from './errors.ts';
import { MACOS_PYTHON3_BIN, MACOS_SUDO_BIN } from './smc-apple.ts';
import type {
  FanPersistedState,
  FanStateStore,
  PersistedFanEntry,
} from './types.ts';

export const DEFAULT_FAN_DIR = '/Library/Application Support/iyowei-fan';
export const DEFAULT_FAN_STATE_PATH = `${DEFAULT_FAN_DIR}/state.json`;

function isValidEntry(value: unknown): value is PersistedFanEntry {
  if (value === null || typeof value !== 'object') return false;
  const record = value as Record<string, unknown>;
  if (record.mode === 'auto') return true;
  if (record.mode !== 'manual') return false;
  const kind = record.kind;
  const num = record.value;
  if (typeof num !== 'number' || !Number.isFinite(num)) return false;
  if (kind === 'percent') return num >= 0 && num <= 100;
  if (kind === 'rpm') return num > 0;
  return false;
}

/** 从磁盘读取并校验 `state.json` v1; 不存在返回 `null`, 损坏或遇符号链接抛 `STATE_CORRUPT` */
export function readPersistedState(
  statePath: string,
): FanPersistedState | null {
  if (!existsSync(statePath)) return null;
  if (lstatSync(statePath).isSymbolicLink()) {
    throw new FanError(
      'STATE_CORRUPT',
      `持久化状态路径不得为符号链接: ${statePath}`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(statePath, 'utf8'));
  } catch (error) {
    throw new FanError(
      'STATE_CORRUPT',
      `持久化状态文件损坏 (非合法 JSON): ${statePath}`,
      { cause: error },
    );
  }
  if (parsed === null || typeof parsed !== 'object') {
    throw new FanError('STATE_CORRUPT', `持久化状态格式异常: ${statePath}`);
  }
  const obj = parsed as Record<string, unknown>;
  if (
    obj.version !== 1 ||
    obj.fans === null ||
    typeof obj.fans !== 'object' ||
    Array.isArray(obj.fans)
  ) {
    throw new FanError(
      'STATE_CORRUPT',
      `持久化状态版本或字段不合法: ${statePath}`,
    );
  }
  const cleanFans: Record<string, PersistedFanEntry> = Object.create(
    null,
  ) as Record<string, PersistedFanEntry>;
  for (const [k, v] of Object.entries(obj.fans as Record<string, unknown>)) {
    if (!/^(?:0|[1-9]\d*)$/.test(k) || !isValidEntry(v)) {
      throw new FanError(
        'STATE_CORRUPT',
        `持久化状态中风扇 ${k} 条目不合法: ${statePath}`,
      );
    }
    cleanFans[k] = v;
  }
  return {
    version: 1,
    updatedAt: typeof obj.updatedAt === 'string' ? obj.updatedAt : '',
    fans: { ...cleanFans },
  };
}

/** 纯函数合并单次变更到现有持久化状态 */
export function mergePersistedState(
  existing: FanPersistedState | null,
  updates: Readonly<Record<string, PersistedFanEntry>>,
  updatedAt = new Date().toISOString(),
): FanPersistedState {
  const nextFans: Record<string, PersistedFanEntry> = {
    ...existing?.fans,
  };
  for (const [k, v] of Object.entries(updates)) {
    nextFans[k] = v;
  }
  return {
    version: 1,
    updatedAt,
    fans: nextFans,
  };
}

function assertNoSymlinkPath(statePath: string): void {
  const parent = dirname(statePath);
  if (existsSync(parent) && lstatSync(parent).isSymbolicLink()) {
    throw new FanError('STATE_CORRUPT', `持久化目录不得为符号链接: ${parent}`);
  }
  if (existsSync(statePath) && lstatSync(statePath).isSymbolicLink()) {
    throw new FanError(
      'STATE_CORRUPT',
      `持久化状态文件不得为符号链接: ${statePath}`,
    );
  }
}

const PRIVILEGED_WRITE_PY = `
import os, sys
path = sys.argv[1]
content = sys.argv[2]
parent = os.path.dirname(path)
if os.path.islink(parent) or os.path.islink(path):
    sys.stderr.write(f"Refusing symlink path: {path}\\n")
    sys.exit(1)
os.makedirs(parent, mode=0o755, exist_ok=True)
if hasattr(os, "geteuid") and os.geteuid() == 0:
    os.chown(parent, 0, 0)
os.chmod(parent, 0o755)
tmp = f"{path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(content)
if hasattr(os, "geteuid") and os.geteuid() == 0:
    os.chown(tmp, 0, 0)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
`;

function nearestExistingAncestor(
  targetDir: string,
  existsFn: (path: string) => boolean,
): string | null {
  let cur = targetDir;
  while (!existsFn(cur)) {
    const up = dirname(cur);
    if (up === cur) return null;
    cur = up;
  }
  return cur;
}

function canWriteDirectly(
  statePath: string,
  geteuid: () => number,
  existsFn: (path: string) => boolean,
): boolean {
  if (geteuid() === 0) return true;
  const probeDir = nearestExistingAncestor(dirname(statePath), existsFn);
  if (probeDir === null) return false;
  const probe = join(
    probeDir,
    `.write-probe-${String(process.pid)}-${String(Date.now())}`,
  );
  try {
    writeFileSync(probe, '');
    renameSync(probe, probe);
    return true;
  } catch {
    return false;
  } finally {
    rmSync(probe, { force: true });
  }
}

export interface MacOsStateStoreDeps {
  statePath?: string;
  platform?: NodeJS.Platform;
  python3Bin?: string;
  sudoBin?: string;
  env?: Record<string, string | undefined>;
  geteuid?: () => number;
  exists?: (path: string) => boolean;
  spawnSyncFn?: typeof spawnSync;
  writeTimeoutMs?: number;
}

/** 创建默认 macOS 状态存储 (读免提权; 写目录受 root 保护时自动经 `/usr/bin/sudo` 原子落盘) */
export function createMacOsFanStateStore(
  deps: MacOsStateStoreDeps = {},
): FanStateStore {
  const env = deps.env ?? process.env;
  const rawEnvPath = env.FAN_STATE_PATH?.trim();
  const statePath =
    deps.statePath ??
    (rawEnvPath !== undefined && rawEnvPath !== ''
      ? rawEnvPath
      : DEFAULT_FAN_STATE_PATH);
  const platform = deps.platform ?? process.platform;
  const python3Bin = deps.python3Bin ?? MACOS_PYTHON3_BIN;
  const sudoBin = deps.sudoBin ?? MACOS_SUDO_BIN;
  const geteuid =
    deps.geteuid ??
    (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1));
  const existsFn = deps.exists ?? existsSync;
  const spawnSyncFn = deps.spawnSyncFn ?? spawnSync;
  const writeTimeoutMs = deps.writeTimeoutMs ?? 30_000;

  return {
    path: statePath,
    read(): FanPersistedState | null {
      return readPersistedState(statePath);
    },
    write(state: FanPersistedState): void {
      assertNoSymlinkPath(statePath);
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (
        canWriteDirectly(statePath, geteuid, existsFn) ||
        platform !== 'darwin'
      ) {
        mkdirSync(dirname(statePath), { recursive: true, mode: 0o755 });
        const tmp = `${statePath}.tmp.${String(process.pid)}`;
        writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o644 });
        renameSync(tmp, statePath);
        return;
      }
      if (!existsFn(sudoBin)) {
        throw new FanError(
          'PERMISSION_DENIED',
          `写入持久化状态需要 root 权限, 但找不到 ${sudoBin}`,
        );
      }
      // 保留 stdin='inherit' 供 sudo 交互式密码/Touch ID 提示, 内容经 argv 传递 (无机密)
      const res = spawnSyncFn(
        sudoBin,
        [python3Bin, '-c', PRIVILEGED_WRITE_PY, statePath, serialized],
        {
          encoding: 'utf8',
          stdio: ['inherit', 'pipe', 'pipe'],
          ...(geteuid() === 0 ? { timeout: writeTimeoutMs } : {}),
        },
      );
      if (res.error !== undefined) {
        throw new FanError(
          'DAEMON_FAILED',
          `写入持久化状态进程失败: ${res.error.message}`,
          { cause: res.error },
        );
      }
      if (res.status !== 0) {
        const msg = (res.stderr ?? '').trim();
        throw new FanError(
          /password|sudoers|terminal/i.test(msg)
            ? 'PERMISSION_DENIED'
            : 'DAEMON_FAILED',
          msg !== '' ? msg : `写入持久化状态失败: ${statePath}`,
        );
      }
    },
  };
}
