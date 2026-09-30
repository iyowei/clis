# 向 {{NAME}} 贡献

[English](CONTRIBUTING.md) | **中文**

感谢你抽出时间参与贡献。缺陷报告、功能建议、文档修正与 pull request 都欢迎。

参与本项目的所有人都受[行为准则](CODE_OF_CONDUCT.md)约束。

## 贡献方式

- 报缺陷: 用缺陷报告表单开一个 issue;
- 提功能: 用功能建议表单开一个 issue;
- 提改动: 开一个 pull request。超出小修的改动请先开 issue, 把做法谈定再动手;
- 报安全问题: 不要开公开 issue, 按 [SECURITY.md](SECURITY.md) 走。

<!-- 模板骨架: 示例包是占位实现; 换成自己的工具后, 同步下面「仓库结构」与两条命令示例。 -->

## 仓库结构

本仓库是 turbo 管理的 monorepo, 每个工具都住在 `packages/` 下:

- `packages/{{NAME}}-cli`: 命令行工具 `{{BIN_NAME}}`, 发布为 `{{SCOPE}}/{{NAME}}-cli`;
- `packages/{{NAME}}`: 可编程 API 包, 发布为 `{{SCOPE}}/{{NAME}}`。

## 环境准备

前置: bun 与 node。

- bun 是开发工具链与包管理器; 版本经 `packageManager` 锁定;
- node 亦为必需, `>= 22.18.0`;
- `.nvmrc` 给版本管理器锁 node 大版本, `.gitattributes` 强制仓库内 LF 行尾。

```shell
# 装依赖; 在检出态同时装好 git 钩子 (lefthook)
bun install
```

钩子在入口把关 (pre-commit: 全项目类型检查 + prettier / oxlint 扫暂存文件), 推送前再跑一遍全量检查 (pre-push 跑 `bun scripts/ci.ts`, 步骤清单的单一来源)。机器上没有 lefthook 时, 钩子链经 bunx 取 pin 版兜底。配置见 [lefthook.yml](lefthook.yml)。

## 常用命令

以下命令均在仓库根执行:

```shell
# 类型检查 (tsc --noEmit, 经 turbo)
bun run typecheck

# 代码检查 (oxlint); `bun run lint:fix` 自动修复
bun run lint

# 格式化 (prettier --write .)
bun run format

# 测试 (经 turbo; `bun test` 直跑测试器)
bun run test

# 打包各包的发布产物
bun run build

# 本地 CI 预演 (与 GitHub Actions 同一套步骤清单)
bun run ci
```

环境准备、提交钩子与发布链的完整说明见[开发指南](docs/development.md)。

## 提交

- 用 Conventional Commits 类型前缀 (`feat` / `fix` / `chore` / `test` / `refactor` 等) 加一句短描述;
- 守单一主题原则: 一个提交只含一个完整逻辑变更, 跨主题须拆分;
- 破坏性变更必须双标齐备: 类型后的 `!` (`feat!: ...`) 驱动版本判定, 英文 `BREAKING CHANGE: <描述>` footer 是发布说明生成器认得的形态; 只有 `!` 而 footer 不可识别时, 该提交会整个丢掉、不进 CHANGELOG。

## Pull request

- 填好 pull request 模板, 让 PR 聚焦单一主题;
- 关联它解决的 issue; 较大改动, 那个 issue 就是讨论做法的地方;
- CI 对每个 PR 跑完整检查: 构建 / 类型 / 测试 / lint / 格式;
- 不要手动改版本号或 CHANGELOG; 发布由 `main` 上的自动链完成 (semantic-release, 带维护者批准闸门)。

## 文档

工程技术文档在 `docs/` 下, 索引是 [docs/README.md](docs/README.md)。新增文档必须登记到它所属的索引 (`adrs/`、`designs/` 下的登记到各自 README, 其余登记到总索引); 不接受索引之外的孤岛文档。改动行为或已登记契约时, 同一个 PR 里把对应文档一并更新。

## 提问

开一个 issue, 或在既有讨论里 @{{OWNER}}。
