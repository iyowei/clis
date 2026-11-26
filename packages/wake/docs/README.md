# wake (API 主包) 文档

> 文档类型: 产品级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/wake` 是跨网段 Wake-on-LAN 远程唤醒引擎的可编程 API 主包, 承载魔术包构造、IPv4 子网广播路由筛选、安全配置持久化、无 shell 注入 SSH 中继故障转移与就绪轮询; CLI 薄壳见 [wake-cli 文档](../../wake-cli/docs/README.md), 用户向用法见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 包内文档

| 文档                                                                                | 一句话                                                                |
| ----------------------------------------------------------------------------------- | --------------------------------------------------------------------- |
| [API 面与传输边界设计](designs/wake-api.md)                                         | 公开导出 API、配置模型 v1、虚拟网卡过滤与无等待 SSH 中继协议          |
| [ADR 0025: 唤醒架构与安全边界](adrs/0025-wake-architecture-and-network-boundary.md) | 为什么拆分子网直发 + 有序 SSH 中继故障转移, 以及严格零 shell 注入边界 |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md) / [ADR 索引](../../../docs/adrs/README.md)
- CLI 包: [wake-cli 文档入口](../../wake-cli/docs/README.md) / [CLI 命令面与输出契约](../../wake-cli/docs/designs/cli-surface.md)
