/**
 * 内联于 `@iyowei/fan` 的 macOS LaunchDaemon 守护脚本模板 (内部模块, 不进公开 API)。
 * 职责:
 * 1. 开机 (`RunAtLoad`)、真实唤醒 (`FullWake` / 开盖) 以及从后台唤醒升格为用户活跃 (`IOPMUserIsActive == True`) 时从 `state.json` 恢复手动风扇转速;
 * 2. 无外接显示器合盖 (`AppleClamshellState && AppleClamshellCausesSleep`)、进入系统睡眠 (`kIOMessageSystemWillSleep`)
 *    以及无用户活跃的后台维护唤醒 (`DarkWake`: `IOPMUserTriggeredFullWake == False` 且 `IOPMUserIsActive != True`) 期间,
 *    自动将手动风扇临时交还系统 `auto` (停转), 不改写 `state.json`; 外接显示器合盖办公与亮屏会话空闲息屏均保留手动转速;
 * 3. 醒着正常开盖期间采用边沿状态机, 零定时轮询且不覆盖 `--once` 临时设定;
 * 4. 复用 `SMC_PY_STRUCTS_AND_CORE`, 统一兼容 Apple M5 (`F*md`)、M1–M4/T2 (`F*Md` + `Ftst`) 与经典 Intel (`FS! `)。
 */
import { SMC_PY_STRUCTS_AND_CORE } from './smc-script.ts';

function daemonPreamble(escapedStatePath: string): string {
  return `#!/usr/bin/python3
"""LaunchDaemon for @iyowei/fan: restores SMC fan speeds and releases to auto on clamshell/sleep."""

import ctypes
import json
import os
import struct
import sys
import time

STATE_PATH = ${escapedStatePath}
IOKIT_PATH = "/System/Library/Frameworks/IOKit.framework/IOKit"
CF_PATH = "/System/Library/Frameworks/CoreFoundation.framework/CoreFoundation"
LIBC_PATH = "/usr/lib/libc.dylib"

K_IO_MSG_CAN_SYSTEM_SLEEP = 0xE0000270
K_IO_MSG_SYSTEM_WILL_SLEEP = 0xE0000280
K_IO_MSG_SYSTEM_HAS_POWERED_ON = 0xE0000300
K_CF_STRING_ENCODING_UTF8 = 0x08000100
${SMC_PY_STRUCTS_AND_CORE}

iokit = ctypes.CDLL(IOKIT_PATH)
cf = ctypes.CDLL(CF_PATH)
libc = ctypes.CDLL(LIBC_PATH)

iokit.IOServiceMatching.argtypes = [ctypes.c_char_p]
iokit.IOServiceMatching.restype = ctypes.c_void_p
iokit.IOServiceGetMatchingService.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
iokit.IOServiceGetMatchingService.restype = ctypes.c_uint32
iokit.IOServiceOpen.argtypes = [
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.POINTER(ctypes.c_uint32),
]
iokit.IOServiceOpen.restype = ctypes.c_int32
iokit.IOServiceClose.argtypes = [ctypes.c_uint32]
iokit.IOObjectRelease.argtypes = [ctypes.c_uint32]
iokit.IOConnectCallStructMethod.argtypes = [
    ctypes.c_uint32,
    ctypes.c_uint32,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_size_t),
]
iokit.IOConnectCallStructMethod.restype = ctypes.c_int32
iokit.IORegistryEntryCreateCFProperty.argtypes = [
    ctypes.c_uint32,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_uint32,
]
iokit.IORegistryEntryCreateCFProperty.restype = ctypes.c_void_p

POWER_CB = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p
)
INTEREST_CB = ctypes.CFUNCTYPE(
    None, ctypes.c_void_p, ctypes.c_uint32, ctypes.c_uint32, ctypes.c_void_p
)

iokit.IORegisterForSystemPower.argtypes = [
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_void_p),
    POWER_CB,
    ctypes.POINTER(ctypes.c_uint32),
]
iokit.IORegisterForSystemPower.restype = ctypes.c_uint32
iokit.IOAllowPowerChange.argtypes = [ctypes.c_uint32, ctypes.c_void_p]
iokit.IOAllowPowerChange.restype = ctypes.c_int32
iokit.IONotificationPortCreate.argtypes = [ctypes.c_uint32]
iokit.IONotificationPortCreate.restype = ctypes.c_void_p
iokit.IONotificationPortGetRunLoopSource.argtypes = [ctypes.c_void_p]
iokit.IONotificationPortGetRunLoopSource.restype = ctypes.c_void_p
iokit.IOServiceAddInterestNotification.argtypes = [
    ctypes.c_void_p,
    ctypes.c_uint32,
    ctypes.c_char_p,
    INTEREST_CB,
    ctypes.c_void_p,
    ctypes.POINTER(ctypes.c_uint32),
]
iokit.IOServiceAddInterestNotification.restype = ctypes.c_int32

cf.CFRunLoopGetCurrent.restype = ctypes.c_void_p
cf.CFRunLoopAddSource.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
cf.CFRunLoopRun.restype = None
cf.CFStringCreateWithCString.argtypes = [
    ctypes.c_void_p,
    ctypes.c_char_p,
    ctypes.c_uint32,
]
cf.CFStringCreateWithCString.restype = ctypes.c_void_p
cf.CFBooleanGetValue.argtypes = [ctypes.c_void_p]
cf.CFBooleanGetValue.restype = ctypes.c_bool
cf.CFGetTypeID.argtypes = [ctypes.c_void_p]
cf.CFGetTypeID.restype = ctypes.c_ulong
cf.CFBooleanGetTypeID.argtypes = []
cf.CFBooleanGetTypeID.restype = ctypes.c_ulong
cf.CFRelease.argtypes = [ctypes.c_void_p]
libc.mach_task_self.restype = ctypes.c_uint32
K_CF_RUN_LOOP_DEFAULT_MODE = ctypes.c_void_p.in_dll(cf, "kCFRunLoopDefaultMode")
`;
}

const DAEMON_SMC_HELPERS = `
def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    sys.stdout.write(f"[{ts}] {msg}\\n")
    sys.stdout.flush()


def smc_open():
    svc = iokit.IOServiceGetMatchingService(0, iokit.IOServiceMatching(b"AppleSMC"))
    if not svc:
        raise RuntimeError("AppleSMC service not found")
    conn = ctypes.c_uint32(0)
    kr = iokit.IOServiceOpen(svc, libc.mach_task_self(), 0, ctypes.byref(conn))
    iokit.IOObjectRelease(svc)
    if kr != 0:
        raise RuntimeError(f"IOServiceOpen(AppleSMC) failed: {hex(kr)}")
    return conn


def read_pm_bool(pm_svc, key_bytes):
    if not pm_svc:
        return None
    cf_key = cf.CFStringCreateWithCString(None, key_bytes, K_CF_STRING_ENCODING_UTF8)
    if not cf_key:
        return None
    val = iokit.IORegistryEntryCreateCFProperty(pm_svc, cf_key, None, 0)
    cf.CFRelease(cf_key)
    if not val:
        return None
    try:
        if cf.CFGetTypeID(val) == cf.CFBooleanGetTypeID():
            return bool(cf.CFBooleanGetValue(val))
        return None
    finally:
        cf.CFRelease(val)


def is_initial_dark_wake(pm_svc):
    if not pm_svc:
        return False
    full_wake = read_pm_bool(pm_svc, b"IOPMUserTriggeredFullWake")
    if full_wake is not False:
        return False
    # XNU 在非 HID 唤醒 (如 USB-C_plug / RTC) 后升格为 FullWake 时不会把
    # IOPMUserTriggeredFullWake 改回 True, 而是置 IOPMUserIsActive = True
    user_active = read_pm_bool(pm_svc, b"IOPMUserIsActive")
    return user_active is not True


def is_promoted_to_full_wake(pm_svc):
    if not pm_svc:
        return True
    if read_pm_bool(pm_svc, b"IOPMUserIsActive") is True:
        return True
    return read_pm_bool(pm_svc, b"IOPMUserTriggeredFullWake") is True


def should_suspend_fans(pm_svc, system_sleeping, in_dark_wake):
    if system_sleeping:
        return True, "system-sleep"
    clamshell_closed = read_pm_bool(pm_svc, b"AppleClamshellState")
    if clamshell_closed is True:
        causes_sleep = read_pm_bool(pm_svc, b"AppleClamshellCausesSleep")
        if causes_sleep is not False:
            return True, "clamshell-closed"
    if in_dark_wake and not is_promoted_to_full_wake(pm_svc):
        return True, "dark-wake"
    return False, "active"
`;

const DAEMON_LOOP = `
def load_state():
    if not os.path.exists(STATE_PATH) or os.path.islink(STATE_PATH):
        return None
    with open(STATE_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if (
        not isinstance(data, dict)
        or type(data.get("version")) is not int
        or data.get("version") != 1
    ):
        return None
    fans = data.get("fans")
    return fans if isinstance(fans, dict) else None


def release_manual_fans_to_auto(reason):
    for attempt in range(4):
        conn = None
        try:
            conn = smc_open()
            count = read_fan_count(conn)
            released = []
            for idx in range(count):
                if read_fan_mode(conn, idx) == "manual":
                    set_fan_mode(conn, idx, False)
                    released.append(f"F{idx}=auto")
            sync_ftst_if_all_auto(conn, count)
            if released:
                log(f"{reason}: released {', '.join(released)}")
            return
        except Exception as exc:
            if attempt == 3:
                log(f"{reason}: failed to release manual fans: {exc}")
            else:
                time.sleep(0.1)
        finally:
            if conn is not None and conn.value:
                iokit.IOServiceClose(conn)


def apply_saved_state(reason, should_abort=None):
    try:
        fans_cfg = load_state()
    except Exception as exc:
        log(f"{reason}: failed to read {STATE_PATH}: {exc}")
        return
    if not fans_cfg:
        return
    has_manual = any(
        isinstance(v, dict) and v.get("mode") == "manual" for v in fans_cfg.values()
    )
    if not has_manual:
        return

    for attempt in range(10):
        if should_abort is not None and should_abort():
            log(f"{reason}: aborted restore because system entered sleep/clamshell")
            release_manual_fans_to_auto(f"{reason}-abort")
            return
        conn = None
        try:
            conn = smc_open()
            count = read_fan_count(conn)
            applied = []
            any_auto_applied = False
            for idx in range(count):
                entry = fans_cfg.get(str(idx))
                if not isinstance(entry, dict):
                    continue
                if entry.get("mode") == "auto":
                    if read_fan_mode(conn, idx) == "manual":
                        set_fan_mode(conn, idx, False)
                        applied.append(f"F{idx}=auto")
                        any_auto_applied = True
                    continue
                if entry.get("mode") != "manual":
                    continue
                mn = float(read_key(conn, f"F{idx}Mn"))
                mx = float(read_key(conn, f"F{idx}Mx"))
                kind = entry.get("kind")
                val = float(entry.get("value", 0))
                if kind == "percent":
                    pct = max(0.0, min(100.0, val))
                    target = int(mn + (pct / 100.0) * (mx - mn) + 0.5)
                else:
                    target = max(mn, min(mx, val))
                cur_mode = read_fan_mode(conn, idx)
                cur_tg = read_key_opt(conn, f"F{idx}Tg")
                if (
                    cur_mode != "manual"
                    or cur_tg is None
                    or abs(float(cur_tg) - target) >= 1.0
                ):
                    set_fan_mode(conn, idx, True)
                    write_key(conn, f"F{idx}Tg", float(target))
                    applied.append(f"F{idx}={int(target)}RPM")
            if any_auto_applied:
                sync_ftst_if_all_auto(conn, count)
            if applied:
                log(f"{reason}: applied {', '.join(applied)}")
            return
        except Exception as exc:
            if attempt == 9:
                log(f"{reason}: SMC apply failed after retries: {exc}")
            else:
                time.sleep(0.5)
        finally:
            if conn is not None and conn.value:
                iokit.IOServiceClose(conn)


def create_power_reconciler(
    pm_svc,
    apply_fn=apply_saved_state,
    release_fn=release_manual_fans_to_auto,
):
    runtime = {
        "system_sleeping": False,
        "dark_wake": is_initial_dark_wake(pm_svc),
        "suspended": False,
        "root_port": 0,
    }
    should_abort_restore = lambda: (
        should_suspend_fans(
            pm_svc, runtime["system_sleeping"], runtime["dark_wake"]
        )[0]
    )

    def boot():
        init_suspend, init_reason = should_suspend_fans(
            pm_svc, False, runtime["dark_wake"]
        )
        runtime["suspended"] = init_suspend
        if init_suspend:
            release_fn(f"boot-{init_reason}")
        else:
            apply_fn("boot", should_abort_restore)

    def reconcile(trigger, force_check_on_wake=False):
        if runtime["dark_wake"] and is_promoted_to_full_wake(pm_svc):
            runtime["dark_wake"] = False
        want_suspend, reason = should_suspend_fans(
            pm_svc, runtime["system_sleeping"], runtime["dark_wake"]
        )
        if want_suspend and not runtime["suspended"]:
            runtime["suspended"] = True
            release_fn(f"{trigger}:{reason}")
        elif not want_suspend and runtime["suspended"]:
            runtime["suspended"] = False
            apply_fn(trigger, should_abort_restore)
        elif want_suspend and force_check_on_wake:
            release_fn(f"{trigger}:{reason}")

    def handle_will_sleep():
        runtime["system_sleeping"] = True
        runtime["dark_wake"] = False
        reconcile("sleep")

    def handle_powered_on(settle_sec=0.5):
        runtime["system_sleeping"] = False
        if settle_sec > 0:
            time.sleep(settle_sec)
        runtime["dark_wake"] = is_initial_dark_wake(pm_svc)
        reconcile("wake", force_check_on_wake=True)

    def handle_interest():
        if not runtime["system_sleeping"]:
            reconcile("pm-state")

    return {
        "runtime": runtime,
        "boot": boot,
        "reconcile": reconcile,
        "handle_will_sleep": handle_will_sleep,
        "handle_powered_on": handle_powered_on,
        "handle_interest": handle_interest,
    }
`;

const DAEMON_ENTRYPOINT = `
def main():
    log(f"fan-daemon started (state={STATE_PATH})")
    pm_svc = iokit.IOServiceGetMatchingService(
        0, iokit.IOServiceMatching(b"IOPMrootDomain")
    )
    if not pm_svc:
        log("warning: IOPMrootDomain service not found; clamshell/DarkWake monitoring disabled")
    ctrl = create_power_reconciler(pm_svc)
    runtime = ctrl["runtime"]
    ctrl["boot"]()

    @POWER_CB
    def on_power(_refcon, _service, msg_type, msg_arg):
        try:
            if msg_type == K_IO_MSG_CAN_SYSTEM_SLEEP:
                iokit.IOAllowPowerChange(runtime["root_port"], msg_arg)
            elif msg_type == K_IO_MSG_SYSTEM_WILL_SLEEP:
                try:
                    ctrl["handle_will_sleep"]()
                finally:
                    iokit.IOAllowPowerChange(runtime["root_port"], msg_arg)
            elif msg_type == K_IO_MSG_SYSTEM_HAS_POWERED_ON:
                ctrl["handle_powered_on"](0.5)
        except Exception as exc:
            log(f"on_power error: {exc}")

    @INTEREST_CB
    def on_interest(_refcon, _service, _msg_type, _msg_arg):
        try:
            ctrl["handle_interest"]()
        except Exception as exc:
            log(f"on_interest error: {exc}")

    notify_port = ctypes.c_void_p()
    notifier = ctypes.c_uint32()
    root_port = iokit.IORegisterForSystemPower(
        None, ctypes.byref(notify_port), on_power, ctypes.byref(notifier)
    )
    if not root_port or not notify_port.value:
        log("IORegisterForSystemPower failed; exiting")
        sys.exit(1)
    runtime["root_port"] = root_port

    run_loop = cf.CFRunLoopGetCurrent()
    cf.CFRunLoopAddSource(
        run_loop,
        iokit.IONotificationPortGetRunLoopSource(notify_port),
        K_CF_RUN_LOOP_DEFAULT_MODE,
    )

    interest_port = None
    interest_notifier = ctypes.c_uint32()
    if pm_svc:
        interest_port = iokit.IONotificationPortCreate(0)
        if interest_port:
            kr = iokit.IOServiceAddInterestNotification(
                interest_port,
                pm_svc,
                b"IOGeneralInterest",
                on_interest,
                None,
                ctypes.byref(interest_notifier),
            )
            if kr == 0:
                cf.CFRunLoopAddSource(
                    run_loop,
                    iokit.IONotificationPortGetRunLoopSource(interest_port),
                    K_CF_RUN_LOOP_DEFAULT_MODE,
                )
            else:
                log(f"IOServiceAddInterestNotification failed: {hex(kr)}")

    cf.CFRunLoopRun()


if __name__ == "__main__":
    main()
`;

/** 纯 Python 电源状态机与 SMC 恢复逻辑片段 (供跨平台单测直接加载验证) */
export const DAEMON_CORE_PY = [DAEMON_SMC_HELPERS, DAEMON_LOOP].join('\n');

export function buildDaemonPythonScript(statePath: string): string {
  return [
    daemonPreamble(JSON.stringify(statePath)),
    DAEMON_CORE_PY,
    DAEMON_ENTRYPOINT,
  ].join('\n');
}
