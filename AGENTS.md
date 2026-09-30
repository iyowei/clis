<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓库是 CLI 工具集合仓 (仓库名 `iyowei/clis`; 边界与结构见 [集合仓定位](docs/designs/collection-positioning.md))。本节说明**文档之间的关系和阅读顺序**, 分层规则见 [文档分层协议](docs/designs/docs-layering.md)。

## 文档分层与读取路径

- **仓库级文档**在 `docs/`: 先读 [文档总索引](docs/README.md); 仓库级设计的入口是 [设计文档索引](docs/designs/README.md);
- **产品区文档**在 `docs/<product>/` (现为 `docs/sweep/`): 该产品的跨包与整体文档、验收套件都在这; 从 [产品区 README](docs/sweep/README.md) 进;
- **包级文档**在各包 `packages/<pkg>/docs/`, 入口固定是包内 `docs/README.md` (里面有该包的文档清单、包级 ADR 和指回上级的链接; 内部 `designs/`、`adrs/` 的组织方式与仓库级相同);
- **ADR 编号全仓库共用一套, 不会重号**: 仓库级的在 `docs/adrs/`, 包级的在各包 `docs/adrs/`; 总索引 [docs/adrs/README.md](docs/adrs/README.md) 列出全部编号 (包级的条目直接链到包内文件);
- **读取顺序**: 总索引 → 产品区或包入口 → 明细; 三级文档互相链接, 从任何一级都能找到另外两级 (仓库级 ↔ 产品区 ↔ 包级)。

## 结构事实

- 包怎么分类、怎么发布见 [包分类与发布协议](docs/designs/package-classification.md); 包之间的依赖方向见 [依赖方向纪律](docs/designs/dependency-direction.md);
- 工程闸门链只有一份步骤清单, 就是 `scripts/ci.ts` (本地全链、pre-push、CI、Release verify 跑的是同一套; 其中 Release 的 `release` job 在获批后多一步发布凭据预检, 即 `npm-trust` 步, 见[开发指南](docs/development.md)「发布」章);
- 提交信息与发布链的约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
