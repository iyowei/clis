# 架构总览: 程序设计范式与代价

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-24 (2026-11-20 演进同步)
> **决策者**: 沈委
> **父文档**: [设计总纲](sweep-design.md)
>
> 用途: 横向概览, 讲这套代码「怎么组织的、为什么这么组织」, 面向第一次读这个仓库的技术读者。
> 范围: 各篇设计文档讲「这个工具的设计是什么」(命令面 / 配置 / 扫描 / 删除); 本文只归纳背后的程序设计范式与代价, 不复述这些文档的细节。
> 权威: 行为与决策的权威在 `packages/sweep/docs/`、`packages/sweep-cli/docs/` 与仓库级 `docs/adrs/` 下的各篇文档; 本文属解释性归纳。

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                                                  |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-24 | 初稿: 归纳本仓的程序设计范式与代价; 补记「候选间一致」对撞套件与大档阈值重标 (512 MiB)                                                                                                                                                                                                                                                                                                |
| 2026-09-27 | 工序模块列举补 `skip.ts` (设备边界落地)                                                                                                                                                                                                                                                                                                                                               |
| 2026-11-20 | 依 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md) 同步通用工作区多技术栈清理器 `@iyowei/sweep` / `@iyowei/sweep-cli` 双包结构: 纳入声明式预设注册表 (`presets.ts`)、规则编译 (`rules.ts`)、零依赖三端回收站 (`trash.ts` + `TrashDeps` 注入)、无损迁移 (`migrate.ts`) 与摘要模板 (`config-summary.ts`) |

`sweep` 干的活很清晰: 站在工作区层面, 跨多个根目录统一找出 Node.js、Rust、Python、Java、C/C++ 的构建与依赖产物、系统元数据垃圾文件以及自定义规则命中的目标, 量出体积, 确认后安全移入回收站或批量删除。

但翻一遍源码会发现, 这套代码的重心不在「删」。

> 它的重心在「凭什么说它清理得对」: 谁上场由实测数据裁定, 行为对错由编号条款与金样本语料验收, 通用目录名必须过项目锚定校验, 危险动作用泛化五不变量加逐级复核加回收站不降级铁律层层兜底, 连「名单写错了」都有专门的告警通道。

本文回答一个问题: 这套代码用了哪些程序设计范式 (分层、设计模式、数据结构、设计原则), 以及这些选择各有什么代价。前一半是骨架, 后一半是账单, 两边都不省略。

## 先看骨架: 双包分层与一条数据流

一次 `sweep --yes` 的运行路线是固定的:

参数解析 → 配置定位 / 无损迁移与装载 → 多预设锚定与规则扫描 → 体积统计 → 语义闸与设备边界 → 预览渲染 → 泛化安全闸校验 → 回收站/删除执行 → 结果摘要与退出码。

沿着这条路线, 全部业务逻辑收归 API 主包 (`packages/sweep/src/`), CLI 薄壳 (`packages/sweep-cli/src/`) 只做参数解析、交互向导/迁移确认与视觉渲染 (不另拆第三个私有包, 见 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md)):

```text
packages/sweep-cli/src/
  cli.ts / cli-commands.ts / args.ts   入口编排与子命令分发 (init/migrate/config/update)
  init.ts / migrate-cli.ts             交互向导与无损迁移流编排
  render.ts / config-summary.ts / progress.ts / help.ts / outcome.ts
                                       色块清单、配置摘要模板、stderr 进度与退出码收口
        ↓  (消费 @iyowei/sweep 公开 API)
packages/sweep/src/
  sweep.ts / summary.ts                编排层 (plan / run) 与四档计数摘要
  presets.ts / rules.ts                声明式 6 预设锚定注册表 / 自定义规则校验与通配编译
  config.ts / config-validate.ts / migrate.ts
                                       配置 v2、32 项三端护栏与无损迁移引擎
  scan.ts → scan-{parallel,prune,native}.ts (+ scan-match / scan-roots)
  size.ts → size-{du,js}.ts            门面与多实现候选层
  classify.ts / guard.ts / guard-device.ts / skip.ts / stale.ts
                                       语义闸、泛化五不变量、设备边界与跳过集册
  trash.ts / delete.ts / delete-review.ts
                                       零依赖三端回收站 (失败不强删) 与 4 路并发复核删除
```

每层只解决一个问题。编排层解决「流程怎么串」; 门面层 (`scan.ts` / `size.ts`) 解决「对外暴露哪个胜出候选」; 候选层解决「同一接口由哪种算法落地」; 工序模块 (`presets.ts` / `rules.ts` / `guard.ts` / `trash.ts` / `migrate.ts` 等) 各自收口一项正交职责, 彼此间只在必要处共享单源原语 (例如扫描与安全闸共用 `guard.ts` 的 `dedupeKey`, 确保同一路径在不同大小写或符号链接写法下两处结论绝不打架)。早期的双运行时差异适配层 `runtime.ts` 在实测 Bun 与 Node 对 `node:` 标准 API 行为一致后已退出生产链路, 仅保留供兼容性自测。

## 候选制: 由数据裁定

这套代码里最具辨识度的工程机制是候选制。

扫描保留三个候选: 手写剪枝递归 (`scan-prune`)、原生递归加后过滤 (`scan-native`)、有界并发 (`scan-parallel`)。体积统计保留两个候选: 系统 `du` 快路径 (`size-du`) 与纯 JS 实现 (`size-js`)。

竞争有明确赛制: 先过同一套契约用例资格赛与「候选间一致」对撞, 再在同一批数据上跑基准并追加写入 `bench/results/bench.jsonl`, 连续 3 轮无收益即收口。扫描侧由有界并发 (`CONCURRENCY = 32`, 真实工作区约 4.8× 提速) 胜出, 在演进为多预设/多规则引擎后仍完整保留 7 轮性能优化成果 (原生回调池、显式 LIFO 栈、单遍 `readdir` 内存同级文件表零多余磁盘 IO 锚定)。体积统计采用「策略 A 双轨」: POSIX 有 `du` 时走 `du` 并发快路径 (`'disk-usage'`), 无 `du` 及全部 Windows 走纯 JS 跨目标共享回调池 (`'logical-bytes'`), 各自对齐所在平台原生直觉。

候选制不是运行时插件系统, 而是开发期的实证裁定程序; 落选参照实现保留在仓内持续参与对撞与回归对比。

## 设计模式: 七个落点

| 模式                          | 落点                                                                                         | 一句话                                                                                      |
| ----------------------------- | -------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------- |
| Facade 门面                   | `packages/sweep/src/scan.ts` / `size.ts`                                                     | 对外只暴露胜出或双轨分流实现, 换实现只改一处                                                |
| Strategy 策略                 | 候选实现 (`scan-*` / `size-*`) 与三端回收站分支 (`trash.ts`)                                 | 同一接口或统一入口下按实证或平台分派实现                                                    |
| Declarative Registry 注册表   | `packages/sweep/src/presets.ts` (`BUILTIN_PRESETS`)                                          | 声明式描述预设名称、形态、锚定校验与默认动作, 零侵入扩展新技术栈                            |
| Dependency Injection 依赖注入 | `InitDeps` / `TrashDeps` / `DeviceProbe` / `ResolveConfigPathOptions`                        | 把文件系统、子进程、时钟、平台与环境变量参数化, 在单机上确定性测三端全分支                  |
| State Machine 状态机          | `InitResult` / `MigrationFlowResult`                                                         | 向导与迁移流显式穷举终态 (`written`/`migrated`/`cancelled`/`declined-overwrite`/`conflict`) |
| Discriminated Union 判别联合  | `LoadConfigResult` / `MigrationDetection` / `BatchOutcome` / `TrashOutcome` / `EntryOutcome` | 编译器强制调用方穷举每一分支, 杜绝 `null` / 布尔猜状态                                      |
| Factory Function 工厂惯例     | `createSweeper` / `createScanner` / `createSizer`                                            | 除 `SweepError` 外不导出类, 域数据一律为可无损 `JSON.stringify` 的普通对象                  |

其中依赖注入 (`TrashDeps`、`DeviceProbe`、`InitDeps`) 是跨平台可测性的核心杠杆: 在 macOS 开发机上注入 `platform: 'win32'` 与桩 `execFile`/`lstat`, 就能确定性覆盖 Windows 260 字符拦截、只读剥离、PowerShell 环境变量传参与 `%APPDATA%` 路径逻辑 (同时在文档中如实登记真机未测边界)。

## 数据结构: Map、Set 与确定性排序

受零运行时依赖底线 ([ADR 0003](../adrs/0003-zero-runtime-deps.md)) 约束, 全部源码只用原生 `Map`、`Set`、数组与普通对象接口:

- **去重键编码业务语义**: `dedupeKey(realPath, style)` 将 realpath 归一与 win32 大小写折叠合一, 扫描去重与安全闸判重同源; 多源碰撞时按 `trash` 优先于 `delete` 保守合并。
- **内存同级文件集合 (`siblingFiles`)**: 每次 `readdir` 线性提取普通文件名成 `Set<string>`, 让绝大多数预设项目锚定校验以 `O(1)` 零额外 syscall 完成。
- **输出与并发完成序解耦**: 32 路扫描与 4 路删除的完成序均非确定, 但输出严格按 `target` 码点升序 (扫描/体积) 或输入顺序重排 (删除四桶与 `stale`), 不依赖 locale。
- **显式 LIFO 栈替代深递归**: 避免深层目录链爆调用栈与无界 Promise 扇出。

## 设计原则: 代码里读得出的信条

1. **纯函数优先与显式边界**: 路径判定 (`guard.ts`)、预设名校验、规则通配编译 (`rules.ts`)、语义分类 (`classify.ts`)、结果汇总 (`summary.ts`)、配置转换 (`convertV1ToV2`) 与摘要渲染 (`config-summary.ts`) 全部保持纯函数或可注入依赖, 副作用集中收口在明确边界。
2. **克制与演进边界 (YAGNI)**: 当多语言工作区清理成为真实高频诉求时, 才通过 [ADR 0021](../adrs/0021-sweep-general-cleaner-evolution.md) ~ [ADR 0024](../adrs/0024-cli-init-migrate-and-summary-display.md) 升级为通用清理器; 依然坚定不做交互勾选 TUI、启发式活跃度删除、`--json` CLI 开关、第三方运行时依赖以及第三个私有包。
3. **失败响亮与保守默认**: 预览是默认态, 非 TTY 无配置直接报错拒盲扫, 回收站失败严禁静默降级 `fs.rm`, 名单拼错必在 stderr 告警, 写配置迁移前强制备份原文件, 任一异常或未处理目标均以退出码 `1` 响亮告之。

## 契约优先: 先定尺子, 再写实现

验收体系分三层: 代码单测与双运行时 e2e (含三端桩与红线反证)、语言中立的 CLI/API 双面黑盒金样本语料与变异自证 ([行为契约](../protocol/behavior-contract.md) / [转写双面覆盖](transcription-dual-surface.md) / [ADR 0008](../adrs/0008-transcription-kit.md)), 以及四组性能与压测基准 (`packages/sweep/bench/`)。覆盖不到的边界 (如 Windows 宿主机真机回收站执行、真实挂载竞态缝) 显式登记豁免与实测缺口, 绝不装作万能。

## 代价: 这套结构的账单

1. **候选制同步税**: 扫描参照候选 (`scan-prune` / `scan-native`) 与生产引擎 (`scan-parallel`) 共存带来基准维护与对撞成本, 换取性能演化有据可查、回归零盲区。
2. **保守安全与锚定的合理摩擦**: 通用目录名强制要求项目锚点 (裸无 `package.json` 的 `node_modules` 不再自动纳入)、删除侧强制真实路径锚点 (macOS `/tmp` 须写 `/private/tmp`)、回收站失败宁可停手也不强删, 把少量显式确认成本换成数据零误删的确定性。
3. **零依赖的自研账单**: 手写 ANSI 色块渲染与 CJK 宽度计算、手写参数解析、纯 TS 实现 Linux XDG Trash 与简单通配编译器、自制金样本断言器, 换来零供应链风险、零预编译二进制与极简双包分发面。

这套代码的每个结构都在回答同一个问题:

> 如果我错了, 谁会知道?

答案是机械的回答: 性能退化由基准抓, 行为漂移由双面语料抓, 危险目标由锚定校验与泛化安全闸拦, 回收站故障由不降级红线保底, 坏配置与盲扫由显式退出码 1 拦截。毕竟, 一个清理工具最不能有的品质, 就是自信。
