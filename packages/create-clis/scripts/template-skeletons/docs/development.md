# 开发指南

> 面向本仓库的维护者与贡献者; 入门级开发说明见 [CONTRIBUTING](../CONTRIBUTING.md), 本文是深入版。设计决策见[设计文档索引](designs/README.md); 发布链见 `.github/workflows/`。

## 环境准备

```shell
# 装 devDependencies, 并在本仓库检出态自动装好 git 钩子 (lefthook)
bun install
```

装钩子由 `scripts/install-git-hooks.mjs` 把守 (prepare 入口): 只在本仓库自身的 git 仓库根执行 `lefthook install`, 被作为依赖安装到别的仓库时自动跳过。lefthook 不列为依赖: 安装期取 PATH 上的 lefthook, 无则按 `lefthook.yml` 的配置经 bunx 取 pin 版; 都不可用时安装照常完成, 只是没有钩子。

## 常用命令

以下命令除注明外均在仓库根执行:

```shell
# 类型检查 (tsc --noEmit; 经 turbo 编排各包)
bun run typecheck

# 代码检查 (oxlint)
bun run lint

# 格式化 (prettier --write)
bun run format

# 测试 (经 turbo 编排各包, 带缓存)
bun run test

# 本地 CI 预演 (与 GitHub Actions 的 verify job 同集合; 推前必跑, pre-push 钩子按同集合自动执行)
bun run ci

# 打包各包发布产物; 发布时由各自的 prepublishOnly 自动跑
bun run build
```

## 提交与推送

由 lefthook 把关 (操作级细节以仓库根 `lefthook.yml` 为准):

- **pre-commit** (增量): prettier 重暂存 + oxlint 扫暂存文件; 类型检查例外, 跑全项目 `tsc --noEmit`;
- **pre-push** (全量): 单条调用 `bun scripts/ci.ts`; 步骤集合的单一事实来源在 `scripts/ci.ts`, CI 与 Release 的 verify job 共用同一套步骤定义。

提交信息按 Conventional Commits 前缀 (`feat` / `fix` / `chore` / `test` 等), 并守单一主题原则: 一个提交只含一个完整逻辑变更, 跨主题须拆分。

## 发布

主路径是 CI 自动链 (`.github/workflows/release.yml`): 推送到 `main` 后, `verify` job 先跑与 CI 同套的检查, 通过后 `release` job 停在 `environment: release` 的人工批准闸门外, 批准即由 multi-semantic-release 执行发布; npm 侧走 OIDC Trusted Publishing, 不设 token、无 OTP。

发布动作统一过 `prepublishOnly` 闸门 (链上链下同一道, 各包各自): 构建 (`bun run build`) + 发布前置闸门 (`bun run verify:release`, 在各自包目录跑); 闸门按序短路, 任一命中即退 1 拒发。

**README / LICENSE 类备份别落包目录**: npm 会把包根的 `README*` / `LICENSE*` 无条件收进发行包, 且没有任何配置可以排除; 备份一律落仓库外。

## 相关文档

- [工程技术文档总索引](README.md)
- [设计文档索引](designs/README.md)
- [架构决策记录](adrs/README.md)
