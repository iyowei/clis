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
  return (
    (kind === 'rpm' || kind === 'percent') &&
    typeof num === 'number' &&
    Number.isFinite(num)
  );
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
  const cleanFans: Record<string, PersistedFanEntry> = {};
  for (const [k, v] of Object.entries(obj.fans as Record<string, unknown>)) {
    if (!isValidEntry(v)) {
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
    fans: cleanFans,
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
os.chmod(parent, 0o755)
tmp = f"{path}.tmp.{os.getpid()}"
with open(tmp, "w", encoding="utf-8") as fh:
    fh.write(content)
os.chmod(tmp, 0o644)
os.replace(tmp, path)
`;

function canWriteDirectly(statePath: string): boolean {
  if (typeof process.geteuid === 'function' && process.geteuid() === 0) {
    return true;
  }
  const parent = dirname(statePath);
  if (existsSync(parent)) {
    try {
      const probe = join(parent, `.write-probe-${String(process.pid)}`);
      writeFileSync(probe, '');
      renameSync(probe, probe);
      spawnSync('/bin/rm', ['-f', probe], { stdio: 'ignore' });
      return true;
    } catch {
      return false;
    }
  }
  return false;
}

export interface MacOsStateStoreDeps {
  statePath?: string;
  platform?: NodeJS.Platform;
  python3Bin?: string;
  sudoBin?: string;
}

/** 创建默认 macOS 状态存储 (读免提权; 写目录受 root 保护时自动经 `/usr/bin/sudo` 原子落盘) */
export function createMacOsFanStateStore(
  deps: MacOsStateStoreDeps = {},
): FanStateStore {
  const statePath =
    deps.statePath ?? process.env.FAN_STATE_PATH ?? DEFAULT_FAN_STATE_PATH;
  const platform = deps.platform ?? process.platform;
  const python3Bin = deps.python3Bin ?? MACOS_PYTHON3_BIN;
  const sudoBin = deps.sudoBin ?? MACOS_SUDO_BIN;

  return {
    path: statePath,
    read(): FanPersistedState | null {
      return readPersistedState(statePath);
    },
    write(state: FanPersistedState): void {
      assertNoSymlinkPath(statePath);
      const serialized = `${JSON.stringify(state, null, 2)}\n`;
      if (canWriteDirectly(statePath) || platform !== 'darwin') {
        mkdirSync(dirname(statePath), { recursive: true, mode: 0o755 });
        const tmp = `${statePath}.tmp.${String(process.pid)}`;
        writeFileSync(tmp, serialized, { encoding: 'utf8', mode: 0o644 });
        renameSync(tmp, statePath);
        return;
      }
      const res = spawnSync(
        sudoBin,
        [python3Bin, '-c', PRIVILEGED_WRITE_PY, statePath, serialized],
        { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'] },
      );
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
