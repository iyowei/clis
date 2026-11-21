# ADR 0021: 演进为通用工作区清理器 `@iyowei/sweep` / `@iyowei/sweep-cli`

> **状态**: 已接受 (Accepted), 局部取代 [ADR 0001](0001-workspace-level-cleaner.md) 与 [ADR 0002](0002-fixed-config-and-preview-execution.md) 中的 `node_modules` 单一职责限定
> **日期**: 2026-11-20
> **决策者**: 沈委
> **标签**: [工程, 架构]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

[ADR 0001](0001-workspace-level-cleaner.md) 最初将工具限定为只清理 `node_modules` 的单技术栈工具 (`@iyowei/sweep-node-modules` + `@iyowei/sweep-node-modules-cli`, 命令 `sweep-nm`), 并预留了「将来若出现多种工作区级清理需求, 再议是否抽取共享基础库或整合」的演进节点。

随着日常开发跨 Node.js、Rust、Python、Java、C/C++ 多技术栈并行, 工作区磁盘占用早已不止 `node_modules`: Rust `target/`、Python `.venv/` 与测试/类型缓存、Maven/Gradle 产物、CMake 构建目录以及操作系统元数据垃圾文件 (`.DS_Store`、`Thumbs.db`) 共享完全一致的「多根扫描、锚定防误删、体积核算、预览复核、批量清理」主轴。继续为每种语言另起 `sweep-*` 兄弟包会带来大量重复配置与维护税。

同时, 本工具尚无存量外部 npm 用户, 当前处于重塑定位与包名的最佳窗口期; 在新契约与跨平台回收站机制完成充分打磨待首发前, 也需与公开自动发布链隔离。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[为每种技术栈各自维护独立的 `sweep-*` 双包工具]**

放弃理由: 扫描并发池、体积统计双轨、安全闸五不变量、跨设备边界、视觉渲染、配置与迁移逻辑在各语言间 90% 同构; 拆成多个命令会让用户记多套配置文件和排除名单, 体验割裂且工程维护成本成倍放大。

**[另起第三个内部私有包 (如 `@iyowei/sweep-core`) 承载通用引擎]**

放弃理由: 仓内默认双包范式 ([ADR 0019](../../../../docs/adrs/0019-two-tier-package-owned-docs.md)) 已清晰界定「API 主包承载全部域能力 + CLI 从包做薄壳」; 再拆第三个私有包只会增加工作区编排、构建链路与类型导出缝合成本, 没有任何独立消费者。

**[保留旧名 `sweep-nm` 过渡别名并向 npm 发 `deprecate` 公告]**

放弃理由: 当前无存量外部用户, 保留双名别名与历史过渡文案只会制造命令歧义和长期死代码; 彻底更名后仅在本地配置迁移模块中保留旧配置文件路径的只读探测与无损升级通道即可。

## 决策与理由 (Decision & Why)

1. **包重命名与唯一命令**: 将原 `packages/sweep-node-modules` 与 `packages/sweep-node-modules-cli` 整体演进并重命名为 `packages/sweep` (`@iyowei/sweep`) 与 `packages/sweep-cli` (`@iyowei/sweep-cli`), 唯一可执行命令为 `sweep`, 彻底移除 `sweep-nm` 与旧目录。
2. **三包合一收归内部模块**: 通用遍历引擎、预设锚定注册表、自定义规则引擎、体积双轨、安全闸、跨平台回收站/删除通道与 `plan`/`run` 编排全部收归 `@iyowei/sweep` 内部清晰分层模块, 不再另起第三个私有包。
3. **显式 `"private": true` 隔离发布链**: 在 `@iyowei/sweep` 与 `@iyowei/sweep-cli` 的 `package.json` 中显式标记 `"private": true`, 在首发前与 `multi-semantic-release` 与 `scripts/npm-trust-guard.ts` 隔离; 依据仓级依赖方向规则 (`cli → private-lib`), `@iyowei/sweep-cli` 依赖 `@iyowei/sweep` 合法合规。
4. **延续核心工程底线**: 严格继承 [ADR 0003](0003-zero-runtime-deps.md) (零第三方运行时依赖, 仅 `bun:` / `node:` 内置与相对模块)、[ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) (Bun 优先 + Node `>= 22.18.0` 兼容) 与 [ADR 0008](0008-transcription-kit.md) (双面转写契约套件)。

理由: 用一套配置、一条 `sweep` 命令和一份零依赖 API 主包统一覆盖多技术栈工作区清理, 复用既有高性能并发与纵深安全基线, 同时把包结构维持在极简双包形态。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 单一命令 `sweep` 与单一配置管辖多技术栈构建/缓存产物与系统垃圾文件, 可持续扩展新预设。
- 复用既有 32 路并发扫描、双轨体积统计、五不变量安全闸与 4 路并发删除架构, 零第三方依赖。
- 标 `"private": true` 防止重构演进期误发半成品到公共 npm registry。

**代价**

- 需同步迁移仓内全部路径引用、文档、转写金样本语料、`scripts/` 闸门与 `create-clis` 模板快照坐标。
- 删除安全闸不再能依赖「末段必须是 `node_modules`」单一硬编码, 须泛化为「预设锚定校验 + 规则安全词表约束 + 完整纵深复核」, 详见 [ADR 0022](0022-config-v2-presets-and-rules.md)。

## 验证方式与关联引用 (Validation & References)

**验证方式**

1. 全仓检索确认非历史 ADR 注记与非旧配置迁移模块中 `sweep-nm` / `sweep-node-modules` / `SWEEP_NM_CONFIG` 零残留;
2. `bun scripts/ci.ts` 全链路 (`build` / `typecheck` / `test` / `lint` / `format-check` / `lint:refs` / `lint:examples` / `lint:deps` / `lint:coverage` / `lint:backups` / `conformance:bun` / `conformance:node`) 全绿。

**关联引用**

- 演进前历史定位: [ADR 0001](0001-workspace-level-cleaner.md) / [ADR 0002](0002-fixed-config-and-preview-execution.md);
- 配套配置、回收站与交互决策: [ADR 0022](0022-config-v2-presets-and-rules.md) / [ADR 0023](0023-zero-dep-cross-platform-trash.md) / [ADR 0024](0024-cli-init-migrate-and-summary-display.md);
- 仓级双包与分层规范: [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md) / [ADR 0019](../../../../docs/adrs/0019-two-tier-package-owned-docs.md)。
