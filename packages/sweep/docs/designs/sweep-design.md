# sweep 设计总纲

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-23 (2026-11-20 演进升级)
> **决策者**: 沈委
> **标签**: [工程, 架构]
> **影响范围**: [全项目]

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-23 | 初稿: 立项设计, 含命令与输出、配置规格、扫描与安全闸、代码结构、测试策略、明确不做清单; 随后拆分为总纲与多份分册, 补记初始化向导 ([ADR 0004](../adrs/0004-config-initialization-wizard.md))、工程闸门 ([ADR 0005](../../../../docs/adrs/0005-engineering-gates-and-hooks.md))、双运行时 ([ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md))、三平台可移植 ([ADR 0007](../adrs/0007-platform-portability.md))、转写契约套件 ([ADR 0008](../adrs/0008-transcription-kit.md)) 与分发形态 ([ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md)) |
| 2026-09-26 | 发布侧补上产物自证 (`dist/manifest.json`、`scripts/verify-release.ts`) 与包文件白名单对账                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| 2026-09-27 | 安全审计加固: 设备边界 (`BC-41` / `OF-15`)、rm 阶段 ENOENT 本体复核、运行时解析排除 cwd (`EC-08`)、钩子守卫脚本与双语 README 白名单同步                                                                                                                                                                                                                                                                                                                                                                                                                                |
| 2026-09-30 | 按 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md) 拆分为 API 主包 + CLI 薄壳双包架构                                                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-11-19 | 按 [ADR 0019](../../../../docs/adrs/0019-two-tier-package-owned-docs.md) 实施两级文档分层, 产品设计、转写契约与产品 ADR 收归 API 主包                                                                                                                                                                                                                                                                                                                                                                                                                                  |
| 2026-11-20 | 按 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md) 演进为通用工作区多技术栈清理器 `@iyowei/sweep` / `@iyowei/sweep-cli` (`sweep`): 配置 v2、6 大锚定预设、自定义规则、32 项三端家目录护栏、零依赖三端回收站 (失败绝不降级永久删除)、无损迁移、无配置非 TTY 拒盲扫与模板化摘要展示; 两包标 `"private": true` 在仓内独立演进                                                                                                                                                              |

## 分册索引

本总纲只写项目级设计 (定位、演进边界、双包结构、测试策略与明确不做清单); 各子领域独立成册, 全部分册与推荐阅读顺序见 [产品设计索引](README.md)。

## 一、定位与成功标准

通用工作区级多技术栈清理器 (`@iyowei/sweep` API 主包 + `@iyowei/sweep-cli` 薄壳 CLI, 唯一可执行命令 `sweep`, 演进决策见 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md), 原始工作区层级定位见 [ADR 0001](../adrs/0001-workspace-level-cleaner.md)):

- 一次扫描多个工作区根目录, 按配置 v2 统一识别 6 大内置技术栈预设 (`node`、`rust`、`python`、`java`、`cpp`、`os-junk`, 均受强制项目锚定保护) 与用户自定义规则 (`rules`, 缺省走回收站), 先预览体积与生效动作, 确认后再安全移入系统回收站或批量永久删除;
- 与单项目构建工具自身的 `clean` 命令分层共存: 单项目工具面向「进入单个项目清自己的产物」, `sweep` 面向「站在工作区层面跨几十个多语言项目一次性盘点与回收空间」;
- **演进态隔离**: 当前 `@iyowei/sweep` 与 `@iyowei/sweep-cli` 均在 `package.json` 显式标记 `"private": true`, 在首发定型前与公开 npm 自动发布链隔离, 不再维护旧包名过渡别名。

成功标准:

- **正确与锚定防误删**: 扫描不漏不重, 通用构建目录名 (`target`、`build`、`venv`、`node_modules`、`.gradle`) 必须通过项目锚点校验方纳入目标, 删除/回收站动作仅命中经安全闸核验的目标;
- **失败响亮与回收站铁律**: 任何清理失败、回收站故障、整批中止、配置缺失 (非 TTY) 或损坏均以非零退出码与清晰汇总报出; 回收站失败严禁静默降级为永久删除 ([ADR 0023](../adrs/0023-zero-dep-cross-platform-trash.md));
- **零运行时依赖**: 全部运行时代码 (含三端回收站通道) 仅依赖 `node:` / `bun:` 内置能力与相对模块 ([ADR 0003](../adrs/0003-zero-runtime-deps.md));
- **可移植**: 支持 macOS、Linux 与 Windows, 双运行时 (Bun 优先, Node `>= 22.18.0` 兼容, 见 [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) / [ADR 0007](../adrs/0007-platform-portability.md));
- **够用就停**: 坚持双包极简架构 (不再拆第三个私有包), 明确不做边界见第四节。

## 二、代码结构与运行时基座

按 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md) 与 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md), 全部域能力收敛在 `@iyowei/sweep` (`packages/sweep`), `@iyowei/sweep-cli` (`packages/sweep-cli`) 仅作参数解析、配置向导/迁移交互与视觉渲染薄壳:

```text
packages/sweep/
├── src/
│   ├── index.ts            # 公开 API 唯一导出入口 (契约基准: api-surface.md)
│   ├── codes.ts / errors.ts / types.ts  # 域枚举与错误码 / SweepError / 共享域类型
│   ├── config.ts / config-validate.ts   # 配置 v2 规格、三端定位、32 项 DEFAULT_EXCLUDE 与结构校验
│   ├── migrate.ts          # 无损 v1→v2 与旧路径 (sweep-node-modules/config.json) 自动迁移与写前备份
│   ├── presets.ts / rules.ts            # 6 大内置锚定预设注册表 / 自定义规则通配编译与安全校验
│   ├── scan.ts / scan-parallel.ts / scan-match.ts / scan-roots.ts
│   │                       # 32 路有界并发扫描引擎 (另有 scan-prune / scan-native 基准参照实现)
│   ├── size.ts / size-du.ts / size-du-parse.ts / size-js.ts
│   │                       # 策略 A 双轨体积统计 (du 并发快路径 + 纯 JS 共享回调池)
│   ├── classify.ts / guard.ts / guard-device.ts / skip.ts / stale.ts
│   │                       # 语义闸、泛化五不变量安全闸、设备边界、跳过集册与 stale 窄例外
│   ├── trash.ts            # 零依赖三端回收站 (macOS / Linux XDG / Windows PowerShell, 失败不强删)
│   ├── delete.ts / delete-review.ts     # 4 路并发清理执行器、链头与逐级组件 lstat 复核、四桶结果
│   ├── sweep.ts / sweep-options.ts / summary.ts / display.ts
│   │                       # 编排层 (plan/run)、选项校验、结果计数摘要与 OF-14 单源净化
│   ├── fixtures.ts / runtime.ts         # 合成工作区夹具 / 运行时兼容自测模块
│   └── *.test.ts           # 按模块与契约/鲁棒/压测维度组织的单测与冒烟
├── bench/                  # 基准与长跑压测套件 (run.ts / scan / size / real-workspace / stress)
└── docs/                   # 产品设计分册、转写契约套件 (protocol/) 与产品 ADR (0001..0008, 0021..0024)

packages/sweep-cli/
├── src/
│   ├── cli.ts / cli-commands.ts / args.ts  # 入口编排、子命令分发 (init/migrate/config/update) 与参数解析
│   ├── init.ts / init-io.ts                # 交互式初始化向导与 init --default (含双阶段锚点校验)
│   ├── migrate-cli.ts / config-summary.ts  # 迁移流编排与 ▍ SWEEP 模板化配置摘要展示 (禁原始 JSON)
│   ├── render.ts / progress.ts / help.ts / outcome.ts
│   │                       # 色块清单与动作标签渲染、stderr 实时进度指示器、帮助页与退出码收口
│   └── *.test.ts / goldens/                # CLI 单测、多维度 e2e 与渲染金样本
├── bin/
│   ├── sweep / sweep.cmd   # 源码启动器 (优先 Bun, 回退 Node; 排除 cwd 防劫持)
│   ├── sweep.mjs / sweep.d.mts             # 包分发入口 (含 dist/manifest.json 自证校验)
│   └── bunfig.toml
└── docs/                   # CLI 包文档入口与命令面设计 (cli-surface.md)
```

双运行时说明 ([ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md)): 生产链路已统一采用 `node:` 标准兼容 API (子进程走 `node:child_process`, 文件系统走 `node:fs` / `node:fs/promises`), 在 Bun 与 Node `>= 22.18.0` 上行为一致; 顶栏运行时自述由 CLI 直接读取 `process.versions` 呈现; `packages/sweep/src/runtime.ts` 保留供兼容性自测。

## 三、测试策略

运行 `bun test` (及全仓门禁 `bun scripts/ci.ts`), 所有测试夹具均在临时目录动态创建并在 `finally` / `afterEach` 清理:

| 维度           | 从属分册     | 核心断言                                                                                                     |
| -------------- | ------------ | ------------------------------------------------------------------------------------------------------------ |
| 扫描与剪枝     | 扫描与体积   | 嵌套目录命中即剪枝; 排除/包含及排除优先; 符号链接不跟进不纳入; 多候选对撞一致                                |
| 6 预设强制锚定 | 扫描与体积   | 覆盖 `node`/`rust`/`python`/`java`/`cpp`/`os-junk` 全部正反例、`~/.gradle` 与项目 `.gradle` 隔离、禁删名单   |
| 自定义规则     | 配置与初始化 | `match` 危险通配/路径分隔符/控制字符硬拒、`action` 缺省 `"trash"`、`olderThanDays` 边界、冲突 `"trash"` 优先 |
| 泛化安全闸     | 删除安全闸   | 非法末段 (`.`/`..`/`.git`/`*`/尾斜杠)、根外路径、`/` 与 `$HOME`、软链根锚点、跨设备与疑似安装树拦截          |
| 三端回收站     | 删除安全闸   | macOS 本机实测 + Linux XDG 端到端测试 + Windows 桩测试; **红线反证**: 任一端失败原文件不动、零调用 `fs.rm`   |
| 配置与无损迁移 | 配置与初始化 | `v1→v2` 写前备份 `config.json.YYYYMMDD_HHMMSS.modified`、仅启 `node`、非 TTY 无损自动/非无损硬拒             |
| CLI 初始化交互 | 命令面与输出 | 无配置非 TTY 硬报错退 1 (拒盲扫)、`init --default` 覆盖保护、摘要模板展示且零原始 JSON 全文刷屏              |

实测边界声明 ([ADR 0023](../adrs/0023-zero-dep-cross-platform-trash.md)): macOS 回收站路径与 Linux 纯 TypeScript XDG Trash 协议逻辑在本机实测; **Windows 宿主机真机 PowerShell 回收站行为及真实 Linux 桌面集成仅经桩/逻辑测试验证, 尚未在目标宿主机真机实测**。

全量用例与黑盒转写验收以实时命令为准: `bun test` 与 `bun run conformance -- --target "bun packages/sweep-cli/src/cli.ts"`, 详单见 [转写双面覆盖](transcription-dual-surface.md) 与 [转写契约套件](../protocol/README.md)。

## 四、明确不做 (YAGNI)

- 交互式 TUI 多选勾选界面;
- 基于活跃度/热度的智能推荐删除;
- `--json` 等 CLI 机器输出 (程序化集成请直接使用 `@iyowei/sweep` 可编程 API);
- 体积阈值过滤;
- 引入任何第三方运行时依赖或预编译平台二进制;
- 在 `@iyowei/sweep` 与 `@iyowei/sweep-cli` 之外另拆第三个内部引擎包。

## 关联引用

- 历史演进基线: [ADR 0001](../adrs/0001-workspace-level-cleaner.md) / [ADR 0002](../adrs/0002-fixed-config-and-preview-execution.md) / [ADR 0003](../adrs/0003-zero-runtime-deps.md) / [ADR 0004](../adrs/0004-config-initialization-wizard.md) / [ADR 0007](../adrs/0007-platform-portability.md) / [ADR 0008](../adrs/0008-transcription-kit.md)
- 多技术栈通用清理器演进决策: [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) / [ADR 0022](../adrs/0022-config-v2-presets-and-rules.md) / [ADR 0023](../adrs/0023-zero-dep-cross-platform-trash.md) / [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md)
- 仓库级治理与工程基座: [ADR 0005](../../../../docs/adrs/0005-engineering-gates-and-hooks.md) / [ADR 0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) / [ADR 0009](../../../../docs/adrs/0009-npm-distribution-form.md) / [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md) / [ADR 0019](../../../../docs/adrs/0019-two-tier-package-owned-docs.md)
- 工程闸门以仓库根 `lefthook.yml`、`.oxlintrc.json`、`.prettierrc` 为准; 文档体系见 [docs/README](../../../../docs/README.md)。
