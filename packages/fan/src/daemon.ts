/**
 * macOS `LaunchDaemon` 管理 (`com.iyowei.fan`):
 * 安装、卸载与状态查询开机及睡眠唤醒自动恢复服务。
 */
import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { buildDaemonPythonScript } from './daemon-script.ts';
import { FanError } from './errors.ts';
import { MACOS_PYTHON3_BIN, MACOS_SUDO_BIN } from './smc-apple.ts';
import {
  DEFAULT_FAN_DIR,
  DEFAULT_FAN_STATE_PATH,
  readPersistedState,
} from './state.ts';
import type { PersistDaemonStatus } from './types.ts';

export const FAN_DAEMON_LABEL = 'com.iyowei.fan';
export const DEFAULT_DAEMON_SCRIPT_PATH = `${DEFAULT_FAN_DIR}/fan-daemon.py`;
export const DEFAULT_PLIST_PATH = `/Library/LaunchDaemons/${FAN_DAEMON_LABEL}.plist`;
export const DEFAULT_DAEMON_LOG_PATH = '/var/log/iyowei-fan.log';
export const MACOS_LAUNCHCTL_BIN = '/bin/launchctl';

export interface DaemonPaths {
  plistPath?: string;
  daemonScriptPath?: string;
  statePath?: string;
  logPath?: string;
  python3Bin?: string;
  sudoBin?: string;
  launchctlBin?: string;
  platform?: NodeJS.Platform;
}

function escapeXml(value: string): string {
  return value
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;');
}

/** 生成 `/Library/LaunchDaemons/com.iyowei.fan.plist` 内容 */
export function buildLaunchDaemonPlist(options: {
  label?: string;
  python3Bin?: string;
  daemonScriptPath?: string;
  logPath?: string;
}): string {
  const label = escapeXml(options.label ?? FAN_DAEMON_LABEL);
  const py = escapeXml(options.python3Bin ?? MACOS_PYTHON3_BIN);
  const script = escapeXml(
    options.daemonScriptPath ?? DEFAULT_DAEMON_SCRIPT_PATH,
  );
  const log = escapeXml(options.logPath ?? DEFAULT_DAEMON_LOG_PATH);

  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${label}</string>
  <key>ProgramArguments</key>
  <array>
    <string>${py}</string>
    <string>${script}</string>
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>StandardOutPath</key>
  <string>${log}</string>
  <key>StandardErrorPath</key>
  <string>${log}</string>
</dict>
</plist>
`;
}

function resolvePaths(opts: DaemonPaths = {}) {
  return {
    plistPath: opts.plistPath ?? DEFAULT_PLIST_PATH,
    daemonScriptPath: opts.daemonScriptPath ?? DEFAULT_DAEMON_SCRIPT_PATH,
    statePath:
      opts.statePath ?? process.env.FAN_STATE_PATH ?? DEFAULT_FAN_STATE_PATH,
    logPath: opts.logPath ?? DEFAULT_DAEMON_LOG_PATH,
    python3Bin: opts.python3Bin ?? MACOS_PYTHON3_BIN,
    sudoBin: opts.sudoBin ?? MACOS_SUDO_BIN,
    launchctlBin: opts.launchctlBin ?? MACOS_LAUNCHCTL_BIN,
    platform: opts.platform ?? process.platform,
  };
}

function assertDarwin(platform: NodeJS.Platform, python3Bin: string): void {
  if (platform !== 'darwin') {
    throw new FanError(
      'UNSUPPORTED_PLATFORM',
      `macOS LaunchDaemon 仅支持 darwin 平台 (当前: ${platform})`,
    );
  }
  if (!existsSync(python3Bin)) {
    throw new FanError(
      'SMC_UNAVAILABLE',
      `缺少系统 Python 运行时 (${python3Bin})`,
    );
  }
}

/** 查询开机与睡眠唤醒持久化守护服务状态 (只读, 无需 sudo) */
export function getPersistDaemonStatus(
  opts: DaemonPaths = {},
): PersistDaemonStatus {
  const paths = resolvePaths(opts);
  const installed =
    existsSync(paths.plistPath) && existsSync(paths.daemonScriptPath);
  let running = false;
  if (paths.platform === 'darwin' && existsSync(paths.launchctlBin)) {
    const res = spawnSync(
      paths.launchctlBin,
      ['print', `system/${FAN_DAEMON_LABEL}`],
      { stdio: 'ignore' },
    );
    running = res.status === 0;
  }
  let state = null;
  try {
    state = readPersistedState(paths.statePath);
  } catch {
    state = null;
  }
  return {
    installed,
    running,
    label: FAN_DAEMON_LABEL,
    plistPath: paths.plistPath,
    daemonScriptPath: paths.daemonScriptPath,
    statePath: paths.statePath,
    logPath: paths.logPath,
    state,
  };
}

const INSTALL_DAEMON_PY = `
import os, subprocess, sys
plist_path, plist_body, script_path, script_body, label, launchctl = sys.argv[1:7]
for path in (plist_path, script_path):
    parent = os.path.dirname(path)
    if os.path.islink(parent) or os.path.islink(path):
        sys.stderr.write(f"Refusing symlink path: {path}\\n")
        sys.exit(1)
    os.makedirs(parent, mode=0o755, exist_ok=True)
    os.chmod(parent, 0o755)

def atomic_write(path, text, mode):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    os.chmod(tmp, mode)
    os.replace(tmp, path)

atomic_write(script_path, script_body, 0o755)
atomic_write(plist_path, plist_body, 0o644)
subprocess.run([launchctl, "bootout", f"system/{label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
res = subprocess.run([launchctl, "bootstrap", "system", plist_path], capture_output=True, text=True)
if res.returncode != 0:
    sys.stderr.write(res.stderr or f"launchctl bootstrap failed ({res.returncode})\\n")
    sys.exit(res.returncode)
`;

const UNINSTALL_DAEMON_PY = `
import os, subprocess, sys
plist_path, script_path, label, launchctl = sys.argv[1:5]
subprocess.run([launchctl, "bootout", f"system/{label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for path in (plist_path, script_path):
    if os.path.exists(path) and not os.path.islink(path):
        os.remove(path)
`;

function runPrivilegedPython(
  sudoBin: string,
  python3Bin: string,
  script: string,
  args: string[],
): void {
  const isRoot =
    typeof process.geteuid === 'function' && process.geteuid() === 0;
  const cmd = isRoot ? python3Bin : sudoBin;
  const cmdArgs = isRoot
    ? ['-c', script, ...args]
    : [python3Bin, '-c', script, ...args];
  const res = spawnSync(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: ['inherit', 'pipe', 'pipe'],
  });
  if (res.status !== 0) {
    const msg = (res.stderr ?? '').trim();
    throw new FanError(
      !isRoot && /password|sudoers|terminal/i.test(msg)
        ? 'PERMISSION_DENIED'
        : 'DAEMON_FAILED',
      msg !== ''
        ? msg
        : `操作 LaunchDaemon 失败 (退出码 ${String(res.status)})`,
    );
  }
}

/** 安装并立即启动开机/睡眠唤醒恢复 `LaunchDaemon` */
export function installPersistDaemon(
  opts: DaemonPaths = {},
): PersistDaemonStatus {
  const paths = resolvePaths(opts);
  assertDarwin(paths.platform, paths.python3Bin);
  const daemonBody = buildDaemonPythonScript(paths.statePath);
  const plistBody = buildLaunchDaemonPlist({
    label: FAN_DAEMON_LABEL,
    python3Bin: paths.python3Bin,
    daemonScriptPath: paths.daemonScriptPath,
    logPath: paths.logPath,
  });
  runPrivilegedPython(paths.sudoBin, paths.python3Bin, INSTALL_DAEMON_PY, [
    paths.plistPath,
    plistBody,
    paths.daemonScriptPath,
    daemonBody,
    FAN_DAEMON_LABEL,
    paths.launchctlBin,
  ]);
  return getPersistDaemonStatus(opts);
}

/** 停止并卸载开机/睡眠唤醒恢复 `LaunchDaemon` */
export function uninstallPersistDaemon(
  opts: DaemonPaths = {},
): PersistDaemonStatus {
  const paths = resolvePaths(opts);
  if (paths.platform !== 'darwin') {
    throw new FanError(
      'UNSUPPORTED_PLATFORM',
      `macOS LaunchDaemon 仅支持 darwin 平台 (当前: ${paths.platform})`,
    );
  }
  runPrivilegedPython(paths.sudoBin, paths.python3Bin, UNINSTALL_DAEMON_PY, [
    paths.plistPath,
    paths.daemonScriptPath,
    FAN_DAEMON_LABEL,
    paths.launchctlBin,
  ]);
  return getPersistDaemonStatus(opts);
}
