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

构造编排器: 整条链收在一个对象之后。第二个实例不花什么成本 (工厂不做扫描 / 删除级 IO)。

- `options` `SweepOptions`:
  - `roots` `string[]` (必填, 非空): 扫描根, 绝对路径。
  - `exclude?` `string[]`: 要跳过的目录名; 根到命中点之间任意一级命中即整棵子树跳过。缺省取 `DEFAULT_EXCLUDE` (与 CLI 同一份内置名单)。
  - `include?` `string[]`: 包含名单; 根到 `node_modules` 之间出现其一才纳入。缺省 `[]` (不过滤)。两个名单同时命中时 `exclude` 优先。
  - `home?` `string | null`: 家目录 (清单缩写与隐藏目录形态判定共用的同一份语义)。缺省 `os.homedir()`; `null` 关闭 home 本体防线与隐藏目录形态判定。
  - `style?` `PathStyle`: 路径风味; 缺省平台原生 (测试注入用)。
  - `policy?` `SweepPolicy`: `{ releaseSuspects: boolean }`。缺省 `{ releaseSuspects: false }`。
- Returns: `Sweeper`:
  - `options` `Readonly<ResolvedSweepOptions>`: 合并缺省后的只读选项快照, 供日志与审计。
  - `plan(options?)`: 只读面, 见下。
  - `run(options?)`: 执行面, 见下。

参数错误 (`roots` 为空或非字符串数组) 在**构造期同步抛出**: 无 IO 即失败, 尽早报错; 下文全部异步入口则一律以 rejected promise 抛出, 同一规则的另一半。

- 两份名单都过 CLI 同款的合并 (`mergeNames`): 去重, 且 `node_modules` / `.git` 被静默剔除 (这两个名字写进任何名单都永不生效)。
- `policy.releaseSuspects` 就是库侧的 `--force`: 放行「疑似安装树」进批, 只放行这一类, 不放宽任何不变量; 跨设备目标不受它影响。

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

### `sweeper.plan(options?): Promise<SweepPlan>`

只读面: 扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除。

- `options?` `SweepPlanOptions`:
  - `onProgress?` `(event: SweepProgressEvent) => void`: 进度回调; 阶段事件加上透传的各类原语事件。
  - `signal?` `AbortSignal`: 取消信号, 传给各层。
- Returns: `Promise<SweepPlan>`:
  - `roots` / `exclude` / `include` / `policy`: 本次生效的输入, 回显供审计 (名单已过 `mergeNames`)。
  - `basis?` `SizeBasis`: 本次运行的体积口径, 计划存在条目时即给出 (全未测到的一轮也会给出, 此时可能与逐条 `entry.basis` 不同值)。
  - `entries` `SweepEntry[]`: 每个测量时仍在的命中一条 (已消失的命中不产生条目, 见 `SizeResult` 的 `gone`): `target` / `project` / `root` / `bytes?` / `basis?` / `kind` / `kindReason?` / `crossDevice?` / `unmeasuredCode?` / `unmeasuredReason?` / `inBatch`, 未进批者另带 `skipReason` 与 `skipNote` (码与话随条目携带, 复核表不必按 target 去 join)。
  - `batch` `string[]`: 将进入删除的目标清单, 保清单顺序。
  - `skipped` `SkippedTarget[]`: 全部批次外目标, 各带 `reason` 与 `note`。
  - `warnings` `SweepWarning[]`: 扫描与体积的非致命告警 (`{ code, message, path?, errno? }`); `code` 为 `SweepWarningCode`, 即 `ScanWarningCode` 与 `SizeWarningCode` 的并集。
  - `nameMatches`: `{ exclude: NameMatch[]; include: NameMatch[] }`, 两份名单的逐名命中统计 (零命中的名字也在列, 拼错了当场可见)。

```ts
const plan = await sweeper.plan({ onProgress, signal });
```

### `sweeper.run(options?): Promise<SweepReport>`

先重跑一遍只读面 (绝不拿旧计划执行: 每个事实都以此刻的磁盘状态重判), 再送安全闸、执行删除。

- `options?` `SweepRunOptions` (继承 `SweepPlanOptions`, 因此 `onProgress` 与 `signal` 照旧可用):
  - `expectedBatch?` `readonly string[]`: 刚被批准的那份清单。给了它, 本次删除面 = 期望批次 ∩ 实时批次: 之后新冒出来的目标不删 (进 `drift.added`, 条目结果为 `{ kind: 'not-expected' }`), 已消失或被策略挡下的也不删 (进 `drift.removed`)。它收窄范围, 不跳过重判。
  - `staleTargets?` `'reject' | 'missing'` (缺省 `'reject'`): 安全闸之前「目标已不存在」怎么处置。`'missing'` 把这类目标从批次摘出、按「目标已达成」计成功侧, 不触发整批拒绝 (对应「别人已经删掉了」这类情形); 缺省维持保守规则: 一处被拒, 整批零删除。只有 `GUARD_TARGET_MISSING` 适用这条; 不可读与其余任何拒绝码仍维持整批拒绝。
- Returns: `Promise<SweepReport>`:
  - `status` `SweepRunStatus`: `'executed'` | `'rejected'` (整批拒绝) | `'nothing-to-do'` (空批)。
  - `plan` `SweepPlan`: 本次执行实际依据的实时计划; 与先前 `plan()` 不一致时以它为准, 差异另由 `drift` 给出。
  - `validation?` `ValidationResult`: 进入安全闸后即给出 (整批拒绝也有, 伴随零删除)。`removal?` `RemovalResult`: 删除分桶 (`removed` / `missing` / `failed` / `aborted`); 未执行删除时缺省。
  - `entries` `SweepOutcomeEntry[]`: 与 `plan.entries` 同序同长, 每条为条目加 `outcome`。
  - `stale` `string[]`: 按 `staleTargets: 'missing'` 摘出的已消失目标。
  - `drift?` `SweepDrift`: `{ added, removed }`, 提供了 `expectedBatch` 时给出。
  - `releasedBytes` `number`: 成功侧 (removed + missing + stale) 的体积累计。

`outcome` 是 `EntryOutcome` 判别联合。`kind` 取值: `removed` / `missing` / `stale` (成功侧: 删掉、核验已不存在、或压根没进删除面), `failed`, `rejected`, `not-attempted` (整批中止时中止点及其之后), `not-expected` (在期望批次之外), `skipped` (被策略挡下)。

```ts
const report = await sweeper.run({
  onProgress,
  signal,
  expectedBatch,
  staleTargets,
});
```

### `isSuccessOutcome(outcome): boolean`

- `outcome` `EntryOutcome`
- Returns: `boolean`: 成功侧 (`removed` / `missing` / `stale`) 为 `true`, 其余 (真失败与未处理项) 为 `false`。

别手写 `kind !== 'x' && kind !== 'y'`: 库里哪天新增一种成功侧 kind, 手写判据会静默漏判, 库函数则跟着版本走。

### `summarizeReport(report): SweepSummary`

- `report` `SweepReport`
- Returns: `SweepSummary`:
  - `counts` `Record<EntryOutcomeKind, number>`: 逐 kind 计数, 恒有项, 缺省 0。
  - `succeeded` `number`: `removed` + `missing` + `stale`。
  - `unprocessed` `number`: `skipped` + `rejected` + `not-attempted` + `not-expected`。
  - `failed` `number`: 真失败。
  - `aborted` `boolean`: 是否发生了整批中止 (存在 `removal.aborted`)。

### 成功口径与退出码

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

## 原语层

每个原语都可独立使用, 导入零副作用, 且都不打印任何东西; 异步入口失败一律 reject。做只读快照, 串 `scan` → `measure` → `classifyTarget` 即可, 这条路径上不存在任何删除动作。

### 扫描

#### `createScanner(): Scanner`

- Returns: `Scanner`:
  - `name` `string`: 候选中立名 (`'parallel'`), 供基准与日志区分实现。
  - `scan(options)`: 见下。

#### `scanner.scan(options): Promise<ScanResult>`

- `options` `ScanOptions`:
  - `roots` `string[]` (必填): 扫描根 (调用方保证为绝对路径)。
  - `exclude` `string[]` (此处必填: 不过滤就传 `[]`): 目录名; 从根到命中点的任意一级命中即整棵子树跳过。
  - `include` `string[]` (此处必填): 包含名单; 空数组 = 不过滤; 两个名单同时命中时 `exclude` 优先。
  - `signal?` `AbortSignal`: 在每个遍历任务开始前检查; 中断后以 `SweepError('CANCELLED')` reject。
  - `onProgress?` `(event: ScanProgressEvent) => void`: 每命中一处发一条 `hit` 事件。
- Returns: `Promise<ScanResult>`:
  - `hits` `ScanHit[]`: `{ project, target, root }[]`, 按 `target` 升序、按真实路径去重。`root` 取输入顺序中首个遍历到该命中的根, 按根分组因此确定可复现。
  - `warnings` `SweepWarning[]`: 非致命扫描告警 (`code` 为 `ScanWarningCode`); 某个根不存在或不可读不中断遍历。
  - `excludeMatches` / `includeMatches` `NameMatch[]`: `{ name, hits }[]`, 恒在 (未命中的名字以 `hits: 0` 在列, 拼错了当场可见)。

```ts
const scan = await createScanner().scan({
  roots,
  exclude: [...DEFAULT_EXCLUDE], // 原语层为必填: 不过滤就传 []
  include: [],
  signal,
  onProgress: (event) => ..., // 每命中一处一条 'hit' 事件
});
```

### 体积

#### `createSizer(): Sizer`

- Returns: `Sizer`:
  - `name` `string`: 候选中立名 (`'du'` 为 `du` 快路径, `'js'` 为纯实现), 供基准与日志区分实现。
  - `basis` `SizeBasis`: 本实例的体积口径, 调用前即可读。
  - `measure(targets, options?)`: 见下。

#### `sizer.measure(targets, options?): Promise<SizeResult>`

- `targets` `string[]`: 要测的路径 (通常是 `scan.hits.map((hit) => hit.target)`)。
- `options?` `MeasureOptions`:
  - `signal?` `AbortSignal`: 逐目标之间检查 (`du` 批量路径在批量调用前后各一次)。
  - `onProgress?` `(event: MeasureProgressEvent) => void`: 每目标一条 (`measured` / `unmeasured` / `gone`)。
- Returns: `Promise<SizeResult>`:
  - `entries` `SizeEntry[]`: 测到的目标 (`{ target, bytes }`), 按 `target` 升序。
  - `basis` `SizeBasis`: `'disk-usage'` (`du` 快路径, 报磁盘占用) 或 `'logical-bytes'` (纯实现, 报逻辑字节); 一次调用恒一口径, 调用前后都可读, 不要猜它。win32 恒为 `logical-bytes`。
  - `warnings` `SweepWarning[]`: 非致命体积告警 (`code` 为 `SizeWarningCode`)。
  - `unmeasured` `UnmeasuredEntry[]`: 存在但测不到的目标 (`{ target, code, reason }`, `code` 为 `UnmeasuredCode`), 按 `target` 升序。
  - `gone` `string[]`: 测量时已不存在, 按 target 升序 (三桶同此口径)。

入参每个目标恒落在且仅落在一个桶, 无第四类: `entries` (测到了)、`unmeasured` (存在但测不到)、`gone` (测量时已不存在)。这条完备性恒等式是契约, 不必再造 `'unknown'` 兜底分支。

```ts
const size = await createSizer().measure(targets, { signal, onProgress });
```

### 类别

#### `classifyTarget(target, options?): Classification`

- `target` `string`: 一个 `node_modules` 路径。
- `options?` `ClassifyOptions`:
  - `style?` `PathStyle`: 路径风味; 缺省平台原生。
  - `home?` `string | null`: 家目录, 供下述隐藏目录形态使用。缺省 `os.homedir()`; `null` 关闭该形态。
- Returns: `Classification`:
  - `kind` `TargetKind`: `'project'` | `'suspect-install-tree'`。
  - `reason?` `string`: 判定为疑似安装树时的中文理由。

纯路径判定, 零 IO, 语义与 CLI 的清单标记同源。三种疑似形态按序判定: 祖先链上任一段命中内置名单 (另加 `extensions` 与 `_npx`); 父目录名为 `lib` (版本管理器把全局包放在 `<版本目录>/lib/node_modules`); `node_modules` 落在**家目录下的隐藏目录**里。比较一律折叠大小写: 多出来的误判同样落在安全侧。

```ts
const { kind, reason } = classifyTarget(target, options?);
// kind: 'project' | 'suspect-install-tree'
```

### 安全闸

#### `validateTargets(targets, options): Promise<ValidationResult>`

- `targets` `string[]`: 候选目标。
- `options` `ValidateOptions`:
  - `roots` `string[]` (必填): 扫描根, 须保留配置里的原始拼写; 锚点判定读的是拼写, 不是真实路径。
  - `home?` `string | null`: home 本体防线; 缺省 `os.homedir()`, `null` 关闭。
  - `style?` `PathStyle`: 路径风味; 缺省平台原生。
  - `signal?` `AbortSignal`: 逐目标之间检查。
- Returns: `Promise<ValidationResult>`:
  - `accepted` `string[]`: 可删目标: 已 realpath 归一、已去重、保输入顺序。
  - `rejected` `RejectedTarget[]`: 每条被拒目标的 `{ target, code, message, details? }`, 与输入逐条对应; `code` 为 `GuardCode`, `details?` 为 `RejectionDetails` (`{ errno?, root?, symlink? }`)。
  - `mappings` `PathMapping[]`: `{ original, real }` 配对, 与 `accepted` 逐位对应; 显示用 `original`, 删除用 `real`, 不必再靠位次手工对齐。

各不变量逐条判定、命中即短路: 末段必须恰为 `node_modules`; 目标须存在且可读 (realpath); 配置拼写的根链上有符号链接介入时, 其下目标整类被拒; 文件系统根本体与 home 本体直接拒绝; 真实路径仍须以 `node_modules` 结尾、落在某个声明的根之下, 且按真实路径去重。拒绝**走返回值而非抛错**: 整份清单恒被处理完, 每条拒绝都带 `code` 供分流。

### 设备边界

#### `findCrossDeviceTargets(targets, options): Promise<CrossDeviceEntry[]>`

- `targets` `string[]`
- `options` `CrossDeviceOptions`:
  - `roots` `string[]` (必填): 目标的所属根取包含它且路径最长的那个根。
  - `style?` `PathStyle`: 路径风味; 缺省平台原生。
  - `probe?` `DeviceProbe`: 设备号探针; 缺省 `fsDeviceProbe` (注入它可在单一文件系统上测跨设备流程)。
- Returns: `Promise<CrossDeviceEntry[]>`: `{ target, kind }` 条目, 保输入顺序; 无跨设备目标时为空数组。

`kind: CrossDeviceKind` 取 `'on-path' | 'target-itself'`: 要么挂载点位于根与目标之间, 要么目标本体即挂载点。两形态的解除路径不同 (把挂载点声明为独立根, 或先卸载该卷), 故分列呈现, 且都不由 policy 放行。结果返回数组而非 `Map`, 是为了让它能穿过 `JSON.stringify` 进审计而不丢列。

#### `crossDeviceIndex(entries): ReadonlyMap<string, CrossDeviceKind>`

- `entries` `readonly CrossDeviceEntry[]`
- Returns: `ReadonlyMap<string, CrossDeviceKind>`: 查询视图 (跳过集册家族第二参要的 `has` / `get` 形态)。

```ts
const crossDevice = await findCrossDeviceTargets(targets, { roots });
const index = crossDeviceIndex(crossDevice); // 需要 has / get 时用这个视图
```

#### `fsDeviceProbe(path, follow): Promise<number | null>`

- `path` `string`
- `follow` `boolean`: `true` 取 `stat` 语义 (解析末段符号链接), `false` 取 `lstat` 语义 (不解析)。
- Returns: `Promise<number | null>`: 该路径的 `st_dev`; 读不到 (路径已消失或不可读) 时为 `null`。

`DeviceProbe` 的缺省实现 (`(path: string, follow: boolean) => Promise<number | null>`)。两种语义并存, 因为两处调用方要的读法相反: 根按 `follow: true` 读 (其解析出的实际目录才是参照面), 目标按 `follow: false` 读 (与 `fs.rm` 对齐: 删的是链接, 不跟进)。

### 路径风味与锚点判定

安全闸的路径层, 暴露给测试与自定义流程。每个判定函数都把 `PathStyle` 显式传参, 且不做任何 IO。

#### `POSIX_STYLE` / `WIN32_STYLE`

- `PathStyle` 常量, 可直接注入: `WIN32_STYLE` 在每次比较前折叠大小写; `POSIX_STYLE` 不折叠。
- `PathStyle`: `{ name: 'posix' | 'win32', ops: PathOps, caseInsensitive: boolean }`, 其中 `PathOps` 是最小路径能力集 (`sep` / `basename` / `relative` / `isAbsolute` / `parse` / `join` / `resolve` / `dirname`), `node:path` 的两种风味都满足。

#### `nativeStyle(): PathStyle`

- Returns: `PathStyle`: 当前平台的风味; 凡省略 `style` 选项处, 它就是缺省。

#### `dedupeKey(realPath, style): string`

- `realPath` `string`, `style` `PathStyle`
- Returns: `string`: 真实路径的去重键 (win32 上先折叠大小写)。

#### `hasNodeModulesLeaf(target, style): boolean`

- `target` `string`, `style` `PathStyle`
- Returns: `boolean`: 末段是否恰为 `node_modules` (win32 上大小写不敏感)。

#### `insideAnyRoot(realPath, roots, style): boolean`

- `realPath` `string`, `roots` `string[]`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否严格位于某个根之下, 按 `path.relative` 语义判定而非字符串前缀。等于根本体、上溯逃逸 (`..`)、或结果为绝对路径 (win32 跨盘), 一律算在外。

#### `isFilesystemRootBody(realPath, style): boolean`

- `realPath` `string`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否即文件系统根本体 (posix 的 `/`, win32 的盘根)。

#### `isHomeBody(realPath, home, style): boolean`

- `realPath` `string`, `home` `string | null`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否即 home 本体; `home: null` 关闭该判定。

#### `firstSymlinkOnAnchor(links): string | null`

- `links` `AnchorLink[]`: 链上逐级一条 `{ path, symlink }`, `symlink` 由 `lstat` 判得 (指向哪里都算, 悬空也算: 链上有链接这一事实本身就是证据)。
- Returns: `string | null`: 首个符号链接那一级的路径; 全级皆真目录时为 `null`。

锚点判在配置拼写上, 不判在 realpath 上: realpath 永远只报此刻的解析结果, 名字被换成链接这件事在它那里不留痕, 而拼写上看得见。系统固有链接 (macOS 的 `/var`、`/tmp`) 同样命中, 这是刻意的: 在拼写层, 用户环境与攻击无法区分, 一律拒绝; 解法是改写成真实路径。

#### `anchorChainPaths(root, style): string[]`

- `root` `string`: 一个扫描根或任意写入目标; 端点自身入链, 文件系统根本身不入 (它不可能是符号链接)。
- Returns: `string[]`: 自文件系统根的一级子目录逐级前缀, 直至端点。相对拼写先按给定风格绝对化 (与 `lstat` 读取同一坐标系)。

```ts
anchorChainPaths('/Users/x/ws/app', POSIX_STYLE);
// ['/Users', '/Users/x', '/Users/x/ws', '/Users/x/ws/app']
```

#### `firstSymlinkOnTarget(target): Promise<string | null>`

- `target` `string`
- Returns: `Promise<string | null>`: 链上首个符号链接的路径; 全链为真目录或各级均不可核验时为 `null`。

采集 (逐级 `lstat` 走链) 与检出一步到位。写侧在写之前用它: 写入会跟随链接改写其目标, 故与删除侧读同一条链, 实现只此一份。

#### `firstSymlinkOnRoot(root): Promise<string | null>`

- `root` `string`
- Returns: `Promise<string | null>`: 与 `firstSymlinkOnTarget` 同一实现, 单独留名, 因为该调用点把它读作扫描根的信任锚。

### 删除

#### `removeTargets(targets, options): Promise<RemovalResult>`

- `targets` `string[]`: 过安全闸的目标 (realpath 形态)。
- `options` `RemovalOptions`:
  - `roots` `TrustRoot[]` (必填): 拥有这些目标的信任根; 目标不在任何根之下即整批中止。
  - `signal?` `AbortSignal`: 条目之间检查 (单条 `rm` 中途的硬纪律见 [进度与取消](#进度与取消))。
  - `onProgress?` `(event: RemovalProgressEvent) => void`: 每条目标出桶即发一条 (`removed` / `missing` / `failed` / `aborted`)。
- Returns: `Promise<RemovalResult>`:
  - `removed` `string[]`: 已删除, 保输入顺序。
  - `missing` `string[]`: `rm` 报 ENOENT 且复核确认目标本体已不存在 (计成功侧, 保输入顺序)。
  - `failed` `TargetFailure[]`: `{ target, code, errno?, message, partialRisk }`, `code` 为 `RemoveFailureCode`; `partialRisk: true` 表示内容可能已被部分删除, 提示人工复查 (`partialRisk: false` 的失败从未尝试删除)。
  - `aborted?` `AbortedBatch`: 复核未通过致整批中止 (`{ target, code, message, path? }`, `code` 为 `AbortCode`); 中止点及其之后一条未动。

每条目标删除前, 自根向下至其父目录逐级复核; 半路检出替换即整批停手。

```ts
const removal = await removeTargets(accepted, {
  roots: await toTrustRoots(roots),
  signal,
  onProgress,
});
```

#### `toTrustRoots(roots): Promise<TrustRoot[]>`

- `roots` `string[]`: 配置里的原始拼写。
- Returns: `Promise<TrustRoot[]>`: `{ configured, real }` 配对, 每根一对; realpath 失败时 `real` 回落为拼写。

给每个配置根配上它的真实路径。这对配对是锚点防线的一半, 不要手写。

#### `removeBatch(targets, options): Promise<BatchOutcome>`

推荐的写侧入口: 安全闸 + 整批拒绝规则 + 配对 + 删除一次吃掉, 调用方不必知道 `TrustRoot` 的存在。

- `targets` `string[]`
- `options` `RemoveBatchOptions`:
  - `roots` `string[]` (必填): 扫描根, 保留配置里的原始拼写; 安全闸据它判归属与锚点, 配对助手供给删除侧。
  - `home?` / `style?` / `signal?` / `onProgress?`: 同 `validateTargets` 与 `removeTargets`。
  - `staleTargets?` `'reject' | 'missing'`: 与 `sweeper.run` 同款的窄容忍。
- Returns: `Promise<BatchOutcome>`: `{ status: 'rejected', rejected }` (零删除) 或 `{ status: 'executed', accepted, mappings, stale, removal }`。

```ts
const outcome = await removeBatch(targets, { roots, staleTargets });
```

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

#### `toSkipCandidates(hits, size, options?): SkipCandidate[]`

- `hits` `readonly ScanHit[]`: 扫描命中。
- `size` `SizeResult`: 这些命中的体积结果。
- `options?` `ClassifyOptions`: 透传给类别判定。
- Returns: `SkipCandidate[]`: `{ target, bytes?, unmeasuredReason?, suspect }`, 按命中顺序 (`size.gone` 里的目标同样产出, `bytes` 为 undefined)。

#### `skipsBatch(entry, crossDevice, policy): boolean`

- `entry` `SkipCandidate`; `crossDevice` `ReadonlyMap<string, CrossDeviceKind>` (用 `crossDeviceIndex` 构造); `policy` `SweepPolicy`。
- Returns: `boolean`: 该条目是否被挡在删除批之外。

#### `skipReasonOf(entry, crossDevice, policy): SkipReason | null`

- 参数同 `skipsBatch`。
- Returns: `SkipReason | null`, `null` 即进批。判定顺序即优先级: 跨设备 (两种形态, 不受 policy 影响) → 体积未测到 → 疑似安装树 (仅 `policy.releaseSuspects` 放行)。

#### `deletionBatch(entries, crossDevice, policy): string[]`

- 参数同 `skipsBatch`。
- Returns: `string[]`: 进批的目标清单, 保清单顺序。

#### `collectSkips(entries, crossDevice, policy): SkipBook`

- 参数同 `skipsBatch`。
- Returns: `SkipBook`:
  - `entries` `ReadonlyArray<SkippedTarget>`: `{ target, reason, note }`, 码与人话一次给全 (与 `plan.skipped` 同源同值)。
  - `trailer` `string[]`: 末行说明行, 按类各一行, 只在出现时出。
  - `hints` `ReadonlyMap<string, string>`: 目标 → 行尾说明, 只收测得体积的条目。

`SkipCandidate.suspect` 定为必填是刻意的: 它承载「这条会不会被语义闸挡下」的全部信息, 留成可选的话, 一个裸体积条目就能滑进写侧、安全语义静默消失; 不想手填就走 `toSkipCandidates`。

#### `crossDeviceNote(kind): string`

- `kind` `CrossDeviceKind`
- Returns: `string`: 跨设备形态的人话标签。

### 配置装载 (可选原语)

库不自动读平台配置文件; 这组装载件是给「想在自己的工具里接同一套配置行为」的调用方准备的:

#### `resolveConfigPath(options): ResolvedConfigPath`

- `options` `ResolveConfigPathOptions`:
  - `flag?` `string`: `--config` 旗标值, 优先级最高。
  - `platform?` `string`: 平台标识; 缺省 `process.platform` (测试注入 `'win32'`)。
  - `homedir?` `string`: 缺省 `os.homedir()`。
  - `env?` `EnvTable`: 环境变量表; 缺省 `process.env` (它承载 `SWEEP_NM_CONFIG`, win32 上还有 `APPDATA` / `USERPROFILE`)。
- Returns: `ResolvedConfigPath`: `{ path, source }`, `source: ConfigSource` 取 `'flag' | 'env' | 'platform-default'`。

优先级: `--config` 旗标 > `SWEEP_NM_CONFIG` 环境变量 > 平台默认。平台默认是 `~/.config/sweep-node-modules/config.json`; win32 上是 `%APPDATA%\sweep-node-modules\config.json`, `APPDATA` 未设时回落到 `USERPROFILE\AppData\Roaming`。

#### `loadConfig(path): Promise<LoadConfigResult>`

- `path` `string`
- Returns: `Promise<LoadConfigResult>`: `{ state: 'ok', config }` 或 `{ state: 'absent' }`。文件缺失是正常状态 (向导据此分流); 文件损坏或读取失败抛 `SweepError` (`CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_READ_FAILED`)。

`ok` 分支里, `Config` 携带 `roots` (必填) / `exclude` / `include`: 省略 `exclude` 字段取 `DEFAULT_EXCLUDE`, 省略 `include` 取 `[]`; 而显式写出的空数组意味着由调用方接管该名单。

#### `loadResolvedConfig(resolved): Promise<LoadConfigResult>`

- `resolved` `ResolvedConfigPath`
- Returns: 与 `loadConfig` 同形。
- 来源为显式时更严: `--config` 旗标或 `SWEEP_NM_CONFIG` 指向的文件不存在即抛错 (`SweepError('CONFIG_ABSENT')`), 不让打错的路径静默降级成「没有配置」。平台默认来源保留软行为。

#### `mergeNames(configNames, cliNames): string[]`

- `configNames` `string[]`, `cliNames` `string[]`
- Returns: `string[]`: 配置名单在前、CLI 名单殿后, 跨来源去重 (首见者胜), 并静默剔除 `node_modules` 与 `.git` (这两个名字写进名单永不生效)。

#### `DEFAULT_EXCLUDE`

- `readonly string[]`: 内置排除名单: 包管理器与版本管理器的安装树、编辑器扩展目录、系统 / 应用数据根。

### 展示辅助

#### `formatBytes(bytes): string`

- `bytes` `number`
- Returns: `string`: 清单同款人类可读体积, 逐级 1024 走 `B` / `KB` / `MB` / `GB` / `TB`; 保留 1 位小数, 整数值省小数尾。

#### `sanitizeLine(text): string`

- `text` `string`
- Returns: `string`: 剥控制类字符 (C0 含 ESC 与 DEL、C1、bidi 控制、零宽与 BOM), 剩余空白 (含换行) 折成单空格, 两端去空白。

#### `sanitizeOutputLine(text): string`

- `text` `string`
- Returns: `string`: 即 `sanitizeLine`, 差别只有一处: 保留每行的行首缩进 (工具自带的分级手段); 行内其余空白照常折叠。

`sanitizeLine` / `sanitizeOutputLine` 是全输出面共用的唯一实现。外部数据 (路径、名字) 进任何输出面前先过它们; CLI 就是这么做的, 也不要再写第二份。

## 错误与代码

一条规则决定通道: **能列出结果的失败走返回值; 无法开始或无法继续的失败才抛错。**

| 通道   | 装什么                                                               | 出现位置                                                              |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 返回值 | 域内可预期结果: 安全闸拒绝、删除失败、整批中止、体积测不到、策略跳过 | `rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped` |
| 抛错   | 无法开始或无法继续: 参数错误、配置损坏、取消                         | 同步入口同步抛; 异步入口 reject                                       |

### `SweepError`

- `class SweepError extends Error`: `{ name: 'SweepError', code, message, details? }`。
  - `code` `SweepErrorCode`: `CONFIG_READ_FAILED` / `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_ABSENT` / `INVALID_ARGUMENT` / `CANCELLED`。
  - `message` `string`: 可读文本 (规矩见下)。
  - `details?` `SweepErrorDetails`: 按 `code` 取值的判别联合: `{ path, errno? }`、`{ path }`、`{ path, field }`、`{ path, source }`、`{ field }`、`{ phase, partial? }`。
- 构造: `new SweepError(code, message, details?)`。
- 包内唯一的类: 其余实例一律来自 `createXxx()` 工厂, 域数据则一律是普通对象。

### `isSweepError(value): value is SweepError`

- `value` `unknown`
- Returns: `value is SweepError`: 按形状判别 (Error 形状 + `name` + 已知 `code`), 不是类判别。

打包或多实例环境 (同一进程里可能并存两份库) 里, `instanceof SweepError` 会给出假阴; 跨实例场景一律用它。未预期的内部异常不作包装, 原样冒泡。

### code 家族

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
  SIZE_SUBPATH_FAILED、SIZE_TARGET_VANISHED、SIZE_DU_UNAVAILABLE

跳过原因 (SweepEntry.skipReason / SkippedTarget.reason)
  suspect-install-tree、cross-device:on-path、cross-device:target-itself、unmeasured
```

几条要紧的纪律:

- **程序判断只许看 `code` 与 `details`, 严禁解析 `message`。** `message` 是给人读的中文人话; 要本地化就丢掉它, 用 `code` + `details` 自造文案。
- 三个 realpath 拒绝码刻意共用同一句 `message`: 它们靠 `code` 与 `details.errno` (`ENOENT` / `EACCES` / 其余) 区分, 因为处置方向相反: 「已不存在」可容忍, 「不可读」不可。
- code 一经发布即冻结: 只增不改, 取值不回收。`switch` 的 `default` 分支请记录 code 原文, 不要归入「其他」静默吞掉。

## 进度与取消

`onProgress` 与 `signal` 可传给 `plan` / `run`, 以及支持它们的任一原语 (`scan`、`measure`、`validateTargets`、`removeTargets`、`removeBatch`)。

事件种类: `phase` (逐阶段 start / done, 阶段取 `SweepPhase` 全集: `scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), 原语事件 (`hit` · `measured` · `unmeasured` · `skipped` · `removed` · `failed` · `aborted` · `warning`), 以及终结事件: `plan()` 的流恒以 `plan-done` (携带完整计划) 收尾, `run()` 的流恒以 `done` (携带运行状态) 收尾。终结事件之后不再有任何事件; 取消时流以抛错收场, 终结事件不出现。

- 回调同步调用, 库不 await 其返回值; 回调抛错原样冒泡, 中断本次调用 (不吞错)。
- 事件高频且**不承诺顺序** (并发完成序); 结果承诺有序 (hits 与体积三桶按 target 升序; 删除分桶与 `stale` 保输入顺序)。
- 不得在回调里再次调用同一个 `Sweeper` 实例, 也不要在一个实例上并发跑两次调用 (重入未定义); 工厂不做扫描 / 删除级 IO (体积工厂只探测一次 `du`), 需要并发就建第二个实例。
- 取消检查落在条目之间与阶段边界; 取消以 `SweepError('CANCELLED')` 抛错。删除阶段绝不中断单条 `rm` 中途 (那只会新造半删状态): 取消落在条目之间, 错误里带 `details.partial` 给出已出桶的部分结果; 其余阶段只带 `details.phase`, 不返回部分结果。

库不提供 `watch()` 异步迭代入口: CLI 直接消费回调, 那是常态; 编辑器一类需要 `for await` 的宿主, 参考实现 (约 20 行) 写在设计文档里。

## 安全模型

> 本包的性格, 一句话: 看不准的时候, 默认不删。

- **导入不做事, `plan()` 也不删任何东西。** 删除只经显式的 `run()` / `removeTargets()` / `removeBatch()` 发生。
- **删什么, 由名字与归属双重判定。** 只认名字恰为 `node_modules` 的目录, 且必须落在声明的根之下; 归属按路径层级判定, 不是字符串前缀, `..` 上溯与冒名路径一概拒绝。文件系统根本体与 home 本体直接拒绝。
- **要真实路径, 否则整批拒绝。** 删除侧要求根及其祖先链无符号链接介入, 命中即整批拒绝并指出链接所在; 读取侧照常跟进符号链接根。门槛跟着可逆性走: 不可逆的那一步, 不放行。
- **一处被拒, 整批零删除**, 而不是逐条放行; 动手前自根至目标父目录逐级复核, 半路被掉包即停止后续条目的删除。唯一窄例外是显式开启的 `staleTargets: 'missing'`, 且只容忍「目标已不存在」: 不放宽任何不变量, 也绝不会把目标加进删除面。
- **两类目标默认不进批**: 疑似安装树 (只由显式 `policy.releaseSuspects` 放行) 与跨设备目标 (policy 不放行, 解除走布局: 把挂载点声明为独立根, 或先卸载该卷)。体积测不到的目标一律不删: 宁可留着, 不猜。
- **外部数据进输出前先净化。** `sanitizeLine` / `sanitizeOutputLine` 是全输出面共用的唯一实现; 用它, 别抄一份。

## 数据形态与稳定性

- **落盘 / 审计域**数据一律普通对象与数组: `JSON.stringify` 无损 (无类实例、无 `Map` / `Set`、无函数)。查询辅助 (`SkipBook.hints`、`crossDeviceIndex()`) 返回 `ReadonlyMap`, 属查询面、不属落盘域。包内唯一的类是 `SweepError`。
- 与时间无关: 域数据不带时间戳 (唯一的时钟读数是进度事件里的 `elapsedMs`)。今天写进 JSONL 审计的形状, 明天读回来仍是决策输入。
- 结果确定: `hits` 与体积三桶按 target 升序, 删除分桶与 `stale` 保输入顺序, 扫描按真实路径去重; 事件顺序明确不承诺。
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
- [安全防护保障](../../docs/safety-guardrails.md): 全量版 (含已知残余风险的诚实账)
