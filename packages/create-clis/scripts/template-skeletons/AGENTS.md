<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓库是 CLI 工具集合仓。本节说明**文档之间的关系和阅读顺序**。

## 文档分层与读取路径

- **仓库级文档**在 `docs/`: 先读[文档总索引](docs/README.md); 仓库级设计的入口是[设计文档索引](docs/designs/README.md), 仓库级 ADR 入口是 [docs/adrs/README.md](docs/adrs/README.md);
- **包级文档**按需建在各包 `packages/<pkg>/docs/` (无独立包内文档时不建空壳目录, 总索引直链包根 `README.md`), 存在包内文档时入口为 `packages/<pkg>/docs/README.md`;
- **ADR 编号全仓库共用一套四位递增编号, 跨级唯一、永不重编**: 仓库级 ADR 位于 `docs/adrs/` 并仅登记在 [docs/adrs/README.md](docs/adrs/README.md); 包级 ADR 位于各包 `packages/<pkg>/docs/adrs/` 并去中心化登记在各自 `packages/<pkg>/docs/README.md`, 引用闸门联合扫描两级防重号。

## 结构事实

- 工程闸门链只有一份步骤清单, 就是 `scripts/ci.ts` (本地全链、pre-push、CI 与 Release 前置门禁共用; Release 获批后额外经 `--only npm-trust` 跑 OIDC 凭据预检, 见 [开发指南](docs/development.md)「发布」章);
- 提交信息与发布链的约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
