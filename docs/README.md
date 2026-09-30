# sweep-node-modules 工程技术文档总索引

> 文档类型: 全工程技术文档总入口
> 适用对象: 本项目维护者与 AI Agent
> 范围说明: 本索引收录工程技术文档 (决策 / 设计 / 协议 / 开发); 新增文档必须登记 (adrs/ 与 designs/ 与 protocol/ 下登记于各自目录的 README, 其余登记于本索引), 严禁产生散落的孤岛文档。
>
> 分层说明: 文档分三级: 仓库级 (`docs/`) / 产品区 (`docs/<product>/`) / 包级 (`packages/<pkg>/docs/`); 判据与外链标准位见 [文档分层协议](designs/docs-layering.md) 与 [ADR 0011](adrs/0011-docs-and-adr-layering.md); 产品区与包级入口见下「设计文档」区。
>
> 命名约定: `designs/` 下文件名不带日期, 文档修订在内容内以「修订记录」登记日期; ADR 按编号顺序追加, 已接受的决定不原地改写。

## 成员包

**sweep-node-modules (API + CLI 双包)**
[API 包文档入口](../packages/sweep-node-modules/docs/README.md) (可编程 API 面与包级 ADR) / [CLI 包文档入口](../packages/sweep-node-modules-cli/docs/README.md) (命令面与输出)。

## 决策与模版

**架构决策记录**
[架构决策记录索引](adrs/README.md)
收录本项目演进过程中的重大单项技术决策 (ADRs) 及上下文权衡。

## 设计文档

**设计文档索引 (仓库级)**
[设计文档索引 (按最佳阅读顺序)](designs/README.md)
仓库级设计 (集合仓治理与脚手架) 的登记入口与推荐阅读顺序。

**产品区 (sweep-node-modules)**
[产品区入口](sweep/README.md)
sweep 的跨包文档: 产品设计 (总纲 / 配置 / 扫描 / 删除闸 / 加固 / 安全总账 / 双面覆盖 / 架构) 与转写契约套件 (下两节另列明细条目)。

## 安全防护

**安全防护保障 (全量)**
[安全防护保障](sweep/designs/safety-guardrails.md)
全量沉淀六组 91 条保障点与 14 类内部账目 (含已知残余风险的诚实账); 面向想深挖的用户与未来维护者; CLI 包 README 的安全防护节从本文裁剪而来。

## 转写契约

**转写契约套件**
[转写契约套件 (transcription kit)](sweep/protocol/README.md)
面向未来多语言精准转写的工具包: 编号行为契约、金样本语料、确定性验收器、变异自证与实施提示词; 见 [ADR 0008](../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)。

## 开发

**开发指南**
[开发指南](development.md)
环境准备、常用命令、双运行时验证与提交钩子; 面向仓库维护者与贡献者。使用说明见 CLI 包 [README](../packages/sweep-node-modules-cli/README.md) (英文主版; 中文版 [README.zh-CN.md](../packages/sweep-node-modules-cli/README.zh-CN.md))。
