/**
 * `AppleSmcTransport` 跨平台分支、跨代 SMC 协议矩阵与 macOS 只读真机冒烟测试。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';

import { isFanError } from './errors.ts';
import { MACOS_PYTHON3_BIN, createAppleSmcTransport } from './smc-apple.ts';
import { SMC_PY_STRUCTS_AND_CORE } from './smc-script.ts';

function resolveTestPython3(): string | null {
  const candidates =
    process.platform === 'darwin'
      ? [MACOS_PYTHON3_BIN, 'python3']
      : ['python3'];
  for (const bin of candidates) {
    if (bin.startsWith('/') && !existsSync(bin)) continue;
    const res = spawnSync(bin, ['-c', 'import ctypes, struct; print("ok")'], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 5000,
    });
    if (res.status === 0 && res.stdout.trim() === 'ok') {
      return bin;
    }
  }
  return null;
}

const TEST_PYTHON3 = resolveTestPython3();

describe('createAppleSmcTransport (注入)', () => {
  test('非 macOS 平台拒绝并抛 UNSUPPORTED_PLATFORM', () => {
    const transport = createAppleSmcTransport({ platform: 'linux' });
    try {
      transport.readFans();
      throw new Error('Expected UNSUPPORTED_PLATFORM');
    } catch (err) {
      expect(isFanError(err)).toBe(true);
      if (isFanError(err)) expect(err.code).toBe('UNSUPPORTED_PLATFORM');
    }
    expect(transport.isMacsFanControlRunning()).toBe(false);
  });

  test('非 root 写操作经绝对路径 sudo 调用系统 python3, 读操作不走 sudo', () => {
    const calls: Array<{ cmd: string; args: string[] }> = [];
    const fakeFans = JSON.stringify([
      {
        index: 0,
        actualRpm: 3000,
        targetRpm: 3000,
        minRpm: 1350,
        maxRpm: 6250,
        mode: 'manual',
        percent: 33.7,
      },
    ]);
    const transport = createAppleSmcTransport({
      platform: 'darwin',
      geteuid: () => 501,
      exists: () => true,
      spawnSyncFn: ((cmd: string, args: string[]) => {
        calls.push({ cmd, args: [...args] });
        return {
          pid: 1,
          output: ['', fakeFans, ''],
          stdout: fakeFans,
          stderr: '',
          status: 0,
          signal: null,
        };
      }) as never,
    });

    const read = transport.readFans();
    expect(read[0]?.actualRpm).toBe(3000);
    expect(calls[0]?.cmd).toBe(MACOS_PYTHON3_BIN);

    const written = transport.applyWrites([
      { kind: 'manual', fanIndex: 0, targetRpm: 4000 },
    ]);
    expect(written).toHaveLength(1);
    expect(calls[1]?.cmd).toBe('/usr/bin/sudo');
    expect(calls[1]?.args[0]).toBe(MACOS_PYTHON3_BIN);
  });

  test('只读超时 (ETIMEDOUT) 转换为结构化 SMC_UNAVAILABLE', () => {
    const transport = createAppleSmcTransport({
      platform: 'darwin',
      exists: () => true,
      readTimeoutMs: 50,
      spawnSyncFn: (() => ({
        pid: 1,
        output: ['', '', ''],
        stdout: '',
        stderr: '',
        status: null,
        signal: null,
        error: Object.assign(new Error('spawnSync ETIMEDOUT'), {
          code: 'ETIMEDOUT',
        }),
      })) as never,
    });
    try {
      transport.readFans();
      throw new Error('Expected SMC_UNAVAILABLE');
    } catch (err) {
      expect(isFanError(err)).toBe(true);
      if (isFanError(err)) expect(err.code).toBe('SMC_UNAVAILABLE');
    }
  });

  test('root 写操作与 pgrep 冲突探测均附带非交互 stdio 与超时守卫', () => {
    const optsSeen: Array<{
      cmd: string;
      stdio: unknown;
      timeout: number | undefined;
    }> = [];
    const fakeFans = JSON.stringify([
      {
        index: 0,
        actualRpm: 4000,
        targetRpm: 4000,
        minRpm: 1350,
        maxRpm: 6250,
        mode: 'manual',
        percent: 54.1,
      },
    ]);
    const transport = createAppleSmcTransport({
      platform: 'darwin',
      geteuid: () => 0,
      exists: () => true,
      readTimeoutMs: 4321,
      writeTimeoutMs: 12_345,
      spawnSyncFn: ((
        cmd: string,
        _args: string[],
        opts: { stdio?: unknown; timeout?: number },
      ) => {
        optsSeen.push({ cmd, stdio: opts.stdio, timeout: opts.timeout });
        return {
          pid: 1,
          output: ['', fakeFans, ''],
          stdout: fakeFans,
          stderr: '',
          status: 0,
          signal: null,
        };
      }) as never,
    });

    transport.applyWrites([{ kind: 'manual', fanIndex: 0, targetRpm: 4000 }]);
    expect(transport.isMacsFanControlRunning()).toBe(true);
    expect(optsSeen[0]).toEqual({
      cmd: MACOS_PYTHON3_BIN,
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 12_345,
    });
    expect(optsSeen[1]?.timeout).toBe(4321);
    expect(optsSeen[1]?.stdio).toBe('ignore');
  });
});

describe('SMC_PY_STRUCTS_AND_CORE 跨代协议仿真 (M5 / M1-M2 / M3-M4 Ftst / Intel FS! / 无风扇)', () => {
  test.skipIf(TEST_PYTHON3 === null)(
    '兼容 F0md、F0Md (含 thermalmonitord mode=3 与 Ftst 解锁)、Intel FS! 位掩码与 FNum 缺失',
    () => {
      const harness = `
import ctypes, struct, time
${SMC_PY_STRUCTS_AND_CORE}

class FakeSMC:
    def __init__(self, store, lock_with_ftst=False, unlock_delay_writes=0):
        self.store = dict(store)
        self.lock_with_ftst = lock_with_ftst
        self.pending_unlock_writes = 0
        self.unlock_delay_writes = unlock_delay_writes

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
            payload = bytes(inp.bytes[:sz])
            if self.lock_with_ftst and k.endswith("Md"):
                ftst_val = self.store.get("Ftst", ("ui8 ", b"\\x00"))[1][0]
                if ftst_val == 0:
                    out.result = 130  # 0x82 kSMCKeyNotWritable while locked
                    return out
                if self.pending_unlock_writes > 0:
                    self.pending_unlock_writes -= 1
                    out.result = 130  # 模拟 thermalmonitord 延迟让权窗口
                    return out
            self.store[k] = (dt, payload)
            if self.lock_with_ftst and k == "Ftst":
                if payload[0] == 1:
                    self.pending_unlock_writes = self.unlock_delay_writes
                elif payload[0] == 0:
                    for mk in list(self.store.keys()):
                        if mk.endswith("Md") and self.store[mk][1] == b"\\x00":
                            self.store[mk] = (self.store[mk][0], b"\\x03")
            out.result = 0
            return out
        raise RuntimeError(f"unexpected op {inp.data8}")

def bind(fake):
    global smc_call_raw
    smc_call_raw = fake.call_raw

# 1) Apple M5: 仅有小写 F0md, 无 F0Md / FS! / Ftst
m5 = FakeSMC({
    "FNum": ("ui8 ", b"\\x01"),
    "F0md": ("ui8 ", b"\\x00"),
    "F0Tg": ("flt ", struct.pack("<f", 1350.0)),
})
bind(m5)
assert read_fan_count(None) == 1
assert read_fan_mode(None, 0) == "auto"
set_fan_mode(None, 0, True)
assert read_fan_mode(None, 0) == "manual"
set_fan_mode(None, 0, False)
assert read_fan_mode(None, 0) == "auto"

# 2) Apple M1/M2/M2 Pro: 仅有大写 F0Md (无 Ftst / FS!), 且模拟 RTKit 异步回读延迟 (前 2 次读取仍返回旧 0)
class DelayedModeSMC(FakeSMC):
    def __init__(self, store, stale_reads_after_write=2):
        super().__init__(store)
        self.stale_reads_left = 0
        self.stale_reads_after_write = stale_reads_after_write

    def call_raw(self, conn, inp):
        k = unfoucc(inp.key)
        if inp.data8 == K_SMC_WRITE_KEY and k.endswith("Md") and inp.bytes[0] == 1:
            res = super().call_raw(conn, inp)
            self.stale_reads_left = self.stale_reads_after_write
            return res
        if inp.data8 == K_SMC_READ_KEY and k.endswith("Md") and self.stale_reads_left > 0:
            self.stale_reads_left -= 1
            out = SMCKeyData()
            out.result = 0
            out.bytes[0] = 0
            return out
        return super().call_raw(conn, inp)

SMC_MODE_STABILIZE_SEC = 0.0
m2_pro = DelayedModeSMC({
    "FNum": ("ui8 ", b"\\x02"),
    "F0Md": ("ui8 ", b"\\x00"),
    "F1Md": ("ui8 ", b"\\x00"),
}, stale_reads_after_write=2)
bind(m2_pro)
assert read_fan_mode(None, 0) == "auto"
set_fan_mode(None, 0, True)
set_fan_mode(None, 1, True)
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"
assert m2_pro.store["F0Md"][1] == b"\\x01"
assert m2_pro.store["F1Md"][1] == b"\\x01"

# 若 F0Md 始终被固件拒绝置 1 (非缺键), 必须报真实的 switch failed 而非误导的 key not found
stuck_m2 = DelayedModeSMC({
    "FNum": ("ui8 ", b"\\x01"),
    "F0Md": ("ui8 ", b"\\x00"),
}, stale_reads_after_write=9999)
SMC_DIRECT_MODE_WINDOW_SEC = 0.06
bind(stuck_m2)
try:
    set_fan_mode(None, 0, True)
    raise AssertionError("expected RuntimeError")
except RuntimeError as err_msg:
    assert "failed to switch F0Md" in str(err_msg)
    assert "key not found" not in str(err_msg)
SMC_DIRECT_MODE_WINDOW_SEC = 1.5

# 3) Apple M3/M4: F0Md/F1Md 初始为 3 (thermalmonitord 锁), 需自动写 Ftst=1 解锁并在全 auto 后归还 Ftst=0
m4 = FakeSMC({
    "FNum": ("ui8 ", b"\\x02"),
    "Ftst": ("ui8 ", b"\\x00"),
    "F0Md": ("ui8 ", b"\\x03"),
    "F1Md": ("ui8 ", b"\\x03"),
}, lock_with_ftst=True, unlock_delay_writes=2)
bind(m4)
assert read_fan_mode(None, 0) == "auto"
assert read_fan_mode(None, 1) == "auto"
set_fan_mode(None, 0, True)
set_fan_mode(None, 1, True)
assert m4.store["Ftst"][1] == b"\\x01"
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"
# 仅把 Fan 0 切回 auto 时 Fan 1 仍为 manual, Ftst 须保持 1
set_fan_mode(None, 0, False)
sync_ftst_if_all_auto(None, 2)
assert m4.store["Ftst"][1] == b"\\x01"
assert read_fan_mode(None, 0) == "auto"
assert read_fan_mode(None, 1) == "manual"
# 把 Fan 1 也切回 auto 后, Ftst 自动归零交还 thermalmonitord
set_fan_mode(None, 1, False)
sync_ftst_if_all_auto(None, 2)
assert m4.store["Ftst"][1] == b"\\x00"
assert read_fan_mode(None, 1) == "auto"

# 4) 经典 Intel Mac: 无 F0md / F0Md, 采用 FS! ({fds 2 字节大端位掩码) + fpe2 14.2 定点转速
intel = FakeSMC({
    "FNum": ("ui8 ", b"\\x02"),
    "FS! ": ("{fds", b"\\x00\\x00"),
    "F0Tg": ("fpe2", struct.pack(">H", 2000 * 4)),
})
bind(intel)
assert read_fan_mode(None, 0) == "auto"
assert read_key(None, "F0Tg") == 2000.0
set_fan_mode(None, 0, True)
set_fan_mode(None, 1, True)
assert intel.store["FS! "][1] == b"\\x00\\x03"
assert read_fan_mode(None, 0) == "manual"
assert read_fan_mode(None, 1) == "manual"
write_key(None, "F0Tg", 3250.5)
assert read_key(None, "F0Tg") == 3250.5
set_fan_mode(None, 0, False)
assert intel.store["FS! "][1] == b"\\x00\\x02"
assert read_fan_mode(None, 0) == "auto"
assert read_fan_mode(None, 1) == "manual"

# 5) 无风扇 MacBook Air: FNum 返回 132 (kSMCKeyNotFound), 平滑返回 0 把风扇
air = FakeSMC({})
bind(air)
assert read_fan_count(None) == 0
print("ALL_OK")
`;
      const res = spawnSync(TEST_PYTHON3!, ['-c', harness], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 20_000,
      });
      expect(res.status, res.stderr).toBe(0);
      expect(res.stdout.trim()).toBe('ALL_OK');
    },
    25_000,
  );
});

const hasAppleSmcHost =
  process.platform === 'darwin' && TEST_PYTHON3 === MACOS_PYTHON3_BIN;

describe('AppleSMC 真机只读冒烟 (仅 macOS)', () => {
  test.skipIf(!hasAppleSmcHost)(
    'readFans() 可直接读取本机风扇参数 (无物理 SMC/风扇的虚拟化宿主机保持结构化报错)',
    () => {
      const transport = createAppleSmcTransport();
      try {
        const fans = transport.readFans();
        expect(Array.isArray(fans)).toBe(true);
        if (fans.length > 0) {
          expect(fans[0]!.maxRpm).toBeGreaterThan(fans[0]!.minRpm);
        }
      } catch (error) {
        // GitHub Actions macos-latest 虚拟机等无物理 SMC 宿主机需给出明确结构化 FanError, 不得未捕获崩溃
        expect(isFanError(error)).toBe(true);
        if (isFanError(error)) {
          const expectedHardwareMissing =
            error.code === 'SMC_UNAVAILABLE' ||
            (error.code === 'SMC_COMMAND_FAILED' &&
              /AppleSMC|FNum|IOServiceOpen/i.test(error.message));
          expect(expectedHardwareMissing, error.message).toBe(true);
        }
      }
    },
    20_000,
  );
});
