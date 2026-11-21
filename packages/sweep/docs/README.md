# sweep (API 主包与产品文档)

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep` 是通用工作区多技术栈清理器的可编程 API 主包 ([ADR 0021](adrs/0021-sweep-general-cleaner-evolution.md)): 扫描 / 多预设锚定 / 自定义规则 / 体积双轨 / 安全闸 / 三端回收站与删除 / 无损配置迁移的域逻辑, 以及全套产品设计、转写契约、产品级 ADR 均收归于此; CLI 包 (`@iyowei/sweep-cli`, 命令 `sweep`) 是其渲染与交互薄壳。两包当前标记 `"private": true`, 在仓内独立演进打磨。使用面见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 产品设计

总纲 / 可编程 API 面 / 配置 / 扫描与体积 / 删除安全闸 / 加固 / 安全防护保障 / 转写双面覆盖 / 架构总览, 入口见[产品设计索引](designs/README.md)。

## 转写契约套件

行为契约 (BC / OF / EC) / 金样本语料 / 覆盖表 / 变异自证 / 实施提示词, 见[套件入口](protocol/README.md)。

## 包级 ADR

| 编号                                                      | 标题                                                             |
| --------------------------------------------------------- | ---------------------------------------------------------------- |
| [0001](adrs/0001-workspace-level-cleaner.md)              | 工作区级清理工具定位                                             |
| [0002](adrs/0002-fixed-config-and-preview-execution.md)   | 固定配置与预览执行模型                                           |
| [0003](adrs/0003-zero-runtime-deps.md)                    | 零运行时依赖                                                     |
| [0004](adrs/0004-config-initialization-wizard.md)         | 配置初始化向导                                                   |
| [0007](adrs/0007-platform-portability.md)                 | 三平台可移植性与配置定位                                         |
| [0008](adrs/0008-transcription-kit.md)                    | 转写契约套件                                                     |
| [0021](adrs/0021-sweep-general-cleaner-evolution.md)      | 演进为通用工作区清理器 `@iyowei/sweep` / `@iyowei/sweep-cli`     |
| [0022](adrs/0022-config-v2-presets-and-rules.md)          | 配置 v2、预设锚定校验、自定义规则与保守迁移                      |
| [0023](adrs/0023-zero-dep-cross-platform-trash.md)        | 零第三方依赖的三端回收站 (`trash`) 通道与失败不强删铁律          |
| [0024](adrs/0024-cli-init-migrate-and-summary-display.md) | 自动 `init` / `migrate`、无配置非 TTY 拒盲扫与模板化配置摘要展示 |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [仓级设计索引](../../../docs/designs/README.md) / [仓级 ADR 索引](../../../docs/adrs/README.md);
- CLI 薄壳包: [sweep-cli 文档](../../sweep-cli/docs/README.md) / [命令面与输出](../../sweep-cli/docs/designs/cli-surface.md)。
