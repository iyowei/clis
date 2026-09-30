<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓库是 CLI 工具集合仓。本节说明**文档之间的关系和阅读顺序**。

## 文档分层与读取路径

- **仓库级文档**在 `docs/`: 先读[文档总索引](docs/README.md); 仓库级设计的入口是[设计文档索引](docs/designs/README.md);
- **包级文档**在各包 `packages/*/docs/`, 入口固定是包内 `docs/README.md` (里面有该包的文档清单、包级 ADR 和指回上级的链接);
- **ADR 编号全仓库共用一套, 不会重号**: 仓库级的在 `docs/adrs/`, 包级的在各包 `docs/adrs/`; 总索引 [docs/adrs/README.md](docs/adrs/README.md) 列出全部编号。

## 结构事实

- 工程闸门链只有一份步骤清单, 就是 `scripts/ci.ts` (本地全链、pre-push、CI、Release verify 跑的是同一套);
- 提交信息与发布链的约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
