# sweep-node-modules

[![CI](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)](https://github.com/iyowei/clis/actions/workflows/ci.yml)
[![npm version](https://img.shields.io/npm/v/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
[![npm downloads](https://img.shields.io/npm/dm/@iyowei/sweep-node-modules)](https://www.npmjs.com/package/@iyowei/sweep-node-modules)
![node](https://img.shields.io/node/v/@iyowei/sweep-node-modules)
![bun](https://img.shields.io/badge/dynamic/json?url=https%3A%2F%2Fraw.githubusercontent.com%2Fiyowei%2Fsweep-node-modules%2Fmain%2Fpackage.json&query=%24.packageManager&label=bun)

[English](README.md) | **中文**

工作区级 `node_modules` 清理的可编程 API: 扫描、测体积、安全删除, 都能在你自己的脚本和工具里直接调用。CLI 包只是套在这套 API 外面的一层薄壳。

> **包定位变更说明**: 0.4.0 及以前, `@iyowei/sweep-node-modules` 是命令行工具; 从 0.5.0 起, 这个名字对应的是可编程 API 包 (纯库, 没有 `bin`), CLI 迁到了独立包 **[@iyowei/sweep-node-modules-cli](https://www.npmjs.com/package/@iyowei/sweep-node-modules-cli)**。要找 `sweep-nm` 命令的, 请安装那个包; 命令名、旗标和配置文件都照旧。机器上装着旧名 CLI 的, 升级它只会得到这个库, 不会再有命令: 请先卸载旧的全局安装, 再安装 `-cli` 包。迁移细节见 release notes。

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
- 零第三方运行时依赖: 只用运行时内置能力 (见 [ADR 0003](docs/adrs/0003-zero-runtime-deps.md))。
- 平台: Windows / macOS / Linux 都能运行 (见 [ADR 0007](docs/adrs/0007-platform-portability.md))。
- 源码是 TypeScript; 类型声明随包一起分发。

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

- `roots` 用绝对路径; 要删除时, 还要求根是**真实路径**: 根和它往上的每一级目录, 都不能是符号链接。macOS 的 `tmpdir()` 会经过 `/var` (系统链接), 拿它当根之前先转成真实路径: `const root = await realpath(await mkdtemp(...))`。只做读取不受这条限制。
- 编排层不读平台配置文件, 交互向导也留在 CLI 包; 下文那套配置加载是可选的, 给「想在自己的工具里用上同一套配置行为」的调用方准备。
- 本包不向 stdout / stderr 写任何东西: 一切给人看的文字都以字符串形式返回, 往哪输出由你决定。

## 两级导出面

| 层                                                                                  | 是什么                                                              | 什么时候用                                   |
| ----------------------------------------------------------------------------------- | ------------------------------------------------------------------- | -------------------------------------------- |
| 编排层: `createSweeper(...).plan()` / `.run()`                                      | 整条链: 扫描 → 体积 → 类别 → 设备 → 批次构造 → 安全闸 → 删除 → 报告 | 默认选它。你只管声明扫什么, 并决定报告怎么用 |
| 原语层: `createScanner` / `createSizer` / `validateTargets` / `removeTargets` / ... | 单点能力, 每个都可独立使用                                          | 需要逐步控制, 或只取链上某一环嵌进自己的流程 |

CLI 包是编排层的薄壳: 解析 → 调用 → 渲染 → 确认。整套业务逻辑只有本包这一份实现, CLI 只是调用方, 不是第二份拷贝。

## 编排层

### `createSweeper(options): Sweeper`

构造编排器: 整条链收在一个对象里。再建一个实例不花什么成本 (工厂不做扫描、删除这类 IO)。

- `options` `SweepOptions`:
  - `roots` `string[]` (必填, 非空): 扫描根, 绝对路径。
  - `exclude?` `string[]`: 要跳过的目录名; 从根到命中点之间, 任意一级命中, 整棵子树跳过。默认取 `DEFAULT_EXCLUDE` (和 CLI 同一份内置名单)。
  - `include?` `string[]`: 包含名单; 从根到 `node_modules` 之间出现了其中任意一个, 才纳入。默认 `[]` (不过滤)。两个名单同时命中时 `exclude` 优先。
  - `home?` `string | null`: 家目录 (清单缩写与隐藏目录形态判定共用同一份语义)。默认 `os.homedir()`; 传 `null` 会关掉「home 目录本身不能删」的保护和隐藏目录形态判定。
  - `style?` `PathStyle`: 路径风味; 默认平台原生 (测试时注入用)。
  - `policy?` `SweepPolicy`: `{ releaseSuspects: boolean }`。默认 `{ releaseSuspects: false }`。
- Returns: `Sweeper`:
  - `options` `Readonly<ResolvedSweepOptions>`: 合并默认值后的只读选项快照, 供日志和审计。
  - `plan(options?)`: 只读, 见下。
  - `run(options?)`: 执行删除, 见下。

参数错误 (`roots` 为空或不是字符串数组) 在**构造期就同步抛出**: 还没做任何 IO 就先失败, 尽早报错; 下文所有异步入口则一律以 rejected promise 抛出, 这是同一条规则的另一半。

- 两份名单都会走一遍和 CLI 一样的合并 (`mergeNames`): 去重, 并且 `node_modules` / `.git` 会被静默剔除 (这两个名字写进任何名单都永不生效)。
- `policy.releaseSuspects` 相当于库里的 `--force`: 放行「疑似安装树」进批, 只放行这一类, 不放宽任何一条安全规则; 跨设备目标不受它影响。

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

只读这一遍: 扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除。

- `options?` `SweepPlanOptions`:
  - `onProgress?` `(event: SweepProgressEvent) => void`: 进度回调; 阶段事件, 加上透传的各类原语事件。
  - `signal?` `AbortSignal`: 取消信号, 传给各层。
- Returns: `Promise<SweepPlan>`:
  - `roots` / `exclude` / `include` / `policy`: 本次生效的输入, 原样回显供审计 (名单已经过 `mergeNames` 合并)。
  - `basis?` `SizeBasis`: 本次运行的体积口径, 计划里只要有条目就会给出 (一条都没测到的那一轮也会给出, 这种时候它可能和逐条 `entry.basis` 的取值不同)。
  - `entries` `SweepEntry[]`: 测量时仍在的每个命中产生一条 (已经消失的命中不产生条目, 见 `SizeResult` 的 `gone`): `target` / `project` / `root` / `bytes?` / `basis?` / `kind` / `kindReason?` / `crossDevice?` / `unmeasuredCode?` / `unmeasuredReason?` / `inBatch`, 未进批的另带 `skipReason` 和 `skipNote` (原因码和说明都带在条目上, 复核时不用再按 target 去 join)。
  - `batch` `string[]`: 即将进入删除的目标清单, 保持清单顺序。
  - `skipped` `SkippedTarget[]`: 所有没进批的目标, 各带 `reason` 和 `note`。
  - `warnings` `SweepWarning[]`: 扫描与体积的非致命告警 (`{ code, message, path?, errno? }`); `code` 为 `SweepWarningCode`, 即 `ScanWarningCode` 与 `SizeWarningCode` 的并集。
  - `nameMatches`: `{ exclude: NameMatch[]; include: NameMatch[] }`, 两份名单逐个名字的命中统计 (零命中的名字也在列, 拼错了当场可见)。

```ts
const plan = await sweeper.plan({ onProgress, signal });
```

### `sweeper.run(options?): Promise<SweepReport>`

先把只读的部分重跑一遍 (绝不拿旧计划执行: 每个事实都按此刻的磁盘状态重新判定), 再过安全闸、执行删除。

- `options?` `SweepRunOptions` (继承 `SweepPlanOptions`, 因此 `onProgress` 和 `signal` 照旧可用):
  - `expectedBatch?` `readonly string[]`: 刚被批准的那份清单。给了它, 本次要删的范围 = 期望批次 ∩ 实时批次: 之后新冒出来的目标不删 (进 `drift.added`, 条目结果为 `{ kind: 'not-expected' }`); 已消失或被策略挡下的也不删 (进 `drift.removed`)。它只收窄范围, 不会跳过重新判定。
  - `staleTargets?` `'reject' | 'missing'` (默认 `'reject'`): 安全闸之前遇到「目标已不存在」, 怎么处置。`'missing'` 把这类目标从批次里摘出来、按「目标已达成」计成功侧, 不触发整批拒绝 (对应「别人已经删掉了」这类情形); 默认维持保守规则: 一处被拒, 整批零删除。这条只适用于 `GUARD_TARGET_MISSING`; 不可读与其余任何拒绝码, 仍然整批拒绝。
- Returns: `Promise<SweepReport>`:
  - `status` `SweepRunStatus`: `'executed'` | `'rejected'` (整批拒绝) | `'nothing-to-do'` (空批)。
  - `plan` `SweepPlan`: 本次执行真正依据的实时计划; 如果和先前 `plan()` 的结果不一致, 以它为准, 差异另由 `drift` 给出。
  - `validation?` `ValidationResult`: 进了安全闸就会给出 (整批拒绝也有, 伴随的是零删除)。`removal?` `RemovalResult`: 删除结果的分桶 (`removed` / `missing` / `failed` / `aborted`); 未执行删除时不给出。
  - `entries` `SweepOutcomeEntry[]`: 与 `plan.entries` 同序同长, 每条是条目再加上 `outcome`。
  - `stale` `string[]`: 被 `staleTargets: 'missing'` 摘出来的已消失目标。
  - `drift?` `SweepDrift`: `{ added, removed }`, 提供了 `expectedBatch` 时给出。
  - `releasedBytes` `number`: 成功侧 (removed + missing + stale) 的体积累计。

`outcome` 是 `EntryOutcome` 判别联合。`kind` 取值: `removed` / `missing` / `stale` (成功侧: 删掉了、核验确认已不存在、或者压根没进删除范围), `failed`, `rejected`, `not-attempted` (整批中止时, 中止点及其之后的条目), `not-expected` (在期望批次之外), `skipped` (被策略挡下)。

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
  - `counts` `Record<EntryOutcomeKind, number>`: 逐 kind 计数, 每项恒有, 默认 0。
  - `succeeded` `number`: `removed` + `missing` + `stale`。
  - `unprocessed` `number`: `skipped` + `rejected` + `not-attempted` + `not-expected`。
  - `failed` `number`: 真失败。
  - `aborted` `boolean`: 是否发生了整批中止 (存在 `removal.aborted`)。

### 成功口径与退出码

「本次运行算不算成功」是产品上的判断, 不是数据事实, 所以库里没有 `ok` 字段, 只给你数字和三种常见配方:

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

每个原语都能单独使用, 导入时零副作用, 而且什么都不打印; 异步入口失败一律 reject。想要一份只读快照, 把 `scan` → `measure` → `classifyTarget` 串起来就行, 这条路径上没有任何删除动作。

### 扫描

#### `createScanner(): Scanner`

- Returns: `Scanner`:
  - `name` `string`: 实现的中立名 (`'parallel'`), 供基准测试和日志区分不同实现。
  - `scan(options)`: 见下。

#### `scanner.scan(options): Promise<ScanResult>`

- `options` `ScanOptions`:
  - `roots` `string[]` (必填): 扫描根 (调用方保证为绝对路径)。
  - `exclude` `string[]` (这里必填: 不过滤就传 `[]`): 目录名; 从根到命中点之间, 任意一级命中, 整棵子树跳过。
  - `include` `string[]` (这里必填): 包含名单; 空数组 = 不过滤; 两个名单同时命中时 `exclude` 优先。
  - `signal?` `AbortSignal`: 在每个遍历任务开始前检查; 中断后以 `SweepError('CANCELLED')` reject。
  - `onProgress?` `(event: ScanProgressEvent) => void`: 每命中一处发一条 `hit` 事件。
- Returns: `Promise<ScanResult>`:
  - `hits` `ScanHit[]`: `{ project, target, root }[]`, 按 `target` 升序、按真实路径去重。`root` 取输入顺序里第一个遍历到该命中的根, 所以按根分组是确定、可复现的。
  - `warnings` `SweepWarning[]`: 非致命扫描告警 (`code` 为 `ScanWarningCode`); 某个根不存在或不可读, 不会中断遍历。
  - `excludeMatches` / `includeMatches` `NameMatch[]`: `{ name, hits }[]`, 永远都在 (没命中的名字也列出来, `hits: 0`, 拼错了当场可见)。

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
  - `name` `string`: 实现的中立名 (`'du'` 为 `du` 快路径, `'js'` 为纯实现), 供基准测试和日志区分不同实现。
  - `basis` `SizeBasis`: 本实例的体积口径, 调用前即可读。
  - `measure(targets, options?)`: 见下。

#### `sizer.measure(targets, options?): Promise<SizeResult>`

- `targets` `string[]`: 要测的路径 (通常是 `scan.hits.map((hit) => hit.target)`)。
- `options?` `MeasureOptions`:
  - `signal?` `AbortSignal`: 在每个目标之间检查 (`du` 批量路径在批量调用前后各检查一次)。
  - `onProgress?` `(event: MeasureProgressEvent) => void`: 每目标一条 (`measured` / `unmeasured` / `gone`)。
- Returns: `Promise<SizeResult>`:
  - `entries` `SizeEntry[]`: 测到的目标 (`{ target, bytes }`), 按 `target` 升序。
  - `basis` `SizeBasis`: `'disk-usage'` (`du` 快路径, 报磁盘占用) 或 `'logical-bytes'` (纯实现, 报逻辑字节); 一次调用只有一个口径, 调用前后都能读, 不要猜它。win32 上永远是 `logical-bytes`。
  - `warnings` `SweepWarning[]`: 非致命体积告警 (`code` 为 `SizeWarningCode`)。
  - `unmeasured` `UnmeasuredEntry[]`: 存在但测不到的目标 (`{ target, code, reason }`, `code` 为 `UnmeasuredCode`), 按 `target` 升序。
  - `gone` `string[]`: 测量时已不存在, 按 target 升序 (三个桶都是这个排序)。

每个入参目标必定落入且只落入一个桶, 没有第四类: `entries` (测到了)、`unmeasured` (存在但测不到)、`gone` (测量时已不存在)。这条完备性保证是契约, 不必再造 `'unknown'` 兜底分支。

```ts
const size = await createSizer().measure(targets, { signal, onProgress });
```

### 类别

#### `classifyTarget(target, options?): Classification`

- `target` `string`: 一个 `node_modules` 路径。
- `options?` `ClassifyOptions`:
  - `style?` `PathStyle`: 路径风味; 默认平台原生。
  - `home?` `string | null`: 家目录, 供下面隐藏目录形态判定用。默认 `os.homedir()`; 传 `null` 关掉该形态。
- Returns: `Classification`:
  - `kind` `TargetKind`: `'project'` | `'suspect-install-tree'`。
  - `reason?` `string`: 判定为疑似安装树时的中文理由。

纯看路径判定, 零 IO, 判定语义和 CLI 的清单标记是同一套。三种疑似形态按顺序判定: 祖先链上任一段命中内置名单 (另外还有 `extensions` 和 `_npx`); 父目录名叫 `lib` (版本管理器把全局包装在 `<版本目录>/lib/node_modules`); `node_modules` 落在**家目录下的隐藏目录**里。比较一律不区分大小写: 多出来的误判同样落在安全一侧。

```ts
const { kind, reason } = classifyTarget(target, options?);
// kind: 'project' | 'suspect-install-tree'
```

### 安全闸

#### `validateTargets(targets, options): Promise<ValidationResult>`

- `targets` `string[]`: 候选目标。
- `options` `ValidateOptions`:
  - `roots` `string[]` (必填): 扫描根, 必须保留配置里的原始拼写; 锚点判定看的是拼写, 不是真实路径。
  - `home?` `string | null`: home 目录本身的防护; 默认 `os.homedir()`, 传 `null` 关掉。
  - `style?` `PathStyle`: 路径风味; 默认平台原生。
  - `signal?` `AbortSignal`: 在每个目标之间检查。
- Returns: `Promise<ValidationResult>`:
  - `accepted` `string[]`: 可删的目标: 已转成真实路径 (realpath)、已去重、保持输入顺序。
  - `rejected` `RejectedTarget[]`: 每条被拒目标的 `{ target, code, message, details? }`, 与输入逐条对应; `code` 为 `GuardCode`, `details?` 为 `RejectionDetails` (`{ errno?, root?, symlink? }`)。
  - `mappings` `PathMapping[]`: `{ original, real }` 配对, 与 `accepted` 逐位对应; 显示时用 `original`, 删除时用 `real`, 不用再靠位次手工对齐。

各项安全检查逐条判定, 命中哪条就当场短路: 末段必须恰好是 `node_modules`; 目标必须存在且可读 (realpath); 配置拼写的根链上一旦有符号链接, 该根之下的目标整类被拒; 文件系统根和 home 目录本身直接拒绝; 真实路径仍须以 `node_modules` 结尾、落在某个声明的根之下, 并按真实路径去重。拒绝是**走返回值, 而不是抛错**: 整份清单一定会被处理完, 每条拒绝都带 `code`, 供分流。

### 设备边界

#### `findCrossDeviceTargets(targets, options): Promise<CrossDeviceEntry[]>`

- `targets` `string[]`
- `options` `CrossDeviceOptions`:
  - `roots` `string[]` (必填): 目标的所属根, 取包含它并且路径最长的那个根。
  - `style?` `PathStyle`: 路径风味; 默认平台原生。
  - `probe?` `DeviceProbe`: 设备号探针; 默认 `fsDeviceProbe` (注入它就能在单一文件系统上测跨设备流程)。
- Returns: `Promise<CrossDeviceEntry[]>`: `{ target, kind }` 条目, 保持输入顺序; 没有跨设备目标时为空数组。

`kind: CrossDeviceKind` 取值 `'on-path' | 'target-itself'`: 要么挂载点夹在根与目标之间, 要么目标本身就是挂载点。两种形态的处理办法不同 (把挂载点声明为独立的根, 或者先卸载那个卷), 所以分开列出, 而且两种都不由 policy 放行。结果返回数组而不是 `Map`, 是为了它能原样通过 `JSON.stringify` 进审计, 不丢内容。

#### `crossDeviceIndex(entries): ReadonlyMap<string, CrossDeviceKind>`

- `entries` `readonly CrossDeviceEntry[]`
- Returns: `ReadonlyMap<string, CrossDeviceKind>`: 查询视图 (跳过相关的几个函数要的就是 `has` / `get` 这种形态)。

```ts
const crossDevice = await findCrossDeviceTargets(targets, { roots });
const index = crossDeviceIndex(crossDevice); // 需要 has / get 时用这个视图
```

#### `fsDeviceProbe(path, follow): Promise<number | null>`

- `path` `string`
- `follow` `boolean`: `true` 取 `stat` 语义 (解析末段符号链接), `false` 取 `lstat` 语义 (不解析)。
- Returns: `Promise<number | null>`: 该路径的 `st_dev`; 读不到 (路径已消失或不可读) 时为 `null`。

`DeviceProbe` 的默认实现 (`(path: string, follow: boolean) => Promise<number | null>`)。两种语义并存, 是因为两处调用方要的读法正好相反: 根按 `follow: true` 读 (以它解析出来的实际目录为准); 目标按 `follow: false` 读 (和 `fs.rm` 对齐: `fs.rm` 删的是链接本身, 不跟进)。

### 路径风味与锚点判定

安全闸的路径层, 暴露出来给测试和自定义流程用。每个判定函数都显式接收 `PathStyle` 参数, 且不做任何 IO。

#### `POSIX_STYLE` / `WIN32_STYLE`

- `PathStyle` 常量, 可直接注入: `WIN32_STYLE` 比较时忽略大小写; `POSIX_STYLE` 不忽略。
- `PathStyle`: `{ name: 'posix' | 'win32', ops: PathOps, caseInsensitive: boolean }`, 其中 `PathOps` 是最小路径能力集 (`sep` / `basename` / `relative` / `isAbsolute` / `parse` / `join` / `resolve` / `dirname`), `node:path` 的两种风味都满足。

#### `nativeStyle(): PathStyle`

- Returns: `PathStyle`: 当前平台的风味; 凡是省略 `style` 选项的地方, 默认就是它。

#### `dedupeKey(realPath, style): string`

- `realPath` `string`, `style` `PathStyle`
- Returns: `string`: 真实路径的去重键 (win32 上先统一成小写)。

#### `hasNodeModulesLeaf(target, style): boolean`

- `target` `string`, `style` `PathStyle`
- Returns: `boolean`: 末段是否恰好是 `node_modules` (win32 上不区分大小写)。

#### `insideAnyRoot(realPath, roots, style): boolean`

- `realPath` `string`, `roots` `string[]`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否严格位于某个根之下, 按 `path.relative` 的语义判定, 而不是字符串前缀。与根相等、往上逃逸 (`..`)、或结果为绝对路径 (win32 跨盘), 一律算在外。

#### `isFilesystemRootBody(realPath, style): boolean`

- `realPath` `string`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否就是文件系统根目录本身 (posix 的 `/`, win32 的盘根)。

#### `isHomeBody(realPath, home, style): boolean`

- `realPath` `string`, `home` `string | null`, `style` `PathStyle`
- Returns: `boolean`: 该路径是否就是 home 目录本身; `home: null` 时关闭这项判定。

#### `firstSymlinkOnAnchor(links): string | null`

- `links` `AnchorLink[]`: 链上每一级一条 `{ path, symlink }`, `symlink` 由 `lstat` 判出 (指向哪里都算, 悬空的也算: 链上有链接这个事实本身就是证据)。
- Returns: `string | null`: 第一个符号链接所在那一级的路径; 每一级都是真目录时为 `null`。

锚点判定看配置里的拼写, 不看 realpath: realpath 永远只报此刻的解析结果, 名字被换成链接这件事在它那里不留痕迹, 而拼写上看得见。系统自带的链接 (macOS 的 `/var`、`/tmp`) 同样命中, 这是故意的: 在拼写这一层, 用户环境和攻击没法区分, 所以一律拒绝; 解决办法是把配置改写成真实路径。

#### `anchorChainPaths(root, style): string[]`

- `root` `string`: 一个扫描根或任意写入目标; 端点自己也进链, 文件系统根不进 (它不可能是符号链接)。
- Returns: `string[]`: 从文件系统根的第一级子目录起, 逐级拼出前缀, 直到端点。相对拼写会先按给定的路径风味转成绝对路径 (和 `lstat` 读取用的是同一个基准)。

```ts
anchorChainPaths('/Users/x/ws/app', POSIX_STYLE);
// ['/Users', '/Users/x', '/Users/x/ws', '/Users/x/ws/app']
```

#### `firstSymlinkOnTarget(target): Promise<string | null>`

- `target` `string`
- Returns: `Promise<string | null>`: 链上第一个符号链接的路径; 整条链都是真目录, 或每一级都核验不了时为 `null`。

采集 (逐级 `lstat` 走链) 和检出一步到位。写入之前会先调用它: 写入会跟随链接、改到链接指向的目标上, 所以写入和删除读的是同一条链, 实现只有一份。

#### `firstSymlinkOnRoot(root): Promise<string | null>`

- `root` `string`
- Returns: `Promise<string | null>`: 和 `firstSymlinkOnTarget` 是同一个实现, 只是单独留了个名字, 因为那个调用点把它当作扫描根的信任锚来读。

### 删除

#### `removeTargets(targets, options): Promise<RemovalResult>`

- `targets` `string[]`: 过了安全闸的目标 (真实路径形式)。
- `options` `RemovalOptions`:
  - `roots` `TrustRoot[]` (必填): 这些目标所属的信任根; 目标不在任何根之下时, 整批中止。
  - `signal?` `AbortSignal`: 在条目之间检查 (单条 `rm` 跑到一半不打断的硬规矩, 见 [进度与取消](#进度与取消))。
  - `onProgress?` `(event: RemovalProgressEvent) => void`: 每条目标一有结果就发一条 (`removed` / `missing` / `failed` / `aborted`)。
- Returns: `Promise<RemovalResult>`:
  - `removed` `string[]`: 已删除, 保持输入顺序。
  - `missing` `string[]`: `rm` 报了 ENOENT, 并且复核确认目标本身已不存在 (计成功侧, 保持输入顺序)。
  - `failed` `TargetFailure[]`: `{ target, code, errno?, message, partialRisk }`, `code` 为 `RemoveFailureCode`; `partialRisk: true` 表示内容可能被删了一部分, 需要人工复查 (`partialRisk: false` 的失败根本没尝试删除)。
  - `aborted?` `AbortedBatch`: 复核没通过, 整批中止 (`{ target, code, message, path? }`, `code` 为 `AbortCode`); 中止点及其之后一条未动。

删每个目标之前, 从根往下到它的父目录逐级复核一遍; 半路发现被替换, 就整批停手。

```ts
const removal = await removeTargets(accepted, {
  roots: await toTrustRoots(roots),
  signal,
  onProgress,
});
```

#### `toTrustRoots(roots): Promise<TrustRoot[]>`

- `roots` `string[]`: 配置里的原始拼写。
- Returns: `Promise<TrustRoot[]>`: `{ configured, real }` 配对, 每根一对; realpath 失败时 `real` 退回为拼写。

给每个配置根配上它的真实路径。这份配对是锚点防护的一半, 不要自己手写。

#### `removeBatch(targets, options): Promise<BatchOutcome>`

推荐的写入入口: 安全闸、整批拒绝规则、配对、删除, 一趟全办完, 调用方不必知道 `TrustRoot` 的存在。

- `targets` `string[]`
- `options` `RemoveBatchOptions`:
  - `roots` `string[]` (必填): 扫描根, 保留配置里的原始拼写; 安全闸靠它判归属和锚点, 配对助手给删除那一步用。
  - `home?` / `style?` / `signal?` / `onProgress?`: 与 `validateTargets` 和 `removeTargets` 相同。
  - `staleTargets?` `'reject' | 'missing'`: 和 `sweeper.run` 一样的窄容忍。
- Returns: `Promise<BatchOutcome>`: `{ status: 'rejected', rejected }` (零删除) 或 `{ status: 'executed', accepted, mappings, stale, removal }`。

```ts
const outcome = await removeBatch(targets, { roots, staleTargets });
```

### 跳过信息

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
- Returns: `SkipCandidate[]`: `{ target, bytes?, unmeasuredReason?, suspect }`, 按命中顺序 (`size.gone` 里的目标也会产出, `bytes` 为 undefined)。

#### `skipsBatch(entry, crossDevice, policy): boolean`

- `entry` `SkipCandidate`; `crossDevice` `ReadonlyMap<string, CrossDeviceKind>` (用 `crossDeviceIndex` 构造); `policy` `SweepPolicy`。
- Returns: `boolean`: 该条目是否被挡在删除批之外。

#### `skipReasonOf(entry, crossDevice, policy): SkipReason | null`

- 参数同 `skipsBatch`。
- Returns: `SkipReason | null`, `null` 就是进批。判定顺序就是优先级: 跨设备 (两种形态, 不受 policy 影响) → 体积未测到 → 疑似安装树 (只有 `policy.releaseSuspects` 能放行)。

#### `deletionBatch(entries, crossDevice, policy): string[]`

- 参数同 `skipsBatch`。
- Returns: `string[]`: 进批的目标清单, 保持清单顺序。

#### `collectSkips(entries, crossDevice, policy): SkipBook`

- 参数同 `skipsBatch`。
- Returns: `SkipBook`:
  - `entries` `ReadonlyArray<SkippedTarget>`: `{ target, reason, note }`, 原因码和说明一次给全 (和 `plan.skipped` 同源同值)。
  - `trailer` `string[]`: 末尾的说明行, 每类一行, 该类出现了才有。
  - `hints` `ReadonlyMap<string, string>`: 目标 → 行尾说明, 只收测得体积的条目。

`SkipCandidate.suspect` 定为必填是刻意的: 「这条会不会被策略挡下」的全部信息都靠它承载; 留成可选的话, 一个只有体积的裸条目就能溜进删除流程, 安全语义会静默消失; 不想手填就走 `toSkipCandidates`。

#### `crossDeviceNote(kind): string`

- `kind` `CrossDeviceKind`
- Returns: `string`: 跨设备形态的说明文字。

### 配置加载 (可选原语)

库不会自己去读平台配置文件; 下面这几个配置加载原语, 是给「想在自己的工具里用上同一套配置行为」的调用方准备的:

#### `resolveConfigPath(options): ResolvedConfigPath`

- `options` `ResolveConfigPathOptions`:
  - `flag?` `string`: `--config` 旗标值, 优先级最高。
  - `platform?` `string`: 平台标识; 默认 `process.platform` (测试时注入 `'win32'`)。
  - `homedir?` `string`: 默认 `os.homedir()`。
  - `env?` `EnvTable`: 环境变量表; 默认 `process.env` (它带着 `SWEEP_NM_CONFIG`, win32 上还有 `APPDATA` / `USERPROFILE`)。
- Returns: `ResolvedConfigPath`: `{ path, source }`, `source: ConfigSource` 取 `'flag' | 'env' | 'platform-default'`。

优先级: `--config` 旗标 > `SWEEP_NM_CONFIG` 环境变量 > 平台默认。平台默认是 `~/.config/sweep-node-modules/config.json`; win32 上是 `%APPDATA%\sweep-node-modules\config.json`, `APPDATA` 没设置时回落到 `USERPROFILE\AppData\Roaming`。

#### `loadConfig(path): Promise<LoadConfigResult>`

- `path` `string`
- Returns: `Promise<LoadConfigResult>`: `{ state: 'ok', config }` 或 `{ state: 'absent' }`。文件缺失是正常状态 (向导据此分流); 文件损坏或读取失败会抛 `SweepError` (`CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_READ_FAILED`)。

`ok` 分支里, `Config` 带着 `roots` (必填) / `exclude` / `include`: 省略 `exclude` 字段就用 `DEFAULT_EXCLUDE`, 省略 `include` 就用 `[]`; 而显式写出的空数组, 意味着这份名单由调用方接管。

#### `loadResolvedConfig(resolved): Promise<LoadConfigResult>`

- `resolved` `ResolvedConfigPath`
- Returns: 与 `loadConfig` 同形。
- 来源是显式的时候更严: `--config` 旗标或 `SWEEP_NM_CONFIG` 指向的文件不存在就直接抛错 (`SweepError('CONFIG_ABSENT')`), 不让打错的路径静默降级成「没有配置」。平台默认这个来源保留软行为。

#### `mergeNames(configNames, cliNames): string[]`

- `configNames` `string[]`, `cliNames` `string[]`
- Returns: `string[]`: 配置名单在前、CLI 名单在后, 跨来源去重 (先出现的为准), 并静默剔除 `node_modules` 和 `.git` (这两个名字写进名单永不生效)。

#### `DEFAULT_EXCLUDE`

- `readonly string[]`: 内置排除名单: 包管理器和版本管理器的安装树、编辑器扩展目录、系统 / 应用数据根。

### 展示辅助

#### `formatBytes(bytes): string`

- `bytes` `number`
- Returns: `string`: 和清单上一样的、给人读的体积格式, 按 1024 逐级走 `B` / `KB` / `MB` / `GB` / `TB`; 保留 1 位小数, 整数值省去小数。

#### `sanitizeLine(text): string`

- `text` `string`
- Returns: `string`: 剥掉控制类字符 (C0, 含 ESC 和 DEL、C1、bidi 控制、零宽和 BOM), 剩下空白 (含换行) 折成单个空格, 两端去空白。

#### `sanitizeOutputLine(text): string`

- `text` `string`
- Returns: `string`: 就是 `sanitizeLine`, 差别只有一处: 保留入参整体最开头的缩进 (逐行调用一次就能保住每行缩进; 这是工具自带的分级排版手段); 行内其余空白照常折叠。

`sanitizeLine` / `sanitizeOutputLine` 是所有输出共用的唯一实现。外部数据 (路径、名字) 在进任何输出之前先过它们; CLI 就是这么做的, 你也别再写第二份。

## 错误与代码

走哪条通道, 一条规则说了算: **能逐条列出来的失败走返回值; 无法开始或无法继续的失败才抛错。**

| 通道   | 装什么                                                               | 出现位置                                                              |
| ------ | -------------------------------------------------------------------- | --------------------------------------------------------------------- |
| 返回值 | 预料之中的结果: 安全闸拒绝、删除失败、整批中止、体积测不到、策略跳过 | `rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped` |
| 抛错   | 无法开始或无法继续: 参数错误、配置损坏、取消                         | 同步入口当场抛; 异步入口 reject                                       |

### `SweepError`

- `class SweepError extends Error`: `{ name: 'SweepError', code, message, details? }`。
  - `code` `SweepErrorCode`: `CONFIG_READ_FAILED` / `CONFIG_CORRUPT_JSON` / `CONFIG_CORRUPT_SHAPE` / `CONFIG_ABSENT` / `INVALID_ARGUMENT` / `CANCELLED`。
  - `message` `string`: 给人读的文本 (规矩见下)。
  - `details?` `SweepErrorDetails`: 按 `code` 取值的判别联合: `{ path, errno? }`、`{ path }`、`{ path, field }`、`{ path, source }`、`{ field }`、`{ phase, partial? }`。
- 构造: `new SweepError(code, message, details?)`。
- 包里唯一的类: 其余实例一律来自 `createXxx()` 工厂, 数据则一律是普通对象。

### `isSweepError(value): value is SweepError`

- `value` `unknown`
- Returns: `value is SweepError`: 按形状判断 (`name` 是 `SweepError`, 再加上已知的 `code`; 不要求具备 Error 的形状本身), 不是按类判断。

打包后或多实例环境里 (同一个进程可能并存两份库), `instanceof SweepError` 会出现假阴性; 跨实例场景一律用它。没预料到的内部异常不做包装, 原样冒泡。

### code 家族

包里的 code 按家族列出 (每个 code 的完整触发表见 [可编程 API 面设计](docs/designs/api-surface.md)):

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

几条要紧的规矩:

- **程序里判断只许看 `code` 和 `details`, 严禁解析 `message`。** `message` 是给人读的中文说明; 要做本地化就丢掉它, 用 `code` + `details` 自己拼文案。
- 三个 realpath 拒绝码是故意共用同一句 `message` 的: 靠 `code` 和 `details.errno` (`ENOENT` / `EACCES` / 其余) 来区分, 因为处置方向正好相反: 「已不存在」可以容忍, 「不可读」不行。
- code 一经发布就冻结: 只增不改, 取值不回收。`switch` 的 `default` 分支请记下 code 原文, 不要归进「其他」静默吞掉。

## 进度与取消

`onProgress` 与 `signal` 可传给 `plan` / `run`, 以及支持它们的任一原语 (`scan`、`measure`、`validateTargets`、`removeTargets`、`removeBatch`)。

事件种类: `phase` (逐阶段 start / done, 阶段取 `SweepPhase` 全集: `scan` · `measure` · `classify` · `device` · `plan` · `validate` · `remove`), 原语事件 (`hit` · `measured` · `unmeasured` · `skipped` · `removed` · `failed` · `aborted` · `warning`), 以及终结事件: `plan()` 的事件流必定以 `plan-done` 收尾 (带上完整计划), `run()` 的事件流必定以 `done` 收尾 (带上运行状态)。终结事件之后不再有任何事件; 取消时事件流以抛错收场, 不会出现终结事件。

- 回调是同步调用的, 库不会 await 它的返回值; 回调抛错会原样冒泡, 中断这次调用 (不吞错)。
- 事件高频, 而且**不承诺顺序** (按并发完成的先后); 结果则承诺有序 (hits 和体积三个桶按 target 升序; 删除分桶和 `stale` 保持输入顺序)。
- 不要在回调里再次调用同一个 `Sweeper` 实例, 也不要在一个实例上并发跑两次调用 (重入行为未定义); 工厂不做扫描 / 删除这一类 IO (体积工厂只探测一次 `du`), 要并发就建第二个实例。
- 取消检查落在条目之间和阶段边界上; 取消以 `SweepError('CANCELLED')` 抛错。删除阶段绝不打断单条 `rm` 的中间过程 (那只会凭空造出半删状态): 取消只落在条目之间, 错误里带 `details.partial`, 给出已经完成的那部分结果; 其余阶段只带 `details.phase`, 不返回部分结果。

库不提供 `watch()` 这种异步迭代入口: CLI 直接用回调, 那是常态; 编辑器一类需要 `for await` 的宿主, 参考实现 (约 20 行) 写在设计文档里。

## 安全模型

> 本包的性格, 一句话: 看不准的时候, 默认不删。

- **导入不做事, `plan()` 也不删任何东西。** 删除只会通过显式的 `run()` / `removeTargets()` / `removeBatch()` 发生。
- **删什么, 由名字和归属双重判定。** 只认名字恰好是 `node_modules` 的目录, 而且必须落在声明的根之下; 归属按路径层级判定, 不是字符串前缀, `..` 上溯与冒名路径一概拒绝。文件系统根和 home 目录本身直接拒绝。
- **要真实路径, 否则整批拒绝。** 删除时要求根和它的祖先链里没有符号链接; 命中就整批拒绝, 并指出链接在哪; 只读取时, 符号链接的根照常跟进。门槛跟着可逆性走: 不可逆的那一步, 不放行。
- **一处被拒, 整批零删除**, 而不是逐条放行; 动手之前, 从根到目标的父目录逐级复核, 半路发现被掉包就停止后面条目的删除。唯一一个窄例外是显式开启的 `staleTargets: 'missing'`, 而且只容忍「目标已不存在」: 不放松任何一条安全规则, 也绝不会把目标加进要删的范围。
- **两类目标默认不进批**: 疑似安装树 (只由显式 `policy.releaseSuspects` 放行) 和跨设备目标 (policy 不放行, 解除的办法是改布局: 把挂载点声明为独立的根, 或者先卸载那个卷)。体积测不到的目标一律不删: 宁可留着, 不猜。
- **外部数据进输出之前先净化。** `sanitizeLine` / `sanitizeOutputLine` 是所有输出共用的唯一实现; 直接用它, 别抄一份。

## 数据形态与稳定性

- **要落盘、要进审计的**数据一律是普通对象和数组: `JSON.stringify` 无损 (没有类实例、没有 `Map` / `Set`、没有函数)。查询辅助 (`SkipBook.hints`、`crossDeviceIndex()`) 返回 `ReadonlyMap`, 它们属于查询用的视图, 不在落盘范围内。包里唯一的类是 `SweepError`。
- 与时间无关: 数据上不带时间戳 (唯一的时钟读数是进度事件里的 `elapsedMs`)。今天写进 JSONL 审计的形状, 明天读回来照样是决策输入。
- 结果确定: `hits` 和体积的三个桶按 target 升序, 删除分桶和 `stale` 保持输入顺序, 扫描按真实路径去重; 事件顺序则明确不承诺。
- 导入时零副作用; 不写任何 stdout / stderr; 不做 TTY 探测 (交互向导是 CLI 专属的)。

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
- [可编程 API 面设计](docs/designs/api-surface.md): 本页背后的权威导出面、错误码与行为契约
- [安全防护保障](../../docs/sweep/designs/safety-guardrails.md): 全量版 (含已知残余风险的诚实账)
