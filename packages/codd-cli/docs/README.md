# codd-cli (CLI 包) 文档

> 文档类型: 包级文档入口 (两级分层规则见 [文档分层协议](../../../docs/designs/docs-layering.md) 与 [ADR 0019](../../../docs/adrs/0019-two-tier-package-owned-docs.md))

`@iyowei/codd-cli` 提供 `codd` 命令。CLI 包是 API 主包 `@iyowei/codd` 的薄壳 (参数解析 → 交互向导 → 调 API 生成 → 终端卡片渲染), 核心公式、校验、模板资产与产品级设计/ADR 均内聚于主包 `@iyowei/codd`。用户向用法见 [包 README](../README.md)。

## 包内文档

| 文档                                       | 一句话                                                                            |
| ------------------------------------------ | --------------------------------------------------------------------------------- |
| [命令面与交互契约](designs/cli-surface.md) | 对外契约: 命令、旗标、4 步向导、退出码、`.codd-state/` 状态契约与双运行时自证规则 |

## 关联入口

- 主包 (产品完整设计、部署运维分册、看板与 ADR 0012-0018): [codd 主包文档入口](../../codd/docs/README.md) / [生成器与科学公式详解](../../codd/docs/designs/generator-and-formulas.md) / [通用运维与灾备手册](../../codd/docs/designs/operations-and-recovery.md);
- 仓库级治理: [仓库文档总索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md)。
