# 开发指南

> 面向本仓库的维护者与贡献者; 入门级开发说明见 [CONTRIBUTING](../CONTRIBUTING.md), 本文是深入版。仓库为双包 monorepo: `packages/sweep-node-modules` 承载可编程 API 与全部业务语义, `packages/sweep-node-modules-cli` 是它的 CLI 薄壳 (依据见 [ADR 0010](adrs/0010-dual-package-monorepo.md))。使用说明见 CLI 包 [README](../packages/sweep-node-modules-cli/README.md) 与 API 包 [README](../packages/sweep-node-modules/README.md); 设计决策见 [设计文档索引](designs/README.md); 转写套件见 [转写契约](sweep/protocol/README.md)。

## 环境准备

```shell
# 装 devDependencies, 并在本仓库检出态自动装好 git 钩子 (lefthook)
bun install
```

装钩子由 `scripts/install-git-hooks.mjs` 把守 (prepare 入口): 只在本仓库自身的 git 仓库根执行 `lefthook install`, 被作为依赖安装到别的仓库时自动跳过, 不写使用方仓库的 `.git/hooks` (依据见 [ADR 0005](adrs/0005-engineering-gates-and-hooks.md) 决策第 1 条)。lefthook 不列为依赖: 安装期取 PATH 上的 lefthook (如 `brew install lefthook`), 无则按 `lefthook.yml` 的 `lefthook:` 配置经 bunx 取 pin 版; 都不可用时安装照常完成, 只是没有钩子 (可按提示手动补装)。CI 下不装。

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

# 转写一致性验收 (金样本语料见 docs/sweep/protocol/; target 为 CLI 包内源码路径)
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# 本地 CI 预演 (与 GitHub Actions 的 verify + conformance 两 job 同集合: build / 类型 / 测试 / lint / 格式 / 文档与仓库卫生四闸门 / conformance 双 target; 推前必跑, pre-push 钩子按同集合自动执行)
bun run ci

# 打包两包发布产物: CLI 单文件 (dist/cli.js + 自证清单) 与 API 包 (dist/index.js + 类型声明 + 自证清单); 发布时由各自的 prepublishOnly 自动跑
bun run build

# 发布前置闸门 (干净检出 + 产物自证 + 发行面白名单; API 包另加 d.ts specifier 复查; 在各自包目录跑, 发布前自动跑, 也可手动复核)
cd packages/sweep-node-modules-cli && bun run verify:release

# 干净重装 (清掉 CLI 包 dist / bun.lock / node_modules 后重新 bun install; API 包 dist 不在清理面; 只清不建, 跑测试或推送前先 bun run build 重建产物)
bun run safe-install
```

## 发布

主路径是 CI 自动链 (`.github/workflows/release.yml`): 推送到 `main` 后, `verify` job 先跑与 CI 同套的检查 (构建 / 类型 / 测试 / lint / 格式 / 文档与仓库卫生四闸门), 通过后 `release` job 停在 `environment: release` 的人工批准闸门外, 批准即由 Lido multi-semantic-release 执行发布; npm 侧走 OIDC Trusted Publishing, 不设 token、无 OTP, 自动带 provenance 签名, 完成后打 tag 并建 GitHub Release。版本语义按提交判定 (angular 预设): `feat` 提 minor, `fix` 提 patch。发布链覆盖双包: CLI 包持续演进, API 包自 2026-09-29 公开面收口 (`packages/sweep-node-modules/docs/designs/api-surface.md` §9 Q17) 起以同链发布 (收口时根 `package.json` 的 `multi-release.ignorePackages` 曾清空; 现该登记册登记生成器包 `create-clis`, 首发前不入自动发布链, 见下方「新包首发三件事」; API 包首发 0.5.0)。

OIDC 免密发布有一处仓库外依赖: npm 侧的 Trusted Publisher 登记表。换证时 npm 拿 GitHub OIDC 令牌与登记逐字段核对 (repository / workflow 文件名 / environment), 全对才发短期凭证; 仓库改名、换 workflow 文件名、换 environment 名都不会自动跟改登记, 且已存登记不支持就地修改, 只能 revoke 后重建。2026-09-30, 仓库由 `iyowei/sweep-node-modules` 改名为 `iyowei/clis`: 仓内引用 (徽章、两包 `package.json` 的 `repository` 字段、链接) 随改名提交同步了, npm 侧登记还留在旧仓库名上; 改名前的发布 run 还是绿的 (正常发出 0.5.1 与 0.3.0), 改名后每轮 Release run 都在 `release` job 的 npm 认证处失败, 报的却是误导性的 `ENONPMTOKEN No npm token specified` (OIDC 换证被拒后回落到 token 检查所致, 报错不指明真因); 失败自动建 issue 的通道又因仓库缺 `semantic-release` label 报 422, 真错因被掩埋。

现在 Release 的 `release` job 在人工批准后、执行发布前先跑一步发布凭据预检 (`bun run ci -- --only npm-trust`, 步骤经 `scripts/ci.ts` 单源定义, 实现为 `scripts/npm-trust-guard.ts verify-oidc`): 对每个可发布包用 OIDC 试一次换证, 换到即登记与当前仓库全对, 被拒即当场点名并给出排查清单。预检零密钥 (走发布链同一条 OIDC 通道); 预检必须与发布同 job——换证与登记逐字段核对, 其中 environment 声明来自 job 的 environment, 放进无 environment 的 job 会被 npm 以误导性的 404 (`package not found`) 拒绝 (2026-10-01 曾在 `verify` job 试过, 实测如此)。该步骤不进任何组, 普通 CI job 与本机全链跑不到它; 改名后的第一次发布在批准后即被拦下点名, 不再等到 semrel 报误导错误。

本地核对与修复走同脚本的另两个子命令: `check` 只读对账 (期望值: git origin 派生的 repository, 加 workflow 文件名与环境名两个常量 `release.yml` / `release`), `fix` 对失配项 revoke + 重建 (这两个常量与 `.github/workflows/release.yml` 同步; 换 workflow 文件名或 environment 名时, 先把 `scripts/npm-trust-guard.ts` 顶部的 `RELEASE_WORKFLOW` / `RELEASE_ENVIRONMENT` 同步成新值再跑 `fix`, 否则会把登记重建回旧值; 仅改仓库名不受影响); 两者都需 npm 登录态与交互式终端 (读取登记要认证, 匿名请求被 401 拒; 敏感操作要过浏览器一次性认证)。手工等效的 npm 命令: `npm trust list <包>` 查看登记, `npm trust revoke <包> --id=<旧 id>` 删旧, `npm trust github <包> --file release.yml --repo <owner/repo> --env release --allow-publish` 重建; 三条都须显式带 `--registry=https://registry.npmjs.org/`, trust 管理端点只存在于官方源。

**新包首发三件事** (最近一例是生成器包 `create-clis`, 现停在首发前): ① npm 侧为新包登记 Trusted Publisher: 登记入口在包设置页 (npmjs.com → Packages → 包 → Settings → Trusted publishing), 无自动创建通道, 字段与既有包同口径 (repository / workflow 文件名 `release.yml` / environment `release`), 登记在仓库外、不会随改名自动跟改 (见上段); ② 首次发布取人工路径: 在包目录手动发布一次 (`npm publish` / `bun publish`), 同一道 `prepublishOnly` 闸门把关, 不依赖自动链; ③ 首发后把包移出根 `package.json` 的 `multi-release.ignorePackages` (不移出则语义发布链永远跳过它), 移出即自动纳入 `scripts/npm-trust-guard.ts` 的核对与发布凭据预检面 (该脚本按 workspaces 枚举可发布包并减去该名单, 与发布链同源), 此后新版本由自动链接管。

发布动作统一过 `prepublishOnly` 闸门 (链上链下同一道, 逐包各自)。三层按包列举: CLI 与 API 两包 = 构建 (`bun run build`; CLI 产出 `dist/cli.js` 与自证清单 `dist/manifest.json`, API 产出 `dist/index.js`、类型声明与自证清单) + 发布前置闸门 (`bun run verify:release`, 在各自包目录跑); 生成器包 `create-clis` 在前面另串一层 heavy-smoke (现场生成一个 core 档完整项目并跑通它的整套闸门链, 见包 README), 全绿才允许发布。闸门按序短路, 任一命中即退 1 拒发: 工作树不干净 / 产物缺失 / 清单与提交或产物的对账不过 / 发行面包内文件与白名单 `PACK_FILES_EXPECTED` 不符 (该检查跑一次只读的 `npm pack --dry-run --json --ignore-scripts`, 需要 npm; API 包另查 d.ts 相对 specifier 无 `.ts` 残留)。手动发布 (`npm publish` / `bun publish`) 是链外的兜底通道, 走的是同一道闸门 (两者自行打包时都执行 `prepublishOnly`, 核验依据见 [ADR 0009](adrs/0009-npm-distribution-form.md) 补记第 4 条); 已知残留口: `npm pack` 与 `npm publish <tarball>` 不经闸门。

**README / LICENSE 类备份别落 CLI 包目录**: npm 会把包根 (`packages/sweep-node-modules-cli/`) 的 `README*` / `LICENSE*` 无条件收进发行包, 且没有任何配置可以排除 (官方 files 节与 npm-packlist 的 strict 规则, 见 ADR 0009 补记第 3 条), 落包根目录的备份会被静默发出去; 备份一律落 `~/tmp`。

装进包里的 `bin/sweep-nm.mjs` (CLI 包内 `packages/sweep-node-modules-cli/bin/sweep-nm.mjs`) 挑选运行时时, win32 下先按 PATH 解析出运行时的绝对路径再执行 (不搜当前工作目录: 本工具在被扫目录里执行, 目录内放同名 `bun.exe` 即可顶替真实运行时; 依据与落法见 [ADR 0007](../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md) 决策第 4 条补记)。它在优先使用产物前核对清单摘要 (含形状版本), 清单缺失 / 损坏 / 版本不支持 / 摘要不符即拒收产物并给出指引 (处置按运行场景分流: 仓库检出态给源码入口与重构建, 包态给重装本包); 无产物时回退源码的语义不变。启动器不判工作树脏净 (开发态常脏), 那是发布闸门的职责。清单字段、判定与两道防线的分工见 [ADR 0009](adrs/0009-npm-distribution-form.md) 补记与 `packages/sweep-node-modules-cli/scripts/release-artifact.ts`。

## 运行时双跑

`bun packages/sweep-node-modules-cli/src/cli.ts` 与 `node packages/sweep-node-modules-cli/src/cli.ts` 均可直接运行。**双运行时是项目的硬约束**, 改动须在两个载体上都验证, 而两个验证通道的行为不同:

- **单测**已参数化: e2e 用例按 `bun` / `node` 各注册一遍, 跑一次 `bun run test` 即覆盖两侧, 且它在 pre-push 闸门内。**前提是机器上两个运行时都装了**: 缺哪一侧, 那一侧的用例会静默 skip, 整体仍显示全绿 (该 skip 是有意设计, 机制落点见 `packages/sweep-node-modules-cli/src/cli.e2e.test.ts` 的 `RUNNERS` 与逐载体注册循环; 同类说明另见 `packages/sweep-node-modules/src/runtime.test.ts` 文件头), 故 bun-only 机器上闸门不构成 node 侧的把关;
- **转写验收不参数化**: `--target` 一次只收一个载体; **pre-push 与 CI 的 conformance 步均对两载体各跑一遍** (见 `scripts/ci.ts` 的双 target 循环), 无需再手动双跑; 需要手工单跑时, 对两载体各跑一遍, 都全通过才算数:

```shell
# bun 载体
bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"

# node 载体 (需先 bun run build: node 不读 tsconfig paths, 按 exports 解析到 API 包 dist)
bun run conformance -- --target "node packages/sweep-node-modules-cli/src/cli.ts"
```

## 提交与推送

由 lefthook 把关 (操作级细节以仓库根 `lefthook.yml` 为准):

- **pre-commit** (增量): prettier 重暂存 + oxlint 扫暂存文件; 类型检查例外, 跑全项目 `tsc --noEmit`
- **pre-push** (全量): 单条调用 `bun scripts/ci.ts` (全链 = 验证组 + 验收组); 步骤集合的单一事实来源在 `scripts/ci.ts`, CI 的两个 job 与 Release 的 verify job 共用同一套步骤定义 (Release 的 `release` job 获批后另加一步发布凭据预检, 见「发布」章; `bun scripts/ci.ts --help` 可查看步骤与分组)

> 本地预演全绿不等于 CI 会绿: `bun scripts/ci.ts` 只覆盖「同一台机器 + 命令清单」两个维度, CI 是唯一在「干净环境 + 全部配置 + 真实时序」下运行的地方; 后三样恰是本地预演的全盲区, 全绿给的是虚假的安全感。

2026-09-29 至 30 连续挂红, 复盘出四类盲区:

- **环境态假设** (本地有而 CI 没有的东西): conformance 的 node target 按 exports 解析到 API 包 `dist`, 当时的 conformance job 没有 build 前置, 57 条验收全数报 `ERR_MODULE_NOT_FOUND`; 测试套件假设家目录下已有 `~/tmp` 再 `mkdtemp`, CI runner 的 HOME 下没有, 6 处调用点集体 ENOENT。本机常备状态把这两类假设一路遮到 CI 才爆。
- **配置脱耦**: workflow yaml 里写死的字面脚本路径与仓库布局脱节, 曾一处多带一层包目录, 直接报「模块未找到」; 同一份命令清单当时散落多处, 改一处漏一处。
- **并发时序**: 一条契约测试断言在并发下取值漂动, 时绿时红; semrel 往 main 推送版本提交被拒, 成因是两次 push 之间, 旧 run 被批准时分支已前进。
- **仓库外状态** (跨平台登记): 仓库改名 (2026-09-30) 是平台动作, 不进 git diff; npm 侧 Trusted Publisher 登记在仓库外, 本地预演全盲, 改名后每轮 Release 都在 npm 认证处报出误导性的 `ENONPMTOKEN`。

对应的防线均已落地: test 步骤改在隔离 HOME 下执行 (临时家目录经 `scripts/lib/tmp-root.ts` 的 `makeTmpRoot` 创建, 2026-09-30), 「本机常备而 CI 缺失」的环境态依赖不再被本地状态掩盖, 这类盲区本地预演即可抓住; 两个 workflow 的验证与验收步骤已全部经 `scripts/ci.ts` 单源调用 (`bun run ci -- --verify` / `--conformance`), yaml 里不再出现字面命令路径; `release.yml` 有 `concurrency` 排队, 并发漂动的断言已改为取批次序最前触发条; 仓库外登记的核对已由发布链预检把守 (Release 的 `release` job 在获批后先跑 `npm-trust` 步), 失配当场点名, 细节见「发布」章。

推前自检因此有四条: 写测试与脚本时不要假设本机常备状态 (家目录、已有产物、PATH 上的工具), 这类假设会在隔离 HOME 的 test 步骤当场暴露; 闸门步骤的增删只动 `scripts/ci.ts` 一处, 不往 workflow yaml 里写字面命令; push 连发时以最后一个 run 为准, 时绿时红的用例按并发缺陷处理, 修断言而非重跑; 遇到改名、换 workflow 文件名、换 environment 名这类平台动作时, npm 侧登记不会自动跟改, 顺手跑一次 `bun scripts/npm-trust-guard.ts check` 对账, 失配就 `fix`。

提交信息按 Conventional Commits 前缀 (`feat` / `fix` / `chore` / `test` 等), 并守单一主题原则: 一个提交只含一个完整逻辑变更, 跨主题须拆分。仓库目前没有 commit-msg 钩子强制该约定, 靠自觉。

## 相关文档

- [工程技术文档总索引](README.md)
- [设计文档索引](designs/README.md): 设计总纲与各分册
- [架构决策记录](adrs/README.md): ADR
- [转写契约套件](sweep/protocol/README.md): 编号行为契约与金样本语料
