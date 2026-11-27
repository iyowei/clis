/**
 * macOS `LaunchDaemon` 管理 (`com.iyowei.fan`):
 * 安装、卸载与状态查询开机及睡眠唤醒自动恢复服务。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, lstatSync, readFileSync } from 'node:fs';

import { buildDaemonPythonScript } from './daemon-script.ts';
import { FanError } from './errors.ts';
import { MACOS_PYTHON3_BIN, MACOS_SUDO_BIN } from './smc-apple.ts';
import { SMC_PY_STRUCTS_AND_CORE } from './smc-script.ts';
import {
  DEFAULT_FAN_DIR,
  DEFAULT_FAN_STATE_PATH,
  readPersistedState,
} from './state.ts';
import type { PersistDaemonStatus, PersistDaemonSyncResult } from './types.ts';

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
  env?: Record<string, string | undefined>;
  geteuid?: () => number;
  exists?: (path: string) => boolean;
  spawnSyncFn?: typeof spawnSync;
  statusTimeoutMs?: number;
  writeTimeoutMs?: number;
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
  const env = opts.env ?? process.env;
  const envStatePath = env.FAN_STATE_PATH?.trim();
  return {
    plistPath: opts.plistPath ?? DEFAULT_PLIST_PATH,
    daemonScriptPath: opts.daemonScriptPath ?? DEFAULT_DAEMON_SCRIPT_PATH,
    statePath:
      opts.statePath ??
      (envStatePath !== undefined && envStatePath !== ''
        ? envStatePath
        : DEFAULT_FAN_STATE_PATH),
    logPath: opts.logPath ?? DEFAULT_DAEMON_LOG_PATH,
    python3Bin: opts.python3Bin ?? MACOS_PYTHON3_BIN,
    sudoBin: opts.sudoBin ?? MACOS_SUDO_BIN,
    launchctlBin: opts.launchctlBin ?? MACOS_LAUNCHCTL_BIN,
    platform: opts.platform ?? process.platform,
    geteuid:
      opts.geteuid ??
      (() => (typeof process.geteuid === 'function' ? process.geteuid() : -1)),
    exists: opts.exists ?? existsSync,
    spawnSyncFn: opts.spawnSyncFn ?? spawnSync,
    statusTimeoutMs: opts.statusTimeoutMs ?? 5_000,
    writeTimeoutMs: opts.writeTimeoutMs ?? 30_000,
  };
}

function assertDarwin(
  platform: NodeJS.Platform,
  python3Bin: string,
  existsFn: (path: string) => boolean,
): void {
  if (platform !== 'darwin') {
    throw new FanError(
      'UNSUPPORTED_PLATFORM',
      `macOS LaunchDaemon 仅支持 darwin 平台 (当前: ${platform})`,
    );
  }
  if (!existsFn(python3Bin)) {
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
    paths.exists(paths.plistPath) && paths.exists(paths.daemonScriptPath);
  let running = false;
  if (paths.platform === 'darwin' && paths.exists(paths.launchctlBin)) {
    const res = paths.spawnSyncFn(
      paths.launchctlBin,
      ['print', `system/${FAN_DAEMON_LABEL}`],
      { stdio: 'ignore', timeout: paths.statusTimeoutMs },
    );
    running = res.error === undefined && res.status === 0;
  }
  let state = null;
  let stateError: string | undefined;
  try {
    state = readPersistedState(paths.statePath);
  } catch (error) {
    state = null;
    stateError = error instanceof Error ? error.message : String(error);
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
    ...(stateError !== undefined ? { stateError } : {}),
  };
}

const INSTALL_DAEMON_PY = `
import os, subprocess, sys
plist_path, plist_body, script_path, script_body, label, launchctl = sys.argv[1:7]
is_root = hasattr(os, "geteuid") and os.geteuid() == 0
for path in (plist_path, script_path):
    parent = os.path.dirname(path)
    if os.path.islink(parent) or os.path.islink(path):
        sys.stderr.write(f"Refusing symlink path: {path}\\n")
        sys.exit(1)
    os.makedirs(parent, mode=0o755, exist_ok=True)
    if is_root:
        os.chown(parent, 0, 0)
    os.chmod(parent, 0o755)

def atomic_write(path, text, mode):
    tmp = f"{path}.tmp.{os.getpid()}"
    with open(tmp, "w", encoding="utf-8") as fh:
        fh.write(text)
    if is_root:
        os.chown(tmp, 0, 0)
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
import ctypes, os, struct, subprocess, sys, time
plist_path, script_path, label, launchctl = sys.argv[1:5]
subprocess.run([launchctl, "bootout", f"system/{label}"], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
for path in (plist_path, script_path):
    if os.path.exists(path) and not os.path.islink(path):
        os.remove(path)

# 卸载守护后尽力将处于 manual 的风扇归还系统 auto 并复位 Ftst, 防失去守护看管后滞留低速
iokit_path = "/System/Library/Frameworks/IOKit.framework/IOKit"
if os.path.exists(iokit_path):
    try:
        iokit = ctypes.CDLL(iokit_path)
        libc = ctypes.CDLL("/usr/lib/libc.dylib")
        iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
        iokit.IOServiceMatching.restype = ctypes.c_void_p
        iokit.IOServiceGetMatchingService.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
        iokit.IOServiceGetMatchingService.restype = ctypes.c_uint32
        iokit.IOServiceOpen.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_uint32, ctypes.POINTER(ctypes.c_uint32)]
        iokit.IOServiceOpen.restype = ctypes.c_int32
        iokit.IOServiceClose.argtypes = [ctypes.c_uint32]
        iokit.IOObjectRelease.argtypes = [ctypes.c_uint32]
        iokit.IOConnectCallStructMethod.argtypes = [ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p, ctypes.c_size_t, ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
        iokit.IOConnectCallStructMethod.restype = ctypes.c_int32
        libc.mach_task_self.restype = ctypes.c_uint32
${SMC_PY_STRUCTS_AND_CORE.split('\n')
  .map((line) => (line === '' ? '' : `        ${line}`))
  .join('\n')}
        svc = iokit.IOServiceGetMatchingService(0, iokit.IOServiceMatching(b"AppleSMC"))
        if svc:
            conn = ctypes.c_uint32(0)
            kr = iokit.IOServiceOpen(svc, libc.mach_task_self(), 0, ctypes.byref(conn))
            iokit.IOObjectRelease(svc)
            if kr == 0:
                try:
                    cnt = read_fan_count(conn)
                    for idx in range(cnt):
                        if read_fan_mode(conn, idx) == "manual":
                            set_fan_mode(conn, idx, False)
                    sync_ftst_if_all_auto(conn, cnt)
                finally:
                    iokit.IOServiceClose(conn)
    except Exception:
        pass
`;

function runPrivilegedPython(
  paths: ReturnType<typeof resolvePaths>,
  script: string,
  args: string[],
): void {
  const isRoot = paths.geteuid() === 0;
  if (!isRoot && !paths.exists(paths.sudoBin)) {
    throw new FanError(
      'PERMISSION_DENIED',
      `管理 LaunchDaemon 需要 root 权限, 但找不到 ${paths.sudoBin}`,
    );
  }
  const cmd = isRoot ? paths.python3Bin : paths.sudoBin;
  const cmdArgs = isRoot
    ? ['-c', script, ...args]
    : [paths.python3Bin, '-c', script, ...args];
  // 保留 stdin='inherit' 供 sudo 交互式密码/Touch ID 提示, 内容经 argv 传递 (无机密)
  const res = paths.spawnSyncFn(cmd, cmdArgs, {
    encoding: 'utf8',
    stdio: [isRoot ? 'ignore' : 'inherit', 'pipe', 'pipe'],
    ...(isRoot ? { timeout: paths.writeTimeoutMs } : {}),
  });
  if (res.error !== undefined) {
    throw new FanError(
      'DAEMON_FAILED',
      `执行 ${cmd} 失败: ${res.error.message}`,
      { cause: res.error },
    );
  }
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
  assertDarwin(paths.platform, paths.python3Bin, paths.exists);
  const daemonBody = buildDaemonPythonScript(paths.statePath);
  const plistBody = buildLaunchDaemonPlist({
    label: FAN_DAEMON_LABEL,
    python3Bin: paths.python3Bin,
    daemonScriptPath: paths.daemonScriptPath,
    logPath: paths.logPath,
  });
  runPrivilegedPython(paths, INSTALL_DAEMON_PY, [
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
  assertDarwin(paths.platform, paths.python3Bin, paths.exists);
  runPrivilegedPython(paths, UNINSTALL_DAEMON_PY, [
    paths.plistPath,
    paths.daemonScriptPath,
    FAN_DAEMON_LABEL,
    paths.launchctlBin,
  ]);
  return getPersistDaemonStatus(opts);
}

function readSafeText(
  filePath: string,
  existsFn: (path: string) => boolean,
): string | null {
  try {
    if (!existsFn(filePath) || lstatSync(filePath).isSymbolicLink()) {
      return null;
    }
    return readFileSync(filePath, 'utf8');
  } catch {
    return null;
  }
}

/**
 * 幂等确保 `LaunchDaemon` 已安装、运行且脚本/plist 与当前版本完全一致:
 * - 若已安装、正在运行且磁盘脚本与 plist 逐字节匹配, 免 `sudo` 直接返回 `action: 'unchanged'`;
 * - 若未安装、未运行或守护模板已升级, 自动安装/重载并返回 `'installed'` 或 `'updated'`。
 */
export function ensurePersistDaemon(
  opts: DaemonPaths = {},
): PersistDaemonSyncResult {
  const paths = resolvePaths(opts);
  assertDarwin(paths.platform, paths.python3Bin, paths.exists);

  const expectedScript = buildDaemonPythonScript(paths.statePath);
  const expectedPlist = buildLaunchDaemonPlist({
    label: FAN_DAEMON_LABEL,
    python3Bin: paths.python3Bin,
    daemonScriptPath: paths.daemonScriptPath,
    logPath: paths.logPath,
  });

  const currentScript = readSafeText(paths.daemonScriptPath, paths.exists);
  const currentPlist = readSafeText(paths.plistPath, paths.exists);
  const currentStatus = getPersistDaemonStatus(opts);

  if (
    currentStatus.installed &&
    currentStatus.running &&
    currentScript === expectedScript &&
    currentPlist === expectedPlist
  ) {
    return { status: currentStatus, action: 'unchanged' };
  }

  const existedBefore =
    currentScript !== null || currentPlist !== null || currentStatus.installed;
  const nextStatus = installPersistDaemon(opts);
  return {
    status: nextStatus,
    action: existedBefore ? 'updated' : 'installed',
  };
}
