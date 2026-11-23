# 开发指南

> 面向本仓库的维护者与贡献者; 入门级开发说明见 [CONTRIBUTING](../CONTRIBUTING.md), 本文是深入版。仓库为多包 CLI 工具集合 monorepo (默认「可编程 API 主包 + CLI 薄壳从包」双包范式, 见 [ADR 0010](adrs/0010-dual-package-monorepo.md) 与 [ADR 0019](adrs/0019-two-tier-package-owned-docs.md))。各包清单见根 [README](../README.zh-CN.md); 仓级治理设计见 [设计文档索引](designs/README.md); `sweep` 转写套件见 [转写契约](../packages/sweep/docs/protocol/README.md)。

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
# 类型检查 (bun check; 经 turbo 编排全仓各包并校验根 scripts/ 与 .agents/skills/, 边界见 ADR 0020)
bun run typecheck

# 代码检查 (oxlint)
bun run lint

# 格式化 (bun fmt; 读根 .prettierrc 与 .prettierignore)
bun run format

# 单元测试 (契约 / 鲁棒 / 压测 / 双载体 e2e / 伪终端冒烟 / 启动器冒烟 / 模板回归等; 经 turbo 编排全部工作区包 + 根 scripts/ + .agents/skills/)
bun run test

# 直通形态: 不走 turbo (不自动触发 ^build 前置, 且默认跳过 . 开头的隐藏目录如 .agents/, 适合已构建后单测快速排障)
bun test

# 基准组 (经 turbo 调度各包 bench)
bun run bench

# 转写一致性验收 (双运行时全集语料, 条数以 corpus/*.json 为准, 等价于 CI 的 conformance 组)
bun run ci -- --conformance

# 转写一致性验收 (验任意外部目标语言产物时同时传 --target 与 --api-target; 失败可加 --emit-failures ~/tmp/failures)
bun run conformance -- --target "bun packages/sweep-cli/src/cli.ts" --api-target "bun scripts/transcription/api-harness.ts"

# 差分模糊测试: 本仓参考实现不变量自检 (目标清单以各包 fuzz-targets.json 为准) 与 Bun vs Node 双运行时差分比对
bun run fuzz
bun run fuzz:diff

# 本地 CI 预演 (步骤集合唯一来源见 scripts/ci.ts: 与 GitHub Actions 的 verify + conformance 同集合; pre-push 钩子按同集合自动执行)
bun run ci

# 构建全部包发布产物: 各 API 包 bundle + 类型声明 + 清单, 各 CLI 包单文件 + 清单, 以及模板资产 (assets/)
bun run build

# 发布前置闸门 (干净检出 + 产物自证 + 发行面白名单; API 包另查 d.ts specifier; 须在包目录内先跑包级 build 刷新当前 HEAD 清单, 或在根仓加 -- --force 跳过 Turbo 缓存)
cd packages/sweep-cli && bun run build && bun run verify:release

# 干净重装 (清理全部工作区包的 dist / assets / .turbo 以及根 .turbo / bun.lock / node_modules 后重新 bun install; 重装后请执行 bun run build)
bun run safe-install
```

## 发布

主路径是 CI 自动链 (`.github/workflows/release.yml`): 推送到 `main` 后, `checks` job 直接通过 `workflow_call` 复用 `.github/workflows/ci.yml` 的三路检查 (`verify` Linux 权威全量 / `verify-windows` Windows OS 兼容 / `conformance` macOS 金样本验收, 消除 `main` 推送双跑并把 Windows 兼容正式纳入发版门禁), 通过后 `release` job 停在 `environment: release` 的人工批准闸门外, 批准即由 Lido multi-semantic-release 执行发布; npm 侧走 OIDC Trusted Publishing, 不设 token、无 OTP, 自动带 provenance 签名, 完成后打 tag 并建 GitHub Release。版本语义按提交判定 (angular 预设): `feat` 提 minor, `fix` 提 patch。发布链覆盖非 private 双包与生成器包: API 包自 2026-09-29 公开面收口 (`packages/sweep/docs/designs/api-surface.md` §9 Q17) 起纳入同链发布 (新包与重构中待首发包均以包自身 `"private": true` 隔离, 如当前演进至多技术栈清理器的 `@iyowei/sweep` 与 `@iyowei/sweep-cli`, 见 [ADR 0021](../packages/sweep/docs/adrs/0021-sweep-general-cleaner-evolution.md); 生成器包 `create-clis` 与 `@iyowei/codd` / `@iyowei/codd-cli` 双包均已按下方「新包首发路径」完成首发)。

OIDC 免密发布有一处仓库外依赖: npm 侧的 Trusted Publisher 登记表。换证时 npm 拿 GitHub OIDC 令牌与登记逐字段核对 (repository / workflow 文件名 / environment), 全对才发短期凭证; 仓库改名、换 workflow 文件名、换 environment 名都不会自动跟改登记, 且已存登记不支持就地修改, 只能 revoke 后重建。2026-09-30, 仓库由旧单产品仓名改名为 `iyowei/clis`: 仓内引用 (徽章、两包 `package.json` 的 `repository` 字段、链接) 随改名提交同步了, npm 侧登记还留在旧仓库名上; 改名前的发布 run 还是绿的 (正常发出 0.5.1 与 0.3.0), 改名后每轮 Release run 都在 `release` job 的 npm 认证处失败, 报的却是误导性的 `ENONPMTOKEN No npm token specified` (OIDC 换证被拒后回落到 token 检查所致, 报错不指明真因); 失败自动建 issue 的通道又因仓库缺 `semantic-release` label 报 422, 真错因被掩埋。

现在 Release 的 `release` job 在人工批准后、执行发布前先跑一步发布凭据预检 (`bun run ci -- --only npm-trust`, 步骤经 `scripts/ci.ts` 单源定义, 实现为 `scripts/npm-trust-guard.ts verify-oidc`): 对每个可发布包用 OIDC 试一次换证, 换到即登记与当前仓库全对, 被拒即当场点名并给出排查清单。预检零密钥 (走发布链同一条 OIDC 通道); 预检必须与发布同 job: 换证与登记逐字段核对, 其中 environment 声明来自 job 的 environment, 放进无 environment 的 job 会被 npm 以误导性的 404 (`package not found`) 拒绝 (2026-10-01 曾在 `verify` job 试过, 实测如此)。该步骤不进任何组, 普通 CI job 与本机全链跑不到它; 改名后的第一次发布在批准后即被拦下点名, 不再等到 semrel 报误导错误。

本地核对与修复走同脚本的另两个子命令: `check` 只读对账 (期望值: git origin 派生的 repository, 加 workflow 文件名与环境名两个常量 `release.yml` / `release`), `fix` 对失配项 revoke + 重建 (这两个常量与 `.github/workflows/release.yml` 同步; 换 workflow 文件名或 environment 名时, 先把 `scripts/npm-trust-guard.ts` 顶部的 `RELEASE_WORKFLOW` / `RELEASE_ENVIRONMENT` 同步成新值再跑 `fix`, 否则会把登记重建回旧值; 仅改仓库名不受影响); 两者都需 npm 登录态与交互式终端 (读取登记要认证, 匿名请求被 401 拒; 敏感操作要过浏览器一次性认证)。手工等效的 npm 命令: `npm trust list <包>` 查看登记, `npm trust revoke <包> --id=<旧 id>` 删旧, `npm trust github <包> --file release.yml --repo <owner/repo> --env release --allow-publish` 重建; 三条都须显式带 `--registry=https://registry.npmjs.org/`, trust 管理端点只存在于官方源。

**新包首发路径** (以生成器包 `create-clis` 为首发实证例: 2026-10-01 按此路径经 0.1.0 起步后由自动链发出 1.0.0, 当时两 tag 均已补到远端; 后续 `@iyowei/codd` 与 `@iyowei/codd-cli` 双包亦按同路径完成首发): ① 首发前新包以自身 `package.json` 的 `"private": true` 隔离 (mrs 的 `ignorePrivate` 默认开启, private 包不进它的加载面, 连加载都不会发生); ② 首发次序: 移除 private 并提交推送 → 人工发布一个起步版本 (`npm publish` / `bun publish`, 同一道 `prepublishOnly` 闸门把关) 并完成 Trusted Publisher 登记 → 在 `release` environment 批准 → 自动链 first-release 一次性完成 (首发同样经 `prepublishOnly` 全套闸门, 且自动创建 tag 与 release 提交)。起步版本与登记都必须在批准之前: TP 登记只能在包首次发布之后 (对尚未发布的包预登记不可行, 2026-10-01 实测返回 404), 而批准后 release job 的第一道发布凭据预检要求包已有登记; 登记命令 `npm trust github <包> --file release.yml --repo <owner/repo> --env release --allow-publish` (字段口径同既有包: repository / workflow 文件名 `release.yml` / environment `release`; 登记在仓库外、不会随改名自动跟改, 见上段)。移除 private 后新包即自动纳入 `scripts/npm-trust-guard.ts` 的核对与发布凭据预检面 (该脚本按 workspaces 枚举非 private 包, 与发布链同源); create-clis 实测次序即 0.1.0 起步 + 登记 → 批准 → 自动链发 1.0.0; ③ 别指望用起步版本续版: 不要给起步版本补 tag, 自动链看得到该包既有 tag 时会按它递增 (0.1.0 → 0.1.1), 看不到时按 first-release 缺省发 `1.0.0` (create-clis 的 1.0.0 即此成因), 版本由 tag 到达时机决定而非预期; 这条「人工发布 + 补 tag 再交自动链」正是被弃用的旧路径 (实测证伪; 手动发与自动链的交接天然脆弱); ④ 首发版本没有配置口: 无前序发布时 semantic-release 固定发 `1.0.0` (2026-10-01 核验: semantic-release v25 源码中该值是硬编码常量 `FIRST_RELEASE`; 官方 FAQ 明文拒绝初始版本可配置, 原话 `This is not supported by semantic-release.`; 官方配置文档选项表中无 `initialVersion` 一类字段; 本仓 mrs 1.0.3 全量检索亦无此字段)。不要用 `multi-release.ignorePackages` 做新包隔离: 2026-10-01 实测它对包名形式不生效 (被 mrs 映射为 topo 负 glob 后无效), 被列入的包仍会被处理, 并因 npm 侧无登记而挂 ENONPMTOKEN 类错误; 该字段现已清空。

发布动作统一过 `prepublishOnly` 闸门 (链上链下同一道, 逐包各自): 各 API 包 (`@iyowei/sweep` / `@iyowei/codd`) 与 CLI 包 (`@iyowei/sweep-cli` / `@iyowei/codd-cli`) 均执行 `build` + `verify:release` (通用逻辑收拢于 `scripts/lib/release-verify.ts` 与 `scripts/lib/release-cli.ts`), `create-clis` 在 `verify:release` 之后另串不可变资产 `heavy-smoke`; 仓内共享私有库 (`@iyowei/cli-updater`) 与当前待首发双包 (`@iyowei/sweep` / `@iyowei/sweep-cli`) 均以 `"private": true` 隔离于自动发布链之外。闸门按序短路, 任一命中即退 1 拒发: 工作树不干净 / 产物缺失 / 清单与提交或产物的对账不过 / 发行面包内文件与白名单不符 (API 包另查 `.d.ts` 相对 specifier 无 `.ts` 残留)。手动发布 (`npm publish` / `bun publish`) 走的是同一道闸门 (见 [ADR 0009](adrs/0009-npm-distribution-form.md) 补记第 4 条); 已知残留口: `npm pack` 与 `npm publish <tarball>` 不经闸门。

**README / LICENSE 类备份别落任何包目录 (`packages/*/`)**: npm 会把包根的 `README*` / `LICENSE*` 无条件收进发行包, 且没有任何配置可以排除 (ADR 0009 补记第 3 条), 落包根目录的备份会被静默发出去; 备份一律落 `~/tmp/repo_backups/` 并由 `scripts/lint-stray-backups.ts` 全树兜底。

所有 CLI 包的启动器 (`bin/*.mjs` / `bin/<cmd>` / `bin/<cmd>.cmd`) 均落实三道运行期防线: ① `bin/*.mjs` 与 POSIX `bin/<cmd>` 按 `PATH` 严格解析绝对路径并跳过空与相对条目, Windows `bin/<cmd>.cmd` 经 `%%~$PATH:I` 仅搜 `PATH` 避免 `cmd.exe` 默认优先搜索当前工作目录 (防被扫/当前工作目录同名 `bun` 或 `node` 劫持, 见 [ADR 0007](../packages/sweep/docs/adrs/0007-platform-portability.md)); ② 选中 Bun 时强制附加 `--config=<pkg>/bin/bunfig.toml --no-env-file`, 隔绝工作目录坏 `bunfig.toml` (`preload` RCE / 语法报错) 与 `.env` 注入; ③ 执行 `dist/` 产物前校验 `dist/manifest.json` SHA-256 摘要。

## 运行时双跑

`bun packages/sweep-cli/src/cli.ts` 可直接从源码运行, `node packages/sweep-cli/src/cli.ts` 则需先执行 `bun run build` 生成/更新 API 包 `dist/` 后运行 (调试 `sweep` 时可通过 `SWEEP_CONFIG` 指定测试配置路径, 缺省位置 `~/.config/sweep/config.json`)。**双运行时是项目的硬约束**, 改动须在两个载体上都验证, 而两个验证通道的行为不同:

- **单测**已参数化: e2e 用例按 `bun` / `node` 各注册一遍, 跑一次 `bun run test` 即覆盖两侧, 且它在 pre-push 闸门内。**前提是机器上两个运行时都装了**: 缺哪一侧, 那一侧的用例会静默 skip, 整体仍显示全绿 (该 skip 是有意设计, 机制落点见 `packages/sweep-cli/src/cli.e2e.test.ts` 的 `RUNNERS` 与逐载体注册循环; 同类说明另见 `packages/sweep/src/runtime.test.ts` 文件头), 故 bun-only 机器上闸门不构成 node 侧的把关;
- **转写验收不参数化**: 一次运行只绑定一个运行载体; **pre-push 与 CI 的 conformance 步均对两载体各跑一遍** (见 `scripts/ci.ts` 的 `conformance:bun` 与 `conformance:node`), 无需再手动双跑; 需要手工跑双运行时全集语料时, 用 `--all-products --runtime <bun|node>` 同步绑定 CLI 与 API 双面载体, 都全通过才算数 (若验收外部独立编译产物, 则同时显式传 `--target` 与 `--api-target`, 避免仅传 `--target "node ..."` 时 API 语料仍回退跑在默认 Bun 参考 harness 上):

```shell
# bun 载体 (全协议产品 CLI + API 双面)
bun run conformance -- --all-products --runtime bun

# node 载体 (需先 bun run build: node 不读 tsconfig paths, 按 exports 解析到 API 包 dist)
bun run build && bun run conformance -- --all-products --runtime node
```

## 提交与推送

由 lefthook 把关 (操作级细节以仓库根 `lefthook.yml` 为准):

- **pre-commit** (增量): `bun fmt` 重暂存 + oxlint 扫暂存文件; 类型检查例外, 跑全项目 `bun run typecheck` (`bun check`, 见 [ADR 0020](adrs/0020-bun-native-fmt-and-typecheck.md))
- **pre-push** (全量): 单条调用 `bun scripts/ci.ts` (全链 = 验证组 + 验收组); 步骤集合的单一事实来源在 `scripts/ci.ts`, CI 三路 job (`--verify` / `--verify-windows` / `--conformance`) 与 Release 前置门禁 (`workflow_call` 复用 `ci.yml`) 共用同一套步骤定义 (Release 的 `release` job 获批后另加一步发布凭据预检, 见「发布」章; `bun scripts/ci.ts --help` 可查看步骤与分组)

> 本地预演全绿不等于 CI 会绿: `bun scripts/ci.ts` 只覆盖「同一台机器 + 命令清单」两个维度, CI 是唯一在「干净环境 + 全部配置 + 真实时序」下运行的地方; 后三样恰是本地预演的全盲区, 全绿给的是虚假的安全感。

2026-09-29 至 30 连续挂红, 复盘出四类盲区:

- **环境态假设** (本地有而 CI 没有的东西): conformance 的 node target 按 exports 解析到 API 包 `dist`, 当时的 conformance job 没有 build 前置, 57 条验收全数报 `ERR_MODULE_NOT_FOUND`; 测试套件假设家目录下已有 `~/tmp` 再 `mkdtemp`, CI runner 的 HOME 下没有, 6 处调用点集体 ENOENT。本机常备状态把这两类假设一路遮到 CI 才爆。
- **配置脱耦**: workflow yaml 里写死的字面脚本路径与仓库布局脱节, 曾一处多带一层包目录, 直接报「模块未找到」; 同一份命令清单当时散落多处, 改一处漏一处。
- **并发时序**: 一条契约测试断言在并发下取值漂动, 时绿时红; semrel 往 main 推送版本提交被拒, 成因是两次 push 之间, 旧 run 被批准时分支已前进。
- **仓库外状态** (跨平台登记): 仓库改名 (2026-09-30) 是平台动作, 不进 git diff; npm 侧 Trusted Publisher 登记在仓库外, 本地预演全盲, 改名后每轮 Release 都在 npm 认证处报出误导性的 `ENONPMTOKEN`。

对应的防线均已落地: test 步骤改在隔离 HOME 下执行 (临时家目录经 `scripts/lib/tmp-root.ts` 的 `makeTmpRoot` 创建, 2026-09-30), 「本机常备而 CI 缺失」的环境态依赖不再被本地状态掩盖, 这类盲区本地预演即可抓住; `ci.yml` 的三路验证与验收步骤全部经 `scripts/ci.ts` 单源调用 (`--verify` / `--verify-windows` / `--conformance`), `release.yml` 直接 `uses: ./.github/workflows/ci.yml` 复用, yaml 里不再出现字面命令路径或重复 job 定义; `release.yml` 有 `concurrency` 排队, 并发漂动的断言已改为取批次序最前触发条; 仓库外登记的核对已由发布链预检把守 (Release 的 `release` job 在获批后先跑 `npm-trust` 步), 失配当场点名, 细节见「发布」章。

推前自检因此有四条: 写测试与脚本时不要假设本机常备状态 (家目录、已有产物、PATH 上的工具), 这类假设会在隔离 HOME 的 test 步骤当场暴露; 闸门步骤的增删只动 `scripts/ci.ts` 一处, 不往 workflow yaml 里写字面命令; push 连发时以最后一个 run 为准, 时绿时红的用例按并发缺陷处理, 修断言而非重跑; 遇到改名、换 workflow 文件名、换 environment 名这类平台动作时, npm 侧登记不会自动跟改, 顺手跑一次 `bun scripts/npm-trust-guard.ts check` 对账, 失配就 `fix`。

提交信息按 Conventional Commits 前缀 (`feat` / `fix` / `chore` / `test` 等), 并守单一主题原则: 一个提交只含一个完整逻辑变更, 跨主题须拆分。仓库目前没有 commit-msg 钩子强制该约定, 靠自觉。

## 相关文档

- [工程技术文档总索引](README.md)
- [设计文档索引](designs/README.md): 设计总纲与各分册
- [架构决策记录](adrs/README.md): 仓级工程 ADR
- [跨语言转写基建](transcription/README.md): 全仓共享转写纪律、对抗评审指令、TS 暗坑核查表与目标语言通用模板
- [sweep 转写契约套件](../packages/sweep/docs/protocol/README.md): 编号行为契约、金样本语料与模糊测试目标清单
