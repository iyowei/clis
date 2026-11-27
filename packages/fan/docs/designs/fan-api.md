# `@iyowei/fan` API 面与 AppleSMC 传输设计

> 文档类型: 产品设计
> 所属主包: `@iyowei/fan` (见[主包文档入口](../README.md))

## 1. 设计目标

1. 在 Bun 与 Node.js (`>= 22.18.0`) 下提供完全一致的可编程风扇控制 API, 且保持零第三方运行时依赖。
2. 通过可注入的 `FanTransport` 与 `FanStateStore` 抽象把 macOS AppleSMC 真机交互与纯 TypeScript 编排逻辑解耦, 确保单测可在 Linux / Windows / macOS 确定性通过。
3. 最小化权限边界: 读取风扇状态与 `state.json` 无需 root; 仅写入、持久化落盘与守护安装经 `/usr/bin/sudo` 调用 `/usr/bin/python3`; 写入后轮询确认 SMC 目标键刷新 (最多 1 秒) 再返回状态。
4. 默认自动记住、保底下限温控、失败回滚与守护联动: `set` / `max` / `min` / `auto` 默认先预检并读取合并 `/Library/Application Support/iyowei-fan/state.json` (若磁盘 `state.json` 已损坏, 持久化写入前置拒绝且不修改硬件或覆盖配置; 只读 `status` 与 `persist: false` 则保留硬件读数并上浮 `STATE_CORRUPT` 告警); 硬件写入成功后若写盘失败且错误非 `PERMISSION_DENIED`, 会尽最大努力回滚写入前的风扇快照并抛出带回滚状态说明的 `FanError`; 执行持久化手动调速 (`set` / `max` / `min` 且 `persist !== false`) 时默认幂等确保 `com.iyowei.fan` `LaunchDaemon` 已安装并同步为最新脚本 (`persist: false` 临时调速不安装或重载守护, 且守护会自动识别并避让未改写 `state.json` 的 `--once` 临时转速; 守护首次安装或更新重载后会自动复核硬件状态并在漂移时补写; 若守护同步失败则保留已更新的硬件与持久化配置并抛 `FanError` 明确提示): `set` 与 `min` 默认采用 `strategy: 'floor'` 保底下限模式 (低温稳守设定下限, 芯片核心温度高于 `65°C` 时守护通过 `AppleSMC` `Tp*`/`Te*`/`Tg*`/`TC0D` 或 `IOHIDEventSystemClient` `PMU tdie*` 采样并经非对称 EMA 与迟滞死区平滑上调 `F{i}Tg`, `>= 92°C` 拉满 `maxRpm`, 降温后回落至设定下限; 显式传 `fixed: true` 则写入 `strategy: 'fixed'` 恒定锁速且零温度轮询); 在开机 (`RunAtLoad`)、真实唤醒 (`FullWake` / 开盖) 与后台唤醒升格为用户活跃 (`IOPMUserIsActive == True`) 时恢复设定, 在无外接显示器合盖 (`AppleClamshellState && AppleClamshellCausesSleep`)、系统睡眠 (`kIOMessageSystemWillSleep`) 与无用户活跃的后台维护唤醒 (`DarkWake`: `IOPMUserTriggeredFullWake == False` 且 `IOPMUserIsActive != True`) 期间自动将手动风扇临时切回 `auto` 停转 (外接显示器合盖办公与亮屏会话空闲息屏均保留手动转速)。

## 2. AppleSMC 跨代键值契约

不同代际 Mac 的 AppleSMC FourCC 键区分大小写且协议不同 (键不存在时 IOKit 返回 `result = 132` / `0x84` `kSMCKeyNotFound`), 驱动与 `LaunchDaemon` 统一按探测优先级自适应兼容:

| 键       | 类型                     | 方向 | 适用代际与说明                                                                                            |
| -------- | ------------------------ | ---- | --------------------------------------------------------------------------------------------------------- |
| `FNum`   | `ui8 `                   | 只读 | 系统风扇数量; 无风扇机型 (如 MacBook Air) 缺失 (`132`) 或为 `0` 时返回空列表并映射为 `SMC_UNAVAILABLE`    |
| `F{i}Ac` | `flt ` / `fpe2`          | 只读 | 第 `i` 把风扇当前实际转速 (RPM, Apple Silicon 小端 `flt `, 经典 Intel 大端 14.2 定点 `fpe2`)              |
| `F{i}Mn` | `flt ` / `fpe2`          | 只读 | 第 `i` 把风扇最小允许转速                                                                                 |
| `F{i}Mx` | `flt ` / `fpe2`          | 只读 | 第 `i` 把风扇最大允许转速                                                                                 |
| `F{i}Tg` | `flt ` / `fpe2`          | 读写 | 第 `i` 把风扇目标转速 (只读固件缺失 `F{i}Tg` 时读取回退为 `F{i}Ac`)                                       |
| `F{i}md` | `ui8 `                   | 读写 | Apple M5 系列单扇模式键: `0` = 系统自动 (`auto`), `1` = 手动 (`manual`)                                   |
| `F{i}Md` | `ui8 ` / `flag`          | 读写 | Apple M1–M4 及 T2 / 后期 Intel 单扇模式键: `0` 或 `3` (`thermalmonitord` 托管) = `auto`, `1` = `manual`   |
| `Ftst`   | `ui8 ` / `flag`          | 读写 | M3/M4 等固件温控解锁键: `F{i}Md` 被锁定在 `3` 时先写 `Ftst = 1` 请求让权, 全部风扇恢复 `auto` 后写回 `0`  |
| `FS! `   | `ui16` / `hex_` / `{fds` | 读写 | 经典 Intel Mac 全局强制风扇位掩码 (无 `F{i}md`/`F{i}Md` 时回退): 第 `i` 位 (`1 << i`) 为 `1` 表示手动模式 |

## 3. 公开 API

- `createFanController({ transport?, stateStore?, ensureDaemon?, platform? })`: 返回 `{ status, set, max, min, auto, apply }` (其中 `set` / `min` 支持 `fixed?: boolean`, 默认 `false` 对应 `ManualControlStrategy = 'floor'`), 所有方法返回结构化 `FanStatusReport` (`{ fans, macsFanControlRunning, warnings, persisted?, didPersist?, daemonAction? }`, 其中 `warnings[].code` 含 `FAN_CLAMPED` / `MACS_FAN_CONTROL_RUNNING` / `STATE_CORRUPT` / `EXTERNAL_AUTO_OVERRIDE`)。
- `createAppleSmcTransport(overrides?)`: 默认使用 macOS `/usr/bin/python3` 与 `/usr/bin/sudo` 通过 `IOKit` 访问 `AppleSMC`。
- `readPersistedState` / `mergePersistedState` / `createMacOsFanStateStore`: 无符号链接校验、跨风扇合并读写 `/Library/Application Support/iyowei-fan/state.json` (`v1`)。
- `ensurePersistDaemon` / `getPersistDaemonStatus` / `installPersistDaemon` / `uninstallPersistDaemon` / `buildLaunchDaemonPlist`: 管理并幂等同步 `/Library/LaunchDaemons/com.iyowei.fan.plist` 守护服务 (`PersistDaemonStatus` 在读取 `state.json` 失败时通过 `stateError` 暴露诊断信息)。
- `parseSpeedSpec` / `resolveTargetRpm` / `computePercent`: 纯函数转速解析与区间夹逼。
- `FanError` / `isFanError`: 统一结构化错误, 错误码包括 `UNSUPPORTED_PLATFORM`、`SMC_UNAVAILABLE`、`SMC_COMMAND_FAILED`、`INVALID_FAN_INDEX`、`INVALID_SPEED`、`PERMISSION_DENIED`、`STATE_CORRUPT`、`DAEMON_FAILED`。
