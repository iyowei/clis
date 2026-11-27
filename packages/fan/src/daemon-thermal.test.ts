/**
 * `daemon-thermal-script.ts` 边界对抗回归测试:
 * 覆盖低温 (<15°C) 冷启动动态温度键发现、高温下 --once 回到 floor_rpm 避让、单扇配置更新不牵连兄弟风扇及全 auto 唤醒复位。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DAEMON_CORE_PY } from './daemon-script.ts';
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
    if (res.status === 0 && res.stdout.trim() === 'ok') return bin;
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

describe('fan-daemon.py 温控边界对抗回归', () => {
  test.skipIf(TEST_PYTHON3 === null)(
    '低温冷机动态发现 Tg1C、高温 --once 压回下限避让、单扇改配置不误锁另一扇及全 auto 归还',
    () => {
      const dir = mkdtempSync(join(tmpdir(), 'fan-thermal-edge-'));
      tempDirs.push(dir);
      const statePath = join(dir, 'state.json');
      writeFileSync(
        statePath,
        JSON.stringify({
          version: 1,
          updatedAt: '2026-11-27T03:30:00.000Z',
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
store = {
    "#KEY": ("ui32", struct.pack(">I", 2)),
    "FNum": ("ui8 ", b"\\x02"),
    "F0md": ("ui8 ", b"\\x01"),
    "F1md": ("ui8 ", b"\\x01"),
    "F0Mn": ("flt ", struct.pack("<f", 1350.0)),
    "F0Mx": ("flt ", struct.pack("<f", 6250.0)),
    "F0Tg": ("flt ", struct.pack("<f", 3000.0)),
    "F1Mn": ("flt ", struct.pack("<f", 1350.0)),
    "F1Mx": ("flt ", struct.pack("<f", 6750.0)),
    "F1Tg": ("flt ", struct.pack("<f", 3000.0)),
    "Tg1C": ("flt ", struct.pack("<f", 11.5)),
    "Tf06": ("flt ", struct.pack("<f", 101.05)),
}

def call_raw(_conn, inp):
    out = SMCKeyData()
    if inp.data8 == K_SMC_GET_KEY_FROM_INDEX:
        out.result = 0
        out.key = fourcc("Tg1C" if inp.data32 == 0 else "Tf06")
        return out
    k = unfoucc(inp.key)
    if k not in store:
        out.result = K_SMC_KEY_NOT_FOUND
        return out
    dt, raw = store[k]
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
        store[k] = (dt, bytes(inp.bytes[:sz]))
        out.result = 0
        return out
    raise RuntimeError(f"unexpected op {inp.data8}")

smc_call_raw = call_raw
smc_open = lambda: FakeConn()
log = lambda _msg: None
read_pm_bool = lambda _svc, key: key == b"IOPMUserIsActive"

# 1) 11.5°C 冬季低温冷启动动态发现 Tg1C (忽略 Tf06=101.05), 随后升至 94°C 拉满
ctrl = create_power_reconciler(1)
ctrl["boot"]()
assert read_key(None, "F0Tg") == 3000.0
store["Tg1C"] = ("flt ", struct.pack("<f", 94.0))
for _ in range(7):
    ctrl["handle_thermal_tick"]()
assert read_key(None, "F0Tg") == 6250.0
assert read_key(None, "F1Tg") == 6750.0

# 2) 高温下用户执行 --once 把 Fan 1 压回 3000 RPM: 进入 detached 不被守护 2.5s 覆写
write_key(None, "F1Tg", 3000.0)
ctrl["handle_thermal_tick"]()
assert 1 in ctrl["thermal"]["detached"]
assert read_key(None, "F1Tg") == 3000.0

# 3) 高温下用户仅持久化改 Fan 1 为 2500 RPM: 降温后未改动的 Fan 0 不误入 detached, 双扇精确回落
write_key(None, "F1Tg", 2500.0)
with open(STATE_PATH, "w", encoding="utf-8") as fh:
    json.dump({
        "version": 1,
        "updatedAt": "2026-11-27T03:31:00.000Z",
        "fans": {
            "0": {"mode": "manual", "kind": "rpm", "value": 3000, "strategy": "floor"},
            "1": {"mode": "manual", "kind": "rpm", "value": 2500, "strategy": "floor"},
        },
    }, fh)
os.utime(STATE_PATH, ns=(4_000_000_000_000_000_000, 4_000_000_000_000_000_000))
store["Tg1C"] = ("flt ", struct.pack("<f", 42.0))
for _ in range(25):
    ctrl["handle_thermal_tick"]()
assert 0 not in ctrl["thermal"]["detached"]
assert read_key(None, "F0Tg") == 3000.0
assert read_key(None, "F1Tg") == 2500.0

# 4) 全 auto 持久化配置在 boot 时归还残留 manual 风扇回 auto
with open(STATE_PATH, "w", encoding="utf-8") as fh:
    json.dump({
        "version": 1,
        "updatedAt": "2026-11-27T03:32:00.000Z",
        "fans": {"0": {"mode": "auto"}, "1": {"mode": "auto"}},
    }, fh)
os.utime(STATE_PATH, ns=(5_000_000_000_000_000_000, 5_000_000_000_000_000_000))
ctrl_auto = create_power_reconciler(1)
ctrl_auto["boot"]()
assert read_fan_mode(None, 0) == "auto"
assert read_fan_mode(None, 1) == "auto"
print("THERMAL_EDGE_OK")
`;

      const res = spawnSync(TEST_PYTHON3!, ['-c', harness], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe('THERMAL_EDGE_OK');
    },
    25_000,
  );
});
