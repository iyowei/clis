# sweep-node-modules

[![CI](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/sweep-node-modules/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
![node](https://img.shields.io/node/v/@iyowei/sweep-node-modules)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fsweep-node-modules%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

工作区级 `node_modules` 清理能力的可编程 API: 扫描、测体积并安全删除, 供你自己的脚本与工具直接调用。CLI 包就是这套 API 之上的一层薄壳。

> **包定位变更说明**: 0.4.0 及以前, `@iyowei/sweep-node-modules` 是命令行工具; 自 0.5.0 起, 该名字承载可编程 API 包 (纯库形态, 无 `bin`), CLI 则迁到独立包 **[@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)**。要找 `sweep-nm` 命令的, 请改装该包; 命令名、旗标与配置文件均照旧。机器上装着旧名 CLI 的, 升级它只会得到本库、不再有命令: 卸载旧的全局安装, 改装 `-cli` 包。迁移细节见 release notes。

## 目录

- [要求](#要求)
- [安装](#安装)
- [快速上手](#快速上手)
- [两级导出面](#两级导出面)
- [编排层](#编排层)
- [原语层](#原语层)
- [错误与代码](#错误与代码)
- [进度与取消](#进度与取消)
- [安全模型](#安全模型)
- [数据形态与稳定性](#数据形态与稳定性)
- [开发](#开发)
- [文档](#文档)

## 要求

- **双运行时**: 有 bun 走 bun, 否则 node (功能一致, bun 启动更快); node 版本下限 `>= 22.18.0` (本包 `engines` 字段)。
- 零第三方运行时依赖: 只用运行时内置能力 (见 [ADR 0003](../../docs/adrs/0003-zero-runtime-deps.md))。
- 平台: Windows / macOS / Linux 三平台均可运行 (见 [ADR 0007](../../docs/adrs/0007-platform-portability.md))。
- 源码为 TypeScript; 类型声明随包分发。

## 安装

```shell
npm install @iyowei/sweep-node-modules
bun add @iyowei/sweep-node-modules
```

本包不装命令: 它是一个库。命令行工具请装 [@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)。

## 快速上手

```ts
import {
  createSweeper,
  formatBytes,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

// 编排层不读平台配置文件: 扫什么由你显式给定
const sweeper = createSweeper({
  roots: ['/Users/me/workspace/development'], // 绝对路径
});

// plan(): 只读面。扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除
const plan = await sweeper.plan();

for (const entry of plan.entries) {
  const size = entry.bytes === undefined ? '?' : formatBytes(entry.bytes);
  const note = entry.inBatch ? '' : `  (${entry.skipNote})`;
  console.log(
    `${entry.inBatch ? '*' : '-'} ${size.padStart(9)}  ${entry.target}${note}`,
  );
}
console.log(`将清理 ${plan.batch.length} 处`);

// run(): 以此刻的磁盘事实重跑判定链, 过安全闸后执行删除
const report = await sweeper.run({
  expectedBatch: plan.batch, // 把删除面收在上一步刚批准的清单内
  staleTargets: 'missing', // 已被别人删掉的目标不算失败
});

const summary = summarizeReport(report);
console.log(
  `已删 ${summary.counts.removed} 处, 释放 ${formatBytes(report.releasedBytes)}`,
);
```

上手前值得先知道的几件事:

- `roots` 用绝对路径; 删除侧还要求**真实路径形态**: 根及其祖先链不得有符号链接介入。macOS 的 `tmpdir()` 经过 `/var` (系统链接), 当根用之前先归一: `const root = await realpath(await mkdtemp(...))`。读取侧不受此限。
- 编排层不装载平台配置, 交互向导也留在 CLI 包; 下文的配置装载件, 是给「想在自己的工具里接同一套配置行为」的调用方准备的可选原语。
- 本包不向 stdout / stderr 写任何东西: 一切给人看的文字都以字符串形式返回, 往哪输出由你决定。

## 两级导出面

| 层                                                                                  | 是什么                                                              | 什么时候用                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| 编排层: `createSweeper(...).plan()` / `.run()`                                      | 整条链: 扫描 → 体积 → 类别 → 设备 → 批次构造 → 安全闸 → 删除 → 报告 | 默认选它。你只管声明扫什么, 并决定报告怎么用 |
| 原语层: `createScanner` / `createSizer` / `validateTargets` / `removeTargets` / ... | 单点能力, 每个都可独立使用                                          | 需要逐步控制, 或只取链上某一环嵌进自己的流程 |

CLI 包是编排层的薄壳: 解析 → 调用 → 渲染 → 确认。业务语义只有本包一份实现, CLI 是消费方, 不是第二份拷贝。

## 编排层

### `createSweeper(options): Sweeper`

```ts
const sweeper = createSweeper({
  roots, // 必填, 非空: 扫描根, 绝对路径
  exclude, // 缺省取 DEFAULT_EXCLUDE (与 CLI 同一份内置名单)
  include, // 缺省 [] (不过滤)
  home, // 缺省 os.homedir(); 传 null 关闭 home 本体防线与隐藏目录形态判定
  style, // posix / win32 路径风味; 缺省平台原生 (测试注入用)
  policy: { releaseSuspects: false },
});
```

参数错误 (如 `roots` 为空或非字符串数组) 在**构造期同步抛出**: 无 IO 即失败, 尽早报错; 下文全部异步入口则一律以 rejected promise 抛出, 同一规则的另一半。

- `exclude` / `include` 按目录名匹配, 从根到命中点的任意一级命中即生效; `exclude` 命中整棵子树跳过。两个名单同时命中时 `exclude` 优先。
- `policy.releaseSuspects` 就是库侧的 `--force`: 放行「疑似安装树」进批, 只放行这一类, 不放宽任何不变量; 跨设备目标不受它影响。
- `sweeper.options` 是合并缺省后的只读选项快照, 供日志与审计。

### `plan()`: 只读面

```ts
const plan = await sweeper.plan({ onProgress, signal });
```

扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除。`SweepPlan`:

- `entries`: 每个命中一条 `SweepEntry`: `target` / `project` / `root` / `bytes?` / `basis?` / `kind` / `kindReason?` / `crossDevice?` / `unmeasuredCode?` / `unmeasuredReason?` / `inBatch`, 未进批者另带 `skipReason` 与 `skipNote` (码与话随条目携带, 复核表不必按 target 去 join)。
- `batch`: 将进入删除的目标清单, 保清单顺序。
- `skipped`: 全部批次外目标, 各带 `reason` 与 `note`。
- `warnings`: 非致命告警 (`{ code, message, path?, errno? }`)。
- `nameMatches`: 两份名单的逐名命中统计 (零命中的名字也在列, 拼错了当场可见)。
- `basis`: 本次体积口径 (有目标被测到时给出)。

### `run()`: 执行面

```ts
const report = await sweeper.run({
  onProgress,
  signal,
  expectedBatch,
  staleTargets,
});
```

`run()` 先重跑一遍只读面 (绝不拿旧计划执行: 每个事实都以此刻的磁盘状态重判), 再送安全闸、执行删除。在 `plan` 的选项之上多两个旋钮:

- `expectedBatch`: 刚被批准的那份清单。给了它, 本次删除面 = 期望批次 ∩ 实时批次: 之后新冒出来的目标不删 (进 `drift.added`, 条目结果为 `{ kind: 'not-expected' }`), 已消失或被策略挡下的也不删 (进 `drift.removed`)。它收窄范围, 不跳过重判。
- `staleTargets: 'reject' | 'missing'` (缺省 `'reject'`): 安全闸之前「目标已不存在」怎么处置。`'missing'` 把这类目标从批次摘出、按「目标已达成」计成功侧, 不触发整批拒绝 (对应「别人已经删掉了」这类情形); 缺省维持保守规则: 一处被拒, 整批零删除。只有 `GUARD_TARGET_MISSING` 适用这条; 不可读与其余任何拒绝码仍维持整批拒绝。

`SweepReport`:

- `status`: `'executed'` | `'rejected'` (整批拒绝) | `'nothing-to-do'` (空批)。
- `plan`: 本次执行实际依据的实时计划; 与先前 `plan()` 不一致时以它为准, 差异另由 `drift` 给出。
- `validation?` / `removal?`: 安全闸结果与删除分桶 (`removed` / `missing` / `failed` / `aborted`); 未执行删除时缺省。
- `entries`: 与 `plan.entries` 同序同长, 每条为条目加 `outcome`。
- `stale`: 按 `staleTargets: 'missing'` 摘出的已消失目标。
- `drift?`: `{ added, removed }`, 提供了 `expectedBatch` 时给出。
- `releasedBytes`: 成功侧 (removed + missing + stale) 的体积累计。

`outcome.kind` 取值: `removed` / `missing` / `stale` (成功侧: 删掉、核验已不存在、或压根没进删除面), `failed`, `rejected`, `not-attempted` (整批中止时中止点及其之后), `not-expected` (在期望批次之外), `skipped` (被策略挡下)。

### 成功口径与退出码

`isSuccessOutcome(outcome)` 与 `summarizeReport(report)` 给出库自己的成功侧定义 (`removed` / `missing` / `stale`) 与逐 kind 计数。别手写 `kind !== 'x' && kind !== 'y'`: 库里哪天新增一种成功侧 kind, 手写判据会静默漏判, 库函数则跟着版本走。

「本次运行算不算成功」是产品口径, 不是数据事实, 所以库不内置 `ok` 字段, 只给数字与三种常见配方:

```ts
const summary = summarizeReport(report);

// ① 严格 (与 CLI 包同口径): 任何未处理项或失败都算失败
const strict =
  summary.failed === 0 &&
  summary.unprocessed === 0 &&
  !summary.aborted &&
  report.status !== 'rejected';

// ② 宽松 (交互式): 只有真失败与整批中止算失败
const relaxed =
  summary.failed === 0 && !summary.aborted && report.status !== 'rejected';

// ③ 只读面: 没删成不算失败, 只报数字
```

`SweepSummary` 字段: `counts` (逐 kind 恒有项, 缺省 0)、`succeeded`、`unprocessed`、`failed`、`aborted`。

## 原语层

每个原语都可独立使用, 导入零副作用, 且都不打印任何东西; 异步入口失败一律 reject。做只读快照, 串 `scan` → `measure` → `classifyTarget` 即可, 这条路径上不存在任何删除动作。

### 扫描

```ts
const scan = await createScanner().scan({
  roots,
  exclude: [...DEFAULT_EXCLUDE], // 原语层为必填: 不过滤就传 []
  include: [],
  signal,
  onProgress: (event) => ..., // 每命中一处一条 'hit' 事件
});
```

- `Scanner.name`: 候选中立名 (`'parallel'`)。
- `ScanResult.hits`: `{ project, target, root }[]`, 按 `target` 升序、按真实路径去重; `root` 取输入顺序中首个遍历到该命中的根, 按根分组因此确定可复现。
- `excludeMatches` / `includeMatches`: `{ name, hits }[]`, 恒在 (未命中的名字以 `hits: 0` 在列)。

### 体积

```ts
const size = await createSizer().measure(targets, { signal, onProgress });
```

- `Sizer.basis` / `SizeResult.basis`: `'disk-usage'` (`du` 快路径, 报磁盘占用) 或 `'logical-bytes'` (纯实现, 报逻辑字节); 一次调用恒一口径, 调用前后都可读, 不要猜它。win32 恒为 `logical-bytes`。
- 入参每个目标恒落在且仅落在一个桶, 无第四类: `entries` (测到了: `{ target, bytes }`, 升序)、`unmeasured` (存在但测不到: `{ target, code, reason }`)、`gone` (测量时已不存在)。这条完备性恒等式是契约, 不必再造 `'unknown'` 兜底分支。

### 类别

```ts
const { kind, reason } = classifyTarget(target, options?);
// kind: 'project' | 'suspect-install-tree'
```

纯路径判定, 零 IO, 语义与 CLI 的清单标记同源。

### 安全闸

```ts
const { accepted, rejected, mappings } = await validateTargets(targets, {
  roots,
  home,
  style,
  signal,
});
```

- `accepted`: 可删目标: 已 realpath 归一、已去重、保输入顺序。
- `rejected`: 每条被拒目标的 `{ target, code, message, details? }`, 与输入逐条对应。
- `mappings`: `original → real` 配对, 与 `accepted` 逐位对应; 显示用 `original`, 删除用 `real`, 不必再靠位次手工对齐。

```ts
const crossDevice = await findCrossDeviceTargets(targets, { roots });
const index = crossDeviceIndex(crossDevice); // 需要 has / get 时用这个视图
```

`findCrossDeviceTargets` 返回数组而非 `Map`: `JSON.stringify` 无损, 审计里不丢列; 查询视图由 `crossDeviceIndex` 另给。

### 删除

```ts
const removal = await removeTargets(accepted, {
  roots: await toTrustRoots(roots),
  signal,
  onProgress,
});
```

- `toTrustRoots(roots)`: 给每个配置根配上它的真实路径; 这对配对是锚点防线的一半, 不要手写。
- `RemovalResult`: `removed` / `missing` (复核确认已不存在, 计成功侧) / `failed` (`{ target, code, errno?, message, partialRisk }`; `partialRisk: true` 表示内容可能已被部分删除, 提示人工复查) / `aborted?` (复核未通过致整批中止, 中止点及其之后一条未动)。

```ts
const outcome = await removeBatch(targets, { roots, staleTargets });
```

`removeBatch` 是推荐的写侧入口: 安全闸 + 整批拒绝规则 + 配对 + 删除一次吃掉, 调用方不必知道 `TrustRoot` 的存在。`BatchOutcome` 二选一: `{ status: 'rejected', rejected }` (零删除) 或 `{ status: 'executed', accepted, mappings, stale, removal }`。

### 跳过集册

自己组装「什么不进批、为什么」时:

| 你手上有什么 / 想要什么            | 用哪个                                        |
| ---------------------------------- | --------------------------------------------- |
| 有 hits + 体积 + 类别, 要候选数组  | `toSkipCandidates(hits, size, options?)`      |
| 问「这一条进不进批」(单个布尔)     | `skipsBatch(entry, crossDevice, policy)`      |
| 问「这一条为什么不进批」(单个编码) | `skipReasonOf(entry, crossDevice, policy)`    |
| 只要进批的目标清单                 | `deletionBatch(entries, crossDevice, policy)` |
| 要整份「码 + 人话 + 末行说明」     | `collectSkips(entries, crossDevice, policy)`  |
| 要跨设备形态的人话标签             | `crossDeviceNote(kind)`                       |

`SkipCandidate.suspect` 定为必填是刻意的: 它承载「这条会不会被语义闸挡下」的全部信息, 留成可选的话, 一个裸体积条目就能滑进写侧、安全语义静默消失; 不想手填就走 `toSkipCandidates`。

### 配置装载 (可选原语)

库不自动读平台配置文件; 这组装载件是给「想在自己的工具里接同一套配置行为」的调用方准备的:

- `resolveConfigPath(options)` → `{ path, source }`, `source` 取 `'flag' | 'env' | 'platform-default'`。
- `loadConfig(path)` / `loadResolvedConfig(resolved)` → `{ state: 'ok', config }` 或 `{ state: 'absent' }`; 文件损坏时抛 `SweepError`。
- `mergeNames(configNames, cliNames)`: 与 CLI 同一套合并 (去重, 并剔除永不生效名)。
- `DEFAULT_EXCLUDE`: 内置排除名单。

### 路径判定件与展示辅助

- `POSIX_STYLE` / `WIN32_STYLE` / `nativeStyle()` 与一组纯判定函数 (`dedupeKey`、`hasNodeModulesLeaf`、`insideAnyRoot`、`isFilesystemRootBody`、`isHomeBody`、`firstSymlinkOnAnchor` 等): 安全闸的路径层, 供测试与自定义流程使用。
- `formatBytes(bytes)`: 清单同款人类可读体积 (`1.2 MB`, 整数值省小数尾)。
- `sanitizeLine(text)` / `sanitizeOutputLine(text)`: 输出净化的唯一实现 (剥控制字节、折叠空白; 多行变体保留行首缩进)。外部数据 (路径、名字) 进任何输出面前先过它们; CLI 就是这么做的, 也不要再写第二份。

## 错误与代码

一条规则决定通道: **能列出结果的失败走返回值; 无法开始或无法继续的失败才抛错。**

| 通道   | 装什么                                                               | 出现位置                                                              |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 返回值 | 域内可预期结果: 安全闸拒绝、删除失败、整批中止、体积测不到、策略跳过 | `rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped` |
| 抛错   | 无法开始或无法继续: 参数错误、配置损坏、取消                         | 同步入口同步抛; 异步入口 reject                                       |

库报出的错误一律是 `SweepError`: `{ name: 'SweepError', code, message, details? }`。打包或多实例环境 (同一进程里可能并存两份库) 里, 用不依赖类身份的 `isSweepError(value)` 判别, 别用 `instanceof`; 未预期的内部异常不作包装, 原样冒泡。

- `SweepErrorCode`: `CONFIG_READ_FAILED` / `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_ABSENT` / `INVALID_ARGUMENT` / `CANCELLED`。
- `details` 是按 `code` 取值的判别联合: `{ path, errno? }`、`{ path }`、`{ path, field }`、`{ path, source }`、`{ field }`、`{ phase, partial? }`。

域内 code 按家族列出 (每个 code 的完整触发表见 [可编程 API 面设计](../../docs/designs/api-surface.md)):

```text
安全闸 (validateTargets → rejected[].code)
  GUARD_LEAF_NOT_NODE_MODULES、GUARD_TARGET_MISSING、GUARD_TARGET_UNREADABLE、
  GUARD_REALPATH_FAILED、GUARD_ROOT_ANCHOR_SYMLINK、GUARD_FILESYSTEM_ROOT_BODY、
  GUARD_HOME_BODY、GUARD_REAL_LEAF_NOT_NODE_MODULES、GUARD_OUTSIDE_ROOTS、
  GUARD_DUPLICATE_TARGET

删除失败 (RemovalResult.failed[].code)
  REMOVE_FAILED、REMOVE_ENOENT_SURVIVOR、REVIEW_UNVERIFIED、REVIEW_COMPONENT_VANISHED

整批中止 (RemovalResult.aborted.code)
  REVIEW_NOT_UNDER_ANY_ROOT、REVIEW_HEAD_SYMLINK、REVIEW_COMPONENT_REPLACED

体积未测到 (SizeResult.unmeasured[].code)
  SIZE_UNMEASURED_PERMISSION、SIZE_UNMEASURED_NOT_DIR、SIZE_UNMEASURED_LOOP、
  SIZE_UNMEASURED_UNPARSEABLE、SIZE_UNMEASURED_CONTROL_CHAR、SIZE_UNMEASURED_OTHER

告警 (SweepWarning.code)
  SCAN_ROOT_MISSING、SCAN_ROOT_UNREADABLE、SCAN_ROOT_NOT_DIR、SCAN_ROOT_UNAVAILABLE、
  SCAN_DIR_UNREADABLE、SIZE_DU_OUTPUT_MISMATCH、SIZE_DU_LINE_UNATTRIBUTED、
  SIZE_SUBPATH_FAILED、SIZE_TARGET_VANISHED

跳过原因 (SweepEntry.skipReason / SkippedTarget.reason)
  suspect-install-tree、cross-device:on-path、cross-device:target-itself、unmeasured
```

几条要紧的纪律:

- **程序判断只许看 `code` 与 `details`, 严禁解析 `message`。** `message` 是给人读的中文人话; 要本地化就丢掉它, 用 `code` + `details` 自造文案。
- 三个 realpath 拒绝码刻意共用同一句 `message`: 它们靠 `code` 与 `details.errno` (`ENOENT` / `EACCES` / 其余) 区分, 因为处置方向相反: 「已不存在」可容忍, 「不可读」不可。
- code 一经发布即冻结: 只增不改, 取值不回收。`switch` 的 `default` 分支请记录 code 原文, 不要归入「其他」静默吞掉。

## 进度与取消

`onProgress` 与 `signal` 可传给 `plan` / `run`, 以及支持它们的任一原语 (`scan`、`measure`、`validateTargets`、`removeTargets`)。

事件种类: `phase` (逐阶段 start / done, 阶段取 `scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), 原语事件 (`hit` · `measured` · `unmeasured` · `skipped` · `removed` · `failed` · `aborted` · `warning`), 以及终结事件: `plan()` 的流恒以 `plan-done` (携带完整计划) 收尾, `run()` 的流恒以 `done` (携带运行状态) 收尾。终结事件之后不再有任何事件; 取消时流以抛错收场, 终结事件不出现。

- 回调同步调用, 库不 await 其返回值; 回调抛错原样冒泡, 中断本次调用 (不吞错)。
- 事件高频且**不承诺顺序** (并发完成序); 结果承诺有序 (hits 升序、分桶保输入顺序)。
- 不得在回调里再次调用同一个 `Sweeper` 实例, 也不要在一个实例上并发跑两次调用 (重入未定义); 工厂零 IO, 需要并发就建第二个实例。
- 取消检查落在条目之间与阶段边界; 取消以 `SweepError('CANCELLED')` 抛错。删除阶段绝不中断单条 `rm` 中途 (那只会新造半删状态): 取消落在条目之间, 错误里带 `details.partial` 给出已出桶的部分结果; 其余阶段只带 `details.phase`, 不返回部分结果。

库不提供 `watch()` 异步迭代入口: CLI 直接消费回调, 那是常态; 编辑器一类需要 `for await` 的宿主, 参考实现 (约 20 行) 写在设计文档里。

## 安全模型

> 本包的性格, 一句话: 看不准的时候, 默认不删。

- **导入不做事, `plan()` 也不删任何东西。** 删除只经显式的 `run()` / `removeTargets()` / `removeBatch()` 发生。
- **删什么, 由名字与归属双重判定。** 只认名字恰为 `node_modules` 的目录, 且必须落在声明的根之下; 归属按路径层级判定, 不是字符串前缀, `..` 上溯与冒名路径一概拒绝。文件系统根本体与 home 本体直接拒绝。
- **要真实路径, 否则整批拒绝。** 删除侧要求根及其祖先链无符号链接介入, 命中即整批拒绝并指出链接所在; 读取侧照常跟进符号链接根。门槛跟着可逆性走: 不可逆的那一步, 不放行。
- **一处被拒, 整批零删除**, 而不是逐条放行; 动手前自根至目标父目录逐级复核, 半路被掉包即整批停手。唯一窄例外是显式开启的 `staleTargets: 'missing'`, 且只容忍「目标已不存在」: 不放宽任何不变量, 也绝不会把目标加进删除面。
- **两类目标默认不进批**: 疑似安装树 (只由显式 `policy.releaseSuspects` 放行) 与跨设备目标 (policy 不放行, 解除走布局: 把挂载点声明为独立根, 或先卸载该卷)。体积测不到的目标一律不删: 宁可留着, 不猜。
- **外部数据进输出前先净化。** `sanitizeLine` / `sanitizeOutputLine` 是全输出面共用的唯一实现; 用它, 别抄一份。

## 数据形态与稳定性

- 域数据一律普通对象与数组: `JSON.stringify` 无损 (无类实例、无 `Map` / `Set`、无函数)。包内唯一的类是 `SweepError`。
- 与时间无关: 域数据不带时间戳 (唯一的时钟读数是进度事件里的 `elapsedMs`)。今天写进 JSONL 审计的形状, 明天读回来仍是决策输入。
- 结果确定: `hits` 按 target 升序、分桶保输入顺序、扫描按真实路径去重; 事件顺序明确不承诺。
- 导入零副作用; 零 stdout / stderr 写入; 不做 TTY 探测 (交互向导是 CLI 专属面)。

| 分级                   | 内容                                                                                | 承诺                       |
| ---------------------- | ----------------------------------------------------------------------------------- | -------------------------- |
| 冻结                   | 域类型字段名、`code` 取值、`SkipReason` 取值、函数签名、`EntryOutcome` 的 kind 取值 | 破坏性改动须走主版本       |
| 冻结但允许新增可选字段 | 选项对象 (`SweepOptions`、`SweepRunOptions`、`MeasureOptions` 等)                   | 加字段是 minor             |
| 允许演化               | `message` / `reason` / `note` 的中文措辞                                            | 不承诺逐字稳定             |
| 不承诺                 | 进度事件顺序、`warnings` 内部次序                                                   | 结果序有承诺, 事件序无承诺 |

## 开发

环境准备、常用命令、双运行时验证与提交钩子, 见 [开发指南](../../docs/development.md); 本包位于该仓库的 `packages/sweep-node-modules` 目录。

## 文档

- [工程技术文档总索引](../../docs/README.md)
- [可编程 API 面设计](../../docs/designs/api-surface.md): 本页背后的权威导出面、错误码与行为契约
- CLI 包: [@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)
- [安全防护保障](../../docs/safety-guardrails.md): 全量版 (含已知残余风险的诚实账)
