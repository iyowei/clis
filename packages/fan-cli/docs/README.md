# fan-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/fan-cli` 提供 `fan` 命令。CLI 包是 API 主包 (`@iyowei/fan`) 的参数解析与终端渲染薄壳, 底层 AppleSMC 读写、转速限幅、持久化与守护管理逻辑全在主包内。用户向用法见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 包内文档

| 文档                                   | 一句话                                                                                              |
| -------------------------------------- | --------------------------------------------------------------------------------------------------- |
| [命令面与输出](designs/cli-surface.md) | 对外契约: 子命令 (`status`/`set`/`max`/`min`/`auto`/`apply`/`persist`/`update`)、旗标、渲染与退出码 |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md)
- 产品主包: [fan 文档入口](../../fan/docs/README.md) / [API 面与 SMC 传输契约](../../fan/docs/designs/fan-api.md)
