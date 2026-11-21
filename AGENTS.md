<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓库是 CLI 工具集合仓 (仓库名 `iyowei/clis`; 边界与结构见 [集合仓定位](docs/designs/collection-positioning.md))。文档采用极简两级结构 (见 [文档分层协议](docs/designs/docs-layering.md) 与 [ADR 0019](docs/adrs/0019-two-tier-package-owned-docs.md))。

## 文档分层与读取路径

- **仓库级文档 (`docs/`)**: 纯工程治理与脚手架机制, 从 [文档总索引](docs/README.md) 进; 仓库级设计入口是 [设计文档索引](docs/designs/README.md), 仓库级工程 ADR 入口是 [docs/adrs/README.md](docs/adrs/README.md);
- **包级 / 产品文档 (`packages/<pkg>/docs/`, 按需创建)**: 每个工具产品的整体设计、协议套件与产品 ADR 全部内聚在其主包 (API 包) 下 (`packages/sweep/docs/README.md`、`packages/codd/docs/README.md`); CLI 薄壳从包按需仅保留命令面契约 (`packages/sweep-cli/docs/README.md`、`packages/codd-cli/docs/README.md`), 无独立包内文档的包 (如 `create-clis`) 不建空壳目录;
- **ADR 编号全局唯一、永不重编**: 仓库级工程 ADR 留在 `docs/adrs/`, 产品 ADR 随主包住在 `packages/<pkg>/docs/adrs/`, 引用闸门联合扫描两级并拦截重号;
- **读取顺序**: 总索引 (`docs/README.md`) → 仓库级设计或对应产品主包 `packages/<pkg>/docs/README.md` → 明细。

## 结构事实

- 默认双包范式与三类包判定见 [包分类与发布协议](docs/designs/package-classification.md); 包间依赖方向由 `scripts/lint-dependency-direction.ts` 物理强制 ([依赖方向纪律](docs/designs/dependency-direction.md));
- 通用多技术栈清理器双包为 `packages/sweep` (`@iyowei/sweep`) 与 `packages/sweep-cli` (`@iyowei/sweep-cli`, 命令 `sweep`, 配置环境变量 `SWEEP_CONFIG`, 默认路径 `~/.config/sweep/config.json`, 当前均标 `"private": true` 隔离于自动发布链之外);
- 工程闸门链只有一份步骤清单, 就是 `scripts/ci.ts` (本地全链、pre-push、CI 与 Release 前置门禁共用; Release 获批后额外经 `--only npm-trust` 跑 OIDC 凭据预检, 见 [开发指南](docs/development.md)「发布」章);
- 提交信息与发布链约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
