# clis 工程技术文档总索引

> 文档类型: 全部工程技术文档的总入口
> 适用对象: 本仓维护者与 AI Agent
> 范围说明: 本索引收录工程技术文档 (决策 / 设计 / 协议 / 开发); 新增文档必须登记 (adrs/、designs/、protocol/ 下的登记到各自目录的 README, 其余登记到本索引), 严禁出现索引之外的孤岛文档。
>
> 分层说明: 文档分三级: 仓库级 (`docs/`) / 产品区 (`docs/<product>/`) / 包级 (`packages/<pkg>/docs/`); 分层的判定标准与外链规则见 [文档分层协议](designs/docs-layering.md) 与 [ADR 0011](adrs/0011-docs-and-adr-layering.md); 产品区与包级的入口见下文「设计文档」一节。
>
> 命名约定: `designs/` 下的文件名不带日期, 修订日期登记在正文的「修订记录」里; ADR 按编号顺序追加, 已接受的决定不原地改写。

## 包

**sweep-node-modules (API 包与 CLI 包)**
[API 包文档入口](../packages/sweep-node-modules/docs/README.md) (可编程 API 与包级 ADR) / [CLI 包文档入口](../packages/sweep-node-modules-cli/docs/README.md) (命令用法与输出)。

**create-clis (生成器包)**
[生成器包文档入口](../packages/create-clis/docs/README.md) (生成新集合仓的文档入口与设计关联)。

## 决策与模板

**架构决策记录**
[架构决策记录索引](adrs/README.md)
收录本仓演进过程中的重大技术决策 (ADRs), 以及当时的背景与权衡。

## 设计文档

**设计文档索引 (仓库级)**
[设计文档索引 (按推荐阅读顺序)](designs/README.md)
仓库级设计 (集合仓治理与脚手架) 的登记入口与推荐阅读顺序。

**产品区 (sweep-node-modules)**
[产品区入口](sweep/README.md)
sweep 的跨包文档: 产品设计 (总纲 / 配置 / 扫描 / 删除闸 / 加固 / 安全总账 / 双面覆盖 / 架构) 与转写契约套件 (明细条目见下面两节)。

## 安全防护

**安全防护保障 (完整版)**
[安全防护保障](sweep/designs/safety-guardrails.md)
完整收录六组 91 条保障点与 14 类内部账目 (含对已知残余风险的如实记录); 面向想深挖的用户与未来维护者; CLI 包 README 的安全防护一节是从本文精简出来的。

## 转写契约

**转写契约套件**
[转写契约套件 (transcription kit)](sweep/protocol/README.md)
为将来的多语言精准转写准备的工具包: 编号行为契约、金样本语料、确定性验收器、变异自证与实施提示词; 见 [ADR 0008](../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)。

## 开发

**开发指南**
[开发指南](development.md)
环境准备、常用命令、双运行时验证与提交钩子; 面向仓库维护者与贡献者。使用说明见 CLI 包 [README](../packages/sweep-node-modules-cli/README.md) (以英文为主; 中文版 [README.zh-CN.md](../packages/sweep-node-modules-cli/README.zh-CN.md))。
