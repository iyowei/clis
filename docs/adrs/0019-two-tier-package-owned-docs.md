# ADR 0019: 回归极简两级文档分层与默认双包工具范式

> **状态**: 已接受 (Accepted), 取代 [ADR 0011](0011-docs-and-adr-layering.md)
> **日期**: 2026-11-19
> **决策者**: 沈委
> **标签**: [文档, 工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

[ADR 0011](0011-docs-and-adr-layering.md) 在 2026-09-30 定下「仓库级 + 包级」两级分层时曾预留明确重评估节点: 「产品级文档在出现第二个产品之前暂住仓库级, 到那时再重新评估」。同日为了给脚手架 `create-clis` 提供干净的根级治理模板, 又额外拆出了第三级「产品区 (`docs/<product>/`)」, 但硬性规定「产品区不设 `adrs/`, 产品 ADR 仍留在包级」。

当本仓演进为多产品集合仓 (先后纳入 `create-clis`、`sweep-node-modules` 与 `codd`) 后, 三级半迁移结构暴露出 5 类结构性摩擦:

1. **产品设计与 ADR 被物理腰斩**: `codd` 的公式设计与看板住在仓根 `docs/codd/`, 7 份 ADR 住在 `packages/codd/docs/adrs/`, 中间的 `packages/codd/docs/README.md` 沦为写着「包内文档: 无」的跳转空壳, 读一个产品需在仓库两端跨 3-4 级目录往返。
2. **强制每包必建 `docs/` 催生空壳**: 4 个包里有 3 个出现空章节或 13 行纯跳转路由页 (`packages/create-clis/docs/README.md`), 违背「不为想象中的结构预留空目录」原则, 还被脚手架扩散至外部新项目。
3. **根 `docs/` 混入产品资产击穿构建缓存与污染脚手架**: `docs/sweep/` 与 `docs/codd/` 住在仓根 `docs/` 下, 既拖累 `turbo.jsonc` 缓存面, 又迫使 `create-clis` 长期维护排除名单与特例别名。
4. **仓级 ADR 总索引被垂直业务决策淹没**: 仓库工程治理、`node_modules` 清理逻辑与 MongoDB 9.0 oplog 配额混排在同一张仓级总表, 随工具增多迅速稀释信噪比。
5. **同时确立工具形态基线**: 经实战复盘, 后续在本仓沉淀的 CLI 工具默认拆为「可编程 API 主包 (`@iyowei/<name>`) + CLI 薄壳从包 (`@iyowei/<name>-cli`)」双包形态 (承继 [ADR 0010](0010-dual-package-monorepo.md) 切分原则, 并正式将 `codd` 拆分为 `@iyowei/codd` + `@iyowei/codd-cli`), 以支持未来被更大格局的程序直接编程集成。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[维持三级结构, 仅允许 `docs/<product>/adrs/`]**

放弃理由: 仍把产品文档留在仓根 `docs/` 下, 主包无法以单棵目录树自包含, 既不利于未来独立拆仓与划定 AI 上下文窗口, 也持续需要脚手架与构建缓存对 `docs/<product>/` 做排除维护。

**[全部产品文档与 ADR 上移至仓根 `docs/<product>/`, 撤销全部 `packages/*/docs/`]**

放弃理由: 规则虽单一, 但彻底割裂了源码与产品文档的物理内聚性; `packages/<pkg>/` 不再自包含, 且每次新增工具仍会污染仓根 `docs/` 目录树。

## 决策与理由 (Decision & Why)

1. **回归极简两级文档结构 (仓库级 `docs/` + 包级 `packages/<pkg>/docs/`)**:
   - **仓库级 (`docs/`) 彻底去产品化**: 只放跨产品的仓库治理、工程开发指南 (`development.md`)、脚手架机制 (`designs/`) 与仓级工程 ADR (`adrs/`), 不再设立仓根 `docs/<product>/` 产品区。
   - **产品全套文档随主包内聚**: 每个工具产品的整体设计、协议/验收套件、运维手册与产品 ADR 全部收敛进其主包 (即与产品同名的 API 包) `packages/<product>/docs/` (例如 `packages/sweep-node-modules/docs/` 与 `packages/codd/docs/`); CLI 薄壳从包按需仅保留自身命令面与交互契约 (`packages/<product>-cli/docs/designs/cli-surface.md`), 并以相对链接指回主包。
2. **包级 `docs/` 改为按需创建, 彻底消灭空壳**:
   - 有专属包内设计或包级 ADR 时才建 `packages/<pkg>/docs/`; 无独立包内文档的包 (如 `create-clis`, 其脚手架设计属仓库级机制留驻 `docs/designs/`) 不建空壳 `docs/` 目录, 总索引直链其包根 `README.md` 与对应仓库级设计。
3. **ADR 编号与索引分层**:
   - **全仓共用一套递增四位编号, 既有编号 (`0001-0018`) 永不重编**, 由引用闸门 (`scripts/lint-doc-references.ts`) 联合扫描仓级与全部包级 `docs/adrs/` 并拦截任何跨级重号碰撞;
   - 仓级 [docs/adrs/README.md](README.md) 改为仅登记**仓库级工程 ADR** (并在索引导语中列出持有产品 ADR 的各主包入口), 不再手工抄录垂直业务 ADR。
4. **包根 README 禁止逃逸相对链接**:
   - 可发布至 npm 的 `packages/<pkg>/README*.md` 严禁使用指向包外 (`../` 或 `/...`) 的相对链接, 仓内深度文档统一使用 GitHub 绝对链接, 由 `scripts/lint-doc-references.ts` 物理拦截, 根治 npm 页面 404。
5. **双包工具默认范式**:
   - 集合内面向日常研发的独立 CLI 工具默认采用「可编程 API 主包 (`@iyowei/<name>`) + CLI 薄壳从包 (`@iyowei/<name>-cli`)」双包形态; `codd` 随本批次拆为 `@iyowei/codd` 与 `@iyowei/codd-cli`。

理由: 让仓库根 `docs/` 100% 纯净、让每个产品主包 100% 自包含, 消除「设计与 ADR 分居仓库两端」和空壳目录维护税, 同时彻底解除 `turbo` 缓存与 `create-clis` 模板快照对产品文档的耦合。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 仓库根 `docs/` 完全去产品化, `create-clis` 模板快照不再需要维护产品文档排除名单, 改动任一产品文档不再击穿全仓构建缓存;
- 每个产品主包 (`packages/sweep-node-modules/`、`packages/codd/`) 一棵目录树即包含源码、模板/契约、设计与全部产品 ADR, 独立拆仓与 AI 上下文聚焦成本最低;
- 消除 3/4 包 `docs/README.md` 空壳化与 9+ 处手工索引同步税。

**代价**

- 既有 `docs/sweep/` 与 `docs/codd/` 需一次性迁入对应主包 `packages/*/docs/`, 并同步更新仓内文档与 `scripts/transcription/` 的相对路径;
- 双包产品的产品级 ADR 统一归主包 (API 包) 持有, CLI 薄壳包的少量交互决策 (如历史 ADR 0004) 仍留在主包产品决策全集中, 通过包内入口互链定位。

## 验证方式与关联引用 (Validation & References)

**落地核验**

1. 根目录下 `docs/sweep/` 与 `docs/codd/` 已完全迁入 `packages/sweep-node-modules/docs/` 与 `packages/codd/docs/`, 空壳 `packages/create-clis/docs/` 已移除;
2. `bun scripts/lint-doc-references.ts` 全绿 (覆盖相对链接、包根 README npm 外链禁令、`§` 节号就近消歧、跨级 ADR 存在性与唯一性);
3. `bun run ci` 全链 (含双包 `codd`/`codd-cli` 与 `sweep` 转写验收) 全绿。

**关联引用**

- 被取代的历史决策: [ADR 0011](0011-docs-and-adr-layering.md);
- 双包切分原则: [ADR 0010](0010-dual-package-monorepo.md);
- 现行协议细则: [文档分层协议](../designs/docs-layering.md) / [包分类与发布协议](../designs/package-classification.md)。
