/**
 * 内联于 `@iyowei/fan` 的零依赖 macOS `IOKit`/`AppleSMC` ctypes 驱动脚本 (内部模块, 不进公开 API)。
 * 通过 `/usr/bin/python3 -c` 执行, 使 Bun 与 Node (>= 22.18) 保持完全一致的硬件交互与最小化 `sudo` 提权边界。
 *
 * 跨代 Mac SMC 兼容矩阵:
 * - Apple M5 系列: `F{i}md` (`ui8 `, `0`=auto, `1`=manual) + `flt ` 转速键;
 * - Apple M1–M4 / T2 Mac: `F{i}Md` (`ui8 ` / `flag`, `0`/`3`=auto, `1`=manual), M3/M4 受 `thermalmonitord` 锁定时自动联动 `Ftst` 解锁与归还;
 * - 经典 Intel Mac: 无单扇模式键时回退至全局强制位掩码 `FS! ` (`ui16` / `hex_` / `{fds`, bit `i` 对应第 `i` 把风扇) + `fpe2` / `flt ` 转速键;
 * - 无风扇机型 (如 MacBook Air): `FNum` 缺失 (`result=132`) 或为 `0` 时平滑返回空数组 `[]`, 交由上层报结构化 `SMC_UNAVAILABLE`。
 */

export const SMC_PY_STRUCTS_AND_CORE = `
K_SMC_HANDLE_YIELD = 2
K_SMC_READ_KEY = 5
K_SMC_WRITE_KEY = 6
K_SMC_GET_KEY_INFO = 9
K_SMC_KEY_NOT_FOUND = 132


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


def fourcc(k):
    return struct.unpack(">I", k.encode("ascii"))[0]


def unfoucc(v):
    return struct.pack(">I", v).decode("ascii", errors="replace")


def smc_call_raw(conn, inp):
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
    return out


def smc_call(conn, inp):
    out = smc_call_raw(conn, inp)
    if out.result != 0:
        raise RuntimeError(
            f"SMC error result={out.result} for key={unfoucc(inp.key)}"
        )
    return out


def key_info_opt(conn, k):
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.data8 = K_SMC_GET_KEY_INFO
    out = smc_call_raw(conn, inp)
    if out.result == K_SMC_KEY_NOT_FOUND or out.keyInfo.dataSize == 0:
        return None
    if out.result != 0:
        raise RuntimeError(f"SMC error result={out.result} for key={k}")
    return unfoucc(out.keyInfo.dataType), out.keyInfo.dataSize


def key_info(conn, k):
    info = key_info_opt(conn, k)
    if info is None:
        raise RuntimeError(f"SMC error result={K_SMC_KEY_NOT_FOUND} for key={k}")
    return info


def decode_smc_bytes(k, dt, sz, raw):
    if dt == "flt " and sz == 4:
        return float(struct.unpack("<f", raw)[0])
    if dt == "fpe2" and sz == 2:
        return float(struct.unpack(">H", raw)[0]) / 4.0
    if dt == "sp78" and sz == 2:
        return float(struct.unpack(">h", raw)[0]) / 256.0
    if dt in ("ui8 ", "flag") and sz == 1:
        return int(raw[0])
    if dt in ("ui16", "hex_", "{fds", "[ui8") and sz in (1, 2):
        return int.from_bytes(raw, "big")
    if dt == "ui32" and sz == 4:
        return int(struct.unpack(">I", raw)[0])
    raise RuntimeError(f"Unsupported SMC read type {dt} for {k}")


def encode_smc_bytes(k, dt, sz, val):
    if dt == "flt " and sz == 4:
        return struct.pack("<f", float(val))
    if dt == "fpe2" and sz == 2:
        clamped = max(0, min(0xFFFF, int(round(float(val) * 4.0))))
        return struct.pack(">H", clamped)
    if dt == "sp78" and sz == 2:
        return struct.pack(">h", int(round(float(val) * 256.0)))
    if dt in ("ui8 ", "flag") and sz == 1:
        return struct.pack("B", int(val) & 0xFF)
    if dt in ("ui16", "hex_", "{fds", "[ui8") and sz in (1, 2):
        return (int(val) & ((1 << (sz * 8)) - 1)).to_bytes(sz, "big")
    if dt == "ui32" and sz == 4:
        return struct.pack(">I", int(val))
    raise RuntimeError(f"Unsupported SMC write type {dt} for {k}")


def read_key_opt(conn, k):
    info = key_info_opt(conn, k)
    if info is None:
        return None
    dt, sz = info
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_READ_KEY
    out = smc_call_raw(conn, inp)
    if out.result == K_SMC_KEY_NOT_FOUND:
        return None
    if out.result != 0:
        raise RuntimeError(f"SMC error result={out.result} for key={k}")
    return decode_smc_bytes(k, dt, sz, bytes(out.bytes[:sz]))


def read_key(conn, k):
    val = read_key_opt(conn, k)
    if val is None:
        raise RuntimeError(f"SMC error result={K_SMC_KEY_NOT_FOUND} for key={k}")
    return val


def write_key(conn, k, val):
    dt, sz = key_info(conn, k)
    payload = encode_smc_bytes(k, dt, sz, val)
    inp = SMCKeyData()
    inp.key = fourcc(k)
    inp.keyInfo.dataSize = sz
    inp.data8 = K_SMC_WRITE_KEY
    for i, b in enumerate(payload):
        inp.bytes[i] = b
    smc_call(conn, inp)


def read_fan_count(conn):
    cnt = read_key_opt(conn, "FNum")
    if cnt is None:
        return 0
    return max(0, int(cnt))


def resolve_mode_key(conn, idx):
    for cand in (f"F{idx}md", f"F{idx}Md"):
        if key_info_opt(conn, cand) is not None:
            return cand
    return None


def read_fan_mode(conn, idx):
    mk = resolve_mode_key(conn, idx)
    if mk is not None:
        md = read_key_opt(conn, mk)
        if md is not None and int(md) == 1:
            return "manual"
    mask = read_key_opt(conn, "FS! ")
    if mask is not None and (int(mask) & (1 << idx)) != 0:
        return "manual"
    return "auto"


def unlock_and_write_mode_manual(conn, mk):
    if key_info_opt(conn, "Ftst") is None:
        return False
    write_key(conn, "Ftst", 1)
    deadline = time.monotonic() + 8.0
    last_err = None
    while time.monotonic() < deadline:
        try:
            write_key(conn, mk, 1)
            if int(read_key_opt(conn, mk) or 0) == 1:
                time.sleep(0.12)
                if int(read_key_opt(conn, mk) or 0) == 1:
                    return True
        except Exception as exc:
            last_err = exc
        time.sleep(0.1)
    if last_err is not None:
        raise last_err
    return int(read_key_opt(conn, mk) or 0) == 1


def set_fan_mode(conn, idx, manual):
    mk = resolve_mode_key(conn, idx)
    has_fs = key_info_opt(conn, "FS! ") is not None
    if manual:
        if mk is not None:
            wrote = False
            first_err = None
            cur_md = read_key_opt(conn, mk)
            locked_by_thermal = (
                cur_md is not None
                and int(cur_md) == 3
                and key_info_opt(conn, "Ftst") is not None
            )
            if not locked_by_thermal:
                try:
                    write_key(conn, mk, 1)
                    wrote = int(read_key_opt(conn, mk) or 0) == 1
                except Exception as exc:
                    first_err = exc
            if not wrote:
                if unlock_and_write_mode_manual(conn, mk):
                    wrote = True
                elif not has_fs and first_err is not None:
                    raise first_err
            if wrote:
                return
        if has_fs:
            mask = int(read_key(conn, "FS! "))
            write_key(conn, "FS! ", mask | (1 << idx))
            return
        raise RuntimeError(
            f"SMC fan mode key not found for fan {idx} (tried F{idx}md, F{idx}Md, FS! )"
        )

    handled = False
    if mk is not None:
        handled = True
        cur = read_key_opt(conn, mk)
        if cur is not None and int(cur) == 1:
            write_key(conn, mk, 0)
    if has_fs:
        handled = True
        mask = int(read_key(conn, "FS! "))
        next_mask = mask & ~(1 << idx)
        if next_mask != mask:
            write_key(conn, "FS! ", next_mask)
    if not handled:
        raise RuntimeError(
            f"SMC fan mode key not found for fan {idx} (tried F{idx}md, F{idx}Md, FS! )"
        )


def sync_ftst_if_all_auto(conn, count):
    if key_info_opt(conn, "Ftst") is None:
        return
    if all(read_fan_mode(conn, i) != "manual" for i in range(count)):
        cur = read_key_opt(conn, "Ftst")
        if cur is not None and int(cur) != 0:
            try:
                write_key(conn, "Ftst", 0)
            except Exception:
                pass
`;

export const SMC_PY_SCRIPT = `
import ctypes, json, struct, sys, time

IOKIT_PATH = "/System/Library/Frameworks/IOKit.framework/IOKit"
LIBC_PATH = "/usr/lib/libc.dylib"
${SMC_PY_STRUCTS_AND_CORE}

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


def read_fan(conn, idx):
    mn = float(read_key(conn, f"F{idx}Mn"))
    mx = float(read_key(conn, f"F{idx}Mx"))
    ac = float(read_key(conn, f"F{idx}Ac"))
    tg_opt = read_key_opt(conn, f"F{idx}Tg")
    tg = float(tg_opt) if tg_opt is not None else ac
    mode = read_fan_mode(conn, idx)
    span = mx - mn
    pct = 0.0 if span <= 0 else round(max(0.0, min(100.0, (ac - mn) / span * 100.0)), 1)
    return {
        "index": idx,
        "actualRpm": round(ac, 1),
        "targetRpm": round(tg, 1),
        "minRpm": round(mn, 1),
        "maxRpm": round(mx, 1),
        "mode": mode,
        "percent": pct,
    }


def read_all(conn):
    count = read_fan_count(conn)
    return [read_fan(conn, i) for i in range(count)]


def wait_state(conn, idx, mode, target=None, timeout=1.0):
    deadline = time.monotonic() + timeout
    while time.monotonic() < deadline:
        f = read_fan(conn, idx)
        if f["mode"] == mode and (target is None or abs(f["targetRpm"] - target) < 5.0):
            return
        time.sleep(0.05)


try:
    req = json.loads(sys.argv[1])
    if req["op"] == "write":
        count = read_fan_count(conn)
        saw_auto = False
        for item in req["requests"]:
            idx = int(item["fanIndex"])
            if item["kind"] == "auto":
                set_fan_mode(conn, idx, False)
                saw_auto = True
                wait_state(conn, idx, "auto")
            else:
                tg = float(item["targetRpm"])
                set_fan_mode(conn, idx, True)
                write_key(conn, f"F{idx}Tg", tg)
                wait_state(conn, idx, "manual", tg)
        if saw_auto:
            sync_ftst_if_all_auto(conn, count)
    sys.stdout.write(json.dumps(read_all(conn)))
except Exception as exc:
    sys.stderr.write(f"{exc}\\n")
    sys.exit(1)
finally:
    iokit.IOServiceClose(conn)
`;
