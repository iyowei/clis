<!-- BEGIN:turborepo-agent-rules -->

# This is NOT the Turborepo you know

Turborepo configuration, task behavior, and CLI commands can vary between installed versions and may differ from your training data. Resolve the `turbo` package from this file's directory or relevant workspace; in monorepos, it may not be visible from the repository root. For example, run `node -p "require.resolve('turbo/package.json')"` from a workspace that depends on `turbo`.

Read `docs/README.md` inside that installed package first, then read the relevant pages from its `docs/` directory before changing Turborepo configuration or commands. Heed deprecation notices. These bundled docs match the installed package version and are available without network access.

This block is written and re-added by `turbo` before repository-scoped commands when an AI agent is detected. In the Turborepo source repository, its template is defined in `crates/turborepo-cli/src/cli/agent_guidance.rs`. Removing the managed block while updates are enabled means a later qualifying invocation will add it again. Set `"agentGuidance": false` in the root `turbo.json` or `turbo.jsonc` to opt out; this does not remove an existing block. Keep the block committed with your work to avoid an uncommitted change on the next agent invocation.
<!-- END:turborepo-agent-rules -->

# 仓库导航 (供 AI Agent 与人类读者)

> 本仓定位为 CLI 工具集合仓 (仓库名 `iyowei/clis`; 边界与结构见 [集合仓定位](docs/designs/collection-positioning.md))。本节说明**文档关联关系的读取路径**, 规则正文见 [文档分层协议](docs/designs/docs-layering.md)。

## 文档分层与读取路径

- **仓库级文档**在 `docs/`: 先读 [文档总索引](docs/README.md); 仓库级设计入口为 [设计文档索引](docs/designs/README.md);
- **产品区文档**在 `docs/<product>/` (现为 `docs/sweep/`): 该产品的跨包/整体文档与验收套件, 入口为 [产品区 README](docs/sweep/README.md);
- **包级文档**在各包 `packages/<pkg>/docs/`, 入口固定为包内 `docs/README.md` (该包文档清单 + 包级 ADR + 回链; 内部 `designs/` 与 `adrs/` 与仓库级同构);
- **ADR 编号跨三级全局唯一**: 仓库级在 `docs/adrs/`, 包级在各包 `docs/adrs/`; 总索引 [docs/adrs/README.md](docs/adrs/README.md) 列全部编号 (包级行外链到包内);
- **读取顺序**: 总索引 → 产品区 / 包入口 → 明细; 各级之间有双向外链 (仓库级 ↔ 产品区 ↔ 包级)。

## 结构事实

- 包协议: 类属与发布见 [包分类与发布协议](docs/designs/package-classification.md), 依赖方向纪律见 [依赖方向纪律](docs/designs/dependency-direction.md);
- 工程闸门链单源为 `scripts/ci.ts` (本地全链 / pre-push / CI / Release verify 同集合);
- 提交信息与发布链约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。
