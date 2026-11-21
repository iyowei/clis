# ADR 0003: 零运行时依赖

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]
> **修订 (2026-09-23)**: 本 ADR 初稿包含 bun 专属的运行时范围与安装形态表述, 这部分已由 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) 修订为双运行时与启动器形态; 本 ADR 的范围收窄到依赖与构建策略, 运行时的事一律以 ADR 0006 为准。
> **修订 (2026-09-23)**: 决策第 2 条的「零构建」已被 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) 局部取代: 开发时仍然零构建, 只有 npm 发布形态会产出编译产物; 本 ADR 的零运行时依赖策略不受影响。
> **修订 (2026-09-27)**: 决策第 3 条的 devDependencies 列举已修订: 钩子工具 lefthook 从依赖列表里移出 (不列依赖的理由与取用方式见文末补记); 本 ADR 的零运行时依赖策略不受影响。

## 上下文与问题 (Context & Problem)

工具是个人自用的 CLI, 要在多台机器上跑。它要用的东西 (文件系统、子进程、readline、ANSI 转义) 运行时基本都自带。引入第三方运行时依赖要付出三样成本: 供应链与安全风险、跟着上游走的升级维护、分发链路里的依赖树。所以要定下来: 依赖与构建策略的边界划在哪。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[引入第三方工具库 (chalk / commander / glob 一类)]**

放弃理由: 这个项目的 CLI 规模很小 (一个主命令 + 一个子命令 + 几个旗标), 颜色与参数解析自己手写, 规模可控; 扫描是高度定制的行为 (命中剪枝、排除名单、符号链接策略), 通用库的默认行为反而得逐个绕开。用一棵依赖树换这几百行, 不划算。

**[引入表格渲染 / 进度条一类便利包]**

放弃理由: 输出追求紧凑清单, 自己写几十行渲染就够; 便利包带来的传递依赖与版本锁定, 成本大于收益。

**[引入构建工具 (打包 / 转译链)]**

放弃理由: 两个运行时都能直接跑 TypeScript (见 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md)), 构建步骤只会多出「改完要重跑构建」的摩擦; 没有依赖要打包, 也没有产物要管理 (该判断的适用范围已被 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) 收窄: npm 发布形态需要一次 `bun build`, 开发时不受影响)。

## 决策与理由 (Decision & Why)

1. **运行时零依赖**: 运行时执行的代码只 import 运行时内置模块 (`bun:` / `node:`) 和相对路径模块, 不引任何第三方包; ANSI 颜色与参数解析手写。
2. **零构建**: 源码直接跑, 没有产物, 没有打包步骤, 改完即生效 (已被 [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) 局部取代: 开发时仍然零构建, npm 发布形态产出编译产物)。
3. **边界: 开发工具链不受限**: devDependencies (oxlint / prettier / lefthook / typescript 等) 不进运行时代码, 也不受本条约束; 但它们一律精确锁定版本 (见 [ADR 0005](../../../../docs/adrs/0005-engineering-gates-and-hooks.md))。(2026-09-27 修订: 钩子工具 lefthook 从依赖列表里移出, 见补记)

选择原因: 依赖归零, 供应链风险、升级负担、构建步骤也跟着归零, 这是个人小工具这一档里最低的长期维护成本。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- 没有供应链风险, 没有依赖升级, 没有锁文件漂移, 没有构建步骤。
- 代码全是业务逻辑, 评审范围小。

**代价**

- 个别能力需要手写 (参数解析、ANSI 渲染), 手写的量由 CLI 规模决定; 如果 CLI 明显增长, 这条就要重新评估。

## 验证方式与关联引用 (Validation & References)

**验证办法 (实现落地后核验)**

1. 静态核验: 扫描 `src` / `bench` / `scripts` 下所有 import 来源 (也就是 tsconfig include 的全部范围), 只允许 `bun:` / `node:` 前缀和相对路径, 出现第三方包名就算违规;
2. 双运行时直接跑: `bun src/cli.ts` 与 `node src/cli.ts` 输出一致 (验证办法与 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) 相同)。

> **修订指引 (2026-09-30)**: 本节的路径还是单包时代写的; 拆成双包后, 源码在 `packages/sweep-node-modules{,-cli}/src`, 直接跑的入口是 `bun packages/sweep-node-modules-cli/src/cli.ts` (见 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md))。

**关联引用**

- 双运行时与安装形态见 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md)。
- 定位见 [ADR 0001](0001-workspace-level-cleaner.md)。

## 补记 (2026-09-27)

决策第 3 条的 devDependencies 列举原本含 lefthook, 修订为**不列依赖**: lefthook 自带 postinstall, 而包管理器默认信任它 (bun 的内置信任名单里就有 lefthook), 本地路径 / vendor 这类形态下, 它会被装进使用方的 `node_modules`, 并把钩子写进使用方仓库的 `.git/hooks`。取用方式改为: 安装期按 PATH 上的 `lefthook` (如 `brew install lefthook`) → `lefthook.yml` 的 `lefthook:` 配置值 (经 bunx 取锁定版本; 安装期与执行期读的是同一行, 单一事实来源), 执行期的版本锁定只有 `lefthook.yml` 一处。不列依赖的理由与实测的完整细节见 [ADR 0005](../../../../docs/adrs/0005-engineering-gates-and-hooks.md) 决策第 1 条, 本文不复述。
