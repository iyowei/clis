# ADR 0009: npm 分发形态

> **状态**: 已接受 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]
> **取代关系**: 本 ADR 局部取代 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md) 决策条第 2 条「零构建」, 以及 [ADR 0006](0006-dual-runtime-bun-first.md) 弃用「构建产物分发」的判断。判断反转的理由: 当时弃用的是「为运行而构建」(它和源码直跑互斥, 而且当时分发形态还没定), 现在只加「为分发而构建」, 开发运行路径没有变; 那两处原文按「已接受的决定不原地改写」保留, 修订指引只加在本 ADR 的决策条里。

## 上下文与问题 (Context & Problem)

工具要发布到 npm (包名 `@iyowei/sweep-node-modules`)。npm 分发暴露出一个开发时不存在的问题: 安装后的代码位于 `node_modules` 之下, 而 node 拒绝对 `node_modules` 目录下的 TypeScript 文件做类型剥离。

实测 (本机 node v26.7.0): 加载一个 `node_modules` 内的 `.ts` 文件, 直接抛 `ERR_UNSUPPORTED_NODE_MODULES_TYPE_STRIPPING`; 该错误码自 node v22.6.0 起存在, 官方描述为「Type stripping is not supported for files descendent of a `node_modules` directory」(descendent 是 v22 系列的原文拼写, 现行文档里已更正为 descendant; 见 nodejs.org/api/errors.html)。

后果: 包内若只发 TypeScript 源码, 用 npm 安装之后, 只装了 Node 的机器完全用不了, 与 [ADR 0006](0006-dual-runtime-bun-first.md)「装任一运行时即可使用」直接冲突; 分发形态必须重新决定。

## 放弃掉的替代方案 (Options Considered & Rejected)

**[包内只发源码, 靠安装方的类型剥离直跑]**

放弃理由: node 侧被上述错误码堵死, 这条冲突在「源码直跑」这条路里无解; 而给 node 另发一份实现, 又会违反单源码原则 ([ADR 0006](0006-dual-runtime-bun-first.md))。

**[发 `bun build --compile` 的独立可执行文件]**

放弃理由: 编译产物按平台和架构分叉, 一个 npm 包要分发全部平台的二进制, 包体积和发布流程复杂度都不划算; 本工具要的就是「装任一运行时即可用」, 不需要自带运行时。

**[为分发引入完整打包 / 转译链]**

放弃理由: 没有第三方依赖可捆, 转译目标单一 (只需去掉类型注解), `bun build` 一条命令就够了; 引入配置文件与插件生态换不来额外收益。

## 决策与理由 (Decision & Why)

1. **开发时仍然源码直跑**: 仓库里 `bun src/cli.ts` / `node src/cli.ts` 与 sh / cmd 启动器一切照旧, 不要求先构建再运行 ([ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)「零构建」在开发运行路径继续成立)。
2. **只有 npm 分发时才产出单文件编译产物**: `bun build src/cli.ts --target=node --outfile=dist/cli.js` (package.json 的 `build` 脚本), 发布前由 `prepublishOnly` 触发; `dist/` 是构建产物, 不进仓库 (被 `.gitignore` 忽略), package.json 的 `files` 只列 `bin/sweep-nm.mjs` 与 `dist`。补记 (2026-09-26): `build` 现在是两步 (上述 `bun build` + 写产物自证清单 `dist/manifest.json`), `prepublishOnly` 变成「构建 + 发布前置闸门」; 清单随 `files` 里的 `dist` 目录进包, 详见下方补记。
3. **npm 入口是 `bin/sweep-nm.mjs`**: package.json 的 `bin` 目标 (命令名仍是 `sweep-nm`); 挑好运行时 (Bun 优先, Node 回退) 后, 按「优先跑 `dist/cli.js`, 没有产物就回退 `src/cli.ts`」选入口; 同一条选择逻辑同时覆盖两种情况: 安装后的包, 和仓库里的开发 (包内只有产物, 开发时通常没有产物)。它与 sh / cmd 启动器是同一套逻辑, 差异在宿主与这条入口选择 (见 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md))。补记 (2026-09-26): 「优先跑 `dist/cli.js`」现在附加了产物自证前置 (先与随附清单对账摘要, 不符就拒收并给出指引), 详见下方补记。
4. **node 版本下限: 两种获取方式一致**: 源码方式需要类型剥离默认启用的版本, 编译产物方式跑的是 JS, 本身不需要该能力, 但两种方式取同一个数值下限 `>= 22.18.0`, 不因为方式不同而放宽 (依据与版本快照见 [ADR 0006](0006-dual-runtime-bun-first.md)「版本要求」)。

理由: 以最小代价解掉「只装 node 的机器装完 npm 包也用不了」这个冲突, 只为分发加一条构建命令, 开发运行路径与单源码原则都不动; 分发产物是单文件 JS, 没有平台分叉, 也没有运行时捆绑。

> **适用边界 (勿与 ADR 0006 的目标混读)**: 本 ADR 解决的是「只装 node 的机器跑不了源码形态」。安装方式对 node 的依赖, 要按**包管理器**区分 (实测: 入口文件的 shebang 是 node, 而 Unix 的 bin 是符号链接、执行时由内核读 shebang 选解释器, 应用层无法介入):
>
> - **`npm install -g`**: 需要有 node (npm 用户必然满足)。
> - **`bun install -g`**: 同样会生成指向本入口的符号链接, 所以**同样需要有 node**。
> - **`bunx <pkg>`**: **不生成符号链接、不经 shebang**, 由 bun 直接执行目标文件, 所以**只有 bun 的机器可用** (本机实测: 在只含 bun/bunx 的 PATH 下 `bunx cowsay@1.6.0` 正常运行, 该包 shebang 同为 node)。
> - **从源码**: sh / cmd 启动器由系统 shell 执行, 装 bun 或 node 任一个就行。
>
> ADR 0006「装任一运行时即可使用」的适用范围是**业务逻辑**和**从源码使用的入口**; npm / bun install 两种安装方式的运行时挑选 (Bun 优先) 只在入口被 node 启动之后才生效。

## 后果与权衡取舍 (Consequences & Trade-offs)

**正面收益**

- npm 安装后, 业务逻辑在 Bun / Node 双运行时下都能用 (入口由 node 启动, 之后仍按 Bun 优先挑选运行时), 与仓库里开发时同源 (同一份 `src/cli.ts` 派生);
- 构建只有一条 `bun build` 命令, 没有打包配置文件, 也没有依赖树。

**代价**

- 产物需要在发布前重建, `prepublishOnly` 已挂上, 漏跑就会发出旧产物;
- 「零构建」的表述从此要带限定: 零的是开发运行路径的构建, 不是分发链;
- 源码与产物之间可能产生偏差, v1 靠发布前重建来收敛, 不为此另设产物比对闸门。**(此项经 2026-09-26 补记推翻, 见下)**

**补记 (2026-09-26)**

安全审计确证: 上述「代价」末条的前提站不住, 这个风险不能被接受: 构建直接从当前工作树取料, 工作树是否干净不做检查, 而 `dist/cli.js` 与源码、提交之间没有任何可核对的绑定, 产物停在旧提交上时, 维护者和安装者都分辨不出来 (审计确证项: 发行包里的 `dist/cli.js` 与源码、提交没有身份绑定)。本补记推翻此前「不另设产物比对闸门」的自我判断, 补上两道防线:

1. **发布前置闸门** (新增 `scripts/verify-release.ts`, package.json 的 `verify:release`): 由 `prepublishOnly` 在构建之后调用; 四项按顺序判定, 一项不过就停: 工作树干净 (`git status --porcelain` 为空, 含未跟踪文件)、产物就位 (`dist/cli.js` 存在且非空)、清单与事实一致 (清单记录的提交等于 HEAD、构建时工作树是干净的、摘要等于产物实测值)、发行包里实际包含的文件与白名单相符 (跑一次只读的 `npm pack --dry-run --json --ignore-scripts` 拿到清单, 与 `scripts/release-artifact.ts` 的 `PACK_FILES_EXPECTED` 逐项对账, 多出的、缺少的分开列出; 该检查需要 npm)。任一项不满足即非零退出, 给出拒绝原因与处置办法。
2. **运行时可自证** (构建产出 `dist/manifest.json`, 启动器使用前对账): 清单字段为 `schemaVersion` / `commit` / `dirty` / `cliSha256` / `builtAt` (字段结构与判定见 `scripts/release-artifact.ts`, 构建侧写入见 `scripts/write-dist-manifest.ts`); `bin/sweep-nm.mjs` 在优先使用 `dist/cli.js` 前核对结构版本与清单摘要 (`schemaVersion` 必须是受支持的字面量 1, 与 `MANIFEST_SCHEMA_VERSION` 同值, 改动时要两处同步), 清单缺失 / 损坏 / 版本不支持 / 摘要不符, 一律拒收该产物并给出指引 (按运行场景给不同指引: 仓库检出里指向源码入口与重新构建, 安装后的包里指向重装本包), 不会悄悄回退到源码; 没有产物时回退源码 `src/cli.ts`, 这个原有行为不变。工作树是否干净不参与运行时判定 (开发时经常是脏的), 那是发布闸门的职责。
3. **发行包白名单** (2026-09-26 补): 白名单存在的理由: npm 的强制收录规则没有排除的口子。官方依据 (npm docs `configuring-npm/package-json`「files」节, 2026-09-26 核查) 原文: "Certain files are always included, regardless of settings", 列举 `package.json` / `README` / `LICENSE` / `LICENCE` 与 main、bin 字段指向的文件, 且 "`README` & `LICENSE` can have any case and extension."; `files` 字段只列白名单, 不提供 `!` 否定模式 (这一节里没有任何否定语法)。底层机制也印证: 本机 npm-packlist 10.0.4 对包根 README / LICENSE 硬编码了 strict 规则 `!/readme{,.*[^~$]}` 与 `!/license{,.*[^~$]}` (`node_modules/npm-packlist/lib/index.js` strict 规则构造处), 这条规则独立于 `.npmignore` 与 `files` 字段, 所以一份放在仓库根的 `README.md.20260924_181433.modified` 备份会被悄悄收进发行包 (修复前实测: 包清单 8 项, 含两份 README 备份; 修复后 6 项, 后来增补 `README.zh-CN.md` 一项, 现为 7 项)。处置: 备份一律移出仓库 (放 `~/tmp`), 白名单断言常驻, 钉住复发。什么时候要改白名单: package.json 的 `files` / `bin` 有变更, 或仓库根增删了总会被收录的文件时, 必须同步 `PACK_FILES_EXPECTED`, 否则闸门拒绝发布。
4. **闸门的触发范围与缺口** (2026-09-26 补): 闸门挂在 `prepublishOnly`, 只在 `npm publish` 且发布目标是仓库目录时触发; `npm pack` 与 `npm publish <tarball>` (对打好的包再发布) 不会经过闸门。**不补 `prepack` 兜底**: `npm pack --dry-run` 是常用的只读查看动作, 挂上闸门会让它在工作树脏 / 没构建的时候直接失败, 代价大于收益; 这个缺口由白名单断言补上: 同一风险已在 `verify:release` 里覆盖, 发布流程以 `npm publish` 为准。**bun 发布路径已联网核验 (2026-09-26, 非凭印象)**: `bun publish` 自行打包时会执行 `prepublishOnly`, 所以也在闸门之内; 依据是 bun 官方测试对执行顺序的断言 (`prepublishOnly` → `prepack` → `prepare` → `postpack` → `publish` → `postpublish`, `test/cli/install/bun-publish.test.ts` 的 lifecycle scripts 块) 与源码 `src/runtime/cli/pack_command.rs` 的 `FOR_PUBLISH` 分支 (锚定 main 分支 2026-09-25 快照); bun 官方文档 (`docs/pm/cli/publish`) 只有否定式条件句 "does not run lifecycle scripts ... if you provide a tarball path", 没有正面的支持矩阵, 直接证据来自源码与官方测试。以 tarball 形式发布 (`bun publish <tarball>`) 与 npm 侧的 `npm publish <tarball>` 一样, 都落在这个缺口里。
5. **双语 README 进包** (2026-09-27 补): 仓库根新增 `README.zh-CN.md` (根 README 的中文对照) 后, 包清单由 6 项变 7 项。这个文件走的是和补记第 3 条一样的强制收录规则 (带后缀的 README 照样被收, 不用写进 `files` 字段; 2026-09-27 实测: `npm pack --dry-run --json --ignore-scripts` 清单 7 项, 即原 6 项加 `README.zh-CN.md`)。处置: 按补记第 3 条的要求同步 `PACK_FILES_EXPECTED`; 白名单断言与单测里和真实 npm 对齐的用例照常钉住。

第 2、3 条决策里的「构建」与「入口选择」由本补记扩展, 完整规格见 [开发指南](../development.md)「发布」和 [设计总纲](../sweep/designs/sweep-node-modules-design.md) 里的代码树, 本文不复述。

## 验证方式与关联引用 (Validation & References)

**验证口径 (本次落地核验)**

1. `bun run build` 产出 `dist/cli.js`, `node dist/cli.js --help` 与 `bun dist/cli.js --help` 都能运行 (已实测);
2. `bin/sweep-nm.mjs` 在仓库里没有产物时回退 `src/cli.ts`, 有产物时走 `dist/cli.js`, 两种情况输出一致 (已实测);
3. `npm pack --dry-run --json --ignore-scripts` 的包清单实测 6 项: `LICENSE` / `README.md` / `bin/sweep-nm.mjs` / `dist/cli.js` / `dist/manifest.json` / `package.json` (2026-09-26 实测; 早期实测只核对了「含入口与产物」这一点, 当时两份放在仓库根的 README 备份被一并收进包而没被察觉; 已修复并加白名单断言, 见补记第 3 条)。**(双语 README 落盘后清单增至 7 项, 见补记第 5 条)**

**关联引用**

- 被局部取代的两处判断见 [ADR 0003](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md) 与 [ADR 0006](0006-dual-runtime-bun-first.md); 入口分轨的设计见 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md)。
- 代码树与模块结构见 [设计总纲](../sweep/designs/sweep-node-modules-design.md); 文档命名约定见 [docs/README](../README.md)。

> **修订指引 (2026-09-30)**: 本文里的包名与路径是包名翻转前的写法: CLI 发行包现为 `@iyowei/sweep-node-modules-cli` (位于 `packages/sweep-node-modules-cli/`, 含 `bin/` 与 `scripts/`); 同名包 `@iyowei/sweep-node-modules` 现在是 API 包 (见 [ADR 0010](0010-dual-package-monorepo.md))。
