# wake-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/wake-cli` 提供 `wake` 命令。CLI 包是 API 主包 (`@iyowei/wake`) 的参数解析、交互向导与双语终端渲染薄壳, 底层魔术包构造、子网广播路由与 SSH 中继故障转移逻辑全在主包内。用户向用法见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 包内文档

| 文档                                   | 一句话                                                                            |
| -------------------------------------- | --------------------------------------------------------------------------------- |
| [命令面与输出](designs/cli-surface.md) | 对外契约: 目标唤醒、子命令 (`list`/`init`/`doctor`/`lang`/`update`)、旗标与退出码 |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md)
- 产品主包: [wake 文档入口](../../wake/docs/README.md) / [API 面与网络传输设计](../../wake/docs/designs/wake-api.md)
