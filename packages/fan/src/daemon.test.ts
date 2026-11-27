/**
 * `daemon.ts` 与 `daemon-script.ts` 回归测试:
 * - LaunchDaemon plist 生成与幂等 `ensurePersistDaemon` 短路判定
 * - 跨平台 Python 电源状态机仿真: 覆盖 USB-C 唤醒升格 FullWake、真 DarkWake、DarkWake->FullWake 升格、亮屏会话空闲息屏、外接屏合盖与无外接屏合盖
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_CORE_PY, buildDaemonPythonScript } from './daemon-script.ts';
import { MACOS_PYTHON3_BIN } from './smc-apple.ts';
import { SMC_PY_STRUCTS_AND_CORE } from './smc-script.ts';

function resolveTestPython3(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [MACOS_PYTHON3_BIN, 'python3']
      : ['python3'];
  for (const bin of candidates) {
    if (bin.startsWith('/') && !existsSync(bin)) continue;
    const res = spawnSync(
      bin,
      ['-c', 'import ctypes, json, struct; print("ok")'],
      {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 5_000,
      },
    );
    if (res.status === 0 && res.stdout.trim() === 'ok') {
      return bin;
    }
  }
  return null;
}

const TEST_PYTHON3 = resolveTestPython3();
const tempDirs: string[] = [];

afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'fan-daemon-test-'));
  tempDirs.push(dir);
  return dir;
}

describe('fan-daemon.py 电源状态机回归仿真', () => {
  test.skipIf(TEST_PYTHON3 === null)(
    '完整守护脚本语法合法, 且精确区分 USB-C 升格 FullWake、真 DarkWake、升格恢复、空闲息屏与合盖模式',
    () => {
      const dir = makeTempDir();
      const statePath = join(dir, 'state.json');
      const fullScriptPath = join(dir, 'full-daemon.py');
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-27T02:46:45.000Z',
          fans: {
            '0': { mode: 'manual', kind: 'percent', value: 100 },
            '1': { mode: 'manual', kind: 'percent', value: 100 },
          },
        }),
        'utf8',
      );
      writeFileSync(fullScriptPath, buildDaemonPythonScript(statePath), 'utf8');

      const harness = `
import ctypes, json, os, struct, sys, time

with open(${JSON.stringify(fullScriptPath)}, "r", encoding="utf-8") as src_fh:
    compile(src_fh.read(), "fan-daemon.py", "exec")

STATE_PATH = ${JSON.stringify(statePath)}
${SMC_PY_STRUCTS_AND_CORE}
${DAEMON_CORE_PY}

class FakeConn:
    value = 1

class FakeIOKit:
    def IOServiceClose(self, _conn):
        pass

iokit = FakeIOKit()

class FakeSMC:
    def __init__(self):
        self.store = {
            "FNum": ("ui8 ", b"\\x02"),
            "F0md": ("ui8 ", b"\\x01"),
            "F1md": ("ui8 ", b"\\x01"),
            "F0Mn": ("flt ", struct.pack("<f", 1350.0)),
            "F0Mx": ("flt ", struct.pack("<f", 6250.0)),
            "F0Tg": ("flt ", struct.pack("<f", 6250.0)),
            "F1Mn": ("flt ", struct.pack("<f", 1350.0)),
            "F1Mx": ("flt ", struct.pack("<f", 6750.0)),
            "F1Tg": ("flt ", struct.pack("<f", 6750.0)),
        }

    def call_raw(self, _conn, inp):
        out = SMCKeyData()
        k = unfoucc(inp.key)
        if k not in self.store:
            out.result = K_SMC_KEY_NOT_FOUND
            return out
        dt, raw = self.store[k]
        if inp.data8 == K_SMC_GET_KEY_INFO:
            out.result = 0
            out.keyInfo.dataType = fourcc(dt)
            out.keyInfo.dataSize = len(raw)
            return out
        if inp.data8 == K_SMC_READ_KEY:
            out.result = 0
            for i, b in enumerate(raw):
                out.bytes[i] = b
            return out
        if inp.data8 == K_SMC_WRITE_KEY:
            sz = inp.keyInfo.dataSize
            self.store[k] = (dt, bytes(inp.bytes[:sz]))
            out.result = 0
            return out
        raise RuntimeError(f"unexpected op {inp.data8}")

smc = FakeSMC()
smc_call_raw = smc.call_raw
smc_open = lambda: FakeConn()
logs = []
log = lambda msg: logs.append(msg)

pm_props = {
    b"AppleClamshellState": False,
    b"AppleClamshellCausesSleep": False,
    # 复现真机现场: USB-C 唤醒升格 FullWake 后 IOPMUserTriggeredFullWake 保持 False, IOPMUserIsActive 为 True
    b"IOPMUserTriggeredFullWake": False,
    b"IOPMUserIsActive": True,
}
read_pm_bool = lambda svc, key: pm_props.get(key) if svc else None

# 1) 守护在 USB-C 唤醒升格 FullWake 会话中启动/重启: 绝不误判为 boot-dark-wake!
ctrl = create_power_reconciler(1)
ctrl["boot"]()
assert ctrl["runtime"]["dark_wake"] is False
assert ctrl["runtime"]["suspended"] is False
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"
assert read_key(None, "F0Tg") == 6250.0
assert read_key(None, "F1Tg") == 6750.0

# 2) 亮屏会话期间屏幕空闲自动息屏 (未睡眠、未合盖): 保持手动全速散热不中断
pm_props[b"IOPMUserIsActive"] = False
ctrl["handle_interest"]()
assert ctrl["runtime"]["suspended"] is False
assert read_fan_mode(None, 0) == "manual"

# 3) 外接显示器合盖办公 (CausesSleep=False) 保持手动; 拔掉外接屏 (CausesSleep=True) 立即交还 auto
pm_props[b"IOPMUserIsActive"] = True
pm_props[b"AppleClamshellState"] = True
pm_props[b"AppleClamshellCausesSleep"] = False
ctrl["handle_interest"]()
assert ctrl["runtime"]["suspended"] is False
assert read_fan_mode(None, 0) == "manual"

pm_props[b"AppleClamshellCausesSleep"] = True
ctrl["handle_interest"]()
assert ctrl["runtime"]["suspended"] is True
assert read_fan_mode(None, 0) == "auto"
assert read_fan_mode(None, 1) == "auto"

# 开盖立即恢复 100% 全速
pm_props[b"AppleClamshellState"] = False
pm_props[b"AppleClamshellCausesSleep"] = False
ctrl["handle_interest"]()
assert ctrl["runtime"]["suspended"] is False
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"

# 4) 系统睡眠 -> 夜间无头 DarkWake 保持静音 -> 用户触控升格 FullWake 立即恢复全速
ctrl["handle_will_sleep"]()
assert ctrl["runtime"]["suspended"] is True
assert read_fan_mode(None, 0) == "auto"

pm_props[b"IOPMUserTriggeredFullWake"] = False
pm_props[b"IOPMUserIsActive"] = False
ctrl["handle_powered_on"](0)
assert ctrl["runtime"]["dark_wake"] is True
assert ctrl["runtime"]["suspended"] is True
assert read_fan_mode(None, 0) == "auto"

# DarkWake 期间即便固件或残余把风扇置为 manual, force_check_on_wake 也会兜底释放回 auto
set_fan_mode(None, 0, True)
ctrl["handle_powered_on"](0)
assert read_fan_mode(None, 0) == "auto"

# 用户拍击键盘升格为 FullWake (XNU 仅将 IOPMUserIsActive 置 True, IOPMUserTriggeredFullWake 仍为 False)
pm_props[b"IOPMUserIsActive"] = True
ctrl["handle_interest"]()
assert ctrl["runtime"]["dark_wake"] is False
assert ctrl["runtime"]["suspended"] is False
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"
assert read_key(None, "F0Tg") == 6250.0
assert read_key(None, "F1Tg") == 6750.0
print("DAEMON_STATE_MACHINE_OK")
`;

      const res = spawnSync(TEST_PYTHON3!, ['-c', harness], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe('DAEMON_STATE_MACHINE_OK');
    },
    25_000,
  );
});

describe('fan-daemon.py 保底下限温控闭环仿真', () => {
  test.skipIf(TEST_PYTHON3 === null)(
    '保底下限 (floor) 闭环随核心温度升高平滑提速、降温回落死守下限, 忽略 Tf* 常量并尊重 --fixed 与 --once',
    () => {
      const dir = makeTempDir();
      const statePath = join(dir, 'floor-state.json');
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-27T03:20:00.000Z',
          fans: {
            '0': {
              mode: 'manual',
              kind: 'rpm',
              value: 3000,
              strategy: 'floor',
            },
            '1': {
              mode: 'manual',
              kind: 'rpm',
              value: 3000,
              strategy: 'floor',
            },
          },
        }),
        'utf8',
      );

      const harness = `
import ctypes, json, os, struct, time

STATE_PATH = ${JSON.stringify(statePath)}
${SMC_PY_STRUCTS_AND_CORE}
${DAEMON_CORE_PY}

class FakeConn:
    value = 1

class FakeIOKit:
    def IOServiceClose(self, _conn):
        pass

iokit = FakeIOKit()
open_count = 0

class FakeSMC:
    def __init__(self):
        self.store = {
            "FNum": ("ui8 ", b"\\x02"),
            "F0md": ("ui8 ", b"\\x01"),
            "F1md": ("ui8 ", b"\\x01"),
            "F0Mn": ("flt ", struct.pack("<f", 1350.0)),
            "F0Mx": ("flt ", struct.pack("<f", 6250.0)),
            "F0Tg": ("flt ", struct.pack("<f", 3000.0)),
            "F1Mn": ("flt ", struct.pack("<f", 1350.0)),
            "F1Mx": ("flt ", struct.pack("<f", 6750.0)),
            "F1Tg": ("flt ", struct.pack("<f", 3000.0)),
            "Tp00": ("flt ", struct.pack("<f", 48.0)),
            "Tg08": ("flt ", struct.pack("<f", 46.5)),
            # Apple M5 Max 真机存在的 Tf06=101.05 校准常量键: 严禁误采导致低温满速!
            "Tf06": ("flt ", struct.pack("<f", 101.05)),
        }

    def set_die_temp(self, temp_c):
        self.store["Tp00"] = ("flt ", struct.pack("<f", float(temp_c)))

    def call_raw(self, _conn, inp):
        out = SMCKeyData()
        k = unfoucc(inp.key)
        if k not in self.store:
            out.result = K_SMC_KEY_NOT_FOUND
            return out
        dt, raw = self.store[k]
        if inp.data8 == K_SMC_GET_KEY_INFO:
            out.result = 0
            out.keyInfo.dataType = fourcc(dt)
            out.keyInfo.dataSize = len(raw)
            return out
        if inp.data8 == K_SMC_READ_KEY:
            out.result = 0
            for i, b in enumerate(raw):
                out.bytes[i] = b
            return out
        if inp.data8 == K_SMC_WRITE_KEY:
            sz = inp.keyInfo.dataSize
            self.store[k] = (dt, bytes(inp.bytes[:sz]))
            out.result = 0
            return out
        raise RuntimeError(f"unexpected op {inp.data8}")

smc = FakeSMC()
smc_call_raw = smc.call_raw

def smc_open_counted():
    global open_count
    open_count += 1
    return FakeConn()

smc_open = smc_open_counted
log = lambda _msg: None
read_pm_bool = lambda _svc, key: key == b"IOPMUserIsActive"

ctrl = create_power_reconciler(1)
ctrl["boot"]()

# 1) 48°C 常规办公低温: 忽略 Tf06=101.05, 稳守 3000 RPM 下限
ctrl["handle_thermal_tick"]()
assert read_key(None, "F0Tg") == 3000.0
assert read_key(None, "F1Tg") == 3000.0

# 2) 核心温度升至 86°C -> 自动突破 3000 RPM 平滑提速; 升至 94°C -> 拉满各自 maxRpm
smc.set_die_temp(86.0)
for _ in range(4):
    ctrl["handle_thermal_tick"]()
boosted_f0 = read_key(None, "F0Tg")
boosted_f1 = read_key(None, "F1Tg")
assert boosted_f0 > 4000.0, f"expected >4000, got {boosted_f0}"
assert boosted_f1 > boosted_f0

smc.set_die_temp(94.0)
for _ in range(4):
    ctrl["handle_thermal_tick"]()
assert read_key(None, "F0Tg") == 6250.0
assert read_key(None, "F1Tg") == 6750.0

# 3) 负载结束降温至 45°C -> 平滑回落并精确停在 3000 RPM 下限, 绝不跌破阈值
smc.set_die_temp(45.0)
for _ in range(25):
    ctrl["handle_thermal_tick"]()
    assert read_key(None, "F0Tg") >= 3000.0
    assert read_key(None, "F1Tg") >= 3000.0
assert read_key(None, "F0Tg") == 3000.0
assert read_key(None, "F1Tg") == 3000.0

# 4) 用户对 Fan 0 执行 --once 临时改为 5200 RPM (未改 state.json mtime): 守护自动避让不覆盖
write_key(None, "F0Tg", 5200.0)
smc.set_die_temp(50.0)
ctrl["handle_thermal_tick"]()
assert 0 in ctrl["thermal"]["detached"]
assert read_key(None, "F0Tg") == 5200.0
assert read_key(None, "F1Tg") == 3000.0

# 5) 切换为 --fixed 持久化预设 (mtime 更新): 即便 95°C 也零 SMC 轮询、恒定锁在 3000 RPM
write_key(None, "F0Tg", 3000.0)
with open(STATE_PATH, "w", encoding="utf-8") as fh:
    json.dump({
        "version": 1,
        "updatedAt": "2026-11-27T03:25:00.000Z",
        "fans": {
            "0": {"mode": "manual", "kind": "rpm", "value": 3000, "strategy": "fixed"},
            "1": {"mode": "manual", "kind": "rpm", "value": 3000, "strategy": "fixed"},
        },
    }, fh)
os.utime(STATE_PATH, ns=(2_000_000_000_000_000_000, 2_000_000_000_000_000_000))
before_opens = open_count
smc.set_die_temp(95.0)
ctrl["handle_thermal_tick"]()
assert open_count == before_opens
assert read_key(None, "F0Tg") == 3000.0
print("THERMAL_FLOOR_LOOP_OK")
`;

      const res = spawnSync(TEST_PYTHON3!, ['-c', harness], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe('THERMAL_FLOOR_LOOP_OK');
    },
    25_000,
  );
});
