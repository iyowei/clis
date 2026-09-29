# 开发指南

> 面向本仓库的维护者与贡献者; 入门级开发说明见 [CONTRIBUTING](../CONTRIBUTING.md), 本文是深入版。仓库为双包 monorepo: `packages/sweep-node-modules` 承载可编程 API 与全部业务语义, `packages/sweep-node-modules-cli` 是它的 CLI 薄壳 (依据见 [ADR 0010](adrs/0010-dual-package-monorepo.md))。使用说明见 CLI 包 [README](../packages/sweep-node-modules-cli/README.md) 与 API 包 [README](../packages/sweep-node-modules/README.md); 设计决策见 [设计文档索引](designs/README.md); 转写套件见 [转写契约](protocol/README.md)。

## 环境准备

```shell
# 装 devDependencies, 并在本仓库检出态自动装好 git 钩子 (lefthook)
bun install
```

装钩子由 `scripts/install-git-hooks.mjs` 把守 (prepare 入口): 只在本仓库自身的 git 仓库根执行 `lefthook install`, 被作为依赖安装到别的仓库时自动跳过, 不写宿主仓库的 `.git/hooks` (依据见 [ADR 0005](adrs/0005-engineering-gates-and-hooks.md) 决策第 1 条)。lefthook 不列为依赖: 安装期取 PATH 上的 lefthook (如 `brew install lefthook`), 无则按 `lefthook.yml` 的 `lefthook:` 配置经 bunx 取 pin 版; 都不可用时安装照常完成, 只是没有钩子 (可按提示手动补装)。CI 下不装。

钩子执行链同样有兜底: 机器上没有全局 lefthook 时, 钩子经 `bunx` 取 pin 版照跑; 确认无处可取时按 `assert_lefthook_installed` 响亮报错退非零, 不静默放行 (两键均在 `lefthook.yml`, 依据同上)。

## 常用命令

以下命令除注明外均在仓库根执行:

```shell
# 类型检查 (tsc --noEmit; 经 turbo 编排两包)
bun run typecheck

# 代码检查 (oxlint)
bun run lint

# 格式化 (prettier --write)
bun run format

# 单元测试 (契约 / 鲁棒 / 压测 / 双载体 e2e / 伪终端冒烟 / 启动器冒烟 等; 经 turbo 编排两包, 带缓存)
bun run test

# 直通形态: 不走 turbo, 由 bun 内置测试器从仓库根递归扫全部 *.test.ts (含仓库根 scripts/ 下的用例, 无缓存)
bun test

# 基准四组 (扫描 / 体积 / 真实工作区 / 压测)
bun run bench

# 转写一致性验收 (金样本语料见 docs/protocol/; target 为 CLI 包内源码路径)
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# 打包 CLI 单文件产物 (packages/sweep-node-modules-cli/dist/cli.js) 并写产物自证清单 (dist/manifest.json; 发布时由 prepublishOnly 自动跑)
bun run build

# 发布前置闸门 (干净检出 + 产物就位 + 清单自洽 + 发行面白名单; 在 CLI 包目录跑, 发布前自动跑, 也可手动复核)
cd packages/sweep-node-modules-cli && bun run verify:release

# 干净重装 (清掉 dist / bun.lock / node_modules 后重新 bun install; 只清不建, 跑测试或推送前先 bun run build 重建产物)
bun run safe-install
```

## 发布

主路径是 CI 自动链 (`.github/workflows/release.yml`): 推送到 `main` 后, `verify` job 先跑与 CI 同套的检查 (构建 / 类型 / 测试 / lint / 格式), 通过后 `release` job 停在 `environment: release` 的人工批准闸门外, 批准即由 Lido multi-semantic-release 执行发布; npm 侧走 OIDC Trusted Publishing, 不设 token、无 OTP, 自动带 provenance 签名, 完成后打 tag 并建 GitHub Release。版本语义按提交判定 (angular 预设): `feat` 提 minor, `fix` 提 patch。发布链当前只覆盖 CLI 包 (根 `package.json` 的 `multi-release.ignorePackages` 把 API 包排除在链外)。

发布动作统一过 `prepublishOnly` 闸门 (链上链下同一道): 构建 (`bun run build`, 产出 `dist/cli.js` 与自证清单 `dist/manifest.json`) + 发布前置闸门 (`bun run verify:release`)。闸门四项按序短路, 任一命中即退 1 拒发: 工作树不干净 / 产物缺失 / 清单与提交或产物的对账不过 / 发行面包内文件与白名单 `PACK_FILES_EXPECTED` 不符 (该检查跑一次只读的 `npm pack --dry-run --json --ignore-scripts`, 需要 npm)。手动发布 (`npm publish` / `bun publish`) 是链外的兜底通道, 走的是同一道闸门 (两者自行打包时都执行 `prepublishOnly`, 核验依据见 [ADR 0009](adrs/0009-npm-distribution-form.md) 补记第 4 条); 已知残留口: `npm pack` 与 `npm publish <tarball>` 不经闸门。

**README / LICENSE 类备份别落 CLI 包目录**: npm 会把包根 (`packages/sweep-node-modules-cli/`) 的 `README*` / `LICENSE*` 无条件收进发行包, 且没有任何配置可以排除 (官方 files 节与 npm-packlist 的 strict 规则, 见 ADR 0009 补记第 3 条), 落包根目录的备份会被静默发出去; 备份一律落 `~/tmp`。

装进包里的 `bin/sweep-nm.mjs` (CLI 包内 `packages/sweep-node-modules-cli/bin/sweep-nm.mjs`) 挑选运行时时, win32 下先按 PATH 解析出运行时的绝对路径再执行 (不搜当前工作目录: 本工具在被扫目录里执行, 目录内放同名 `bun.exe` 即可顶替真实运行时; 依据与落法见 [ADR 0007](adrs/0007-platform-portability.md) 决策第 4 条补记)。它在优先使用产物前核对清单摘要 (含形状版本), 清单缺失 / 损坏 / 版本不支持 / 摘要不符即拒收产物并给出指引 (处置按宿主分流: 仓库检出态给源码入口与重构建, 包态给重装本包); 无产物时回退源码的语义不变。启动器不判工作树脏净 (开发态常脏), 那是发布闸门的职责。清单字段、判定与两道防线的分工见 [ADR 0009](adrs/0009-npm-distribution-form.md) 补记与 `packages/sweep-node-modules-cli/scripts/release-artifact.ts`。

## 运行时双跑

`bun packages/sweep-node-modules-cli/src/cli.ts` 与 `node packages/sweep-node-modules-cli/src/cli.ts` 均可直接运行。**双运行时是项目的硬约束**, 改动须在两个载体上都验证, 而两个验证通道的行为不同:

- **单测**已参数化: e2e 用例按 `bun` / `node` 各注册一遍, 跑一次 `bun run test` 即覆盖两侧, 且它在 pre-push 闸门内。**前提是机器上两个运行时都装了**: 缺哪一侧, 那一侧的用例会静默 skip, 整体仍显示全绿 (该 skip 是有意设计, 机制落点见 `packages/sweep-node-modules-cli/src/cli.e2e.test.ts` 的 `RUNNERS` 与逐载体注册循环; 同类说明另见 `packages/sweep-node-modules/src/runtime.test.ts` 文件头), 故 bun-only 机器上闸门不构成 node 侧的把关;
- **转写验收不参数化**: `--target` 一次只收一个载体, 且**不在本地钩子内** (CI 的 conformance job 会对两载体各跑一遍兜底): 改动了输出面就必须手动跑两遍, 都全通过才算数:

```shell
# bun 载体
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# node 载体
bun run conformance -- --target "node packages/sweep-node-modules-cli/src/cli.ts"
```

## 提交与推送

由 lefthook 把关 (操作级细节以仓库根 `lefthook.yml` 为准):

- **pre-commit** (增量): prettier 重暂存 + oxlint 扫暂存文件; 类型检查例外, 跑全项目 `tsc --noEmit`
- **pre-push** (全量只读): typecheck / test / oxlint / prettier `--check`

提交信息按 Conventional Commits 前缀 (`feat` / `fix` / `chore` / `test` 等), 并守单一主题原则: 一个提交只含一个完整逻辑变更, 跨主题须拆分。仓库目前没有 commit-msg 钩子强制该约定, 靠自觉。

## 相关文档

- [工程技术文档总索引](README.md)
- [设计文档索引](designs/README.md): 设计总纲与各分册
- [架构决策记录](adrs/README.md): ADR
- [转写契约套件](protocol/README.md): 编号行为契约与金样本语料
