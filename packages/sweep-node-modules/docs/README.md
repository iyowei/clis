# sweep-node-modules (API 包) 文档

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep-node-modules` 是可编程 API 包: 扫描 / 体积 / 安全闸 / 删除的域逻辑都在此实现, CLI 包是其渲染薄壳。使用面见[包 README](../README.md)。

## 包内文档

| 文档                            | 一句话                                         |
| ------------------------------- | ---------------------------------------------- |
| [可编程 API 面](api-surface.md) | 对外契约: 两级导出、错误码体系、进度与取消模型 |

## 包级 ADR

| 编号                                                    | 标题                     |
| ------------------------------------------------------- | ------------------------ |
| [0001](adrs/0001-workspace-level-cleaner.md)            | 工作区级清理工具定位     |
| [0002](adrs/0002-fixed-config-and-preview-execution.md) | 固定配置与预览执行模型   |
| [0003](adrs/0003-zero-runtime-deps.md)                  | 零运行时依赖             |
| [0004](adrs/0004-config-initialization-wizard.md)       | 配置初始化向导           |
| [0007](adrs/0007-platform-portability.md)               | 三平台可移植性与配置定位 |
| [0008](adrs/0008-transcription-kit.md)                  | 转写契约套件             |

## 仓库级关联

- [仓库文档索引](../../../docs/README.md) / [设计文档索引](../../../docs/designs/README.md);
- 本包相关的仓库级设计: [设计总纲](../../../docs/designs/sweep-node-modules-design.md) / [扫描与体积](../../../docs/designs/scan-and-size.md) / [删除安全闸](../../../docs/designs/deletion-guard.md) / [安全防护保障](../../../docs/safety-guardrails.md) / [转写契约套件](../../../docs/protocol/README.md)。
