# clis 工程技术文档总索引

> 文档类型: 仓库级工程技术文档总入口
> 适用对象: 本仓维护者与 AI Agent
> 范围说明: 仓根 `docs/` 仅收录跨产品的仓库治理、工程机制、开发指南与仓级 ADR; 各工具产品的整体设计、协议与产品 ADR 全部内聚在各自产品主包的 `packages/<pkg>/docs/` 下。分层规则见 [文档分层协议](designs/docs-layering.md) 与 [ADR 0019](adrs/0019-two-tier-package-owned-docs.md)。
>
> 命名约定: `designs/` 下的文件名不带日期, 修订日期登记在正文的「修订记录」里; ADR 按全仓唯一四位编号顺延追加, 已接受的决定不原地改写。

## 包与产品文档入口

- **`create-clis` (集合仓生成器)**: 用户向用法见 [README](../packages/create-clis/README.md); 脚手架架构、快照与契约设计属仓库级设施, 见 [设计文档索引](designs/README.md)。
- **`sweep` (通用多技术栈工作区清理器 — 双包, 待首发 `private: true`)**:
  - 主包 / API 包 (`@iyowei/sweep`, `packages/sweep`): [主包文档入口](../packages/sweep/docs/README.md) (含 6 大内置预设 `node`/`rust`/`python`/`java`/`cpp`/`os-junk`、自定义 `rules`、零依赖三端回收站、配置 v2 `SWEEP_CONFIG` / `~/.config/sweep/config.json`、可编程 API 面、安全防护总账、转写契约套件与产品 ADR `0001-0004` / `0007-0008` / `0021-0024`);
  - CLI 薄壳包 (`@iyowei/sweep-cli`, `packages/sweep-cli`, 命令 `sweep`): [CLI 包文档入口](../packages/sweep-cli/docs/README.md) (命令面、自动 `init`/`migrate`、输出与交互契约)。
- **`codd` (MongoDB 9.0 部署装配器 — 双包)**:
  - 主包 / API 包 (`@iyowei/codd`): [主包文档入口](../packages/codd/docs/README.md) (含公式设计、Podman / Kubernetes 运维分册、可视化看板 `BOARD.html` 与产品 ADR `0012-0018`);
  - CLI 薄壳包 (`@iyowei/codd-cli`): [CLI 包文档入口](../packages/codd-cli/docs/README.md) (命令面、向导交互、退出码与状态文件契约)。
- **`@iyowei/cli-updater` (仓内私有共享库)**: 为仓内全部 CLI 提供统一 `update` 自更新引擎 (跨 `bun` / `npm` / `pnpm` / `yarn` / `volta` 识别安装源并隔离执行更新, 源码位于 `packages/cli-updater/`, 不对外发布)。

## 仓库级决策 (ADR)

- [仓库级架构决策记录索引](adrs/README.md): 收录集合仓工程基建、双运行时、分发形态、双包结构与文档分层等仓级重大决策。

## 仓库级设计 (治理、脚手架与跨语言转写)

- [设计文档索引 (按推荐阅读顺序)](designs/README.md): 集合仓定位、包分类、依赖方向、文档分层、能力分档、脚手架机制与技术债台账。
- [跨语言转写基建 (`docs/transcription/`)](transcription/README.md): 面向全仓所有包的通用转写纪律、对抗评审指令、TS 跨语言暗坑核查表、Rust 通用模板与确定性双面验收 / 差分模糊测试工作流。

## 开发与协作

- [开发指南](development.md): 环境准备、常用命令、双运行时验证、发布链与提交钩子。
- [贡献指南 (English)](../CONTRIBUTING.md) / [贡献指南 (中文)](../CONTRIBUTING.zh-CN.md) / [安全策略](../SECURITY.md)。
