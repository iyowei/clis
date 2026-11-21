# 仓库级架构决策记录索引

本表列出**仓库级工程与治理 ADR** (`docs/adrs/` 下的记录)。

> 分层说明 (见 [ADR 0019](0019-two-tier-package-owned-docs.md) 与 [文档分层协议](../designs/docs-layering.md)):
>
> - 全仓共用一套四位递增编号, 跨级唯一、永不重编 (由 `scripts/lint-doc-references.ts` 自动检查存在性与防重号);
> - 产品与包级 ADR 随各自产品主包内聚存放, 分别由各主包 `docs/README.md` 索引:
>   - `sweep` 产品 ADR (`0001-0004`, `0007-0008`, `0021-0024`): 见 [packages/sweep/docs/README.md](../../packages/sweep/docs/README.md) (目录 [packages/sweep/docs/adrs/](../../packages/sweep/docs/adrs/))
>   - `codd` 产品 ADR (`0012-0018`): 见 [packages/codd/docs/README.md](../../packages/codd/docs/README.md)

| 编号                                         | 标题                                              | 状态   | 日期       |
| -------------------------------------------- | ------------------------------------------------- | ------ | ---------- |
| [0005](0005-engineering-gates-and-hooks.md)  | 工程闸门与提交钩子                                | 已接受 | 2026-09-23 |
| [0006](0006-dual-runtime-bun-first.md)       | 双运行时支持与 Bun 优先的 API 策略                | 已接受 | 2026-09-23 |
| [0009](0009-npm-distribution-form.md)        | npm 分发形态                                      | 已接受 | 2026-09-23 |
| [0010](0010-dual-package-monorepo.md)        | 双包 monorepo 结构与可编程 API                    | 已接受 | 2026-09-29 |
| [0011](0011-docs-and-adr-layering.md)        | 文档与 ADR 的仓库级 / 包级两级分层                | 已取代 | 2026-09-30 |
| [0019](0019-two-tier-package-owned-docs.md)  | 回归极简两级文档分层与默认双包工具范式            | 已接受 | 2026-11-19 |
| [0020](0020-bun-native-fmt-and-typecheck.md) | 采用 Bun 原生格式化与类型检查并明确工具链保留边界 | 已接受 | 2026-11-20 |

## `sweep` 演进期产品 ADR (`packages/sweep/docs/adrs/`)

> 完整产品 ADR 目录以 [packages/sweep/docs/README.md](../../packages/sweep/docs/README.md) 为准; 以下四篇涉全项目演进与架构边界, 同步登记速览:

| 编号                                                                                | 标题                                                             | 状态   | 日期       |
| ----------------------------------------------------------------------------------- | ---------------------------------------------------------------- | ------ | ---------- |
| [0021](../../packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md)      | 演进为通用工作区清理器 `@iyowei/sweep` / `@iyowei/sweep-cli`     | 已接受 | 2026-11-20 |
| [0022](../../packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)          | 配置 v2、预设锚定校验、自定义规则与保守迁移                      | 已接受 | 2026-11-20 |
| [0023](../../packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md)        | 零第三方依赖的三端回收站 (`trash`) 通道与失败不强删铁律          | 已接受 | 2026-11-20 |
| [0024](../../packages/sweep/docs/adrs/0024-cli-init-migrate-and-summary-display.md) | 自动 `init` / `migrate`、无配置非 TTY 拒盲扫与模板化配置摘要展示 | 已接受 | 2026-11-20 |
