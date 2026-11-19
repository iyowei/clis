# sweep-node-modules (API 主包与产品文档)

> 文档类型: 包级文档入口 (两级分层规则见[文档分层协议](../../../docs/designs/docs-layering.md))

`@iyowei/sweep-node-modules` 是工作区级 `node_modules` 清理工具的可编程 API 主包: 扫描 / 体积 / 安全闸 / 删除的域逻辑与全套产品设计、转写契约、产品级 ADR 均收归于此; CLI 包 (`@iyowei/sweep-node-modules-cli`) 是其渲染与交互薄壳。使用面见[包 README](../README.md) / [中文 README](../README.zh-CN.md)。

## 产品设计

总纲 / 可编程 API 面 / 配置 / 扫描与体积 / 删除安全闸 / 加固 / 安全防护保障 / 转写双面覆盖 / 架构总览, 入口见[产品设计索引](designs/README.md)。

## 转写契约套件

行为契约 (BC / OF / EC) / 金样本语料 / 覆盖表 / 变异自证 / 实施提示词, 见[套件入口](protocol/README.md)。

## 包级 ADR

| 编号                                                    | 标题                     |
| ------------------------------------------------------- | ------------------------ |
| [0001](adrs/0001-workspace-level-cleaner.md)            | 工作区级清理工具定位     |
| [0002](adrs/0002-fixed-config-and-preview-execution.md) | 固定配置与预览执行模型   |
| [0003](adrs/0003-zero-runtime-deps.md)                  | 零运行时依赖             |
| [0004](adrs/0004-config-initialization-wizard.md)       | 配置初始化向导           |
| [0007](adrs/0007-platform-portability.md)               | 三平台可移植性与配置定位 |
| [0008](adrs/0008-transcription-kit.md)                  | 转写契约套件             |

## 关联入口

- 仓库级: [仓库文档索引](../../../docs/README.md) / [仓级设计索引](../../../docs/designs/README.md) / [仓级 ADR 索引](../../../docs/adrs/README.md);
- CLI 薄壳包: [sweep-node-modules-cli 文档](../../sweep-node-modules-cli/docs/README.md) / [命令面与输出](../../sweep-node-modules-cli/docs/designs/cli-surface.md)。
