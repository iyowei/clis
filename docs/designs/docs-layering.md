# 文档分层协议 (Docs Layering)

> 文档类型: 仓库级设计
> 适用对象: 本仓维护者与 AI Agent
> 前置: [集合仓定位](collection-positioning.md); 权威决策见 [ADR 0019](../adrs/0019-two-tier-package-owned-docs.md) (已取代 [ADR 0011](../adrs/0011-docs-and-adr-layering.md))

## 判据

文档只分两级, 按归属直接落位:

- **给整个仓库用** (集合仓治理、工程基建、脚手架机制、仓级开发指南) → **仓库级**, 落 `docs/`;
- **给某个产品或单个包用** (该产品的架构/公式/运维手册、可编程 API 面、验收套件、产品 ADR 与单包 CLI 命令面) → **包级**, 落 `packages/<pkg>/docs/`。

不再在仓根设立 `docs/<product>/` 产品区, 仓库根 `docs/` 保持 100% 纯工程治理。

## 两级结构

### 仓库级 (`docs/`)

- `README.md`: 仓库级总入口, 列出各包/产品入口与仓库级文档导航;
- `development.md`: 环境准备、常用命令、双运行时验证、发布链与提交钩子;
- `adrs/`: 仓库级工程 ADR 及其索引 `adrs/README.md`;
- `designs/`: 仓库级治理与脚手架设计及其索引 `designs/README.md`;
- `transcription/`: 全仓共享的跨语言转写基建文档 (通用实施纪律、对抗评审指令、TS 暗坑核查表与目标语言通用模板), 与仓库根 `scripts/transcription/` 配套, 避免每个包重复维护通用提示词。

### 包级 (`packages/<pkg>/docs/`, 按需创建)

- **按需创建, 不建空壳**: 只有存在专属设计文档、协议套件或包级 ADR 时才建 `packages/<pkg>/docs/`; 无独立包内文档的包 (如 `create-clis`, 其设计属仓库级脚手架设施) 不建空 `docs/` 目录, 总索引直链其包根 `README.md` 与对应仓级设计。
- **双包一产品的归属规则**:
  - **主包 (API 包, `packages/<product>/docs/`)**: 持有该产品的全部整体设计 (`designs/`)、验收套件 (`protocol/` 等)、看板资产与产品级 ADR (`adrs/`), 一棵目录树自包含完整知识面;
  - **CLI 薄壳从包 (`packages/<product>-cli/docs/`)**: 仅存放本包专属的 CLI 命令面、交互与渲染契约 (`designs/cli-surface.md`), 并以相对链接指回主包 `docs/README.md`, 不重复建空 ADR 章节。
- **发行面隔离**: 包级 `docs/` 不进 npm 发布包 (由各包 `files` 白名单与 `verify:release` 物理锁定); 包根面向 npm 读者的 `packages/<pkg>/README*.md` 严禁使用逃出包目录 (`../` 或 `/...`) 的相对链接, 引用仓内深度文档一律使用 GitHub 绝对 URL (由 `scripts/lint-doc-references.ts` 强制拦截)。

## 读取与外链路径

```text
docs/README.md ──(各包与产品入口)──▶ packages/<product>/docs/README.md ──▶ designs/ / protocol/ / adrs/
                                  └▶ packages/<product>-cli/docs/README.md ──▶ designs/cli-surface.md (并回链主包)
```

链接有效性、包根 README npm 外链禁令、`§` 章节号就近消歧与跨级 ADR 唯一性全部由 `scripts/lint-doc-references.ts` 自动守卫。

## ADR 编号与索引纪律

- **全局唯一四位递增编号, 永不重编**: 无论新增仓级 ADR 还是包级 ADR, 编号均接全仓最大号顺延; 引用闸门同时扫描 `docs/adrs/` 与全部 `packages/*/docs/adrs/`, 拦截幽灵编号与跨目录重号碰撞;
- **分层索引 (不手抄全仓大表)**: `docs/adrs/README.md` 仅登记仓库级工程 ADR; 各产品主包的 ADR 登记在其主包 `docs/README.md` 中, 消除跨产品垂直决策混排噪声与多处手抄漂移。

## 与生成器 / 模板的关系

由于仓根 `docs/` 已彻底去产品化, `create-clis` 快照仓库级文档骨架时零产品文档混入; 生成物内的示例包同样遵循「按需建 `docs/`」原则, 不预置无内容空壳目录。

## 修订记录

| 日期       | 修订                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-30 | 初稿: 两级结构与外链约定; 同日升级为三级结构 (`docs/<product>/` 产品区落地)                                                                                                                   |
| 2026-11-19 | 按 [ADR 0019](../adrs/0019-two-tier-package-owned-docs.md) 回归极简两级: 撤销根级产品区、包级 docs 按需创建、移除易漂移手工全量总表、新增包根 README npm 外链闸门                             |
| 2026-11-21 | 仓库级增设 `docs/transcription/` 收纳跨包共享的转写方法论、对抗评审指令、TS 暗坑核查表与目标语言通用模板; 包级 `packages/<pkg>/docs/protocol/` 收口为单包专属契约、语料、覆盖表与可选领域补充 |
