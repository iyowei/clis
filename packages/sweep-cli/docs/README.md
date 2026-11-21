# sweep-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层的规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep-cli` 提供 `sweep` 命令 ([ADR 0021](../../sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md))。CLI 包是 API 主包 (`@iyowei/sweep`) 的渲染与交互薄壳 (参数解析 → 配置初始化/无损迁移 → 调 API → 摘要与清单渲染 → 退出码收口), 业务逻辑全在 API 主包里。当前标记 `"private": true`, 在仓内演进打磨。用法见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 包内文档

| 文档                                   | 一句话                                                                      |
| -------------------------------------- | --------------------------------------------------------------------------- |
| [命令面与输出](designs/cli-surface.md) | 对外契约: 命令 (`init`/`migrate`/`config`/`update`)、旗标、退出码、渲染规格 |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md);
- 产品主包 (含全部产品 ADR): [sweep 文档入口](../../sweep/docs/README.md) / [设计总纲](../../sweep/docs/designs/sweep-design.md) / [配置与初始化](../../sweep/docs/designs/config-and-initialization.md) / [安全防护保障](../../sweep/docs/designs/safety-guardrails.md)。
