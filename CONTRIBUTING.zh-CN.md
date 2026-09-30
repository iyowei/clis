# 为 clis 贡献

[English](CONTRIBUTING.md) | **中文**

感谢你抽时间参与贡献。bug 报告、功能请求、文档修正与 pull request 都欢迎。

参与本项目的每个人, 都要遵守 [行为准则](CODE_OF_CONDUCT.md)。

## 贡献方式

- 报告 bug: 用 bug 报告表单开一个 issue。
- 请求功能: 用功能请求表单开一个 issue。
- 提交改动: 开一个 pull request。除小修小补外, 先开 issue, 把方案定下来再动手。
- 报告安全问题: 不要开公开 issue, 按 [SECURITY.md](SECURITY.md) 的指引来。

可以从带 `good first issue` 标签的 issue 入手。

## 仓库结构

本仓库是一个 monorepo, 里面有两个包:

- `packages/sweep-node-modules-cli`: `sweep-nm` 命令行工具, 发布为 `@iyowei/sweep-node-modules-cli`。
- `packages/sweep-node-modules`: 可编程 API 包, 发布为 `@iyowei/sweep-node-modules`。

turbo 跨两个包编排构建、类型检查与测试任务。代码对 bun 与 node 一视同仁 (有 bun 走 bun, 否则走 node, 行为一致), 支持 Windows / macOS / Linux, 并保持零第三方运行时依赖。

## 环境准备

前置要求: bun 与 node。

- bun 是开发工具链与包管理器, 仓库通过 `packageManager` 固定其版本。
- node 同样必需, 版本 >= 22.18.0。测试套件会在两个运行时上都跑, 机器上没装的运行时会被静默跳过, 所以只装一个运行时的机器, 套件有一半不会跑。
- 另外还有几份配套文件, 跟着仓库一起维护: `.nvmrc` 固定 node 主版本 (供版本管理器读取), `.mailmap` 统一提交者身份, `.gitattributes` 强制仓库内用 LF 换行, `.vscode/` 放着共享的编辑器配置 (启动配置、任务、推荐扩展)。

```shell
# 安装依赖; 在克隆出来的仓库里, 会一并装好 git 钩子 (lefthook)
bun install
```

钩子在代码进门时把关 (pre-commit: 全项目类型检查, 外加对暂存文件跑 prettier 与 oxlint), 推送前重跑一遍全量检查 (pre-push 只调用 `bun scripts/ci.ts` 这一条命令: 它是整套检查的唯一出处, 覆盖文档与仓库卫生的四道闸门, 以及双载体的转写契约套件)。机器上没有 lefthook 时, 钩子链会回退到经 bunx 取来的 pin 版。配置见 [lefthook.yml](lefthook.yml)。

仓库的 `.gitignore` 由 fast-gitignore (`fgi`) 从 `.gitignorerc.json` 生成, 不要手改: 新增忽略规则写进这个配置的 `custom` 数组, 再在仓库根重跑 `fgi` (它会读取预设, 把 `.gitignore` 整个重新生成)。

## 常用命令

在仓库根目录执行:

```shell
# 类型检查 (tsc --noEmit, 经 turbo)
bun run typecheck

# 代码检查 (oxlint); `bun run lint:fix` 会自动修复
bun run lint

# 格式化 (prettier --write .)
bun run format

# 单元测试: 契约 / 鲁棒性 / 双运行时 e2e / 冒烟测试
bun test

# 基准测试
bun run bench

# 打包两个包: 单文件 CLI 产物与其清单, 以及 API 包的 bundle 与类型声明
bun run build
```

其余内容见 [开发指南](docs/development.md): 转写契约套件、发布闸门与运行时细节。开发指南和其他工程文档一样, 都是中文写的。

## 双运行时纪律

bun 与 node 上的行为必须一致: 只在其中一个上跑通的改动, 不算完成。注意两点:

- `bun test` 会为每个运行时各注册一遍 e2e 用例, 但只为机器上装了的运行时注册; 缺的一侧静默跳过。想真正覆盖两侧, 就把两个运行时都装上。
- 转写契约套件拿 CLI 输出与字节级金样本比对, 由 pre-push 钩子与 CI 自动执行, 且都在两个运行时上各跑一遍; 需要手工跑时, 对两个载体各跑一遍:

```shell
# 在 bun 运行时上跑转写验收
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# 在 node 运行时上跑转写验收
bun run conformance -- --target "node packages/sweep-node-modules-cli/src/cli.ts"
```

开发中想直接试 CLI, 用任一运行时从源码直跑:

```shell
# 在 bun 上从源码运行 CLI
bun packages/sweep-node-modules-cli/src/cli.ts

# 在 node 上运行同一个文件
node packages/sweep-node-modules-cli/src/cli.ts
```

## 提交

- 提交信息采用 Conventional Commits 类型前缀 (`feat` / `fix` / `chore` / `test` / `refactor` 等) 加简短描述; 现有提交历史里的描述都是中文。
- 每个提交只含一个主题, 不相关的改动拆成独立提交。
- 破坏性变更必须同时带两处标记: 类型后的 `!` (如 `feat!: ...`) 驱动版本号跳变; 发布说明生成器只认英文的 `BREAKING CHANGE: <描述>` footer。不带这个 footer 的 `!` 提交, 会从生成的 CHANGELOG 里整体消失 (2026-09-30 实证)。
- 提交信息格式没有钩子把关; lefthook 钩子把关的是类型检查、lint 与格式化。

## Pull requests

- 填好 pull request 模板, 并保持单一主题。
- 关联对应的 issue; 改动较大时, 方案就是在那个 issue 里讨论的。
- CI 在每个 pull request 上跑全套检查: 在 Ubuntu 上执行 build / typecheck / test / lint / 格式检查, 外加在 macOS 上对 bun 与 node 两个载体跑转写契约套件。
- 不要升版本号, 也不要改 changelog; 发布从 `main` 自动进行 (semantic-release, 带维护者审批闸门)。

## 文档

工程文档在 `docs/` 下; 索引见 [docs/README.md](docs/README.md)。新增文档必须登记到所属索引 (`adrs/`、`designs/` 或 `protocol/` 下的 README, 其余登记到顶层索引); 不接受孤岛文档。改动一旦影响行为或已经写进文档的契约, 就在同一个 pull request 里一并更新对应文档。

## 提问

开一个 issue, 或在现有讨论里 @iyowei。
