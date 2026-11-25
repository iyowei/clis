# `@iyowei/fan` API 面与 AppleSMC 传输设计

> 文档类型: 产品设计
> 所属主包: `@iyowei/fan` (见[主包文档入口](../README.md))

## 1. 设计目标

1. 在 Bun 与 Node.js (`>= 22.18.0`) 下提供完全一致的可编程风扇控制 API, 且保持零第三方运行时依赖。
2. 通过可注入的 `FanTransport` 与 `FanStateStore` 抽象把 macOS AppleSMC 真机交互与纯 TypeScript 编排逻辑解耦, 确保单测可在 Linux / Windows / macOS 确定性通过。
3. 最小化权限边界: 读取风扇状态与 `state.json` 无需 root; 仅写入、持久化落盘与守护安装经 `/usr/bin/sudo` 调用 `/usr/bin/python3`; 写入后轮询确认 SMC 目标键刷新 (最多 1 秒) 再返回状态。
4. 默认自动记住并恢复: `set` / `max` / `min` / `auto` 默认将配置按风扇粒度合并写入 `/Library/Application Support/iyowei-fan/state.json` (传入 `persist: false` 则跳过写盘); 安装 `com.iyowei.fan` `LaunchDaemon` 后, 在开机 (`RunAtLoad`) 与每次睡眠唤醒 (`kIOMessageSystemHasPoweredOn`) 时自动恢复设定, 醒着期间零轮询。

## 2. AppleSMC 键值契约

已在 Apple Silicon (MacBook Pro `Mac17,10`, Apple M5 Max) 实机探测验证的 SMC 键如下:

| 键       | 类型   | 方向 | 说明                                                     |
| -------- | ------ | ---- | -------------------------------------------------------- |
| `FNum`   | `ui8 ` | 只读 | 系统风扇数量                                             |
| `F{i}Ac` | `flt ` | 只读 | 第 `i` 把风扇当前实际转速 (RPM)                          |
| `F{i}Mn` | `flt ` | 只读 | 第 `i` 把风扇最小允许转速                                |
| `F{i}Mx` | `flt ` | 只读 | 第 `i` 把风扇最大允许转速                                |
| `F{i}Tg` | `flt ` | 读写 | 第 `i` 把风扇目标转速                                    |
| `F{i}md` | `ui8 ` | 读写 | 控制模式: `0` = 系统自动 (`auto`), `1` = 手动 (`manual`) |

## 3. 公开 API

- `createFanController({ transport?, stateStore? })`: 返回 `{ status, set, max, min, auto, apply }`, 所有方法返回结构化 `FanStatusReport` (`{ fans, macsFanControlRunning, warnings, persisted?, didPersist? }`)。
- `createAppleSmcTransport(overrides?)`: 默认使用 macOS `/usr/bin/python3` 与 `/usr/bin/sudo` 通过 `IOKit` 访问 `AppleSMC`。
- `readPersistedState` / `mergePersistedState` / `createMacOsFanStateStore`: 无符号链接校验、跨风扇合并读写 `/Library/Application Support/iyowei-fan/state.json` (`v1`)。
- `getPersistDaemonStatus` / `installPersistDaemon` / `uninstallPersistDaemon` / `buildLaunchDaemonPlist`: 管理 `/Library/LaunchDaemons/com.iyowei.fan.plist` 守护服务。
- `parseSpeedSpec` / `resolveTargetRpm` / `computePercent`: 纯函数转速解析与区间夹逼。
- `FanError` / `isFanError`: 统一结构化错误, 错误码包括 `UNSUPPORTED_PLATFORM`、`SMC_UNAVAILABLE`、`SMC_COMMAND_FAILED`、`INVALID_FAN_INDEX`、`INVALID_SPEED`、`PERMISSION_DENIED`、`STATE_CORRUPT`、`DAEMON_FAILED`。
