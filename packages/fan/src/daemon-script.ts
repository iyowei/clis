/**
 * 内联于 `@iyowei/fan` 的 macOS LaunchDaemon 守护脚本模板 (内部模块, 不进公开 API)。
 * 在开机 (`RunAtLoad`) 与每次睡眠唤醒 (`kIOMessageSystemHasPoweredOn`) 时,
 * 从持久化 `state.json` 读取手动风扇设定并恢复至 AppleSMC; 醒着期间零轮询, 不干扰 `--once` 临时设定。
 */

function daemonPreamble(escapedStatePath: string): string {
  return `#!/usr/bin/python3
"""LaunchDaemon for @iyowei/fan: restores persisted SMC fan speeds on boot and wake."""

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

K_SMC_HANDLE_YIELD = 2
K_SMC_READ_KEY = 5
K_SMC_WRITE_KEY = 6
K_SMC_GET_KEY_INFO = 9

K_IO_MSG_CAN_SYSTEM_SLEEP = 0xE0000270
K_IO_MSG_SYSTEM_WILL_SLEEP = 0xE0000280
K_IO_MSG_SYSTEM_HAS_POWERED_ON = 0xE0000300


class Vers(ctypes.Structure):
    _fields_ = [
        ("major", ctypes.c_uint8),
        ("minor", ctypes.c_uint8),
        ("build", ctypes.c_uint8),
        ("reserved", ctypes.c_uint8),
        ("release", ctypes.c_uint16),
    ]


class PLimitData(ctypes.Structure):
    _fields_ = [
        ("version", ctypes.c_uint16),
        ("length", ctypes.c_uint16),
        ("cpuPLimit", ctypes.c_uint32),
        ("gpuPLimit", ctypes.c_uint32),
        ("memPLimit", ctypes.c_uint32),
    ]


class KeyInfo(ctypes.Structure):
    _fields_ = [
        ("dataSize", ctypes.c_uint32),
        ("dataType", ctypes.c_uint32),
        ("dataAttributes", ctypes.c_uint8),
    ]


class SMCKeyData(ctypes.Structure):
    _fields_ = [
        ("key", ctypes.c_uint32),
        ("vers", Vers),
        ("pLimitData", PLimitData),
        ("keyInfo", KeyInfo),
        ("result", ctypes.c_uint8),
        ("status", ctypes.c_uint8),
        ("data8", ctypes.c_uint8),
        ("data32", ctypes.c_uint32),
        ("bytes", ctypes.c_uint8 * 32),
    ]


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

POWER_CB = ctypes.CFUNCTYPE(
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
iokit.IONotificationPortGetRunLoopSource.argtypes = [ctypes.c_void_p]
iokit.IONotificationPortGetRunLoopSource.restype = ctypes.c_void_p

cf.CFRunLoopGetCurrent.restype = ctypes.c_void_p
cf.CFRunLoopAddSource.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
cf.CFRunLoopRun.restype = None
libc.mach_task_self.restype = ctypes.c_uint32

K_CF_RUN_LOOP_DEFAULT_MODE = ctypes.c_void_p.in_dll(cf, "kCFRunLoopDefaultMode")
`;
}

const DAEMON_SMC_HELPERS = `
def log(msg):
    ts = time.strftime("%Y-%m-%d %H:%M:%S")
    sys.stdout.write(f"[{ts}] {msg}\\n")
    sys.stdout.flush()


def fourcc(k):
    return struct.unpack(">I", k.encode("ascii"))[0]


def unfoucc(v):
    return struct.pack(">I", v).decode("ascii", errors="replace")


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


def smc_call(conn, inp):
    out = SMCKeyData()
    sz = ctypes.c_size_t(ctypes.sizeof(out))
    rc = iokit.IOConnectCallStructMethod(
        conn.value,
        K_SMC_HANDLE_YIELD,
        ctypes.byref(inp),
        ctypes.sizeof(inp),
        ctypes.byref(out),
        ctypes.byref(sz),
    )
    if rc != 0:
        raise RuntimeError(f"IOConnectCallStructMethod failed: {hex(rc)}")
    if out.result != 0:
        raise RuntimeError(f"SMC error {out.result} for {unfoucc(inp.key)}")
    return out


def key_info(conn, k):
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.data8 = K_SMC_GET_KEY_INFO
    out = smc_call(conn, inp)
    return unfoucc(out.keyInfo.dataType), out.keyInfo.dataSize


def read_key(conn, k):
    dt, sz = key_info(conn, k)
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_READ_KEY
    out = smc_call(conn, inp)
    raw = bytes(out.bytes[:sz])
    if dt == "flt " and sz == 4:
        return float(struct.unpack("<f", raw)[0])
    if dt == "ui8 " and sz == 1:
        return int(raw[0])
    if dt == "ui16" and sz == 2:
        return int(struct.unpack(">H", raw)[0])
    if dt == "fpe2" and sz == 2:
        return float(struct.unpack(">H", raw)[0] >> 2)
    raise RuntimeError(f"Unsupported SMC read type {dt} for {k}")


def write_key(conn, k, val):
    dt, sz = key_info(conn, k)
    if dt == "flt " and sz == 4:
        payload = struct.pack("<f", float(val))
    elif dt == "ui8 " and sz == 1:
        payload = struct.pack("B", int(val))
    elif dt == "fpe2" and sz == 2:
        payload = struct.pack(">H", int(round(float(val) * 4)))
    else:
        raise RuntimeError(f"Unsupported SMC write type {dt} for {k}")
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_WRITE_KEY
    for i, b in enumerate(payload):
        inp.bytes[i] = b
    smc_call(conn, inp)
`;

const DAEMON_LOOP = `
def load_state():
    if not os.path.exists(STATE_PATH) or os.path.islink(STATE_PATH):
        return None
    with open(STATE_PATH, "r", encoding="utf-8") as fh:
        data = json.load(fh)
    if not isinstance(data, dict) or data.get("version") != 1:
        return None
    fans = data.get("fans")
    return fans if isinstance(fans, dict) else None


def apply_saved_state(reason):
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
        conn = None
        try:
            conn = smc_open()
            count = int(read_key(conn, "FNum"))
            applied = []
            for idx in range(count):
                entry = fans_cfg.get(str(idx))
                if not isinstance(entry, dict):
                    continue
                if entry.get("mode") == "auto":
                    if int(read_key(conn, f"F{idx}md")) != 0:
                        write_key(conn, f"F{idx}md", 0)
                        applied.append(f"F{idx}=auto")
                    continue
                if entry.get("mode") != "manual":
                    continue
                mn = float(read_key(conn, f"F{idx}Mn"))
                mx = float(read_key(conn, f"F{idx}Mx"))
                kind = entry.get("kind")
                val = float(entry.get("value", 0))
                if kind == "percent":
                    target = round(mn + (val / 100.0) * (mx - mn))
                else:
                    target = max(mn, min(mx, val))
                cur_md = int(read_key(conn, f"F{idx}md"))
                cur_tg = float(read_key(conn, f"F{idx}Tg"))
                if cur_md != 1 or abs(cur_tg - target) >= 1.0:
                    write_key(conn, f"F{idx}md", 1)
                    write_key(conn, f"F{idx}Tg", float(target))
                    applied.append(f"F{idx}={int(target)}RPM")
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


def main():
    log(f"fan-daemon started (state={STATE_PATH})")
    apply_saved_state("boot")

    root_port_holder = [0]

    @POWER_CB
    def on_power(_refcon, _service, msg_type, msg_arg):
        if msg_type in (K_IO_MSG_CAN_SYSTEM_SLEEP, K_IO_MSG_SYSTEM_WILL_SLEEP):
            iokit.IOAllowPowerChange(root_port_holder[0], msg_arg)
        elif msg_type == K_IO_MSG_SYSTEM_HAS_POWERED_ON:
            time.sleep(1.0)
            apply_saved_state("wake")

    notify_port = ctypes.c_void_p()
    notifier = ctypes.c_uint32()
    root_port = iokit.IORegisterForSystemPower(
        None, ctypes.byref(notify_port), on_power, ctypes.byref(notifier)
    )
    if not root_port or not notify_port.value:
        log("IORegisterForSystemPower failed; exiting")
        sys.exit(1)
    root_port_holder[0] = root_port
    source = iokit.IONotificationPortGetRunLoopSource(notify_port)
    cf.CFRunLoopAddSource(
        cf.CFRunLoopGetCurrent(), source, K_CF_RUN_LOOP_DEFAULT_MODE
    )
    cf.CFRunLoopRun()


if __name__ == "__main__":
    main()
`;

export function buildDaemonPythonScript(statePath: string): string {
  return [
    daemonPreamble(JSON.stringify(statePath)),
    DAEMON_SMC_HELPERS,
    DAEMON_LOOP,
  ].join('\n');
}
