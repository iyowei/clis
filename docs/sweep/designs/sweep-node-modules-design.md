# sweep-node-modules 设计总纲

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                          |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | 初稿: 立项设计, 含命令与输出、配置规格、扫描与安全闸、代码结构、测试策略、明确不做清单                                                                                                                                                                                                                                                        |
| 2026-09-23 | 补记: 配置初始化模型 (`sweep-nm init` 子命令 + 首次自动向导), 见 [ADR 0004](../../../packages/sweep-node-modules/docs/adrs/0004-config-initialization-wizard.md)                                                                                                                                                                              |
| 2026-09-23 | 补记: 工程闸门 (oxlint / prettier / lefthook), 见 [ADR 0005](../../adrs/0005-engineering-gates-and-hooks.md)                                                                                                                                                                                                                                  |
| 2026-09-23 | 补记: 双运行时 (Bun 优先 / Node 回退) 与性能要点, 见 [ADR 0006](../../adrs/0006-dual-runtime-bun-first.md)                                                                                                                                                                                                                                    |
| 2026-09-23 | 拆分: 单篇设计拆为总纲 + 四份分册; 分册后续修订各自记进自己文件内的「修订记录」                                                                                                                                                                                                                                                               |
| 2026-09-23 | 分册索引只留一行指路; 设计索引以 [designs/README.md](../../designs/README.md) 为准 (含推荐阅读顺序)                                                                                                                                                                                                                                           |
| 2026-09-23 | 补记: 三平台 (Windows / macOS / Linux) 可移植性与配置定位, 见 [ADR 0007](../../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md); CLI 输出规格升级为色块视觉规范                                                                                                                                                         |
| 2026-09-23 | 实现落地后回写: 模块表补上 delete / 门面 / bench / scripts; 测试策略补上实现覆盖的出处; 关联 [ADR 0008](../../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 转写契约套件                                                                                                                                                |
| 2026-09-23 | 分发形态: 编译产物 + 单文件打包发布到 npm (`@iyowei/sweep-node-modules`); 「明确不做」清单移除 npm 发布项                                                                                                                                                                                                                                     |
| 2026-09-23 | 代码树补上 npm 分发入口 `bin/sweep-nm.mjs`; 实测规模不再写死条数, 以验收命令的实时输出为准                                                                                                                                                                                                                                                    |
| 2026-09-23 | 分发形态回写: 代码树补上 `dist/cli.js` 与三入口的差异 (见 [ADR 0009](../../adrs/0009-npm-distribution-form.md)); 导出项补上 `runtimeLabel`                                                                                                                                                                                                    |
| 2026-09-26 | 发布侧补上产物自证: 构建产出 `dist/manifest.json` 清单, 新增 `scripts/verify-release.ts` 作为发布前置闸门, npm 启动器在用产物前先对账清单 (见 [ADR 0009](../../adrs/0009-npm-distribution-form.md) 补记); 代码树同步                                                                                                                          |
| 2026-09-26 | 发布白名单: 发布闸门加包内文件清单对账 (防止仓库根 README 这类备份被静默收进包); 启动器补 schemaVersion 校验, 拒收指引按宿主分流; 代码树同步                                                                                                                                                                                                  |
| 2026-09-27 | 设备边界 (安全审计 C6): 目标与所属根不在同一文件系统就逐条跳过 (on-path / target-itself 两种形态的解除路径各按事实), 新立契约 BC-41 / OF-15; 代码树补上 `src/skip.ts` 与 `guard.ts` 的设备比对 (见 [删除安全闸](deletion-guard.md)「设备边界」)                                                                                               |
| 2026-09-27 | rm 阶段 ENOENT 分桶 (安全审计 C8): 删除层增加对目标本体的复核, 代码树补上 delete.node-smoke.ts                                                                                                                                                                                                                                                |
| 2026-09-27 | 运行时解析防劫持 (安全审计 C10): 三个入口挑运行时都排除当前工作目录 (win32 的裸名搜索序含 cwd), npm 入口在 win32 下先按 PATH 解析出绝对路径再执行, cmd 入口改用 for 的 PATH 展开修饰符, du 探针补 win32 平台守卫; 新立契约 EC-08 (见 [ADR 0007](../../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md) 决策第 4 条补记) |
| 2026-09-27 | 工程闸门范围收窄: 装钩子改走守卫脚本 `scripts/install-git-hooks.mjs` (只在本包自己的仓库里装), lefthook 不再列为依赖; 钩子执行链由 `lefthook.yml` 的 `lefthook:` (bunx 取 pin 版) 与 `assert_lefthook_installed` 兜底 (没有全局 lefthook 也照跑, 失败响亮) (见 [ADR 0005](../../adrs/0005-engineering-gates-and-hooks.md) 决策第 1 条)        |
| 2026-09-27 | 发布白名单随双语 README 同步: 仓库根新增 `README.zh-CN.md` (英文主版的中文对照, 经 npm 的强制收录机制进包), 包文件清单从 6 项变 7 项, `PACK_FILES_EXPECTED` 跟着同步 (见 [ADR 0009](../../adrs/0009-npm-distribution-form.md) 补记第 5 条)                                                                                                    |

## 分册索引

本总纲只写项目级设计 (定位、结构、测试、全局边界); 不能再拆的设计块各自独立成册, 全部分册与推荐阅读顺序见 [产品设计索引](README.md)。

## 一、定位与成功标准

工作区级 `node_modules` 清理工具: 一次扫描多个根目录, 跨项目列出各处 `node_modules` 与体积, 确认后批量删除。与单项目清理工具分层共存, 见 [ADR 0001](../../../packages/sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)。

成功标准 (按个人小工具档位):

- **正确**: 扫描不漏不重, 删除只命中目标;
- **失败响亮**: 任何失败都以非零退出码与汇总清单报出, 不静默吞掉;
- **易改**: 零依赖、小模块、纯逻辑与 IO 分离;
- **可移植**: Windows / macOS / Linux 三平台可用, 见 [ADR 0007](../../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md);
- **够用就停**: 见「明确不做清单」, 不预建用不上的能力。

## 二、代码结构与运行时基座

> 下图是单包时期的形态; 双包迁移后的目录布局与包职责见 [ADR 0010](../../adrs/0010-dual-package-monorepo.md)。

```text
src/
├── cli.ts      # 入口编排: 参数 / 配置分流 / 扫描 / 体积 / 渲染 / 安全闸 / 删除; 帮助文案挪到 help.ts (分册: 命令面与输出)
├── runtime.ts  # 运行时适配: Bun 优先 / Node 回退 (spawn 与文件读写)
├── config.ts   # 配置读取与合并 (分册: 配置与初始化)
├── init.ts     # 初始化向导: 交互 IO 与配置生成的纯逻辑分离 (分册: 配置与初始化)
├── scan.ts     # 扫描门面: 对外只暴露胜出的候选 (候选: scan-parallel / scan-prune / scan-native)
├── size.ts     # 体积门面: 策略 A 双轨选择 (du 快路径 / 纯实现基线)
├── guard.ts    # 安全闸与设备边界: 校验不变量 / 锚点链 / st_dev 比对 (分册: 删除安全闸)
├── classify.ts # 目标类别判定: 安装树与项目依赖的语义闸, 纯路径判定 (分册: 删除安全闸)
├── skip.ts     # 跳过类目标的清单: 两类保守默认的批次排除与文案单源 (分册: 删除安全闸)
├── delete.ts   # 删除执行: 组件级复核 / 三桶结果 / 整批中止 (分册: 删除安全闸)
├── render.ts   # 清单渲染: 色块视觉规范与降级 (分册: 命令面与输出)
├── help.ts     # 帮助页文案: 命令速查 + 关键口径, 静态文本拼装 (分册: 命令面与输出)
├── types.ts / fixtures.ts / golden.ts / render.fixtures.ts  # 基建: 候选共享接口 / 合成工作区 / 金样本断言 / 渲染共享样例
├── init.smoke.ts / runtime.node-smoke.ts / delete.node-smoke.ts  # 冒烟入口: 向导走真实管道 (双载体) / runtime 与删除层用 Node 直跑 (由对应 *.test.ts spawn 驱动)
└── *.test.ts   # 与模块同名放在一起, 或按维度命名的单测 (contract / robustness / stress / e2e / smoke)

bench/                  # 基准仪器 (扫描 / 体积 / 真实工作区 / 压测四组)
bin/sweep-nm            # sh 启动器: 挑选运行时 (Bun 优先, Node 回退) 后 exec src/cli.ts
bin/sweep-nm.cmd        # cmd 启动器 (Windows): 与 sh 启动器同逻辑
bin/sweep-nm.d.mts      # bin/sweep-nm.mjs 的类型投影 (供启动器单测带类型 import; 不进 npm 包)
bin/sweep-nm.mjs        # npm 分发的 bin 入口: 优先跑 dist/cli.js (须先通过清单自证: 形状版本受支持且摘要相符, 否则拒收, 并按宿主给不同的指引), 没有产物就回退到 src/cli.ts; 三者是同一套逻辑, 差别只在宿主与入口的选择; 三入口解析运行时均不含当前工作目录 (win32 的裸名搜索序含 cwd, 见 ADR 0007 决策第 4 条补记)
dist/cli.js             # 构建产物 (派生件, 由 bun run build 生成, 不入库): 只在 npm 分发时需要
dist/manifest.json      # 产物自证清单 (同上, 随构建生成): 记录源提交 / 工作区是否干净 / 产物摘要, 供启动器与发布闸门对账
scripts/release-artifact.ts / write-dist-manifest.ts / verify-release.ts  # 发布自证三件套: 清单形状与判定 (含发布白名单 PACK_FILES_EXPECTED) / 写清单 / 发布闸门 (见 ADR 0009 补记)
scripts/release.fixtures.ts / verify-release.test.ts / write-dist-manifest.test.ts  # 自证三件套的共享夹具与单测 (临时 git 检出; 判定走注入的事实, 白名单与真实 npm 的对齐在这里实跑)
scripts/transcription/  # 转写契约套件的验收器与变异生成器 (见 docs/sweep/protocol/)
scripts/install-git-hooks.mjs / install-git-hooks.test.ts  # prepare 的装钩子守卫 (只在本包自己的仓库里装 lefthook 钩子, 作为依赖被安装时跳过, 见 ADR 0005) 与单测
```

双运行时策略见 [ADR 0006](../../adrs/0006-dual-runtime-bun-first.md); `packages/sweep-node-modules/src/runtime.ts` 对外导出的约定:

- `isBun`: 运行时探测 (功能检测 `typeof Bun !== 'undefined'`: 有 Bun 走 Bun 实现, 无则回退 Node);
- `spawnCapture(cmd, args)`: 执行子进程并捕获 stdout (Bun 走 `Bun.spawn`, Node 走 `node:child_process`; stderr 直通不捕获);
- `readTextFile(path)` / `writeTextFile(path, text)`: 文本读写 (Bun 走 `Bun.file` / `Bun.write`, Node 走 `node:fs/promises`);
- `runtimeLabel`: 运行时自述 (形如 `bun 1.4.2`, 取运行时在 `process.versions` 自报的字段, 直接跑与经启动器跑都报真身), 供顶栏如实展示本次执行环境 (分册: 命令面与输出);
- 其余能力 (目录遍历、删除等) 一律直接走 `node:` 兼容 API, 不设分支。
- **现状补记 (2026-09-29 实测)**: 上述三件在生产链路里已经没有使用方: Bun 与 Node 在 `node:` 兼容 API 上行为已一致 (spawn 直接走 `node:child_process`), 顶栏的运行时自述由 CLI 自己取一行, API 也不再导出这些; `runtime.ts` 现在只剩自测在用。

## 三、测试策略

`bun test`; fixture 在系统临时目录动态搭建, 用完即删:

| 用例     | 从属分册     | 断言                                                                                           |
| -------- | ------------ | ---------------------------------------------------------------------------------------------- |
| 剪枝     | 扫描与体积   | 嵌套 `node_modules` 只报最外层                                                                 |
| 排除     | 扫描与体积   | 项目名级与容器名级的排除均命中                                                                 |
| 符号链接 | 扫描与体积   | 不跟进, 不计入                                                                                 |
| 安全闸   | 删除安全闸   | 末段非 `node_modules`、根外路径、`/` 与 `$HOME` 一律拒绝                                       |
| 执行     | 删除安全闸   | 真删 fixture, 目标消失且邻居完好                                                               |
| 失败路径 | 删除安全闸   | 注入不可删目标, 退出码非零且给出汇总                                                           |
| 初始化   | 配置与初始化 | 非 TTY + 无配置时走 cwd 回退, 不阻塞; 配置生成纯逻辑 (答案 → 配置对象); 配置已存在时默认不覆盖 |

测试文件按语义命名 (如 `scan.contract.test.ts`, `guard.contract.test.ts`); 向导的 TTY 交互用伪终端冒烟覆盖 (见 `cli.e2e.test.ts` 的 pty 用例; `init.smoke.test.ts` 走真实管道), 纯逻辑另由「答案到配置对象再到落盘决策」的单测覆盖。

实现落地后, 实测覆盖远超这张表: 用例与语料规模以 `bun test` 与 `bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"` 的实时输出为准 (后者不参数化, 需对两个载体各跑一遍; 含压测长跑、伪终端冒烟、双载体 e2e); 明细见各 `*.test.ts` 与 [转写契约套件](../protocol/README.md) 的覆盖表。

## 四、明确不做 (YAGNI)

- 交互勾选界面;
- 活跃度智能推荐;
- `--json` 等机器输出 (暂时没有下游使用方);
- 体积阈值过滤;
- 其他清理能力 (模拟器等) 与共享基础库抽取。

以上各条, 等真有需要时再议。

## 关联引用

- [ADR 0001: 工作区级清理工具定位](../../../packages/sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)
- [ADR 0002: 固定配置与预览执行模型](../../../packages/sweep-node-modules/docs/adrs/0002-fixed-config-and-preview-execution.md)
- [ADR 0003: 零运行时依赖](../../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)
- [ADR 0004: 配置初始化向导](../../../packages/sweep-node-modules/docs/adrs/0004-config-initialization-wizard.md)
- [ADR 0005: 工程闸门与提交钩子](../../adrs/0005-engineering-gates-and-hooks.md)
- [ADR 0006: 双运行时支持与 Bun 优先的 API 策略](../../adrs/0006-dual-runtime-bun-first.md)
- [ADR 0007: 三平台可移植性与配置定位](../../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md)
- [ADR 0008: 转写契约套件](../../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)
- [ADR 0009: npm 分发形态](../../adrs/0009-npm-distribution-form.md)
- 工程闸门操作细节以仓库根 `lefthook.yml`、`.oxlintrc.json`、`.prettierrc` 为准; 文档体系与命名约定见 [docs/README](../../README.md)。
