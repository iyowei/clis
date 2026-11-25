/**
 * 内联于 `@iyowei/fan` 的零依赖 macOS `IOKit`/`AppleSMC` ctypes 驱动脚本 (内部模块, 不进公开 API)。
 * 通过 `/usr/bin/python3 -c` 执行, 使 Bun 与 Node (>= 22.18) 保持完全一致的硬件交互与最小化 `sudo` 提权边界。
 */
export const SMC_PY_SCRIPT = `
import ctypes, json, struct, sys, time

IOKIT_PATH = "/System/Library/Frameworks/IOKit.framework/IOKit"
LIBC_PATH = "/usr/lib/libc.dylib"
K_SMC_HANDLE_YIELD = 2
K_SMC_READ_KEY = 5
K_SMC_WRITE_KEY = 6
K_SMC_GET_KEY_INFO = 9

class Vers(ctypes.Structure):
    _fields_ = [("major", ctypes.c_uint8), ("minor", ctypes.c_uint8), ("build", ctypes.c_uint8), ("reserved", ctypes.c_uint8), ("release", ctypes.c_uint16)]

class PLimitData(ctypes.Structure):
    _fields_ = [("version", ctypes.c_uint16), ("length", ctypes.c_uint16), ("cpuPLimit", ctypes.c_uint32), ("gpuPLimit", ctypes.c_uint32), ("memPLimit", ctypes.c_uint32)]

class KeyInfo(ctypes.Structure):
    _fields_ = [("dataSize", ctypes.c_uint32), ("dataType", ctypes.c_uint32), ("dataAttributes", ctypes.c_uint8)]

class SMCKeyData(ctypes.Structure):
    _fields_ = [
        ("key", ctypes.c_uint32), ("vers", Vers), ("pLimitData", PLimitData),
        ("keyInfo", KeyInfo), ("result", ctypes.c_uint8), ("status", ctypes.c_uint8),
        ("data8", ctypes.c_uint8), ("data32", ctypes.c_uint32), ("bytes", ctypes.c_uint8 * 32),
    ]

def fourcc(k): return struct.unpack(">I", k.encode("ascii"))[0]
def unfoucc(v): return struct.pack(">I", v).decode("ascii", errors="replace")

iokit = ctypes.CDLL(IOKIT_PATH)
libc = ctypes.CDLL(LIBC_PATH)
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

svc = iokit.IOServiceGetMatchingService(0, iokit.IOServiceMatching(b"AppleSMC"))
if not svc:
    sys.stderr.write("AppleSMC service not found\\n")
    sys.exit(2)
conn = ctypes.c_uint32(0)
kr = iokit.IOServiceOpen(svc, libc.mach_task_self(), 0, ctypes.byref(conn))
iokit.IOObjectRelease(svc)
if kr != 0:
    sys.stderr.write(f"IOServiceOpen(AppleSMC) failed: {hex(kr)}\\n")
    sys.exit(2)

def call(inp):
    out = SMCKeyData()
    sz = ctypes.c_size_t(ctypes.sizeof(out))
    rc = iokit.IOConnectCallStructMethod(conn.value, K_SMC_HANDLE_YIELD, ctypes.byref(inp), ctypes.sizeof(inp), ctypes.byref(out), ctypes.byref(sz))
    if rc != 0:
        raise RuntimeError(f"IOConnectCallStructMethod failed: {hex(rc)}")
    if out.result != 0:
        raise RuntimeError(f"SMC error result={out.result} for key={unfoucc(inp.key)}")
    return out

def key_info(k):
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.data8 = K_SMC_GET_KEY_INFO
    out = call(inp)
    return unfoucc(out.keyInfo.dataType), out.keyInfo.dataSize

def read_key(k):
    dt, sz = key_info(k)
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_READ_KEY
    out = call(inp)
    raw = bytes(out.bytes[:sz])
    if dt == "flt " and sz == 4: return float(struct.unpack("<f", raw)[0])
    if dt == "ui8 " and sz == 1: return int(raw[0])
    if dt == "ui16" and sz == 2: return int(struct.unpack(">H", raw)[0])
    if dt == "fpe2" and sz == 2: return float(struct.unpack(">H", raw)[0] >> 2)
    raise RuntimeError(f"Unsupported SMC read type {dt} for {k}")

def write_key(k, val):
    dt, sz = key_info(k)
    if dt == "flt " and sz == 4: payload = struct.pack("<f", float(val))
    elif dt == "ui8 " and sz == 1: payload = struct.pack("B", int(val))
    elif dt == "fpe2" and sz == 2: payload = struct.pack(">H", int(round(float(val) * 4)))
    else: raise RuntimeError(f"Unsupported SMC write type {dt} for {k}")
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_WRITE_KEY
    for i, b in enumerate(payload): inp.bytes[i] = b
    call(inp)

def read_fan(idx):
    mn = float(read_key(f"F{idx}Mn"))
    mx = float(read_key(f"F{idx}Mx"))
    ac = float(read_key(f"F{idx}Ac"))
    tg = float(read_key(f"F{idx}Tg"))
    md = int(read_key(f"F{idx}md"))
    span = mx - mn
    pct = 0.0 if span <= 0 else round(max(0.0, min(100.0, (ac - mn) / span * 100.0)), 1)
    return {
        "index": idx,
        "actualRpm": round(ac, 1),
        "targetRpm": round(tg, 1),
        "minRpm": round(mn, 1),
        "maxRpm": round(mx, 1),
        "mode": "manual" if md == 1 else "auto",
        "percent": pct,
    }

def read_all():
    count = int(read_key("FNum"))
    return [read_fan(i) for i in range(count)]

def wait_state(idx, mode, target=None, timeout=1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        f = read_fan(idx)
        if f["mode"] == mode and (target is None or abs(f["targetRpm"] - target) < 5.0):
            return
        time.sleep(0.05)

try:
    req = json.loads(sys.argv[1])
    if req["op"] == "write":
        for item in req["requests"]:
            idx = int(item["fanIndex"])
            if item["kind"] == "auto":
                write_key(f"F{idx}md", 0)
                wait_state(idx, "auto")
            else:
                tg = float(item["targetRpm"])
                write_key(f"F{idx}md", 1)
                write_key(f"F{idx}Tg", tg)
                wait_state(idx, "manual", tg)
    sys.stdout.write(json.dumps(read_all()))
except Exception as exc:
    sys.stderr.write(f"{exc}\\n")
    sys.exit(1)
finally:
    iokit.IOServiceClose(conn)
`;
