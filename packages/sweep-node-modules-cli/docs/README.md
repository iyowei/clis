# sweep-node-modules-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层的规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep-node-modules-cli` 提供 `sweep-nm` 命令。CLI 包是 API 包的薄壳 (解析 → 调 API → 渲染 → 交互确认), 业务逻辑全在 API 包里。用法见[包 README](../README.md)。

## 包内文档

| 文档                                   | 一句话                                     |
| -------------------------------------- | ------------------------------------------ |
| [命令面与输出](designs/cli-surface.md) | 对外契约: 命令、旗标、退出码、清单渲染规格 |

## 包级 ADR

(无: 本包的决策随整个产品一起, 记在主包 [API 包文档](../../sweep-node-modules/docs/README.md) 与仓库级 ADR 里。)

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md);
- 产品主包: [sweep-node-modules 文档入口](../../sweep-node-modules/docs/README.md) / [设计总纲](../../sweep-node-modules/docs/designs/sweep-node-modules-design.md) / [配置与初始化](../../sweep-node-modules/docs/designs/config-and-initialization.md) / [安全防护保障](../../sweep-node-modules/docs/designs/safety-guardrails.md)。
