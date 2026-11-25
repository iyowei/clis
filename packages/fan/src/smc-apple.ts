/**
 * macOS `AppleSMC` 真实硬件传输实现 (仅在 `darwin` 上通过 `/usr/bin/python3` 与 `/usr/bin/sudo` 调用 `IOKit`)。
 * 绝不使用裸命令名执行系统工具, 防 `PATH` / `cwd` 劫持; 非 macOS 平台显式抛出 `UNSUPPORTED_PLATFORM`。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { FanError } from './errors.ts';
import { SMC_PY_SCRIPT } from './smc-script.ts';
import type { FanInfo, FanTransport, FanWriteRequest } from './types.ts';

export const MACOS_PYTHON3_BIN = '/usr/bin/python3';
export const MACOS_SUDO_BIN = '/usr/bin/sudo';
export const MACOS_PGREP_BIN = '/usr/bin/pgrep';

export interface AppleSmcDeps {
  platform?: NodeJS.Platform;
  python3Bin?: string;
  sudoBin?: string;
  pgrepBin?: string;
  geteuid?: () => number;
  exists?: (path: string) => boolean;
  spawnSyncFn?: typeof spawnSync;
  readTimeoutMs?: number;
}

function assertSupportedHost(
  platform: NodeJS.Platform,
  python3Bin: string,
  exists: (path: string) => boolean,
): void {
  if (platform !== 'darwin') {
    throw new FanError(
      'UNSUPPORTED_PLATFORM',
      `fan 仅支持 macOS AppleSMC (当前平台: ${platform})`,
    );
  }
  if (!exists(python3Bin)) {
    throw new FanError(
      'SMC_UNAVAILABLE',
      `缺少系统 Python 运行时 (${python3Bin}), 无法访问 AppleSMC`,
    );
  }
}

function parseFansOutput(raw: string): FanInfo[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (error) {
    throw new FanError(
      'SMC_COMMAND_FAILED',
      `AppleSMC 返回了无效 JSON: ${raw.trim() || '(empty)'}`,
      { cause: error },
    );
  }
  if (!Array.isArray(parsed)) {
    throw new FanError('SMC_COMMAND_FAILED', 'AppleSMC 返回格式异常 (非数组)');
  }
  return parsed as FanInfo[];
}

function runSmcPayload(
  payload: unknown,
  elevate: boolean,
  deps: Required<AppleSmcDeps>,
): FanInfo[] {
  assertSupportedHost(deps.platform, deps.python3Bin, deps.exists);
  const serialized = JSON.stringify(payload);
  const needsSudo = elevate && deps.geteuid() !== 0;

  if (needsSudo && !deps.exists(deps.sudoBin)) {
    throw new FanError(
      'PERMISSION_DENIED',
      `修改风扇转速需要 root 权限, 但找不到 ${deps.sudoBin}`,
    );
  }

  const command = needsSudo ? deps.sudoBin : deps.python3Bin;
  const args = needsSudo
    ? [deps.python3Bin, '-c', SMC_PY_SCRIPT, serialized]
    : ['-c', SMC_PY_SCRIPT, serialized];

  const result = deps.spawnSyncFn(command, args, {
    encoding: 'utf8',
    stdio: [needsSudo ? 'inherit' : 'ignore', 'pipe', 'pipe'],
    ...(needsSudo ? {} : { timeout: deps.readTimeoutMs }),
  });

  if (result.error !== undefined) {
    const errCode = (result.error as NodeJS.ErrnoException).code;
    const isTimeout =
      errCode === 'ETIMEDOUT' ||
      /ETIMEDOUT|timed out/i.test(result.error.message);
    throw new FanError(
      isTimeout ? 'SMC_UNAVAILABLE' : 'SMC_COMMAND_FAILED',
      isTimeout
        ? `读取 AppleSMC 超时 (${deps.readTimeoutMs}ms)`
        : `执行 ${command} 失败: ${result.error.message}`,
      { cause: result.error },
    );
  }
  if (result.status !== 0) {
    const detail = (result.stderr ?? '').trim();
    if (
      needsSudo &&
      /password is required|a terminal is required|not in the sudoers|incorrect password/i.test(
        detail,
      )
    ) {
      throw new FanError(
        'PERMISSION_DENIED',
        `sudo 提权失败: ${detail || '需要交互输入管理员密码'}`,
      );
    }
    const code = result.status === 2 ? 'SMC_UNAVAILABLE' : 'SMC_COMMAND_FAILED';
    throw new FanError(
      code,
      detail !== ''
        ? detail
        : `AppleSMC 调用失败 (退出码 ${String(result.status)})`,
    );
  }
  return parseFansOutput(result.stdout ?? '');
}

/** 创建基于 macOS `AppleSMC` 的 `FanTransport` 实例 */
export function createAppleSmcTransport(
  overrides: AppleSmcDeps = {},
): FanTransport {
  const deps: Required<AppleSmcDeps> = {
    platform: overrides.platform ?? process.platform,
    python3Bin: overrides.python3Bin ?? MACOS_PYTHON3_BIN,
    sudoBin: overrides.sudoBin ?? MACOS_SUDO_BIN,
    pgrepBin: overrides.pgrepBin ?? MACOS_PGREP_BIN,
    geteuid:
      overrides.geteuid ??
      (() => (typeof process.geteuid === 'function' ? process.geteuid() : 0)),
    exists: overrides.exists ?? existsSync,
    spawnSyncFn: overrides.spawnSyncFn ?? spawnSync,
    readTimeoutMs: overrides.readTimeoutMs ?? 10_000,
  };

  return {
    readFans(): FanInfo[] {
      return runSmcPayload({ op: 'read' }, false, deps);
    },
    applyWrites(requests: readonly FanWriteRequest[]): FanInfo[] {
      return runSmcPayload({ op: 'write', requests }, true, deps);
    },
    isMacsFanControlRunning(): boolean {
      if (deps.platform !== 'darwin' || !deps.exists(deps.pgrepBin)) {
        return false;
      }
      const res = deps.spawnSyncFn(deps.pgrepBin, ['-x', 'Macs Fan Control'], {
        stdio: 'ignore',
      });
      return res.status === 0;
    },
  };
}
