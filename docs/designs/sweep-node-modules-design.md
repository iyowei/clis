# sweep-node-modules 设计总纲

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23
> **决策者**: 沈委
> **标签**: [工程]
> **影响范围**: [全项目]

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                 |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 2026-09-23 | 初稿: 立项设计, 含命令面、配置规格、扫描与安全闸、代码结构、测试策略、明确不做清单                                                                                                                                                                                                                                                   |
| 2026-09-23 | 补记: 配置初始化模型 (`sweep-nm init` 子命令 + 首次自动向导), 见 [ADR 0004](../../packages/sweep-node-modules/docs/adrs/0004-config-initialization-wizard.md)                                                                                                                                                                        |
| 2026-09-23 | 补记: 工程闸门 (oxlint / prettier / lefthook), 见 [ADR 0005](../adrs/0005-engineering-gates-and-hooks.md)                                                                                                                                                                                                                            |
| 2026-09-23 | 补记: 双运行时 (Bun 优先 / Node 回退) 与性能要点, 见 [ADR 0006](../adrs/0006-dual-runtime-bun-first.md)                                                                                                                                                                                                                              |
| 2026-09-23 | 拆分: 单篇设计拆为总纲 + 四份分册; 分册后续修订各自在文件内补「修订记录」                                                                                                                                                                                                                                                            |
| 2026-09-23 | 分册索引收为指针行; 设计索引权威归 [designs/README.md](README.md) (含推荐阅读顺序)                                                                                                                                                                                                                                                   |
| 2026-09-23 | 补记: 三平台 (Windows / macOS / Linux) 可移植性与配置定位, 见 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md); CLI 输出规格升级为色块视觉规范                                                                                                                                                   |
| 2026-09-23 | 实现落地回写: 模块表补 delete / 门面 / bench / scripts; 测试策略补实现覆盖指针; 关联 [ADR 0008](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md) 转写契约套件                                                                                                                                                  |
| 2026-09-23 | 分发形态: 编译产物 + 单文件打包发布到 npm (`@iyowei/sweep-node-modules`); 「明确不做」清单移除 npm 发布项                                                                                                                                                                                                                            |
| 2026-09-23 | 代码树补 npm 分发入口 `bin/sweep-nm.mjs`; 实测规模改为指代验收命令的实时输出 (不写死条数)                                                                                                                                                                                                                                            |
| 2026-09-23 | 分发形态回写: 代码树补 `dist/cli.js` 与三入口差异 (见 [ADR 0009](../adrs/0009-npm-distribution-form.md)); 导出面补 `runtimeLabel`                                                                                                                                                                                                    |
| 2026-09-26 | 发行面补产物自证: 构建产出 `dist/manifest.json` 清单, 新增 `scripts/verify-release.ts` 发布前置闸门, npm 启动器使用产物前对账清单 (见 [ADR 0009](../adrs/0009-npm-distribution-form.md) 补记); 代码树同步                                                                                                                            |
| 2026-09-26 | 发行面白名单: 发布闸门加发行面包内文件对账 (防仓库根 README 类备份被静默收进包); 启动器补 schemaVersion 校验与拒收指引宿主分流; 代码树同步                                                                                                                                                                                           |
| 2026-09-27 | 设备边界 (安全审计 C6): 目标与所属根不同文件系统即逐条跳过 (两形态 on-path / target-itself 的解除路径各按事实), 新立契约 BC-41 / OF-15; 代码树补 `src/skip.ts` 与 `guard.ts` 的设备比对 (见 [删除安全闸](deletion-guard.md)「设备边界」)                                                                                             |
| 2026-09-27 | rm 阶段 ENOENT 分桶 (安全审计 C8): 删除层增目标本体复核, 代码树补 delete.node-smoke.ts                                                                                                                                                                                                                                               |
| 2026-09-27 | 运行时解析防劫持 (安全审计 C10): 三入口挑运行时排除当前工作目录 (win32 的裸名搜索序含 cwd), npm 入口在 win32 下先按 PATH 解析绝对路径再执行, cmd 入口改用 for 的 PATH 展开修饰符, du 探针补 win32 平台守卫; 新立契约 EC-08 (见 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md) 决策第 4 条补记) |
| 2026-09-27 | 工程闸门形态收窄: 装钩子改经守卫脚本 `scripts/install-git-hooks.mjs` (只在本包自身仓库), lefthook 不列依赖; 钩子执行链经 `lefthook.yml` 的 `lefthook:` (bunx 取 pin 版) 与 `assert_lefthook_installed` 兜底 (无全局 lefthook 照跑, 失败响亮) (见 [ADR 0005](../adrs/0005-engineering-gates-and-hooks.md) 决策第 1 条)                |
| 2026-09-27 | 发行面白名单随双语 README 同步: 仓库根新增 `README.zh-CN.md` (英文主版的中文对照, 经 npm 强制收录通道进包), 包清单 6 项变 7 项, `PACK_FILES_EXPECTED` 随同步 (见 [ADR 0009](../adrs/0009-npm-distribution-form.md) 补记第 5 条)                                                                                                      |

## 分册索引

本总纲只承载项目级设计 (定位、结构、测试、全局边界); 各「不可再拆分的设计块」独立成册, 分册总目与推荐阅读顺序见 [设计文档索引](README.md)。

## 一、定位与成功标准

工作区级 `node_modules` 清理工具: 一次扫描多个根目录, 跨项目列出各处 `node_modules` 与体积, 确认后批量删除。与单项目清理工具分层共存, 见 [ADR 0001](../../packages/sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)。

成功标准 (按个人小工具档位):

- **正确**: 扫描不漏不重, 删除只命中目标;
- **失败响亮**: 任何失败以非零退出码与汇总清单呈现, 不静默吞掉;
- **易改**: 零依赖、小模块、纯逻辑与 IO 分离;
- **可移植**: Windows / macOS / Linux 三平台可用, 见 [ADR 0007](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md);
- **够用就停**: 见「明确不做清单」, 不预建投机能力。

## 二、代码结构与运行时基座

> 下图为单包时代形态; 双包迁移后的目录布局与包职责见 [ADR 0010](../adrs/0010-dual-package-monorepo.md)。

```text
src/
├── cli.ts      # 入口编排: 参数 / 配置分流 / 扫描 / 体积 / 渲染 / 安全闸 / 删除; 帮助面外提至 help.ts (分册: 命令面与输出)
├── runtime.ts  # 运行时适配: Bun 优先 / Node 回退 (spawn 与文件读写)
├── config.ts   # 配置读取与合并 (分册: 配置与初始化)
├── init.ts     # 初始化向导: 交互 IO 与配置生成纯逻辑分离 (分册: 配置与初始化)
├── scan.ts     # 扫描门面: 对外只暴露胜出候选 (候选: scan-parallel / scan-prune / scan-native)
├── size.ts     # 体积门面: 策略 A 双轨选择 (du 快路径 / 纯实现基线)
├── guard.ts    # 安全闸与设备边界: 校验不变量 / 锚点链 / st_dev 比对 (分册: 删除安全闸)
├── classify.ts # 目标类别判定: 安装树与项目依赖的语义闸, 纯路径判定 (分册: 删除安全闸)
├── skip.ts     # 跳过类目标的集册: 两类保守默认的批次排除与文案单源 (分册: 删除安全闸)
├── delete.ts   # 删除执行: 组件级复核 / 三桶结果 / 整批中止 (分册: 删除安全闸)
├── render.ts   # 清单渲染: 色块视觉规范与降级 (分册: 命令面与输出)
├── help.ts     # 帮助页文案: 命令面速查 + 关键口径, 静态文本拼装 (分册: 命令面与输出)
├── types.ts / fixtures.ts / golden.ts / render.fixtures.ts  # 基建: 候选共享接口 / 合成工作区 / 金样板断言 / 渲染共享样例
├── init.smoke.ts / runtime.node-smoke.ts / delete.node-smoke.ts  # 冒烟入口: 向导真实管道 (双载体) / runtime 与删除层的 Node 直跑 (由对应 *.test.ts spawn 驱动)
└── *.test.ts   # 与模块同名并置或按维度命名的单测 (contract / robustness / stress / e2e / smoke)

bench/                  # 基准仪器 (扫描 / 体积 / 真实工作区 / 压测四组)
bin/sweep-nm            # sh 启动器: 挑选运行时 (Bun 优先, Node 回退) 后 exec src/cli.ts
bin/sweep-nm.cmd        # cmd 启动器 (Windows): 与 sh 启动器同逻辑
bin/sweep-nm.d.mts      # bin/sweep-nm.mjs 的类型投影 (供 launcher 单测带类型 import; 不进 npm 包)
bin/sweep-nm.mjs        # npm 分发的 bin 入口: 优先跑 dist/cli.js (须通过清单自证: 形状版本受支持且摘要相符, 否则拒收并按宿主给指引), 无产物回退 src/cli.ts; 三者职责同逻辑, 差异在宿主与入口选择; 三入口的运行时解析面均不含当前工作目录 (win32 的裸名搜索序含 cwd, 见 ADR 0007 决策第 4 条补记)
dist/cli.js             # 构建产物 (派生件, 由 bun run build 生成, 不入库): 仅 npm 分发态需要
dist/manifest.json      # 产物自证清单 (同上, 随构建生成): 记录源提交 / 脏净 / 产物摘要, 供启动器与发布闸门对账
scripts/release-artifact.ts / write-dist-manifest.ts / verify-release.ts  # 发行面自证三件: 清单形状与判定 (含发行面白名单 PACK_FILES_EXPECTED) / 写清单 / 发布闸门 (见 ADR 0009 补记)
scripts/release.fixtures.ts / verify-release.test.ts / write-dist-manifest.test.ts  # 自证三件的共享夹具与单测 (临时 git 检出; 判定走注入事实, 白名单与真实 npm 的对齐在此实跑)
scripts/transcription/  # 转写契约套件的验收器与变异生成器 (见 docs/protocol/)
scripts/install-git-hooks.mjs / install-git-hooks.test.ts  # prepare 的装钩子守卫: 只在本包自身仓库装 lefthook 钩子, 被作为依赖安装时跳过 (见 ADR 0005) 与单测
```

双运行时策略见 [ADR 0006](../adrs/0006-dual-runtime-bun-first.md); `packages/sweep-node-modules/src/runtime.ts` 导出面约定:

- `isBun`: 运行时探测 (功能检测 `typeof Bun !== 'undefined'`: 有 Bun 走 Bun 实现, 无则回退 Node);
- `spawnCapture(cmd, args)`: 子进程执行并捕获 stdout (Bun 走 `Bun.spawn`, Node 走 `node:child_process`; stderr 直通不捕获);
- `readTextFile(path)` / `writeTextFile(path, text)`: 文本读写 (Bun 走 `Bun.file` / `Bun.write`, Node 走 `node:fs/promises`);
- `runtimeLabel`: 运行时自述 (形如 `bun 1.4.2`, 取运行时在 `process.versions` 自报的字段, 直接跑与经启动器跑都报真身), 供顶栏如实展示本次执行环境 (分册: 命令面与输出);
- 其余能力 (目录遍历、删除等) 一律直接走 `node:` 兼容 API, 不设分支。
- **现状补记 (2026-09-29 实测)**: 上述三件在生产链路已无消费方: Bun 与 Node 在 `node:` 兼容 API 上行为已一致 (spawn 直走 `node:child_process`), 顶栏的运行时自述由 CLI 一行自取, API 不导出 runtime 面; `runtime.ts` 现仅存自测。

## 三、测试策略

`bun test`; fixture 在系统临时目录动态搭建, 用完即删:

| 用例     | 从属分册     | 断言                                                                                   |
| -------- | ------------ | -------------------------------------------------------------------------------------- |
| 剪枝     | 扫描与体积   | 嵌套 `node_modules` 只报最外层                                                         |
| 排除     | 扫描与体积   | 项目名级与容器名级排除均命中                                                           |
| 符号链接 | 扫描与体积   | 不跟进, 不计入                                                                         |
| 安全闸   | 删除安全闸   | 非 `node_modules` 末段、根外路径、`/` 与 `$HOME` 一律拒绝                              |
| 执行     | 删除安全闸   | 真删 fixture, 目标消失且邻居完好                                                       |
| 失败路径 | 删除安全闸   | 注入不可删目标, 退出码非零且汇总呈现                                                   |
| 初始化   | 配置与初始化 | 非 TTY + 无配置走 cwd 回退不阻塞; 配置生成纯逻辑 (答案 → 配置对象); 已存在时默认不覆盖 |

测试文件按语义命名 (如 `scan.contract.test.ts`, `guard.contract.test.ts`); 向导的 TTY 交互以伪终端冒烟覆盖 (见 `cli.e2e.test.ts` 的 pty 用例; `init.smoke.test.ts` 走真实管道), 纯逻辑另由「答案到配置对象再到落盘决策」的单测覆盖。

实现落地后实测覆盖远超本表: 用例与语料规模以 `bun test` 与 `bun run conformance -- --target "bun packages/sweep-node-modules-cli/src/cli.ts"` 的实时输出为准 (后者不参数化, 需对两个载体各跑一遍; 含压测长跑、伪终端冒烟、双载体 e2e); 明细见各 `*.test.ts` 与 [转写契约套件](../protocol/README.md) 的覆盖表。

## 四、明确不做 (YAGNI)

- 交互勾选界面;
- 活跃度智能推荐;
- `--json` 等机器输出 (暂无下游消费者);
- 体积阈值过滤;
- 其他清理能力 (模拟器等) 与共享基础库抽取。

以上均等真实需要出现时再议。

## 关联引用

- [ADR 0001: 工作区级清理工具定位](../../packages/sweep-node-modules/docs/adrs/0001-workspace-level-cleaner.md)
- [ADR 0002: 固定配置与预览执行模型](../../packages/sweep-node-modules/docs/adrs/0002-fixed-config-and-preview-execution.md)
- [ADR 0003: 零运行时依赖](../../packages/sweep-node-modules/docs/adrs/0003-zero-runtime-deps.md)
- [ADR 0004: 配置初始化向导](../../packages/sweep-node-modules/docs/adrs/0004-config-initialization-wizard.md)
- [ADR 0005: 工程闸门与提交钩子](../adrs/0005-engineering-gates-and-hooks.md)
- [ADR 0006: 双运行时支持与 Bun 优先的 API 策略](../adrs/0006-dual-runtime-bun-first.md)
- [ADR 0007: 三平台可移植性与配置定位](../../packages/sweep-node-modules/docs/adrs/0007-platform-portability.md)
- [ADR 0008: 转写契约套件](../../packages/sweep-node-modules/docs/adrs/0008-transcription-kit.md)
- [ADR 0009: npm 分发形态](../adrs/0009-npm-distribution-form.md)
- 工程闸门操作细节以仓库根 `lefthook.yml`、`.oxlintrc.json`、`.prettierrc` 为准; 文档体系与命名约定见 [docs/README](../README.md)。
