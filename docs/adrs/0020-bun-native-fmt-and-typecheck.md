# ADR 0020: 采用 Bun 原生格式化与类型检查并明确工具链保留边界

> **状态**: 已接受 (Accepted)
> **日期**: 2026-11-20
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 上下文与问题 (Context & Problem)

本仓在 [ADR 0005](0005-engineering-gates-and-hooks.md) 中确定了 lefthook + 分层门禁体系, 当时格式检查采用 `prettier` (配 `@trivago/prettier-plugin-sort-imports`), 类型检查采用 `tsc --noEmit`, 代码检查采用 `oxlint`。随着集合仓增长至 6 个工作区包与数百个源码/文档文件, 每次 `pre-commit` 与 CI 中最耗时的环节集中在 Node 进程启动 `prettier` 与多次串/并行 `tsc --noEmit` (数秒级开销, 连续原子提交场景下体感尤为明显)。

本仓开发工具链已升级锁定至 **Bun `1.4.5`** (`packageManager: "bun@1.4.5"`)。实测 `bun 1.4.5` 已在稳定版内置两项 Rust 原生工具:

- `bun fmt` / `bun fmt --check`: 兼容 `.prettierrc`、`.prettierignore` 与 `.editorconfig`, 并原生内置 `@trivago/prettier-plugin-sort-imports` 语义;
- `bun check`: 多核原生 TypeScript 类型检查器 (基于 `typescript-go` 架构), 读 `tsconfig.json` 输出与 `tsc --noEmit` 对齐的诊断。

与此同时, 实测 `bun 1.4.5` **尚未发布内置 `bun lint`**, `bun check` **不负责输出 `.d.ts` 声明文件**, 且 `create-clis` 承诺支持无 Bun 的纯 Node 运行时 (`npx create-clis`)。因此需要一次清晰的分层边界决策: 哪些环节切换到 Bun 原生实现, 哪些依赖必须明确保留以及保留理由。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[方案 A: 一刀切卸载 `prettier`、`typescript` 与 `oxlint`]**

放弃理由: 三个不可逾越的硬约束会导致功能直接断裂: ① `bun check` 只做类型检查、不发射 `.d.ts` (`--emitDeclarationOnly`), 3 个库包 (`@iyowei/sweep`、`@iyowei/codd` 与仓内共享私有库 `@iyowei/cli-updater`) 所需的 `.d.ts` 类型声明将无从产出; ② `create-clis` 支持在仅安装 Node.js (`>= 22.18`) 的用户机器上经 `npx create-clis` 执行, 卸载其运行期 `prettier` 依赖会让纯 Node 用户的生成物失去格式化收口; ③ `bun 1.4.5` 尚无内置 `bun lint` 命令。

**[方案 B: 维持现状, 继续在钩子与 CI 中跑 Prettier + `tsc --noEmit`]**

放弃理由: 在已升级并锁定 `bun@1.4.5` 的前提下, 放弃近 50 倍的格式化提速与 10 倍级的类型检查提速没有工程收益, 反而让根仓与 `create-clis` 生成的所有目标项目继续背负多余的 `prettier` 及其插件 `devDependencies`。

**[方案 C: 引入 Biome 取代 Prettier + oxlint]**

放弃理由: 形成第三套配置与规则体系, 无法直接承接 `.oxlintrc.json` 已沉淀的 122 条规则 (`unicorn` / `import/no-cycle` / `max-lines` 等), 且在 Bun 已原生内置 `fmt` / `check` 的节点引入额外大工具得不偿失。

## 决策与理由 (Decision & Why)

1. **格式检查与写入切换至 `bun fmt`**:
   - 根仓 `format` / `format-check`、`scripts/ci.ts` 的 `format-check`、`lefthook.yml` 的 `pre-commit` (`fmt-js` / `fmt-other`) 以及 `create-clis` 模板骨架同步切换为 `bun fmt` 与 `bun fmt --check`;
   - 根 `package.json` 与 `create-clis` 模板骨架 `devDependencies` 移除 `prettier` 与 `@trivago/prettier-plugin-sort-imports`;
   - 保留仓库根 `.prettierrc` 与 `.prettierignore` 作为**单一事实来源**: `bun fmt` 与 `create-clis` 运行期 Prettier 共用同一份配置, 避免配置分裂导致两套工具格式化结果漂移。注 (2026-11-21 实测校准): `bun 1.4.5` 需在 `.prettierrc` 中保留 `"plugins": ["@trivago/prettier-plugin-sort-imports"]` 才会激活内置 import 排序; 为避免未安装本地 `prettier` 依赖导致 IDE 扩展报错, `.vscode/settings.json` 与 `.vscode/extensions.json` 同步移除了对 `esbenp.prettier-vscode` 的默认绑定与推荐。
2. **纯类型检查 (`typecheck`) 切换至 `bun check`**:
   - 根仓 (`turbo run typecheck && bun check`)、全部 6 个工作区包与 `create-clis` 模板骨架的 `typecheck` 脚本统一由 `tsc --noEmit` 切换为 `bun check`。
3. **三处必要保留边界 (明确禁止误删)**:
   - **保留根 `devDependencies` 的 `typescript`**: 专用于 3 个库包 `scripts/build.ts` 的 `tsc -p tsconfig.build.json --emitDeclarationOnly` 生成 `.d.ts` 类型声明, 以及 `scripts/lint-doc-examples.ts` 精确解析 `TSxxxx` 诊断行;
   - **保留 `packages/create-clis/package.json` `dependencies` 的 `prettier` 与 `@trivago/prettier-plugin-sort-imports`**: 保障纯 Node 环境 (`npx create-clis`, 无 Bun) 下生成物仍可完成格式化收口, 并由 `packages/create-clis/src/cli.e2e.test.ts` 以 `bun fmt --check` 端到端锁死 Prettier 收口与 Bun `fmt` 零差异对齐;
   - **保留根 `devDependencies` 的 `oxlint`**: 承接 `.oxlintrc.json` 全部规则集 (Rust 实现, 全量扫描 ~25ms)。
4. **再议触发条件 (未来演进准入线)**:
   - **替换 `oxlint`**: 当 Bun 正式稳定发布 `bun lint`, 且实测覆盖 `.oxlintrc.json` 现有关键规则 (`max-lines`、`max-depth`、`import/no-cycle`、`unicorn` 族等) 无语义退化时再立新决策评估迁移;
   - **移除 `typescript`**: 仅当 Bun 原生构建稳定提供全语义等价的 `.d.ts` 生成能力且通过全仓库包类型声明闸门 (`verify:release`) 与 `lint-doc-examples` 核验时再议。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- **显著提速**: 本地实测 `bun fmt --check` 扫全仓 464 个文件仅 **54.8ms** (原 Prettier 约 2~3 秒), `bun check` 扫根项目 214 个文件仅 **98.8ms**、6 个子包各 **18~51ms**; `pre-commit` 与 CI 验证耗时大幅压缩。
- **依赖减负**: 根仓与脚手架生成的新项目不再在 `devDependencies` 安装 `prettier` 与 `@trivago/prettier-plugin-sort-imports`, 装包体积更轻且零配置迁移成本。
- **单一配置源闭环**: 继续使用 `.prettierrc` / `.prettierignore`, 开发者 IDE 插件、本仓 `bun fmt` 与 `create-clis` 纯 Node 运行期收口三方口径完全一致。

**代价与风险**

- **工具链最低 Bun 版本绑定**: `bun fmt` 与 `bun check` 要求开发与 CI 环境不低于 Bun `1.4.5` (已由根 `package.json` 的 `packageManager` 与模板骨架强锁定)。
- **跨工具微小版本漂移风险**: `create-clis` 内部使用 npm `prettier` 而生成物校验使用 `bun fmt --check`, 未来两者大版本升级可能出现极少数语法格式化细微差异; 通过 `packages/create-clis/src/cli.e2e.test.ts` 与 `heavy-smoke` 持续做真机对账兜底, 出现差异立即在 CI 红灯暴露。

## 验证方式与关联引用 (Validation & References)

**实测核验 (2026-11-20, Bun `1.4.5`)**

1. `bun fmt --doctor`: 确认识别 `.prettierrc` + `.editorconfig`, 464 个文件全部原生格式化, 内置 `@trivago/prettier-plugin-sort-imports`;
2. `bun fmt --check --timing`: 464 个文件 **0 差异**, 总耗时 **54.8ms**;
3. `bun check --timing` 与 6 包 `bun check -p <pkg>/tsconfig.json`: 根目录 214 文件 **98.8ms**、各子包 **18~51ms**, 全部 **0 错**;
4. `bun fmt --check --log-level=error --no-error-on-unmatched-pattern <ignored>`: 仅暂存 `.prettierignore` 忽略文件时退出码 `0`, 不误拦提交;
5. 全量 `bun run ci`、`bun run ci -- --verify-windows` 与 `packages/create-clis heavy-smoke` (隔离装包 + 生成物零 Prettier 依赖跑通 `bun run ci`) 全绿。

**关联引用**

- 分层门禁框架与 lefthook 守卫见 [ADR 0005](0005-engineering-gates-and-hooks.md) (本文修订其第 2、3 条的工具实现, 保留其分层框架决策)。
- 双运行时约束与 Bun 优先策略见 [ADR 0006](0006-dual-runtime-bun-first.md)。
- 日常命令与钩子用法见 [开发指南](../development.md) 与 [CONTRIBUTING](../../CONTRIBUTING.md)。
