# {{NAME}} 工程技术文档总索引

> 文档类型: 全部工程技术文档的总入口
> 适用对象: 本仓维护者与 AI Agent
> 范围说明: 本索引收录工程技术文档 (决策 / 设计 / 协议 / 开发); 新增文档必须登记 (adrs/、designs/ 下的登记到各自目录的 README, 其余登记到本索引), 严禁出现索引之外的孤岛文档。
>
> 命名约定: `designs/` 下的文件名不带日期, 修订日期登记在正文的「修订记录」里; ADR 按编号顺序追加, 已接受的决定不原地改写。

## 决策与模板

**仓库级架构决策记录**
[仓库级架构决策记录索引](adrs/README.md)
仅登记仓库级工程与治理决策 (ADRs); 全仓共用四位递增编号 (新项目从 0001 起), 包级 ADR 去中心化登记在各自 `packages/<pkg>/docs/README.md`。

## 设计文档

**设计文档索引 (仓库级)**
[设计文档索引](designs/README.md)
仓库级设计 (仓库治理与脚手架) 的登记入口与推荐阅读顺序; 包级设计按需建在各包 `packages/<pkg>/docs/designs/` 内。

## 转写协议

**跨语言转写契约与验证套件**
[转写纪律与套件索引](transcription/README.md)
跨语言复刻共用纪律、对抗审阅清单与双面契约验证说明; 示例包的行为契约与覆盖台账见 [behavior-contract.md](../packages/{{NAME}}/docs/protocol/behavior-contract.md) 与 [coverage.md](../packages/{{NAME}}/docs/protocol/conformance/coverage.md)。

## 开发

**开发指南**
[开发指南](development.md)
环境准备、常用命令、提交钩子与发布链; 面向仓库维护者与贡献者。

## 包

- [API 包 README](../packages/{{NAME}}/README.md) (可编程 API; 有专属设计或包级 ADR 时按需在包内创建 `docs/`);
- [CLI 包 README](../packages/{{NAME}}-cli/README.md) (命令用法与输出; 有专属命令面设计时按需在包内创建 `docs/`)。
