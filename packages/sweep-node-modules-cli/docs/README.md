# sweep-node-modules-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep-node-modules-cli` 提供 `sweep-nm` 命令: CLI 是 API 包的薄壳 (解析 → 调 API → 渲染 → 交互确认), 业务语义全在 API 包。使用面见[包 README](../README.md)。

## 包内文档

| 文档                           | 一句话                                     |
| ------------------------------ | ------------------------------------------ |
| [命令面与输出](cli-surface.md) | 对外契约: 命令、旗标、退出码、清单渲染规格 |

## 包级 ADR

(无: 本包的决策随产品整体记录于 API 包的包级 ADR 与仓库级 ADR。)

## 仓库级关联

- [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md);
- 本包相关的仓库级设计: [设计总纲](../../../docs/designs/sweep-node-modules-design.md) / [配置与初始化](../../../docs/designs/config-and-initialization.md) / [安全防护保障](../../../docs/safety-guardrails.md)。
