# `@iyowei/wake` API 面与网络传输设计

> 文档类型: 产品设计
> 所属主包: `@iyowei/wake` (见[主包文档入口](../README.md))

## 1. 设计目标

1. 在 Bun 与 Node.js (`>= 22.18.0`) 下提供一致的 Wake-on-LAN 可编程 API, 保持零第三方运行时依赖。
2. 默认区隔 VPN/虚拟隧道网卡 (`utun`、`wg`、`tailscale`、`docker` 等) 与真实局域网 NIC, 在本地同网段发包时绑源地址定向 UDP 广播 (`:9` / `:7`), 避免广播流量误入隧道接口导致丢弃。
3. 跨网段场景下按目标配置 `relays[]` 依次经 `ssh` (`BatchMode=yes`, 严格参数白名单, 禁用 shell 拼接) 触发中继主机本地广播, 前序节点离线或响应超时自动故障转移至下一个中继, 全中继失败再视 `--no-local-fallback` 决定是否回退本机广播。
4. 配置与所有状态操作支持全内存注入 (`WakeDeps`: `network`、`relay`、`clock`), 确保单测与契约测试在离线沙箱下确定性执行。

## 2. 配置契约 (`config.json` v1)

- 路径解析优先级: 显式 `--config` > 环境变量 `WAKE_CONFIG` > POSIX `~/.config/wake/config.json` (或 `$XDG_CONFIG_HOME/wake/config.json`) / Windows `%APPDATA%\wake\config.json`。
- 目标条目字段:
  - `macs`: 非空规范化 MAC 列表 (支持同一主机多个可唤醒网卡);
  - `host` / `port`: 可选就绪探测 IP/主机名与 TCP 端口 (缺省 `22`);
  - `broadcast`: 可选显式定向广播 IPv4 列表;
  - `relays`: 可选 SSH 中继列表 (按顺序故障转移);
  - `waitTimeoutMs` / `relayTimeoutMs`: 等待上线与单中继超时毫秒数 (缺省 `90_000` / `10_000`)。

## 3. 公开 API

- `wakeTarget(options, deps?)`: 执行预检 -> 中继故障转移或本机广播 -> 可选就绪轮询与周期补发, 返回 `WakeReport` (`already-online` / `dispatched` / `woken` / `timeout`)。
- `diagnoseWake(options?, deps?)`: 严格只读环境体检 (`config`、`interfaces`、目标 TCP 连通性、SSH 中继可用性), 绝不发出魔术包。
- `loadWakeConfig` / `tryLoadWakeConfig` / `saveWakeConfig` / `upsertWakeTarget` / `removeWakeTarget`: 带 `0o600` 权限与符号链接防逃逸保护的原子配置管理。
- `normalizeMac` / `normalizeMacList` / `buildMagicPacket` / `computeBroadcastIpv4` / `sameIpv4Subnet`: 102 字节标准魔术包及纯算术 IPv4 子网运算。
- `listLocalLanInterfaces` / `resolveBroadcastTargets` / `sendUdpMagicBurst` / `probeTcpPort` / `discoverArpNeighbors`: 底层网卡过滤、UDP 突刺、TCP 握手探测及 ARP 邻接表解析。
- `WakeError` / `isWakeError`: 结构化错误类 (`CONFIG_ABSENT` / `CONFIG_READ_FAILED` / `CONFIG_INVALID` / `CONFIG_WRITE_FAILED` / `TARGET_NOT_FOUND` / `INVALID_TARGET` / `INVALID_MAC` / `INVALID_HOST` / `INVALID_PORT` / `INVALID_BROADCAST` / `INVALID_RELAY` / `NETWORK_FAILED` / `RELAY_FAILED`)。
