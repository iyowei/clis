/**
 * 内联于 `@iyowei/fan` 守护脚本的芯片核心温度采集与「保底下限 + 高温自动升速」闭环 (内部模块, 不进公开 API)。
 *
 * 设计要点:
 * 1. 优先通过已打开的 `AppleSMC` 连接直读 CPU/GPU 核心温度键 (`Tp*` / `Te*` / `Tg*` / `TC0D` 等, 严格避开 `Tf*` 校准常量键),
 *    单次采样 `< 0.2ms` 零跨进程 IPC; 若新机型无已知 SMC 温度键, 自动回退至 `IOHIDEventSystemClient` 读取 `PMU tdie*` / `MTR` 传感器;
 * 2. 当 `state.json` 含 `strategy != "fixed"` 且低于 `100%` 的手动保底条目时, 按 `65°C..92°C` 平滑渐进曲线与非对称 EMA 滤波
 *    计算 `max(floor_rpm, thermal_rpm)`, 并设 `60 RPM` 中间迟滞死区 (边界处 `5 RPM` 精确吸附), 降温后平缓落回用户下限;
 * 3. 当 `state.json` 为纯 `auto`、`--fixed` 或 `100%` 满速时, 定时器仅做单次 `os.stat` 检查即短路退出, 零 SMC / IOKit 调用;
 * 4. 自动识别未改写 `state.json` 的 `--once` 临时覆盖 (`detached` 集合), 绝不在会话中途覆写 `--once` 设定。
 */

export const DAEMON_THERMAL_CTYPES_PY = `
K_IOHID_EVENT_TYPE_TEMP = 15
K_IOHID_TEMP_LEVEL_FIELD = 983040
THERMAL_POLL_SEC = 2.5

TIMER_CB = ctypes.CFUNCTYPE(None, ctypes.c_void_p, ctypes.c_void_p)

iokit.IOHIDEventSystemClientCreate.argtypes = [ctypes.c_void_p]
iokit.IOHIDEventSystemClientCreate.restype = ctypes.c_void_p
iokit.IOHIDEventSystemClientCopyServices.argtypes = [ctypes.c_void_p]
iokit.IOHIDEventSystemClientCopyServices.restype = ctypes.c_void_p
iokit.IOHIDServiceClientCopyProperty.argtypes = [ctypes.c_void_p, ctypes.c_void_p]
iokit.IOHIDServiceClientCopyProperty.restype = ctypes.c_void_p
iokit.IOHIDServiceClientCopyEvent.argtypes = [
    ctypes.c_void_p,
    ctypes.c_int64,
    ctypes.c_int32,
    ctypes.c_int64,
]
iokit.IOHIDServiceClientCopyEvent.restype = ctypes.c_void_p
iokit.IOHIDEventGetFloatValue.argtypes = [ctypes.c_void_p, ctypes.c_uint32]
iokit.IOHIDEventGetFloatValue.restype = ctypes.c_double

cf.CFArrayGetCount.argtypes = [ctypes.c_void_p]
cf.CFArrayGetCount.restype = ctypes.c_long
cf.CFArrayGetValueAtIndex.argtypes = [ctypes.c_void_p, ctypes.c_long]
cf.CFArrayGetValueAtIndex.restype = ctypes.c_void_p
cf.CFStringGetCString.argtypes = [
    ctypes.c_void_p,
    ctypes.c_char_p,
    ctypes.c_long,
    ctypes.c_uint32,
]
cf.CFStringGetCString.restype = ctypes.c_bool
cf.CFStringGetTypeID.argtypes = []
cf.CFStringGetTypeID.restype = ctypes.c_ulong
cf.CFAbsoluteTimeGetCurrent.argtypes = []
cf.CFAbsoluteTimeGetCurrent.restype = ctypes.c_double
cf.CFRunLoopTimerCreate.argtypes = [
    ctypes.c_void_p,
    ctypes.c_double,
    ctypes.c_double,
    ctypes.c_ulong,
    ctypes.c_long,
    TIMER_CB,
    ctypes.c_void_p,
]
cf.CFRunLoopTimerCreate.restype = ctypes.c_void_p
cf.CFRunLoopAddTimer.argtypes = [ctypes.c_void_p, ctypes.c_void_p, ctypes.c_void_p]
`;

export const DAEMON_THERMAL_CORE_PY = `
TEMP_BOOST_START = 65.0
TEMP_BOOST_FULL = 92.0
SMC_DIE_TEMP_KEYS = (
    "Tp00",
    "Tp01",
    "Tp04",
    "Tp05",
    "Tp08",
    "Tp09",
    "Tp0C",
    "Tp0D",
    "Te00",
    "Te04",
    "Te05",
    "Tg00",
    "Tg04",
    "Tg05",
    "Tg08",
    "Tg0C",
    "Tg0D",
    "TC0D",
    "TC0E",
    "TC0F",
    "TC0P",
    "TC1C",
    "TG0D",
    "TG0P",
)
HID_DIE_TOKENS = ("tdie", "pacc", "eacc", "gpu mtr", "soc mtr")


def create_thermal_state():
    return {
        "mtime_ns": None,
        "cfg": None,
        "smc_temp_keys": None,
        "ema_temp": None,
        "last_targets": {},
        "detached": set(),
    }


def reset_thermal_runtime(thermal_state):
    thermal_state["ema_temp"] = None
    thermal_state["last_targets"].clear()
    thermal_state["detached"].clear()


def stat_state_mtime_ns():
    try:
        if not os.path.exists(STATE_PATH) or os.path.islink(STATE_PATH):
            return None
        return os.stat(STATE_PATH).st_mtime_ns
    except Exception:
        return None


def resolve_entry_base_rpm(entry, mn, mx):
    kind = entry.get("kind")
    val = float(entry.get("value", 0))
    if kind == "percent":
        pct = max(0.0, min(100.0, val))
        return int(mn + (pct / 100.0) * (mx - mn) + 0.5)
    return int(max(mn, min(mx, val)) + 0.5)


def is_floor_entry(entry):
    if not isinstance(entry, dict) or entry.get("mode") != "manual":
        return False
    if entry.get("strategy", "floor") == "fixed":
        return False
    if entry.get("kind") == "percent" and float(entry.get("value", 0)) >= 100.0:
        return False
    return True


def compute_floor_boost_rpm(floor_rpm, mn, mx, temp_c):
    clamped_floor = max(mn, min(mx, float(floor_rpm)))
    if temp_c is None or mx <= mn or clamped_floor >= mx:
        return int(clamped_floor + 0.5)
    if temp_c <= TEMP_BOOST_START:
        return int(clamped_floor + 0.5)
    if temp_c >= TEMP_BOOST_FULL:
        return int(mx + 0.5)
    x = (float(temp_c) - TEMP_BOOST_START) / (TEMP_BOOST_FULL - TEMP_BOOST_START)
    ratio = 0.35 * x + 0.65 * (x * x)
    thermal_rpm = mn + ratio * (mx - mn)
    return int(max(clamped_floor, min(mx, thermal_rpm)) + 0.5)


def read_hid_die_temp():
    create_fn = getattr(iokit, "IOHIDEventSystemClientCreate", None)
    if create_fn is None:
        return None
    client = create_fn(None)
    if not client:
        return None
    prod_key = cf.CFStringCreateWithCString(
        None, b"Product", K_CF_STRING_ENCODING_UTF8
    )
    if not prod_key:
        cf.CFRelease(client)
        return None
    svcs = iokit.IOHIDEventSystemClientCopyServices(client)
    best = None
    try:
        if svcs:
            str_tid = cf.CFStringGetTypeID()
            buf = ctypes.create_string_buffer(128)
            for i in range(cf.CFArrayGetCount(svcs)):
                sc = cf.CFArrayGetValueAtIndex(svcs, i)
                prop = iokit.IOHIDServiceClientCopyProperty(sc, prod_key)
                name = ""
                if prop:
                    try:
                        if cf.CFGetTypeID(prop) == str_tid and cf.CFStringGetCString(
                            prop, buf, 128, K_CF_STRING_ENCODING_UTF8
                        ):
                            name = buf.value.decode("utf-8", "replace").lower()
                    finally:
                        cf.CFRelease(prop)
                if not name or not any(tok in name for tok in HID_DIE_TOKENS):
                    continue
                ev = iokit.IOHIDServiceClientCopyEvent(
                    sc, K_IOHID_EVENT_TYPE_TEMP, 0, 0
                )
                if not ev:
                    continue
                try:
                    val = float(
                        iokit.IOHIDEventGetFloatValue(ev, K_IOHID_TEMP_LEVEL_FIELD)
                    )
                finally:
                    cf.CFRelease(ev)
                if 0.0 <= val <= 125.0 and (best is None or val > best):
                    best = val
    finally:
        if svcs:
            cf.CFRelease(svcs)
        cf.CFRelease(prod_key)
        cf.CFRelease(client)
    return best


def discover_smc_temp_keys(conn):
    found = []
    seen = set()
    total = read_key_opt(conn, "#KEY")
    if total is not None and int(total) > 0:
        for idx in range(int(total)):
            q = SMCKeyData()
            q.data8 = K_SMC_GET_KEY_FROM_INDEX
            q.data32 = idx
            out = smc_call_raw(conn, q)
            if out.result != 0 or not out.key:
                continue
            name = unfoucc(out.key)
            if name in seen or not name.startswith(("Tp", "Te", "Tg", "TC", "TG")):
                continue
            info = key_info_opt(conn, name)
            if info is not None and info[0] in ("flt ", "sp78"):
                seen.add(name)
                found.append(name)
    for cand in SMC_DIE_TEMP_KEYS:
        if cand in seen:
            continue
        info = key_info_opt(conn, cand)
        if info is not None and info[0] in ("flt ", "sp78"):
            seen.add(cand)
            found.append(cand)
    return tuple(found)


def read_hotspot_temp(conn, thermal_state):
    keys = thermal_state["smc_temp_keys"]
    if keys is None:
        keys = discover_smc_temp_keys(conn)
        thermal_state["smc_temp_keys"] = keys

    best = None
    for k in keys:
        try:
            val = read_key_opt(conn, k)
        except Exception:
            val = None
        if val is not None and 0.0 <= float(val) <= 125.0:
            fval = float(val)
            if best is None or fval > best:
                best = fval
    if best is not None:
        return best
    return read_hid_die_temp()


def update_ema_temp(thermal_state, raw_temp):
    prev = thermal_state["ema_temp"]
    if raw_temp is None:
        return prev
    if prev is None:
        thermal_state["ema_temp"] = float(raw_temp)
    elif raw_temp > prev:
        thermal_state["ema_temp"] = prev + 0.55 * (float(raw_temp) - prev)
    else:
        thermal_state["ema_temp"] = prev + 0.25 * (float(raw_temp) - prev)
    return thermal_state["ema_temp"]


def run_thermal_floor_tick(thermal_state, load_state_fn):
    cur_mtime = stat_state_mtime_ns()
    if cur_mtime != thermal_state["mtime_ns"]:
        prev_cfg = (
            thermal_state["cfg"] if isinstance(thermal_state["cfg"], dict) else {}
        )
        thermal_state["mtime_ns"] = cur_mtime
        try:
            next_cfg = load_state_fn() if cur_mtime is not None else None
        except Exception:
            next_cfg = None
        thermal_state["cfg"] = next_cfg
        next_dict = next_cfg if isinstance(next_cfg, dict) else {}
        for k in set(prev_cfg.keys()) | set(next_dict.keys()):
            if prev_cfg.get(k) != next_dict.get(k) and str(k).isdigit():
                fidx = int(k)
                thermal_state["last_targets"].pop(fidx, None)
                thermal_state["detached"].discard(fidx)

    cfg = thermal_state["cfg"]
    if not isinstance(cfg, dict) or not any(
        is_floor_entry(v) for v in cfg.values()
    ):
        thermal_state["ema_temp"] = None
        return

    conn = None
    try:
        conn = smc_open()
        count = read_fan_count(conn)
        raw_temp = read_hotspot_temp(conn, thermal_state)
        ema_temp = update_ema_temp(thermal_state, raw_temp)
        for idx in range(count):
            entry = cfg.get(str(idx))
            if not is_floor_entry(entry):
                continue
            mn = float(read_key(conn, f"F{idx}Mn"))
            mx = float(read_key(conn, f"F{idx}Mx"))
            floor_rpm = resolve_entry_base_rpm(entry, mn, mx)
            if floor_rpm >= mx - 1.0:
                continue
            cur_mode = read_fan_mode(conn, idx)
            cur_tg = read_key_opt(conn, f"F{idx}Tg")
            expected = thermal_state["last_targets"].get(idx, floor_rpm)

            if idx in thermal_state["detached"]:
                if (
                    cur_mode == "manual"
                    and cur_tg is not None
                    and abs(float(cur_tg) - floor_rpm) <= 25.0
                ):
                    thermal_state["detached"].discard(idx)
                else:
                    continue
            elif cur_mode != "manual" or (
                cur_tg is not None and abs(float(cur_tg) - expected) > 35.0
            ):
                thermal_state["detached"].add(idx)
                continue

            desired = compute_floor_boost_rpm(floor_rpm, mn, mx, ema_temp)
            cur_val = float(cur_tg) if cur_tg is not None else -1.0
            at_edge = desired <= floor_rpm or desired >= int(mx + 0.5)
            deadband = 5.0 if at_edge else 60.0
            if abs(desired - cur_val) >= deadband:
                set_fan_mode(conn, idx, True)
                write_key(conn, f"F{idx}Tg", float(desired))
                thermal_state["last_targets"][idx] = desired
            elif idx not in thermal_state["last_targets"]:
                thermal_state["last_targets"][idx] = int(round(cur_val))
    except Exception as exc:
        log(f"thermal-floor tick error: {exc}")
    finally:
        if conn is not None and conn.value:
            iokit.IOServiceClose(conn)
`;
