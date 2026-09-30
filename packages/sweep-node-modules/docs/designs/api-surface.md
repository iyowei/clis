# 可编程 API 面

> **状态**: 已定稿 (Accepted)
> **日期**: 2026-09-29
> **决策者**: 沈委
> **父文档**: [设计总纲](../../../../docs/sweep/designs/sweep-node-modules-design.md)
>
> 用途: 定义 API 包 (`@iyowei/sweep-node-modules`, 全部能力与契约都在这里) 与 CLI 薄壳包 (`@iyowei/sweep-node-modules-cli`, 解析 → 调 API → 渲染 → 交互) 的切分, 以及 API 包对外的可编程面。
> 范围: 本文只管「API 面长什么样」(导出面 / 错误模型 / 进度与取消 / 域类型 / 缺口处置 / 调用示例); 命令面与字节级输出规格见 [命令面与输出](../../../sweep-node-modules-cli/docs/designs/cli-surface.md), 配置模型见 [配置与初始化](../../../../docs/sweep/designs/config-and-initialization.md), 删除安全语义与安全闸见 [删除安全闸](../../../../docs/sweep/designs/deletion-guard.md), 扫描与体积算法见 [扫描与体积](../../../../docs/sweep/designs/scan-and-size.md)。
> 事实基准: 实读仓库 (2026-09-29) 的 `src/` 全部模块、[行为契约](../../../../docs/sweep/protocol/behavior-contract.md)、`docs/designs/` 四份分册与 [ADR 0002](../adrs/0002-fixed-config-and-preview-execution.md) / [0003](../adrs/0003-zero-runtime-deps.md) / [0006](../../../../docs/adrs/0006-dual-runtime-bun-first.md) / [0009](../../../../docs/adrs/0009-npm-distribution-form.md) / [0010](../../../../docs/adrs/0010-dual-package-monorepo.md); 需求侧的输入是使用方场景清单 (7 场景 + 9 条跨场景观察); 验证侧的输入是使用方体验报告与五份调用代码 (外部材料, 逐条处置见 §12)。
> 标注约定: 「实读」= 仓库现状; 「设计」= 本文的推演; 每一条的落点都标注「复用」「新增」「改动」三档之一 (复用 = 现有函数原样升为导出面, 逻辑不动; 改动 = 现有形状或签名需变; 新增 = 今天不存在的东西)。
> 时点说明: 标注「实读」的代码事实均为**单包时代 (2026-09-29 拆分前)** 的实读, 用于推导设计; 落地后现在的位置 (双包) 见 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md) 与 [设计总纲](../../../../docs/sweep/designs/sweep-node-modules-design.md) 结构一节。
> 反馈处置: 体验报告逐条处置见文末 §12 (57 条: 采纳 49 / 部分采纳 7 / 驳回 1)。

## 修订记录

| 日期       | 修订                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-09-29 | 初稿: 两级导出面、code 体系、进度与取消、域类型、9 条观察回应、缺口处置、三份调用示例、12 条开放问题                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| 2026-09-29 | 依使用方体验反馈 (体验报告里列出的 54 条 + 其代码注释里顺带指出的 3 条, 共 57 条) 修订, 主要动作: ① 安全闸把「目标不存在」与「目标不可读」拆成独立 code 并补 `errno`, 新增 `staleTargets` 容忍开关; ② `SkipCandidate.suspect` 改必填并新增候选构造器; ③ 新增 `expectedBatch` 与 `drift` 消掉「预览与执行不可对账」; ④ 补齐「结果 → 呈现 / 分支」缝合层 (`isSuccessOutcome` / `summarizeReport` / `SweepEntry.skipNote` / `done` 终结事件 / `SweepErrorDetails` / `SweepWarningCode` / `isSweepError`); ⑤ `SizeResult` 新增 `gone` 桶并写死完备性恒等式; ⑥ `excludeMatches` / `includeMatches` 改必填; ⑦ `findCrossDeviceTargets` 改返回可序列化数组; ⑧ 明写 `sanitizeLine` 与 `sanitizeOutputLine` 分工。逐条处置记录见 §12 |
| 2026-09-29 | 定稿落盘 (`docs/designs/` 体例); Q1b 拍板: 不保留过渡期转发 `bin`, 迁移指引放在 API 包 README (包定位变更说明) 与 release notes 里                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| 2026-09-29 | §10 闭环两缺口: `.d.ts` 产出通道已实测 (按 ADR 0010 决策 5 的 `tsc --emitDeclarationOnly` 落地, 需独立构建配置排除测试与 fixtures; declaration emit 会把源码的相对 specifier `.ts` 原样带出, `rewriteRelativeImportExtensions` 在 typescript 7.0.2 的 declaration emit 下实测未生效, 由构建脚本在产物里确定性地改写为 `.js`); 两包发布链经查证无依赖与顺序约束 (CLI 发布产物为 bundle 内联、零依赖声明), 实现见 `packages/sweep-node-modules/scripts/` 的 `build.ts` / `verify-release.ts` 与根 tsconfig 的 paths 双态方案 (开发态直指 src, 发布态 exports 指 dist)                                                                                                                                                         |
| 2026-09-30 | §3.4 三条「新增条款 (待登记)」正式登记为 BC-42 / BC-43 / BC-44 (登记义务由「转写双面覆盖」的设计承接), 标注随之更新                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |

---

## 1. 设计目标与约束

### 1.1 硬约束 (不可协商, 来自 ADR)

| 约束                          | 来源                                                 | 对设计的具体含义                                                                                                                                                                                                      |
| ----------------------------- | ---------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 零运行时依赖                  | ADR 0003                                             | 导出面只依赖 `node:` / `bun:` 内置与相对模块; 不引任何校验库、进度库、事件库                                                                                                                                          |
| 双运行时 Bun 优先 / Node 回退 | ADR 0006                                             | 同一份源码在两侧直接跑; 仅用可擦除 TS 语法 (禁 `enum` / `namespace` / 参数属性); `erasableSyntaxOnly` 是物理闸门                                                                                                      |
| 库的静默契约                  | 实读 `cli.ts` 集中打印 / OF-12                       | API 包零 stdout / 零 stderr 写入; 一切给人看的文字以字符串形式**返回**, 由调用方决定去哪个流                                                                                                                          |
| 无 TTY 依赖                   | 实读 (库内无 `isTTY` 读取)                           | 库不做交互探测, 不因 stdin / stdout 非终端而分叉行为; 向导 (`init.ts`) 是 TTY 专属的界面, 不进 API 包                                                                                                                 |
| 数据形态为普通对象            | 实读 (全链路无类实例, 仅 `createXxx()` 工厂交出实例) | 域数据一律 `interface` 描述、可 `JSON.stringify` 进 job summary / JSONL 审计; **这包括原语层的中间结果** (修正: `findCrossDeviceTargets` 由 `Map` 改返回数组, 取消初稿的 Map 例外); 唯一例外见 §3.6 (`SweepError` 类) |
| 保输入顺序 / 确定序           | 实读 `guard.ts` / `delete.ts` / BC-06                | 结果桶保输入顺序; 扫描结果按 target 升序; 并发只影响到达先后, 不影响输出                                                                                                                                              |
| 安全闸不可放宽                | BC-21 / BC-22 / BC-39                                | `staleTargets` 一类的容忍开关只放宽「目标已不存在」这一种**无安全信号**的拒绝; 任何不变量 (末段 / 归属 / 锚点 / 去重) 一律不放宽                                                                                      |

### 1.2 设计目标 (从场景清单与体验反馈提炼, 逐条可验收)

1. **两级导出面互不遮挡**: 原语层 (7 个使用方都要直接调的单点能力) 与编排层 (场景 1 / 6 想要的整链封装) 并存; CLI 薄壳包必须建立在同一份编排之上, 不得各写一份 (观察 1)。
2. **机器可判别的失败与跳过**: 每个拒绝 / 失败 / 跳过 / 告警都有稳定 `code`; 中文人话保留为附属文本; **同一个 code 不合并两种处置方向相反的语义** (新增: 这条纪律直接催生了 `GUARD_TARGET_MISSING` 与 `GUARD_TARGET_UNREADABLE` 的拆分)。
3. **进度与取消**: 至少覆盖编排层与扫描层; 取消必须能落在删除的**条目之间**而不制造新的半删语义; 事件流自带终结事件 (§4)。
4. **只读面与写入面物理不粘连**: 导入只读能力不触发任何副作用, 也不需要构造写侧的入参 (观察 4)。
5. **路径映射显式化**: `original → realpath` 的映射用字段写出来, 不再靠「保输入顺序」隐式对齐 (观察 5)。
6. **结果到呈现 / 分支的缝合层齐备** (新增目标): 「成功侧判据」「跳过的人话说明」「退出码口径配方」都由库给出或写明, 不让每个调用方各重建一次。
7. **预览与执行可对账** (新增目标): `run()` 允许接收期望批次, 使「用户点头的那份清单」与「真正被删的那份清单」之间的差异显式化, 而不是各算一次。
8. **配置装载是可选原语**: 导出三级覆盖与三态装载, 但库的编排层**不读**平台配置 (观察 7)。
9. **安全语义结构化**: 两类保守默认用 policy 与跳过编码表达, `--force` 的放行边界原样保留, 跨设备不走旗标; 新增的容忍开关必须显式开启且不得放宽不变量 (观察 9)。

### 1.3 本期窗口的特殊性 (实读, 决定了形状可以定死)

- API 包当时**不存在程序化入口**: `package.json` 只有 `bin` 与 `files`, 无 `main` / `exports` / `types` (单包时代实读)。7 个场景当时要么 shell 调 CLI 再从文本抠数字, 要么根本用不上。
- 结论: **本期是唯一可以自由定数据形状的窗口**。一旦发布, §5 的域类型与 §3 的 code 表按「只增不改」冻结; 因此本次把形状一次定到位, 不留「先发字符串版再发对象版」或「先发一个粗 code 再拆细」的二段式破坏。
- 本次修订全部落在这一窗口内: 拆 code、加字段、改 `Map` 为数组这类动作, 一旦发布就都属破坏性变更, 故必须在本批做完。

---

## 2. 导出面总览

### 2.1 包边界: 谁进 API 包, 谁留 CLI 包

| 模块 (单包时代实读)                                           | 归属            | 处理                                                                                                            |
| ------------------------------------------------------------- | --------------- | --------------------------------------------------------------------------------------------------------------- |
| `src/scan.ts` + `scan-parallel.ts` (+ 落选候选)               | API 包          | 复用 (门面一行导出不变)                                                                                         |
| `src/size.ts` + `size-du.ts` + `size-js.ts`                   | API 包          | 改动 (`SizeResult` 加 `basis` 与 `gone`)                                                                        |
| `src/classify.ts`                                             | API 包          | 复用 (纯路径判定原样)                                                                                           |
| `src/guard.ts`                                                | API 包          | 改动 (拒绝码拆分 + `mappings` + 设备判定改返回数组)                                                             |
| `src/delete.ts`                                               | API 包          | 改动 (失败结构化)                                                                                               |
| `src/skip.ts`                                                 | API 包          | 改动 (入参与 `RenderEntry` 解耦, `suspect` 改必填, 新增构造器, 见 §5.2)                                         |
| `src/config.ts`                                               | API 包          | 复用 (装载原语; 编排层不自动调用)                                                                               |
| `src/types.ts`                                                | API 包          | 改动 (加字段, 见 §5.1)                                                                                          |
| `src/render.ts`                                               | CLI 包          | 改动 (清单渲染留 CLI; `formatBytes` / `sanitizeLine` / `sanitizeOutputLine` 三个纯函数拆进 API 包)              |
| `src/help.ts` / `src/init.ts`                                 | CLI 包          | 复用 (帮助文案与向导都是 CLI 面)                                                                                |
| `src/cli.ts` 的 `sweep()` 私有编排 (575 至 679 行)            | API 包 (编排层) | 新增 (提升为 `createSweeper(...).plan()` / `.run()`)                                                            |
| `src/cli.ts` 的私有 `trustRoots()`                            | API 包          | 新增 (提升为 `toTrustRoots`, 逻辑逐字不动)                                                                      |
| `src/cli.ts` 的 `toEntries` 前半 (hits + size → 逐条状态)     | API 包          | 新增 (提升为 `toSkipCandidates` 与编排层的条目构造, 见 §7.8)                                                    |
| `src/cli.ts` 的 `parseArgs` / `collectNameNotes` / 退出码判定 | CLI 包          | 复用 (参数解析与相关文案都归 CLI)                                                                               |
| `src/runtime.ts`                                              | API 包内部依赖  | 不导出 (属实现细节; 生产链路已无使用方, 现仅自测引用; 调用方想要运行时自述, 自己取一行 `process.versions` 即可) |

### 2.2 原语层 (一): 读侧

```ts
// 扫描: 门面直接升 (src/scan.ts 逐字导出)
export function createScanner(): Scanner;

export interface Scanner {
  /** 候选的中立名 ('parallel'), 供基准测试与日志区分 */
  name: string;
  scan(options: ScanOptions): Promise<ScanResult>;
}

export interface ScanOptions {
  /** 扫描根 (调用方保证为绝对路径) */
  roots: string[];
  /** 排除名单: 目录名; 从根到命中点的任意一级命中名单, 即整棵子树跳过 */
  exclude: string[];
  /** 包含名单 (白名单): 空数组 = 不过滤 */
  include: string[];
  /** 取消信号 (新增); 检查点在每个遍历任务开始前, 中断后 reject */
  signal?: AbortSignal;
  /** 进度回调 (新增); 粒度: 每命中一处发一条 hit 事件 */
  onProgress?: (event: ScanProgressEvent) => void;
}

export interface ScanHit {
  /** 直接包含 node_modules 的项目目录 (绝对路径, 调用方传入的拼写) */
  project: string;
  /** node_modules 绝对路径 */
  target: string;
  /** 所属扫描根 (新增, 见 §7.4); 各根串行推进, 取首个遍历到该命中的根 */
  root: string;
}

/** 名单命中统计项 (排除与包含共用同形) */
export interface NameMatch {
  name: string;
  /** 该名命中的次数; 未命中的名称也在列, 值为 0 */
  hits: number;
}

export interface ScanResult {
  /** 命中清单: 按 target 码元序升序, 已按 realpath 去重 (BC-04 / BC-06) */
  hits: ScanHit[];
  /** 非致命告警 (改动: string[] → 结构化, 见 §3.2) */
  warnings: SweepWarning[];
  /**
   * 排除名单命中统计 (改动: 由可选改必填; 未配置名单时为空数组)。
   * 必填的理由: 落盘形态不得随调用参数漂移; 月级 JSONL 序列里键时有时无,
   * 下游 schema 校验器无从分辨「没配名单」与「版本不支持该字段」。
   */
  excludeMatches: NameMatch[];
  includeMatches: NameMatch[];
}

export type ScanProgressEvent = { kind: 'hit'; hit: ScanHit };
```

```ts
// 体积: 门面直接升, 加口径标识、失踪桶与可选调用选项 (src/size.ts)
export function createSizer(): Sizer;

export interface Sizer {
  /** 候选的中立名 ('du' / 'js') */
  name: string;
  /** 本实例的体积口径 (新增, 见 §7.3); 调用前即可读 */
  basis: SizeBasis;
  measure(targets: string[], options?: MeasureOptions): Promise<SizeResult>;
}

/** 体积口径: du 快路径报磁盘占用, 纯实现报逻辑字节 */
export type SizeBasis = 'disk-usage' | 'logical-bytes';

export interface MeasureOptions {
  /** 取消信号 (新增); 检查点在逐目标之间 (du 批量路径在批量调用前后各一次) */
  signal?: AbortSignal;
  /** 进度回调 (新增); 粒度: 每测到一个目标发一条 measured 事件 */
  onProgress?: (event: MeasureProgressEvent) => void;
}

export interface SizeEntry {
  target: string;
  /** 字节数; 口径见 SizeResult.basis */
  bytes: number;
}

export interface UnmeasuredEntry {
  target: string;
  /** 机器可判别的未测到原因 (新增) */
  code: UnmeasuredCode;
  /** 人话中文原因 (逐字保留现状, 不含路径本身) */
  reason: string;
}

export interface SizeResult {
  /** 可测量目标的体积, 按 target 升序 */
  entries: SizeEntry[];
  /** 本次调用实际生效的体积口径 (新增; 同一实例内恒定) */
  basis: SizeBasis;
  /** 非致命告警 (改动: 结构化); 含 `SIZE_TARGET_VANISHED` 事件条 */
  warnings: SweepWarning[];
  /** 存在但无法测量的目标 (如权限不足), 按 target 升序 */
  unmeasured: UnmeasuredEntry[];
  /**
   * 扫描命中、测量时已不存在 (BC-13) 的目标, 保输入顺序 (新增)。
   * 「不存在」既不产生字节也不属「存在但测不到」, 故单列一桶, 与 warnings 里的
   * `SIZE_TARGET_VANISHED` 事件同源同判定 (事件供诊断, 本桶供划分)。
   */
  gone: string[];
}

export type MeasureProgressEvent =
  | { kind: 'measured'; target: string; bytes: number; basis: SizeBasis }
  | { kind: 'unmeasured'; target: string; code: UnmeasuredCode; reason: string }
  | { kind: 'gone'; target: string };
```

**划分完备性恒等式 (新增契约, 回答体验报告 U10)**: 入参 `targets` 里的每个目标, 恒落在且仅落在一个桶:

```text
targets  = entries.map(e => e.target)      // 测到了体积
         ∪ unmeasured.map(u => u.target)   // 存在但测不到
         ∪ gone                            // 测量时已不存在
```

三者两两不相交, 且**无第四类**。调用方因此不必再靠「既不在甲也不在乙」反推未知态 (初稿缺这条, 体验报告的场景 2 只能自造 `bucket: 'unknown'` 兜底)。

```ts
// 类别判定: 纯函数直接升 (src/classify.ts)
export type TargetKind = 'project' | 'suspect-install-tree';

export interface Classification {
  kind: TargetKind;
  /** kind 为 suspect-install-tree 时的中文理由 (人话, 供清单行尾标注) */
  reason?: string;
}

export interface ClassifyOptions {
  /** 路径风格; 缺省平台原生 */
  style?: PathStyle;
  /** 家目录; 缺省 os.homedir(), 显式传 null 关闭「家目录下隐藏目录」形态判定 */
  home?: string | null;
}

export function classifyTarget(
  target: string,
  options?: ClassifyOptions,
): Classification;
```

### 2.3 原语层 (二): 判定件与安全闸

```ts
// 安全闸: 直接升 + mappings + 拒绝码拆分与 errno (src/guard.ts)
export interface ValidateOptions {
  /** 扫描根 (调用方给定, 须保留配置里的原始拼写; 锚点链的判定看拼写) */
  roots: string[];
  /** home 本体防线; 缺省 os.homedir(), 显式传 null 关闭 */
  home?: string | null;
  /** path 判定风格; 缺省随当前平台 */
  style?: PathStyle;
  /** 取消信号 (新增); 检查点在逐目标之间 */
  signal?: AbortSignal;
}

export interface RejectedTarget {
  /** 调用方传入的原始目标 */
  target: string;
  /** 机器可判别的拒绝码 (新增, 见 §3.2) */
  code: GuardCode;
  /** 中文人话理由 (改动: reason → message, 文案逐字保留现状) */
  message: string;
  /** 拒绝的结构化上下文 (新增) */
  details?: RejectionDetails;
}

export interface RejectionDetails {
  /**
   * 原始 errno (新增, 回答体验报告 1-1 / 3-3 / U2)。
   * 有它之后, 调用方判「这一条到底怎么了」不必再匹配中文 message。
   */
  errno?: string;
  /** 锚点类拒绝: 配置里的根 */
  root?: string;
  /** 锚点类拒绝: 检出符号链接的层级 */
  symlink?: string;
}

/** 原始目标 → realpath 归一的配对 (新增, 见 §7.2) */
export interface PathMapping {
  /** 调用方传入的拼写 (显示侧要的形态) */
  original: string;
  /** realpath 归一形态 (删除侧要的形态) */
  real: string;
}

export interface ValidationResult {
  /** 通过全部不变量、已 realpath 化并去重的可删目标 (保输入顺序) */
  accepted: string[];
  /** 未通过的目标与理由, 与输入逐条对应 */
  rejected: RejectedTarget[];
  /** 与 accepted 逐位对应的配对表 (新增; 长度与 accepted 相等) */
  mappings: PathMapping[];
}

export async function validateTargets(
  targets: string[],
  options: ValidateOptions,
): Promise<ValidationResult>;

// 设备边界: 改动 (Map → 可序列化数组, 见 §7.9)
export interface CrossDeviceEntry {
  target: string;
  kind: CrossDeviceKind;
}
export interface CrossDeviceOptions {
  roots: string[];
  style?: PathStyle;
  /** 设备号探针; 缺省读真实文件系统 (测试注入用) */
  probe?: DeviceProbe;
}
export type CrossDeviceKind = 'on-path' | 'target-itself';
/** 保输入顺序; 无跨设备目标时为空数组 */
export async function findCrossDeviceTargets(
  targets: string[],
  options: CrossDeviceOptions,
): Promise<CrossDeviceEntry[]>;
/** 数组 → 查询索引 (新增): 写侧的 skipsBatch / collectSkips 系列要的就是这个形态 */
export function crossDeviceIndex(
  entries: readonly CrossDeviceEntry[],
): ReadonlyMap<string, CrossDeviceKind>;
export type DeviceProbe = (
  path: string,
  follow: boolean,
) => Promise<number | null>;
export const fsDeviceProbe: DeviceProbe;
```

```ts
// 路径风格的判定件与纯判定函数: 全部直接升 (src/guard.ts 的既有 export)
export interface PathOps {
  /* Pick<typeof posix, 'sep' | 'basename' | 'relative' | 'isAbsolute' | 'parse' | 'join' | 'resolve' | 'dirname'> */
}
export interface PathStyle {
  name: 'posix' | 'win32';
  ops: PathOps;
  caseInsensitive: boolean;
}
export const POSIX_STYLE: PathStyle;
export const WIN32_STYLE: PathStyle;
export function nativeStyle(): PathStyle;

export function dedupeKey(realPath: string, style: PathStyle): string;
export function hasNodeModulesLeaf(target: string, style: PathStyle): boolean;
export function insideAnyRoot(
  realPath: string,
  roots: string[],
  style: PathStyle,
): boolean;
export function isFilesystemRootBody(
  realPath: string,
  style: PathStyle,
): boolean;
export function isHomeBody(
  realPath: string,
  home: string | null,
  style: PathStyle,
): boolean;

export interface AnchorLink {
  path: string;
  symlink: boolean;
}
export function firstSymlinkOnAnchor(links: AnchorLink[]): string | null;
export function anchorChainPaths(root: string, style: PathStyle): string[];
export async function firstSymlinkOnTarget(
  target: string,
): Promise<string | null>;
export async function firstSymlinkOnRoot(root: string): Promise<string | null>;
```

### 2.4 原语层 (三): 写侧

```ts
// 删除执行: 直接升 + 结构化失败 (src/delete.ts)
export interface TrustRoot {
  /** 链头判定的对象 (配置里的原始拼写) */
  configured: string;
  /** isUnder 与复核链的比较基准 (realpath 形态, 与 targets 同源) */
  real: string;
}

export interface RemovalOptions {
  /** 可删目标所属的信任根 (与 guard 同源); 目标不在任何根之下时整批中止 */
  roots: TrustRoot[];
  /** 取消信号 (新增); 只在条目之间检查, 绝不在单条 rm 中途中断 (见 §4.3) */
  signal?: AbortSignal;
  /** 进度回调 (新增); 粒度: 每条目标一有结果就发一条 */
  onProgress?: (event: RemovalProgressEvent) => void;
}

export interface TargetFailure {
  /** 调用方传入的目标 (原样回显, 不做二次 realpath) */
  target: string;
  /** 机器可判别的失败码 (新增) */
  code: RemoveFailureCode;
  /** 原始 errno (EACCES / EBUSY / ENOENT …), 无则缺省 (新增) */
  errno?: string;
  /** 中文人话串 (改动: error → message; 文案逐字保留现状) */
  message: string;
  /** 内容可能已被部分或全部删除 (EC-05 半完成语义的机器标记, 新增) */
  partialRisk: boolean;
}

export interface AbortedBatch {
  /** 触发中止的目标 (未被删除) */
  target: string;
  /** 机器可判别的中止码 (新增) */
  code: AbortCode;
  /** 中文人话, 含定位 (文案逐字保留现状) */
  message: string;
  /** 定位路径 (根 / 组件; 从文案里提出做字段, 新增) */
  path?: string;
}

export interface RemovalResult {
  /** 实际删除成功的目标 (保输入顺序) */
  removed: string[];
  /** rm 报 ENOENT 且复核确认目标本体已不存在; 目标已达成, 计成功侧 (保输入顺序) */
  missing: string[];
  /** 删除失败与复核未完成的目标及原因 (保输入顺序) */
  failed: TargetFailure[];
  /** 安全复核未通过即中止整批; 未触发时缺省 */
  aborted?: AbortedBatch;
}

export type RemovalProgressEvent =
  | { kind: 'removed'; target: string }
  | { kind: 'missing'; target: string }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted'; aborted: AbortedBatch };

export async function removeTargets(
  targets: string[],
  options: RemovalOptions,
): Promise<RemovalResult>;
```

```ts
// 信任根配对助手: 新增 (从 cli.ts 私有 trustRoots 提升, 逻辑逐字不动, 见 §7.1)
export async function toTrustRoots(roots: string[]): Promise<TrustRoot[]>;
```

```ts
// 写侧编排: 新增 (把 cli.ts sweep 的第 3、4 步收成一个入口, 见 §7.1)
export interface RemoveBatchOptions {
  /** 扫描根 (原始拼写): 安全闸用它判归属与锚点, 配对助手用它产出删除侧要的配对 */
  roots: string[];
  home?: string | null;
  style?: PathStyle;
  signal?: AbortSignal;
  onProgress?: (event: RemovalProgressEvent) => void;
  /**
   * 安全闸之前「目标已不存在」这一类拒绝如何处置 (新增, 回答体验报告 1-1 / 3-5 / 4-2 / U2)。
   * - 'reject' (缺省, 保现状): 与其余拒绝同款, 触发整批拒绝、零删除 (BC-22);
   * - 'missing': 把这类目标从批次中摘出, 记入 executed 分支的 `stale`, 不触发整批拒绝,
   *   其余健康目标照删 (沿用 EC-01「目标已达成」的定性); 被摘出的目标**不进入删除面**。
   * 只对 `GUARD_TARGET_MISSING` 生效; `GUARD_TARGET_UNREADABLE` 与其余任何拒绝码
   * 一律维持整批拒绝 (不可读没有任何「已达成」的语义)。
   */
  staleTargets?: 'reject' | 'missing';
}

/** 整批拒绝与已执行二选一 (BC-22 的判别联合表达) */
export type BatchOutcome =
  | { status: 'rejected'; rejected: RejectedTarget[] }
  | {
      status: 'executed';
      accepted: string[];
      mappings: PathMapping[];
      /** 因 staleTargets: 'missing' 被摘出的已消失目标 (保输入顺序); 该策略未开启时为空数组 */
      stale: string[];
      removal: RemovalResult;
    };

export async function removeBatch(
  targets: string[],
  options: RemoveBatchOptions,
): Promise<BatchOutcome>;
```

### 2.5 原语层 (四): 跳过集册与配置装载

```ts
// 跳过集册: 判定逻辑逐字复用, 入参类型收紧 (src/skip.ts, 见 §5.2)
export interface SkipCandidate {
  target: string;
  /** undefined = 体积未测到 (体积未测到的条目不进删除批, BC-15) */
  bytes?: number;
  /** 体积未测到时的中文原因 (补, 供 collectSkips 的 entries[].note 单源化); bytes 有值时无意义 */
  unmeasuredReason?: string;
  /**
   * 疑似安装树 (改动: 由可选改**必填**)。
   * 必填的理由是安全的: 它装着「这条会不会被语义闸挡下」的全部信息, 而
   * `releaseSuspects` 缺省为 false; 一旦留成可选, 最顺手的 `SizeEntry[]`
   * (只有 target 与 bytes) 就能直接喂进写侧函数并通过类型检查, 运行时
   * `suspect` 恒为 undefined, 疑似安装树静默进批且无任何报错 (体验报告 4-1)。
   * 改必填后该误用当场类型报错; 不想手填的调用方走 `toSkipCandidates()`。
   */
  suspect: boolean;
}

/**
 * 候选构造器 (新增): 由扫描命中 + 体积结果 + 类别判定组装 SkipCandidate[]。
 * 与 cli.ts 私有 `toEntries` 的前半段同源 (target / bytes / suspect 三项),
 * 把「三份数据手工 join」收进库内, 让调用方拿不到半成品数组。
 * `size.gone` 里的目标同样产出候选 (bytes 为 undefined), 它们不满足进批条件, 天然被挡。
 */
export function toSkipCandidates(
  hits: readonly ScanHit[],
  size: SizeResult,
  options?: ClassifyOptions,
): SkipCandidate[];

export function skipsBatch(
  entry: SkipCandidate,
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy, // 改动: 原第三参 force: boolean
): boolean;

/** 跳过原因编码, null 即进批 (新增, 与 skipsBatch 同一判定) */
export function skipReasonOf(
  entry: SkipCandidate,
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy,
): SkipReason | null;

export function deletionBatch(
  entries: SkipCandidate[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy, // 改动: 原第三参 force: boolean
): string[];

export interface SkippedTarget {
  target: string;
  /** 机器可判别的跳过原因 */
  reason: SkipReason;
  /** 中文人话行尾说明 (恒有值, 见下方契约) */
  note: string;
}

export interface SkipBook {
  /** 跳过集册: 码 + 人话一次给全 (新增, 回答体验报告 4-3 / U12); 与 plan.skipped 同源同值 */
  readonly entries: ReadonlyArray<SkippedTarget>;
  /** 末行说明行: 按类与形态各一行, 出现时才输出 */
  readonly trailer: string[];
  /** 目标 → 行尾说明 (只收测得体积的条目: 未测到者的行尾已有体积失败注记, 不混同) */
  readonly hints: ReadonlyMap<string, string>;
}
export function collectSkips(
  entries: SkipCandidate[],
  crossDevice: ReadonlyMap<string, CrossDeviceKind>,
  policy: SweepPolicy, // 改动
): SkipBook;

export function crossDeviceNote(kind: CrossDeviceKind): string;
```

**跳过集册家族的选择依据 (新增, 回答体验报告「同族函数太多」)**:

| 你要做的事                                | 用哪个                                                          |
| ----------------------------------------- | --------------------------------------------------------------- |
| 判断「这一条进不进批」(单个布尔)          | `skipsBatch`                                                    |
| 问「这一条为什么不进批」(单个编码)        | `skipReasonOf`                                                  |
| 拿到整份「码 + 人话 + 末行说明」          | `collectSkips`                                                  |
| 只要「进批的目标清单」                    | `deletionBatch`                                                 |
| 手上是 `hits` + `size` + 类别, 要组装候选 | `toSkipCandidates`                                              |
| 手上已经有 `SweepEntry[]` (编排层产物)    | 直接用: `entry.inBatch` / `entry.skipReason` / `entry.skipNote` |

`collectSkips` 的 `entries[].note` 来源单源化 (回答体验报告 4-5 / U15): 疑似安装树与跨设备各自取 `skip.ts` 既有文案常量, **未测到体积的条目取 `体积统计失败: <unmeasuredReason>`** (与 CLI 现行 `toEntries` 的行尾注记同源); `hints` 是同一次判定的「只含测得体积条目」子集视图。

```ts
// 配置装载: 直接升 (src/config.ts); 库不自动调用, 由调用方显式决定
export const DEFAULT_EXCLUDE: readonly string[];

export interface Config {
  roots: string[];
  exclude: string[];
  include: string[];
}
export type ConfigSource = 'flag' | 'env' | 'platform-default';
export type EnvTable = Record<string, string | undefined>;

export interface ResolveConfigPathOptions {
  /** `--config` 旗标值, 最高优先级 */
  flag?: string;
  platform?: string;
  homedir?: string;
  /** 环境变量表, 缺省 process.env */
  env?: EnvTable;
}
export interface ResolvedConfigPath {
  path: string;
  source: ConfigSource;
}
export function resolveConfigPath(
  options: ResolveConfigPathOptions,
): ResolvedConfigPath;

export type LoadConfigResult =
  { state: 'ok'; config: Config } | { state: 'absent' };
/** 装载配置 (改动: 损坏时抛 SweepError, 见 §3.4) */
export function loadConfig(path: string): Promise<LoadConfigResult>;
export function loadResolvedConfig(
  resolved: ResolvedConfigPath,
): Promise<LoadConfigResult>;

export function mergeNames(configNames: string[], cliNames: string[]): string[];
```

### 2.6 原语层 (五): 展示辅助 (纯函数, 无打印)

```ts
/**
 * 人类可读体积: 逐级 1024 (B / KB / MB / GB / TB), 保留 1 位小数、整数省略小数尾。
 * 与 CLI 清单同一实现 (自 CLI `render.ts` 上移至 API 包 `display.ts`)。
 */
export function formatBytes(bytes: number): string;

/**
 * 单行净化 (自 CLI `render.ts` 上移至 API 包 `display.ts`): 剥离控制类字符 (C0 含 ESC / DEL /
 * C1 / bidi 控制 / 零宽 / BOM) 并把剩余空白 (含换行) 折成单空格、去掉两端空白。
 * 用途: 把**外部数据** (路径、他人给的字符串) 放进任何单行输出之前。
 */
export function sanitizeLine(text: string): string;

/**
 * 多行块净化 (自 CLI `render.ts` 上移至 API 包 `display.ts`): 是 sanitizeLine 的薄包装,
 * 差别只有一处: **保留每行的行首缩进** (这本身就是一种分级排版手段), 行内其余空白照常折叠。
 * 用途: 逐行写出多行诊断 (告警清单、块状日志), 缩进不丢。
 * 与 sanitizeLine 的分工: 整块多行输出用本函数; 单行字段 (路径、名字) 用 sanitizeLine。
 */
export function sanitizeOutputLine(text: string): string;
```

> 为什么这三个进 API 包而不是留 CLI 包: (1) 场景 1 与场景 6 的示例代码明确要从 API 包拿 `formatBytes`; (2) OF-14 已声明「输出面净化是全输出面共用的唯一实现, 各输出面不得另写一份」, 拆包后内嵌方 (场景 3 / 6) 若拿不到它, 只能各写一份, 那条契约当场失效; (3) 三者都是纯函数、零 IO、零打印, 不破坏库的静默契约。
> `render()` / `RenderOptions` / `bannerLine` / `neutralLine` / `paint` / `BAR_BLOCK` / `shortenHome` 全部留在 CLI 包: 它们是**这一套 CLI 的视觉规范**, 不是通用数据表达。

### 2.7 编排层

```ts
// 编排器: 新增 (cli.ts sweep() 的公开化, 见 §7.5)
export interface SweepPolicy {
  /**
   * 连同疑似安装树一并纳入删除批 (对应 CLI 的 `--force`, BC-38)。
   * 缺省 false。只影响批次构造, 不放宽安全闸不变量。
   * 跨设备目标不受本字段影响: 恒不进删除批 (BC-41), 解除路径是声明独立根或先卸载。
   */
  releaseSuspects: boolean;
}

export interface SweepOptions {
  /** 扫描根 (必填, 非空; 库不读平台配置, 由调用方决定扫什么) */
  roots: string[];
  /** 排除名单; 缺省取 DEFAULT_EXCLUDE (与配置省略该字段时的行为同源, BC-20) */
  exclude?: string[];
  /** 包含名单; 缺省 [] (不过滤) */
  include?: string[];
  /** 家目录 (清单缩写与隐藏目录形态判定共用的同一份语义); 缺省 os.homedir(), null 关闭 home 本体防线 */
  home?: string | null;
  /** 路径风格; 缺省平台原生 (测试注入用) */
  style?: PathStyle;
  /** 安全策略; 缺省 { releaseSuspects: false } */
  policy?: SweepPolicy;
}

export interface ResolvedSweepOptions {
  roots: string[];
  /** 已过 mergeNames 收口的生效名单 (去重 + 静默剔除永不生效名, BC-34) */
  exclude: string[];
  include: string[];
  home: string | null;
  style: PathStyle;
  policy: SweepPolicy;
}

/** 只读面调用选项 (plan) */
export interface SweepPlanOptions {
  /** 进度回调; 阶段事件 + 原语层事件透传 (粒度见 §4.2) */
  onProgress?: (event: SweepProgressEvent) => void;
  /** 取消信号; 透传到各层 */
  signal?: AbortSignal;
}

/** 执行面调用选项 (run): 在只读面选项之上加「对账」与「陈旧容忍」两项 */
export interface SweepRunOptions extends SweepPlanOptions {
  /**
   * 期望批次 (通常是先前 `plan().batch`, 新增, 回答体验报告 5-1)。
   * 提供时本次删除面 = 期望批次 ∩ 本次实时批次:
   * - 期望批次里已被删掉/被策略挡下的目标不再删 (报告里给 `drift.removed`);
   * - 本次新出现、不在期望批次里的目标**不删** (报告里给 `drift.added`, 条目结果
   *   为 `{ kind: 'not-expected' }`), 这正是「用户点头的那份清单」与「真正被删的
   *   那份清单」之间的对账点; 未提供时本次批次即为实时批次。
   * 无论提供与否, 判定链上的每个事实仍是此刻的事实 (仍重跑扫描与安全闸), 故
   * 期望批次不是「拿旧计划执行」, 而是「给本次执行加一圈用户已批准的范围」。
   */
  expectedBatch?: readonly string[];
  /** 安全闸之前已不存在的目标如何处置; 缺省 'reject' (语义与 RemoveBatchOptions 同款) */
  staleTargets?: 'reject' | 'missing';
}

export interface Sweeper {
  /** 本次实际生效的选项 (合并缺省后的只读快照, 供审计与日志) */
  readonly options: Readonly<ResolvedSweepOptions>;
  /** 只读: 扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除 */
  plan(options?: SweepPlanOptions): Promise<SweepPlan>;
  /** 执行: 重跑 plan, 经安全闸删除, 出报告 */
  run(options?: SweepRunOptions): Promise<SweepReport>;
}

/**
 * 构造编排器。`roots` 为空 / 非字符串数组等参数错误**在构造期同步抛出**
 * (新增说明, 回答体验报告 1-6 / 5-5 / U14): 同步 API 同步抛, 让调用方尽早失败,
 * 也为 CLI 侧省掉一层 try 缩进。其余异步入口 (scan / measure / validate / remove /
 * plan / run) 的参数与环境错误一律以 rejected promise 形式抛出 (同一规则的另一半)。
 */
export function createSweeper(options: SweepOptions): Sweeper;
```

```ts
// 编排层的数据形态
export type SweepPhase =
  'scan' | 'measure' | 'classify' | 'device' | 'plan' | 'validate' | 'remove';

/** 逐目标的领域条目: 一次清理里一个 node_modules 的完整状态 (进入 §2.7 的 SweepPlan) */
export interface SweepEntry {
  /** node_modules 绝对路径 (扫描原拼写, 非 realpath 形态) */
  target: string;
  /** 直接包含 node_modules 的项目目录 (绝对路径; 显示用的短名由渲染层自己取 basename) */
  project: string;
  /** 所属扫描根 (新增, 见 §7.4) */
  root: string;
  /** 字节数; undefined = 体积测不到 (与 0 严格可分) */
  bytes?: number;
  /** 有 bytes 时必在: 本次调用的体积口径 */
  basis?: SizeBasis;
  /** 类别 (语义闸判定, BC-37) */
  kind: TargetKind;
  /** suspect 时的中文理由 */
  kindReason?: string;
  /** 与所属根跨设备时给出形态; 同设备时缺省 */
  crossDevice?: CrossDeviceKind;
  /** 体积未测到时的机器可判别原因 */
  unmeasuredCode?: UnmeasuredCode;
  /** 体积未测到时的人话原因 */
  unmeasuredReason?: string;
  /** 是否进入删除批次 (policy 已应用) */
  inBatch: boolean;
  /** inBatch 为 false 时的机器可判别原因 (与 plan.skipped 逐条一致) */
  skipReason?: SkipReason;
  /**
   * inBatch 为 false 时的中文行尾说明 (新增, 回答体验报告 1-5 / 3-6 / 5-4 / U4)。
   * 恒等于同 target 的 `plan.skipped[].note` 与 `SkipBook.entries[].note`;
   * 随条目携带, 是为了让「目标 + 为什么跳过」的复核表不必再按 target join 两份数组。
   */
  skipNote?: string;
}

/** 编排层报出的体积口径 (新增): 本次调用的单值口径; 无任何可测目标时缺省 */
export interface SweepPlan {
  /** 生效的根 (原样回显) */
  roots: string[];
  /** 生效的排除 / 包含名单 (已过 mergeNames 收口, 供审计) */
  exclude: string[];
  include: string[];
  /** 本计划所用的安全策略 */
  policy: SweepPolicy;
  /** 本次体积口径 (与逐条 entry.basis 同源同值; 无目标时缺省) */
  basis?: SizeBasis;
  /** 逐目标领域条目: 保扫描的 target 升序; 测量时已不存在的目标 (BC-13) 不产生条目 */
  entries: SweepEntry[];
  /** 删除批次 (与 deletionBatch 同源, 保清单顺序): policy 已应用 */
  batch: string[];
  /** 批次外目标与原因 (含未测到体积的条目) */
  skipped: SkippedTarget[];
  /** 扫描与体积的非致命告警 (两段合并, 保各自次序) */
  warnings: SweepWarning[];
  /** 两份名单的命中统计 (供 CLI 出名单回执与未命中告警, BC-09 / BC-33) */
  nameMatches: { exclude: NameMatch[]; include: NameMatch[] };
}

export type SweepRunStatus =
  /** 批次非空且通过安全闸, 已执行删除 (逐条成败见 removal) */
  | 'executed'
  /** 安全闸整批拒绝, 零删除 (BC-22) */
  | 'rejected'
  /** 批次为空 (无可删目标), 零删除 */
  | 'nothing-to-do';

export type EntryOutcome =
  /** 删除成功 */
  | { kind: 'removed' }
  /** 删除阶段核验确认目标已不存在 (EC-01 / EC-07), 计成功侧 */
  | { kind: 'missing' }
  /**
   * 安全闸之前目标已不存在, 按 `staleTargets: 'missing'` 从批次摘出 (新增)。
   * 与 missing 的区别是**出处**: missing 由删除器核验过, stale 从未进入删除面;
   * 两者同属「目标已达成」, 同计成功侧。
   */
  | { kind: 'stale' }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'rejected'; rejection: RejectedTarget }
  /** 批次内但未轮到 (整批中止时中止点及其之后) */
  | { kind: 'not-attempted'; code: AbortCode }
  /**
   * 在期望批次之外 (提供了 expectedBatch, 且本目标不在其中, 新增)。
   * 语义是「本次没让它进删除面」, 与 skipped 的区别: skipped 是安全策略挡下,
   * not-expected 是调用方给的范围挡下。
   */
  | { kind: 'not-expected' }
  | { kind: 'skipped'; reason: SkipReason };

export type EntryOutcomeKind = EntryOutcome['kind'];

/** 期望批次与实时批次的差集 (新增, 回答体验报告 5-1 / G9); 未提供 expectedBatch 时缺省 */
export interface SweepDrift {
  /** 在实时批次但不在期望批次: 本次新出现的目标 (未删) */
  added: string[];
  /** 在期望批次但不在实时批次: 已消失或被策略挡下的目标 (未删) */
  removed: string[];
}

export interface SweepOutcomeEntry extends SweepEntry {
  outcome: EntryOutcome;
}

export interface SweepReport {
  status: SweepRunStatus;
  /**
   * 本次执行所依据的**实时**计划。与先前 `plan()` 的结果不一致时,
   * 以本字段为准 (回答体验报告 G9); 两者的差异另由 `drift` 显式给出。
   */
  plan: SweepPlan;
  /** 进入安全闸时的校验结果; status 为 nothing-to-do 时缺省 */
  validation?: ValidationResult;
  /** 删除分桶; 未执行删除 (整批拒绝 / 空批) 时缺省 */
  removal?: RemovalResult;
  /** 逐目标的执行结果 (与 plan.entries 同序同长) */
  entries: SweepOutcomeEntry[];
  /** 按 staleTargets: 'missing' 摘出的已消失目标 (保输入顺序); 未开启时为空数组 */
  stale: string[];
  /** 释放量: 成功侧 (removed + missing + stale) 的体积累计, 口径与 CLI 汇总行同源 */
  releasedBytes: number;
}
```

```ts
// 结果判据 (新增): 让「成功侧」的定义与库同源, 并把「退出码怎么定」交还调用方
export function isSuccessOutcome(outcome: EntryOutcome): boolean;
export interface SweepSummary {
  /** 逐 kind 计数 (EntryOutcome 的每种 kind 恒有一项, 缺省 0) */
  counts: Record<EntryOutcomeKind, number>;
  /** 成功侧: removed + missing + stale */
  succeeded: number;
  /** 未处理 (非失败): skipped + rejected + not-attempted + not-expected */
  unprocessed: number;
  /** 真失败: failed */
  failed: number;
  /** 是否发生了整批中止 (存在 removal.aborted) */
  aborted: boolean;
}
export function summarizeReport(report: SweepReport): SweepSummary;
```

**成功侧与退出码的口径划分 (新增, 回答体验报告 5-2)**

| 层次                           | 口径                                                                | 归属                   |
| ------------------------------ | ------------------------------------------------------------------- | ---------------------- |
| 条目层「达成没有」             | `removed` / `missing` / `stale` 为真, 其余为假                      | 库: `isSuccessOutcome` |
| 计数                           | 见 `SweepSummary` (succeeded / unprocessed / failed / aborted 四档) | 库: `summarizeReport`  |
| 「本次运行算不算成功」(退出码) | **调用方自定**; 库不内置 `ok` 字段                                  | 调用方                 |

库不内置 `ok` 的理由: 「跳过算不算失败」是**产品口径**, 不是数据事实。CLI 包 (`sweep-nm`) 的口径是「有跳过项或未测到目标即退 1」(实读 `cli.ts` 的退出码注释与 BC-26, 用意是让 `--force` 的缺失可见), 而一个交互式第三方 CLI 更可能希望「用户已确认的清理成功即退 0, 跳过只作提示」。两者都合理, 库替调用方决定反而不对。三种常见口径的配方 (新增):

```ts
// ① 严格 (与 CLI 包同口径): 任何未处理项或失败都算失败
const strict =
  summary.failed === 0 &&
  summary.unprocessed === 0 &&
  !summary.aborted &&
  report.status !== 'rejected';

// ② 宽松 (交互式): 只有真失败与整批中止算失败, 跳过/未处理只提示
const relaxed =
  summary.failed === 0 && !summary.aborted && report.status !== 'rejected';

// ③ 只读面: 任何「没删成」都不算失败, 只报数字
const readOnly = true;
```

`isSuccessOutcome` 的价值在于「随版本新增 kind 时不会静默漏判」: 手写的 `every(kind !== 'x' && kind !== 'y')` 在库里新增一种成功侧 kind 后会把新 kind 误判为失败, 而库函数跟着版本走。

### 2.8 导出面计量与稳定性分级

| 分级                   | 内容                                                                                    | 承诺                                |
| ---------------------- | --------------------------------------------------------------------------------------- | ----------------------------------- |
| 冻结 (1.0 起只增不改)  | 全部域类型字段名、`code` 取值、`SkipReason` 取值、函数签名、`EntryOutcome` 的 kind 取值 | 破坏性改动须走主版本                |
| 冻结但允许新增可选字段 | 选项对象 (`ScanOptions` / `MeasureOptions` / `SweepOptions` / `SweepRunOptions` …)      | 加字段是 minor                      |
| 允许演化               | `message` / `reason` / `note` 的中文措辞                                                | 不承诺逐字稳定 (本期与现状逐字一致) |
| 不承诺                 | 进度事件的**顺序** (并发完成序)、`warnings` 内部次序                                    | 结果序有承诺, 事件序无承诺          |

**code 类型别名全表 (补齐, 回答体验报告 1-7 / U8)**: 这些名字在本文档里被当类型用, 逐条定义如下:

| 别名                | 定义                                                 | 取值表                   |
| ------------------- | ---------------------------------------------------- | ------------------------ |
| `ScanWarningCode`   | 扫描段告警码                                         | §3.2 扫描告警表 (5 个)   |
| `SizeWarningCode`   | 体积段告警码                                         | §3.2 体积告警表 (5 个)   |
| `SweepWarningCode`  | `ScanWarningCode \| SizeWarningCode` (并集, 回答 G6) | 同上两表之和 (10 个)     |
| `UnmeasuredCode`    | 未测到原因码                                         | §3.2 未测到表 (6 个)     |
| `GuardCode`         | 安全闸拒绝码                                         | §3.2 拒绝表 (10 个)      |
| `RemoveFailureCode` | 删除失败码                                           | §3.2 失败表 (4 个)       |
| `AbortCode`         | 整批中止码                                           | §3.2 中止表 (3 个)       |
| `SweepErrorCode`    | 抛错码                                               | §3.2 配置与调用表 (6 个) |
| `SweepErrorDetails` | 抛错附带的上下文                                     | §3.6 判别联合            |

穷举 `switch` 的写法建议 (回答 G6): 按 `SCAN_*` / `SIZE_*` 前缀分组, 且 `default` 分支必须**记录 code 原文**而不是静默归入「其他」。新增 code 属 minor 版本, 老调用方应至少看得见它。

> 计量口径: 本文档的导出面共 **41 个值导出** (函数 / 常量 / 错误类) + **73 个类型导出** (含 §3.2 声明的 8 个 code 取值集与 `SweepErrorDetails`)。数量本身不进契约 (会随版本变), 此处只作核对用。

---

## 3. 错误模型

### 3.1 两条通道: 什么时候返回值, 什么时候抛错

**规则 (设计): 能列出结果的失败走返回值; 无法开始或无法继续的失败才抛错。**

| 档             | 例子                                                           | 通道                                                                               | 理由                                                                            |
| -------------- | -------------------------------------------------------------- | ---------------------------------------------------------------------------------- | ------------------------------------------------------------------------------- |
| 域内可预期失败 | 安全闸拒绝、删除失败、整批中止、体积测不到、保守默认跳过       | **返回值** (`rejected` / `failed` / `aborted` / `unmeasured` / `gone` / `skipped`) | 它们是「本次运行的结果」, 调用方要的正是这份结果; 抛错会把结果丢掉              |
| 参数错误       | 空 `roots`、非字符串数组                                       | **同步 throw** (`createSweeper` 等同步入口) / **rejected promise** (其余异步入口)  | 无法开始, 没有结果可言; 同步入口同步抛, 便于尽早失败 (写死时机)                 |
| 配置错误       | 配置读取失败 / JSON 损坏 / 形状不符 / 显式来源指向的文件不存在 | **抛 `SweepError`**                                                                | 错误类型与 code 体系见 §3.6                                                     |
| 取消           | 任一层的 `signal` 被 abort                                     | **抛 `SweepError`** (`CANCELLED`)                                                  | 语义是「本次未完成」, 不是「本次结果是空」; 删除阶段另附已完成的分桶, 见 §4.3   |
| 未预期异常     | 库内部的真异常 (如 `scan-parallel` 暂存的非预期失败)           | **原样冒泡**                                                                       | 保持现状的失败响亮 (实读 `scan-parallel.ts` 的 `failures` 暂存位), 不包装、不吞 |

### 3.2 code 体系 (机器可判别的判别值)

命名规则 (设计): `<域>_<判定>`, 全大写蛇形; 域取自模块 (`SCAN` / `SIZE` / `GUARD` / `REMOVE` / `CONFIG` / `SWEEP`); 不加包名前缀。**code 一经发布即冻结, 只增不改**; 废弃走文档标注, 不回收取值。

取值集的类型声明 (补齐, 回答体验报告 1-7 / U8; 下方各表是它们的定义处):

```ts
export type ScanWarningCode =
  | 'SCAN_ROOT_MISSING'
  | 'SCAN_ROOT_UNREADABLE'
  | 'SCAN_ROOT_NOT_DIR'
  | 'SCAN_ROOT_UNAVAILABLE'
  | 'SCAN_DIR_UNREADABLE';
export type SizeWarningCode =
  | 'SIZE_DU_OUTPUT_MISMATCH'
  | 'SIZE_DU_LINE_UNATTRIBUTED'
  | 'SIZE_SUBPATH_FAILED'
  | 'SIZE_TARGET_VANISHED'
  | 'SIZE_DU_UNAVAILABLE';
/** 并集别名: 后续新增告警域时随之扩展 */
export type SweepWarningCode = ScanWarningCode | SizeWarningCode;
export type UnmeasuredCode =
  | 'SIZE_UNMEASURED_PERMISSION'
  | 'SIZE_UNMEASURED_NOT_DIR'
  | 'SIZE_UNMEASURED_LOOP'
  | 'SIZE_UNMEASURED_UNPARSEABLE'
  | 'SIZE_UNMEASURED_CONTROL_CHAR'
  | 'SIZE_UNMEASURED_OTHER';
export type GuardCode =
  | 'GUARD_LEAF_NOT_NODE_MODULES'
  | 'GUARD_TARGET_MISSING'
  | 'GUARD_TARGET_UNREADABLE'
  | 'GUARD_REALPATH_FAILED'
  | 'GUARD_ROOT_ANCHOR_SYMLINK'
  | 'GUARD_FILESYSTEM_ROOT_BODY'
  | 'GUARD_HOME_BODY'
  | 'GUARD_REAL_LEAF_NOT_NODE_MODULES'
  | 'GUARD_OUTSIDE_ROOTS'
  | 'GUARD_DUPLICATE_TARGET';
export type RemoveFailureCode =
  | 'REMOVE_FAILED'
  | 'REMOVE_ENOENT_SURVIVOR'
  | 'REVIEW_UNVERIFIED'
  | 'REVIEW_COMPONENT_VANISHED';
export type AbortCode =
  | 'REVIEW_NOT_UNDER_ANY_ROOT'
  | 'REVIEW_HEAD_SYMLINK'
  | 'REVIEW_COMPONENT_REPLACED';
export type SweepErrorCode =
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_CORRUPT_JSON'
  | 'CONFIG_CORRUPT_SHAPE'
  | 'CONFIG_ABSENT'
  | 'INVALID_ARGUMENT'
  | 'CANCELLED';
```

**一条硬纪律 (新增)**: 同一个 code 不得合并「处置方向相反」的语义。反例即初稿的 `GUARD_REALPATH_FAILED`: 它同时盖住「目标不存在」(应可容忍、可续跑) 与「目标不可读」(必须整批拒绝), 于是调用方只能靠匹配中文 message 分流, 既违反 §3.3 的自家纪律, 又堵死并发清理、断点续跑、重复点击三条路 (体验报告 1-1 / 3-3 / 3-5 / 4-2)。

**扫描告警 (ScanWarningCode)**: `SweepWarning.code` 的取值, 进 `ScanResult.warnings`:

| code                    | 触发 (实读判定点)                              | 附带的字段      |
| ----------------------- | ---------------------------------------------- | --------------- |
| `SCAN_ROOT_MISSING`     | 根预检 realpath 报 ENOENT                      | `path` = 根     |
| `SCAN_ROOT_UNREADABLE`  | 根预检 EACCES / EPERM                          | `path`, `errno` |
| `SCAN_ROOT_NOT_DIR`     | 根预检 ENOTDIR, 或 realpath 成功而类型不是目录 | `path`          |
| `SCAN_ROOT_UNAVAILABLE` | 其余根预检失败 (带原始码)                      | `path`, `errno` |
| `SCAN_DIR_UNREADABLE`   | 遍历中 readdir 失败                            | `path` = 目录   |

**体积告警 (SizeWarningCode)**: 进 `SizeResult.warnings`, **只作事件, 不作划分**:

| code                        | 触发                                                 | 归属桶 (补, 回答体验报告 2-1 / U9)                    |
| --------------------------- | ---------------------------------------------------- | ----------------------------------------------------- |
| `SIZE_DU_OUTPUT_MISMATCH`   | du 输出与输入集合不符, 本批整体降级                  | 无 (整批降级: 全部入 `unmeasured`)                    |
| `SIZE_DU_LINE_UNATTRIBUTED` | du 的 stderr 行解析不出归属                          | 无                                                    |
| `SIZE_SUBPATH_FAILED`       | 目标之内的路径失败 (部分降级, 该目标结果仍有效)      | 无                                                    |
| `SIZE_TARGET_VANISHED`      | 目标不存在 (`体积统计失败 (不存在)`)                 | **`SizeResult.gone`** (不入 `entries` / `unmeasured`) |
| `SIZE_DU_UNAVAILABLE` (补)  | du 候选探测失败 (两路径均不存在), 本候选跳过体积统计 | 无 (候选级降级; 生产路径由门面兜底, 仅测试注入可达)   |

**未测到 (UnmeasuredCode)**: 进 `SizeResult.unmeasured[].code`:

| code                           | 触发                          |
| ------------------------------ | ----------------------------- |
| `SIZE_UNMEASURED_PERMISSION`   | 权限不足, 无法读取            |
| `SIZE_UNMEASURED_NOT_DIR`      | 不是目录                      |
| `SIZE_UNMEASURED_LOOP`         | 符号链接层级过深              |
| `SIZE_UNMEASURED_UNPARSEABLE`  | 输出不可解析 (含整批降级路径) |
| `SIZE_UNMEASURED_CONTROL_CHAR` | 路径含控制字符 (前置拒绝)     |
| `SIZE_UNMEASURED_OTHER`        | 其余读取失败 (带原始 errno)   |

> 初稿那张并排的表已拆成两张并加了「归属桶」列: `SIZE_TARGET_VANISHED` **只进 `SizeResult.gone` 与 `warnings` 的事件条**, 绝不进 `unmeasured`。

**安全闸拒绝 (GuardCode)**: 逐条对应实读的 `validateTargets` 分支, 判定顺序与中文文案均不动; realpath 失败按 errno 分三类:

| code                               | 现状文案 (message 逐字保留)                                                       | details                                           |
| ---------------------------------- | --------------------------------------------------------------------------------- | ------------------------------------------------- |
| `GUARD_LEAF_NOT_NODE_MODULES`      | 路径末段不是 node_modules                                                         | —                                                 |
| `GUARD_TARGET_MISSING` (新增)      | realpath 失败 (目标不存在或不可读)                                                | `{ errno: 'ENOENT' }`                             |
| `GUARD_TARGET_UNREADABLE` (新增)   | realpath 失败 (目标不存在或不可读)                                                | `{ errno: 'EACCES' \| 'EPERM' }`                  |
| `GUARD_REALPATH_FAILED` (语义收窄) | realpath 失败 (目标不存在或不可读)                                                | `{ errno }` = 其余 errno (ELOOP / ENOTDIR / 未知) |
| `GUARD_ROOT_ANCHOR_SYMLINK`        | 根锚点被换位为符号链接 (根: X; 符号链接: Y), 请把配置根改为不含符号链接的真实路径 | `{ root, symlink }`                               |
| `GUARD_FILESYSTEM_ROOT_BODY`       | 目标是文件系统根本体                                                              | —                                                 |
| `GUARD_HOME_BODY`                  | 目标是 home 本体                                                                  | —                                                 |
| `GUARD_REAL_LEAF_NOT_NODE_MODULES` | realpath 后的末段不是 node_modules                                                | —                                                 |
| `GUARD_OUTSIDE_ROOTS`              | realpath 后不在任何 root 之下                                                     | —                                                 |
| `GUARD_DUPLICATE_TARGET`           | 重复目标 (realpath 去重)                                                          | —                                                 |

> 三个码共用同一句中文 `message` (现状文案逐字保留, 黑盒语料与 CLI 打印因此零变化), 机器分流只走 `code` 与 `details.errno`。拆分的判定依据是**处置方向**: `GUARD_TARGET_MISSING` 是唯一可被 `staleTargets: 'missing'` 容忍的一类 (目标已达成); 另两类必须维持整批拒绝。

**删除失败与中止 (RemoveFailureCode / AbortCode)**

| code                        | 现状文案 (message 逐字保留)                                                                                 | partialRisk |
| --------------------------- | ----------------------------------------------------------------------------------------------------------- | ----------- |
| `REMOVE_FAILED`             | `<errno>: <人话> (目标: …; 注意: 目录内容可能已被部分或全部删除, 请复查)`                                   | true        |
| `REMOVE_ENOENT_SURVIVOR`    | `ENOENT: 删除中途失败 (复核确认目标仍存在 / 目标是否仍存在未能核验) (…)`                                    | true        |
| `REVIEW_UNVERIFIED`         | `安全复核未完成 (<码: 人话>) (目标: …; 组件: …; 未执行删除)`                                                | false       |
| `REVIEW_COMPONENT_VANISHED` | `安全复核未完成 (ENOENT: 路径组件消失) (…; 请复查目标是否仍存在; 未执行删除; 若目标确已不存在, 可忽略此条)` | false       |
| `REVIEW_NOT_UNDER_ANY_ROOT` | `安全复核失败 (目标不在任何 roots 之下): <target>` (aborted)                                                | 不适用      |
| `REVIEW_HEAD_SYMLINK`       | `安全复核失败 (根被替换为符号链接): <configured>` (aborted)                                                 | 不适用      |
| `REVIEW_COMPONENT_REPLACED` | `安全复核失败 (路径组件被替换): <path>` (aborted)                                                           | 不适用      |

> `partialRisk` 是 EC-05 半完成语义的机器化: 为 true 的条目意味着「删过, 内容可能残缺」, 调用方据此决定是否提示人工复查; 为 false 意味着「未执行删除」。

**配置与调用错误 (SweepErrorCode)**

| code                   | 触发                                        | details               |
| ---------------------- | ------------------------------------------- | --------------------- |
| `CONFIG_READ_FAILED`   | 读文件失败 (非 ENOENT)                      | `{ path, errno? }`    |
| `CONFIG_CORRUPT_JSON`  | JSON 解析失败                               | `{ path }`            |
| `CONFIG_CORRUPT_SHAPE` | 顶层或字段形状不符 (逐字段原因进 message)   | `{ path, field }`     |
| `CONFIG_ABSENT`        | 显式来源 (旗标 / 环境变量) 指向的文件不存在 | `{ path, source }`    |
| `INVALID_ARGUMENT`     | 调用方传参非法 (如 `roots` 为空)            | `{ field }`           |
| `CANCELLED`            | `signal` 被 abort                           | `{ phase, partial? }` |

**跳过原因 (SkipReason)**: 复用场景 4 提的取值, 与 `classify.ts` / `guard.ts` 的既有判定同源:

```ts
export type SkipReason =
  | 'suspect-install-tree' // 语义闸 (BC-37 / BC-38)
  | 'cross-device:on-path' // 设备边界 (BC-41)
  | 'cross-device:target-itself' // 设备边界 (BC-41)
  | 'unmeasured'; // 体积未测到, 不执行删除 (BC-15)
```

> 注意 `unmeasured` 与 `stale` 的分界: 体积测不到是「存在但测不出」, 进不了批; 目标已不存在是「没有东西可测」, 走 `gone` 桶与 `staleTargets` 策略, 二者不混。

### 3.3 code 与中文人话的职责划分 (并存规则)

| 维度     | `code`                  | `message` / `reason` / `note` (中文)                          |
| -------- | ----------------------- | ------------------------------------------------------------- |
| 面向     | 程序分支                | 人类读者 (终端、job summary、日志)                            |
| 稳定性   | 冻结, 只增不改          | 措辞可随版本演化, **本期与现状逐字一致**                      |
| 唯一性   | 同一 code 恒指同一判定  | 同一判定可有多套措辞; 三个 realpath 码共用一句 message 即此例 |
| 可否丢弃 | 不可 (程序判断只许看它) | 可 (调用方要本地化就丢掉它, 用 code + details 自造)           |
| 权威     | 本文档 §3.2 的表        | 现状文案 (实读各模块的字面量)                                 |

三条落地纪律 (设计):

1. 程序判断**只许看 code 与 details**, 严禁对 message 做字符串匹配或前缀解析。
2. `message` 必须做到「不做本地化也能读」, 它是兜底而非占位; 因此不许把它写成 `code` 的英文回显。
3. `details` 装着被格式化进文案的定位信息 (根 / 链接 / 组件 / 字段 / errno), 让本地化的调用方不必去 message 里抠路径。

**纪律 1 的可满足性自检 (新增)**: 初稿的 `GUARD_REALPATH_FAILED` 满足不了纪律 1 (体验报告 1-1); 拆码 + 补 `errno` 后, 全部拒绝码都能被程序分流; 本地化文案也不再需要「已不存在或不可读」这类含糊兜底。**任何后续新增 code 都必须先过这条自检**: 「调用方看到这个码, 能不能不必读 message 就决定下一步?」

### 3.4 与既有 BC / EC 编号体系的关系

**关系定性 (设计): 编号体系与 code 体系并列而不同职能, 不复用编号当 code。**

| 体系              | 是什么                                                                                           | 覆盖面                                           | 生命周期                         |
| ----------------- | ------------------------------------------------------------------------------------------------ | ------------------------------------------------ | -------------------------------- |
| BC / OF / EC 编号 | **行为条款编号**, 面向「转写与验收」的语料背书 (实读 `docs/sweep/protocol/behavior-contract.md`) | 全行为面 (含非错误的形态约束, 如 OF-05 体积格式) | 会随设计演进拆分 / 合并 / 重编号 |
| 本文档的 `code`   | **调用期判别值**, 面向程序分支                                                                   | 失败 / 跳过 / 告警 / 未测到                      | 发布即冻结                       |

**复用哪些** (语义与判定逐条复用, 不新造判定): 全部判定原样来自现有代码分支; EC-01 (TOCTOU 归 missing)、EC-02 (整批拒绝)、EC-03 (win32 与 du 平台守卫)、EC-04 (符号链接只删链接)、EC-05 (半完成语义 → `partialRisk`)、EC-07 (ENOENT 两分 → `REMOVE_ENOENT_SURVIVOR`)、EC-08 (命令解析面不含 cwd, 属 CLI 侧) 各自的判定一个不改。

**新增哪些**: code 命名空间本身 (9 个别名)、`SweepError` 类型、三处结构化字段 (`RejectedTarget.code` / `TargetFailure.code` / `SweepWarning.code`)、`SkipReason` 编码、`partialRisk` 机器标记、`errno` 字段、`SizeResult.gone` 桶、`staleTargets` 容忍开关。

**平移为 API 契约底稿的条款** (观察 8 的请求, 逐条落到本设计的哪个字段):

| 条款                            | 平移到 API 契约的表达                                                                                                                                                      |
| ------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| BC-04 / BC-06                   | `ScanResult.hits` 按 target 升序、realpath 去重                                                                                                                            |
| BC-07 / BC-08                   | `ScanResult.warnings` 结构化, 单根失效不中断                                                                                                                               |
| BC-09 / BC-33                   | `ScanResult.excludeMatches` / `includeMatches` (必填, 未命中名也在列)                                                                                                      |
| BC-13 / BC-14                   | `SizeResult.gone` 与 `unmeasured` 分桶; 划分完备性恒等式 (§2.2)                                                                                                            |
| BC-15                           | `unmeasured` 条目不进 `plan.batch`                                                                                                                                         |
| BC-20 / BC-34                   | `SweepOptions.exclude` 缺省取 `DEFAULT_EXCLUDE`; `mergeNames` 收口                                                                                                         |
| BC-21 / BC-22 / EC-02           | `BatchOutcome` 判别联合: 任一被拒即零删除; **例外见下**                                                                                                                    |
| BC-24 / BC-25 / EC-05 / EC-07   | `RemovalResult` 三桶 + `TargetFailure.message` + `partialRisk`                                                                                                             |
| BC-26                           | 退出码口径属 CLI 包; 库侧只给 `SweepSummary` 与三种配方 (§2.7)                                                                                                             |
| BC-37 / BC-38                   | `classifyTarget` + `SweepPolicy.releaseSuspects` + `SkipCandidate.suspect` 必填                                                                                            |
| BC-39                           | `RejectedTarget.code = GUARD_ROOT_ANCHOR_SYMLINK` + `details`                                                                                                              |
| BC-41                           | `SkipReason` 的两个 `cross-device:*` 取值; 不受 policy 影响                                                                                                                |
| BC-12 / EC-03                   | `SizeResult.basis` 与 `Sizer.basis`                                                                                                                                        |
| EC-01 / EC-04                   | `missing` 归成功侧; 符号链接只删链接; **同一「已达成」定性前延到安全闸阶段的 `stale`**                                                                                     |
| **新增条款 (已登记为 BC-42)** A | 「安全闸的整批拒绝规则存在一个窄例外: 显式开启 `staleTargets: 'missing'` 时, 仅 `GUARD_TARGET_MISSING` 不触发整批拒绝, 改判 `stale` 并计成功侧; 其余拒绝码一律维持零删除」 |
| **新增条款 (已登记为 BC-43)** B | 「`SizeResult` 三桶构成入参的全划分 (完备性恒等式), 且两两不相交」                                                                                                         |
| **新增条款 (已登记为 BC-44)** C | 「进度事件流以终结事件收尾: `plan()` 末事件恒为 `plan-done`, `run()` 末事件恒为 `done`, 之后不再有事件」                                                                   |

**OF 条款不进库契约**: OF-01 至 OF-15 全是字节级输出形态 (色块、列宽、`▍` 顶栏、清单走 stdout), 拆包后归 CLI 包自持; API 契约只承诺「返回什么数据」, 不承诺「怎么打印」。其中 OF-14 (输出面净化唯一实现) 是唯一需要跨包的一条, 处置是把 `sanitizeLine` / `sanitizeOutputLine` 提进 API 包 (§2.6)。

### 3.5 结构化告警的形状

```ts
export interface SweepWarning {
  /** 机器可判别的告警码 (类型见 §2.8: ScanWarningCode | SizeWarningCode) */
  code: SweepWarningCode;
  /** 中文人话全文 (逐字保留现状文案, CLI 直接打印这一条即与今天逐字节一致) */
  message: string;
  /** 涉及的路径 (根 / 目录 / 目标), 从文案里提出做字段 */
  path?: string;
  /** 原始 errno (若有) */
  errno?: string;
}
```

改动说明: `ScanResult.warnings` 与 `SizeResult.warnings` 从 `string[]` 变为 `SweepWarning[]`。CLI 侧的适配是一行 (`for (const w of warnings) warn(w.message, color)`), 输出逐字节不变。这是本文档里唯一一处**破坏性形状改动**, 依赖 §1.3 的窗口期一次做掉。

### 3.6 错误类型

```ts
/** 抛错附带的上下文 (补齐定义, 回答体验报告 U1 / G1); 判别联合, 按 code 取对应一支 */
export type SweepErrorDetails =
  | { path: string; errno?: string } // CONFIG_READ_FAILED
  | { path: string } // CONFIG_CORRUPT_JSON
  | { path: string; field: string } // CONFIG_CORRUPT_SHAPE
  | { path: string; source: ConfigSource } // CONFIG_ABSENT
  | { field: string } // INVALID_ARGUMENT
  | { phase: SweepPhase; partial?: RemovalResult }; // CANCELLED

/** 库抛出的唯一错误类型 (config / 参数 / 取消三档共用) */
export class SweepError extends Error {
  readonly name: 'SweepError';
  readonly code: SweepErrorCode;
  readonly details?: SweepErrorDetails;
  constructor(
    code: SweepErrorCode,
    message: string,
    details?: SweepErrorDetails,
  );
}

/**
 * 类型守卫 (新增, 回答体验报告 3-4 / U7): 不依赖类身份, 走「Error 形状 + name + code 取值」
 * 判别。扩展 / 打包环境里同一进程可能存在两份库实例, 此时 `instanceof SweepError`
 * 会假阴; 需要跨实例判别的调用方一律用它。
 */
export function isSweepError(value: unknown): value is SweepError;
```

**code → details 逐条对应 (补齐, 回答体验报告 U1 / G1)**:

| code                   | details 形状          | 备注                                                                                                                                                           |
| ---------------------- | --------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `CONFIG_READ_FAILED`   | `{ path, errno? }`    | —                                                                                                                                                              |
| `CONFIG_CORRUPT_JSON`  | `{ path }`            | —                                                                                                                                                              |
| `CONFIG_CORRUPT_SHAPE` | `{ path, field }`     | `field` 指出首个不符的字段名                                                                                                                                   |
| `CONFIG_ABSENT`        | `{ path, source }`    | 只有显式来源 (flag / env) 会抛; 平台默认缺席走 `state: 'absent'`                                                                                               |
| `INVALID_ARGUMENT`     | `{ field }`           | 构造期同步抛 (见 §2.7)                                                                                                                                         |
| `CANCELLED`            | `{ phase, partial? }` | `phase` 取 `SweepPhase` 全集 (7 个值都可能出现, 回答 G8); `partial` **只在 `phase === 'remove'` 时出现**, 且为「取消点为止已产生的分桶结果」的 `RemovalResult` |

设计说明: `SweepError` 是全仓「以 `createXxx()` 工厂交出实例、不导出类」惯例的**唯一例外** (实读惯例见 `docs/sweep/designs/architecture-overview.md`)。取例外的理由: 调用方要 `instanceof` 判别, 也要保留 `stack` / `cause` (跨实例场景 `instanceof` 用不了, 改用 `isSweepError`)。`class` 属可擦除语法, 不违反 ADR 0006 的语法约束。

---

## 4. 进度与取消模型

### 4.1 事件形态 (编排层)

```ts
export type SweepProgressEvent =
  | {
      kind: 'phase';
      phase: SweepPhase;
      status: 'start' | 'done';
      elapsedMs?: number;
    }
  | { kind: 'hit'; hit: ScanHit }
  | { kind: 'measured'; target: string; bytes: number; basis: SizeBasis }
  | { kind: 'unmeasured'; target: string; code: UnmeasuredCode; reason: string }
  | { kind: 'skipped'; target: string; reason: SkipReason }
  | { kind: 'removed'; target: string; outcome: 'removed' | 'missing' }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted'; aborted: AbortedBatch }
  | { kind: 'warning'; warning: SweepWarning }
  /** 只读面终结事件 (新增): plan() 的最后一个事件, 携带完整计划 */
  | { kind: 'plan-done'; plan: SweepPlan; elapsedMs: number }
  /** 执行面终结事件 (新增): run() 的最后一个事件 */
  | { kind: 'done'; status: SweepRunStatus; elapsedMs: number };
```

**终结事件契约 (新增, 回答体验报告 1-4 / 3-2 / U5)**: `plan()` 的事件流以 `plan-done` 收尾, `run()` 以 `done` 收尾, 两者之后不再有任何事件。这条契约的价值是把「流已结束」变成可判定的: 异步迭代桥接不再需要把 `plan()` 的 Promise 结果塞进队列当结束哨兵 (§8.6)。

### 4.2 落点与粒度

| 层     | 入口                     | 进度事件与粒度                                                                 | 取消检查点                                     |
| ------ | ------------------------ | ------------------------------------------------------------------------------ | ---------------------------------------------- |
| 扫描   | `Scanner.scan`           | `hit`: 每命中一处 (并发完成序, 不承诺顺序)                                     | 每个遍历任务开始前 (协作池内), 与阶段边界      |
| 体积   | `Sizer.measure`          | `measured` / `unmeasured` / `gone`: 每目标一条 (du 批量路径在解析完成后逐条发) | 逐目标之间; du 批量路径在调用前后各一次        |
| 类别   | `classifyTarget`         | 无 (纯函数、零 IO, 不需要进度)                                                 | 不适用                                         |
| 设备   | `findCrossDeviceTargets` | 无 (逐条 st_dev 比对, 开销远低于体积)                                          | 不适用 (无 signal 入参; 逐条比对很快)          |
| 安全闸 | `validateTargets`        | 无 (逐条 realpath, 快)                                                         | 逐目标之间                                     |
| 删除   | `removeTargets`          | `removed` / `missing` / `failed` / `aborted`: 每条目标一有结果就发             | **仅条目之间**, 绝不在单条 `rm` 中途 (见 §4.3) |
| 编排   | `Sweeper.plan` / `run`   | `phase` 阶段边界 + 上述原语事件透传 + `plan-done` / `done`                     | 透传到各层, 并在阶段切换处补一次               |

原语层的 `gone` 事件在编排层被过滤, 不入 `SweepProgressEvent` (消失目标由 `plan` / `report` 的结构化桶呈现; 实现见 `sweep.ts`)。

粒度选择依据: 场景 3 的面板要「每命中一处 / 每测到一批」, 场景 1 要「扫描完成 / 体积完成 / 进入删除」的阶段划分与一条整轮收尾 (由 `done` 满足), 场景 2 与 4 只要求可选打点。上表同时满足三类。

### 4.3 取消语义

- **取消的落点**: `signal` 在 `ScanOptions` / `MeasureOptions` / `ValidateOptions` / `RemovalOptions` / `RemoveBatchOptions` / `SweepPlanOptions` (含 `SweepRunOptions`) 六处都可传, 检查方式统一为「条目 / 任务边界查 `signal.aborted`, 为真则抛 `SweepError('CANCELLED')`」。
- **删除阶段的硬纪律 (设计, 安全底线)**: 取消**只在条目之间生效**。单条 `fs.rm` 不可中断, 强行中断只会制造新的半删状态 (EC-05 已登记的残余面), 所以库不试图在单条删除中途响应取消。取消发生时:
  - 删除阶段抛 `SweepError`, `details = { phase: 'remove', partial: RemovalResult }`, 其中 `partial` 是**全部已派发条目**中已产生结果的 `removed` / `missing` / `failed` (删除为有界并发执行: 取消检出后停止派发新条目, 在飞条目跑完并计入);
  - 未处理的条目既不入 `removed` 也不入 `failed` (它们从未被尝试), 调用方靠 `partial` 自己判断「哪些没动」。
- **其余阶段的取消**: 抛 `SweepError('CANCELLED')`, `details.phase` 标注阶段 (**取值域为 `SweepPhase` 全集**, 回答 G8; 只处理 `'remove'` 分支会漏掉扫描 / 阶段的取消); **不返回部分结果** (半截的扫描结果与半截的体积表都足以误导判断, 而调用方若需要边跑边攒, 进度回调就是那条通道)。
- **不可用的取消窗口 (登记)**: 取消信号在 `du` 子进程运行期间无法中断该子进程 (库不杀子进程, 杀进程会带来临时文件与信号语义的额外风险); 检查点落在批量调用前后。

### 4.4 回调契约

| 契约点     | 约定                                                                                       |
| ---------- | ------------------------------------------------------------------------------------------ |
| 调用方式   | 同步调用, 库不 `await` 回调返回值 (返回 Promise 会被忽略)                                  |
| 回调抛错   | 原样冒泡, 中断本次调用 (不吞错, 与「失败响亮」一致)                                        |
| 调用频率   | 高频 (每命中一处 / 每测到一个目标); 需要节流的调用方自行节流                               |
| 事件顺序   | **不承诺顺序** (并发完成序); 最终结果承诺有序 (hits 升序、桶保输入顺序)                    |
| 事件流边界 | 恒以终结事件收尾 (§4.1); 取消时终结事件不出现 (以抛错收场)                                 |
| 执行位置   | 回调在库的执行流程内同步执行, 调用方不得在回调里再次调用同一个 `Sweeper` 实例 (重入未定义) |

> **异步迭代形态 (修订估价)**: 场景 3 想要 `for await (const event of sweeper.watch(...))`。初稿把自桥估价为「三行」, 体验报告实测为约 50 行 (背压队列 + 结束哨兵 + 错误转发 + 提前 break 的取消联动), 该估价确实低估。本次处置: 终结事件 (§4.1) 消掉了「结束哨兵」这一项, 余下三项仍需约 20 行, 故**不新增 `watch()` 到库** (CLI 包不需要, 只有编辑器场景需要, 属 YAGNI), 但把**完整参考实现**写进文档 (§8.6), 并把估价更正为「约 20 行, 见 §8.6」。Q7 据此从「三行自桥」改为「文档给参考实现」。

---

## 5. 关键域类型

### 5.1 域类型总表 (API 包, 面向程序消费)

域类型的字段定义散见于 §2.2 至 §2.7 的签名块 (每处的注释即其契约), 此处只列**面向**与稳定性:

| 类型                                                                                                           | 面向     | 稳定性                             |
| -------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------------- |
| `ScanHit` / `ScanResult` / `Scanner` / `NameMatch`                                                             | 扫描结果 | 冻结                               |
| `SizeEntry` / `SizeResult` / `Sizer` / `SizeBasis` / `UnmeasuredEntry`                                         | 体积结果 | 冻结                               |
| `Classification` / `TargetKind`                                                                                | 类别判定 | 冻结 (取值集与 `classify.ts` 同源) |
| `RejectedTarget` / `ValidationResult` / `PathMapping` / `RejectionDetails`                                     | 安全闸   | 冻结                               |
| `TrustRoot` / `TargetFailure` / `AbortedBatch` / `RemovalResult`                                               | 删除     | 冻结                               |
| `CrossDeviceEntry` / `CrossDeviceKind`                                                                         | 设备边界 | 冻结                               |
| `SkipReason` / `SkippedTarget` / `SkipBook` / `SkipCandidate`                                                  | 跳过集册 | 冻结                               |
| `SweepEntry` / `SweepPlan` / `SweepReport` / `EntryOutcome` / `SweepDrift` / `SweepSummary` / `SweepRunStatus` | 编排结果 | 冻结                               |
| `SweepWarning` / 各组 code 类型                                                                                | 诊断     | code 冻结, message 可演化          |
| `Config` / `LoadConfigResult` / `ResolvedConfigPath`                                                           | 配置     | 冻结                               |

三条可序列化承诺 (设计, 供场景 1 / 2 / 4 依赖):

1. **落盘 / 审计域**类型是普通对象与数组, `JSON.stringify` 无损 (无类实例、无 `Map`、无 `Set`、无函数)。**查询辅助例外**: `SkipBook.hints` 与 `crossDeviceIndex()` 的返回值以 `ReadonlyMap` 呈现 (供程序化检索, 不属落盘域, 不参与本承诺)。**修正说明**: 初稿把 `findCrossDeviceTargets` 的 `Map` 返回列为例外, 体验报告 4-4 证实该例外会直接吃掉审计里的一整列 (对 `Map` 调 `JSON.stringify` 得到空对象), 故改为返回数组并另给 `crossDeviceIndex()` 供查询, 例外取消。
2. 时间无关: 域类型不带时间戳 (库不打时间, 时间由调用方在写入审计时自加); 唯一的例外是进度事件里的 `elapsedMs` (运行期观测值, 不落盘)。
3. 可跨会话复用: 形状不含运行时句柄, 今天写进 JSONL 的形状, 明天读回来仍能作为决策输入 (场景 4 的隔日执行)。

### 5.2 与渲染层类型的边界 (划清)

| 类型 / 函数                                                                    | 归属               | 判据                                                                             |
| ------------------------------------------------------------------------------ | ------------------ | -------------------------------------------------------------------------------- |
| `SweepEntry` (含 `bytes` / `kind` / `crossDevice` / `skipReason` / `skipNote`) | API 包             | 「这个目标是什么状态」是域事实                                                   |
| `RenderEntry` (`ok` / `error` / `note` / `suspect` 行尾串)                     | CLI 包             | 「这一行怎么印」是渲染决定                                                       |
| `SkipBook.trailer` / `.hints` / `crossDeviceNote`                              | API 包 (skip 模块) | 它们是**跳过语义的说明**, 与 `SkipReason` 同源同表, 拆开会漂移; CLI 只是打印它们 |
| `render()` / `bannerLine()` / `paint()` / `BAR_BLOCK`                          | CLI 包             | 视觉规范                                                                         |
| `formatBytes` / `sanitizeLine` / `sanitizeOutputLine`                          | API 包             | 纯函数, 与具体版式无关; OF-14 的唯一实现义务                                     |

**`skip.ts` 的解耦 (改动)**: 现状 `skipsBatch` / `deletionBatch` / `collectSkips` 的入参类型是 `RenderEntry` (实读 `skip.ts` 首行 `import type { RenderEntry } from './render.ts'`), 这是写入侧的判定被绑在渲染类型上的唯一一处。处置: 引入最小的 `SkipCandidate`, 三个函数的判定逻辑逐字不动, 只换入参类型; **且把 `suspect` 定为必填** (初稿把它留成可选, 等于给「疑似安装树静默进批」留了一条编译期无感的路, 见 §2.5 的字段注释与 §12 的 4-1 处置)。

`RenderEntry` 与 `SkipCandidate` 的关系 (改动): CLI 的 `RenderEntry.suspect` 由可选改必填 (实读 `cli.ts` 的 `toEntries` 两条分支本来就都写了 `suspect`, 故构造点零改动), 结构上满足 `SkipCandidate`, 装配层调用零逻辑改动。

---

## 6. 对「跨场景观察」9 条的逐条回应

| #   | 观察 (需求侧)                                            | 采用的设计                                                                                                                                                                                                                           | 落点               |
| --- | -------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ------------------ |
| 1   | 两级导出面, 编排层是 CLI 薄壳的实现基座, 不得各写一份    | 原语层 (§2.2 至 §2.6) + 编排层 (§2.7) 两段导出; CLI 薄壳只许调 `createSweeper` 的 `plan()` / `run()` 与少量原语, **禁止自写第三条编排链**; CLI 的 `--yes` 分流就是 `plan()` 与 `run()` 的分流 (`run()` 可接收 `plan().batch` 做对账) | §2.7               |
| 2   | 结构化错误码是最大缺口; 中文人话保留, 与 code 并存       | code 体系 (9 个别名) + `message` 并存; 抛错档由 `SweepError` 与 `isSweepError` 表达; `partialRisk` / `errno` 机器化; **增加「一个 code 不合并方向相反的语义」纪律并据此拆码**                                                        | §3.2 / §3.3        |
| 3   | 进度与取消整体缺位; 至少在编排层与扫描层留口子           | 六处 `signal` + 五处 `onProgress`; 编排层补阶段事件与**终结事件**; 取消在删除阶段有硬纪律; 异步迭代桥接的参考实现写进文档                                                                                                            | §4 / §8.6          |
| 4   | 只读面与写入面保持物理分离                               | 事实基础: 全部库模块零模块级副作用 (实读); 包声明 `sideEffects: false`; 写侧唯一负担 (`TrustRoot` 配对) 由 `toTrustRoots` 承担且只在写侧调用                                                                                         | §7.1 / §2.4        |
| 5   | 路径映射需要显式化                                       | `ValidationResult.mappings` (`original → real`, 与 `accepted` 逐位对应); `removeBatch` 把配对透传到结果                                                                                                                              | §2.3 / §7.2        |
| 6   | 库的静默契约 (零 stdout / stderr, 渲染是纯函数)          | API 包承诺零打印; `render()` 留 CLI 包, `formatBytes` / `sanitizeLine` / `sanitizeOutputLine` 进 API 包 (无打印), 净化分工写死                                                                                                       | §2.6 / §5.2        |
| 7   | 配置模型可作可选原语, 但库不得默认读平台配置; 向导留 CLI | 配置四件套 + `DEFAULT_EXCLUDE` 导出; **编排层的 `roots` 必填, 库内部不调 `resolveConfigPath`**; `init.ts` 整体留 CLI 包                                                                                                              | §2.5 / §2.1        |
| 8   | 既有 BC / EC 契约语言可平移; OF 留 CLI                   | 逐条映射表 (§3.4), EC 判定一个不改; 三条新增条款已登记为 BC-42 / BC-43 / BC-44                                                                                                                                                       | §3.4               |
| 9   | 安全语义的 API 表达 (policy 与跳过编码)                  | `SweepPolicy.releaseSuspects` (对应 `--force`); 跨设备**不受 policy 影响**; `SkipReason` 四取值; **新增 `staleTargets` 容忍开关, 边界写死: 只容忍 `GUARD_TARGET_MISSING`, 不放宽任何不变量**                                         | §2.4 / §2.7 / §3.2 |

---

## 7. 缺口处置 (逐条: 现状 → 设计 → 兼容性)

### 7.1 TrustRoot 配对助手

- **现状 (实读)**: `removeTargets` 要求 `TrustRoot[]` (`{ configured, real }` 配对), 而构造配对的逻辑是 `cli.ts` 的私有 `trustRoots()` (约 324 行), 程序化使用方拿不到; 只能自行 realpath, 极易漏掉 `configured` 那一半防线 (而 `configured` 正是链头判定唯一能识破根换位的依据, BC-39)。
- **设计 (新增)**: `toTrustRoots(roots: string[]): Promise<TrustRoot[]>`, 逻辑逐字提升现状私有函数; 另提供 `removeBatch()` 把「配对 + 安全闸 + 整批拒绝规则 + 陈旧容忍 + 删除」收成一个入口, 使调用方**不必知道** `TrustRoot` 的存在也能安全删除。
- **兼容性**: 纯新增; `removeTargets` 的原生契约与类型不变, 需要精细控制的调用方仍走原语。

### 7.2 路径映射 (original → realpath)

- **现状 (实读)**: `validateTargets` 的 `accepted` 是 realpath 化结果且保输入顺序, 而显示侧要原始拼写; 今天靠逐位对齐 (cli.ts 的 `withOutcomes` 里 `accepted[index]`) 隐式兜住, 映射在 API 面上不可见。
- **设计 (改动)**: `ValidationResult.mappings: PathMapping[]` 与 `accepted` 逐位对应 (长度相等, `mappings[i].real === accepted[i]`); 拒绝项在 `rejected` 里同样带原始拼写。`removeBatch` 把 `mappings` 透传到 `executed` 分支; `SweepReport` 的逐条结果按 `SweepEntry.target` (原拼写) 给出, 调用方不再需要自己拼映射。
- **兼容性**: 新增字段 (非破坏); 老调用方按索引对齐的写法继续可用。

### 7.3 体积口径标识 (basis)

- **现状 (实读)**: `SizeEntry.bytes` 不标口径: du 快路径报磁盘占用, 纯实现报逻辑字节 (差异只记在基准测试与设计文档里); 长期序列 (场景 2 的月级 JSONL) 在同一台机器上可能发生口径切换而序列无痕。
- **设计 (改动)**: `SizeBasis = 'disk-usage' | 'logical-bytes'`; `Sizer.basis` 由候选自报, `SizeResult.basis` 回显本次口径; 编排层把它落到 `SweepEntry.basis` **并在 `SweepPlan.basis` 给出单值** (补齐: 使用方代码里为了拿口径单值只能取首条 entry)。
- **口径一致性说明**: 一次 `measure()` 调用内口径恒一 (du 不可用则门面直接选 js 候选; du 可用而输出不可信则整批转 `unmeasured`, 不混口径, 实读两条路径)。`win32` 恒为 `logical-bytes` (EC-03 的平台守卫)。
- **兼容性**: 新增字段; 数值语义不变。

### 7.4 扫描结果的根归属

- **现状 (实读)**: `ScanHit` 只有 `project` 与 `target`; 多根场景下结果按根分组只能自己算 (场景 2 的 `roots` 分组、场景 4 的按根审计)。
- **设计 (改动)**: `ScanHit.root: string` (扫描根的原拼写)。取值规则: 各根串行推进 (实读 `scan-parallel.ts` 根循环), 命中以 realpath 去重、先到者胜, 故归属取**输入顺序中首个遍历到该命中的根**, 结果确定可复现。
- **兼容性**: 新增字段; 现有消费点不受影响。

### 7.5 安全策略参数与陈旧目标容忍

- **现状 (实读)**: 两类保守默认 (疑似安装树 / 跨设备) 与 `--force` 的放行边界今天由 `skip.ts` 单源化, 但以裸 `boolean` 参数 (`force`) 形式出现; 第三方无从知道它只放行一类。
- **设计 (改动 + 新增)**: `SweepPolicy { releaseSuspects: boolean }` 取代裸 boolean (判定逐字不变); 两条边界写进文档: (1) 只放行疑似安装树; (2) 跨设备恒不进删除批。
- **设计 (新增)**: `RemoveBatchOptions.staleTargets` / `SweepRunOptions.staleTargets` (`'reject' | 'missing'`, 缺省 `'reject'`)。边界三条: 只对 `GUARD_TARGET_MISSING` 生效; 被摘出的目标**不进删除面** (不可能因此多删); 其余任何拒绝码维持整批拒绝。它放宽的是「目标已不存在」这一类**无安全信号**的拒绝 (EC-01 语义在安全闸阶段的前延), 不是任何不变量。
- **兼容性**: policy 是破坏性签名改动 (第三个参数类型), 影响面仅 CLI 内部 3 处调用点; `staleTargets` 纯新增, 默认保现状。

### 7.6 结构化跳过编码

- **现状 (实读)**: `collectSkips().hints` 与 `trailer` 是成品中文句子, 只可印给人看; 场景 4 要把它写进机器读的审计。
- **设计 (新增)**: `SkipReason` 四取值 + `skipReasonOf()` (与 `skipsBatch` 同一判定) + `plan.skipped` 列表 + `SweepEntry.skipReason` 与 `skipNote` 逐条字段 + `SkipBook.entries` 码话合一 (新增, 回答体验报告 4-3)。跳过集册家族的选择依据见 §2.5 的决策表。
- **兼容性**: 纯新增。

### 7.7 编排器与 CLI 的单一事实来源

- **现状 (实读)**: 「扫描 → 体积 → 类别 → 设备 → 批次 → 安全闸 → 删除 → 报告」只存在于 `cli.ts` 的 `sweep()` (约 575 至 679 行), 且与渲染、名单回执、退出码交织在一起。
- **设计 (新增)**: `createSweeper(...).plan()` 负责前半链, `.run()` 负责整链 (内部复用 `plan()`); CLI 薄壳退化为「解析参数 → 装载配置 → 组装 `SweepOptions` → 调 plan / run → 用 `SweepEntry` + `SkipBook` + `RemovalResult` 组装 `RenderEntry` → `render()` → 退出码」。退出码派生规则与今天一致 (`removed` / `missing` 算成功侧, 其余一律失败侧, 见 §2.7 的三档配方)。
- **兼容性**: 纯新增 (CLI 侧接线重写, 黑盒行为与 OF/BC 语料不变)。

### 7.8 结果到呈现 / 分支的缝合层 (新增小节)

- **现状 (初稿缺口)**: 域类型完备, 但「把结果讲给人听 / 做程序分支」这一层缺件: 成功侧判据、逐条跳过文案、退出码口径、进度终态、错误上下文的类型定义, 要么只在散文里, 要么散在两处要手工 join。体验报告把这五件的病根归为同一个 (「零件齐、总装缺件」), 并指出它们的共同症状是「每次调用都要手工 join / 重建判据 / cast 一次」。
- **设计 (新增)**:

| 缝合件            | 形态                                    | 替掉的调用方手工活                                        |
| ----------------- | --------------------------------------- | --------------------------------------------------------- |
| 成功侧判据        | `isSuccessOutcome(outcome)`             | 手写 `kind !== 'x' && kind !== 'y'`, 新增 kind 时静默漏判 |
| 计数              | `summarizeReport(report): SweepSummary` | 逐 kind filter + reduce                                   |
| 退出码口径        | §2.7 的三档配方 (库不内置 `ok`)         | 每个 CLI 各自重建一次「什么算失败」                       |
| 逐条跳过文案      | `SweepEntry.skipNote`                   | 按 target join `plan.skipped` 两份数组                    |
| 跳过集册的码 + 话 | `SkipBook.entries`                      | 调两次 `skipReasonOf` + `collectSkips` 再对齐             |
| 进度终态          | `plan-done` / `done` 事件               | 自造结束哨兵                                              |
| 错误上下文        | `SweepErrorDetails` + code → details 表 | cast 到自造类型                                           |
| 告警码归属        | §2.8 别名全表                           | 猜 `SweepWarningCode` 是不是并集                          |

- **兼容性**: 纯新增 (全部落在 API 包导出面)。

### 7.9 设备边界结果的落盘形态 (新增小节)

- **现状 (初稿疏漏)**: `findCrossDeviceTargets` 返回 `Map`, 而初稿把这条列为「可序列化承诺的例外」。体验报告 4-4 证实后果: 走原语层自建审计时 `JSON.stringify` 得到 `{}`, 审计里直接丢掉「为什么这台机器没删」整列。
- **设计 (改动)**: 返回 `CrossDeviceEntry[]` (保输入顺序, 可序列化); 新增 `crossDeviceIndex(entries): ReadonlyMap<string, CrossDeviceKind>` 供需要 `has` / `get` 的使用方使用 (含 `skip.ts` 三个函数的第二参)。例外取消, §5.1 的承诺变成无条件。
- **兼容性**: 破坏性签名改动 (返回类型), 与拆包同批落地; 影响面为 CLI 内部两处调用点。

---

## 8. 完整调用示例

> 以下四段分别是场景 1 (CI 编排层)、场景 2 (快照只读原语层)、场景 6 (内嵌 CLI)、场景 5 + 场景 4 续跑 (写侧原语), 外加一节编辑器集成的桥接参考实现。

### 8.1 场景 1: CI 构建机周期性清理 (编排层)

```ts
// ci-clean.ts: 在 job 收尾步骤里回收工作区磁盘
import {
  DEFAULT_EXCLUDE,
  SweepError,
  createSweeper,
  formatBytes,
  isSweepError,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

const roots = ['/mnt/ci/workspaces', '/mnt/ci/cache']; // 由 job 配置注入, 不读平台默认配置文件

const controller = new AbortController();
process.on('SIGTERM', () => controller.abort());

// 参数错误在构造期同步抛出 (roots 为空一类), 故构造不需要包在 try 里
const sweeper = createSweeper({
  roots,
  exclude: [...DEFAULT_EXCLUDE],
  include: [],
  policy: { releaseSuspects: false }, // CI 侧不放行疑似安装树
});

try {
  const report = await sweeper.run({
    signal: controller.signal,
    // 同一 runner 上可能有另一个 job 在清理重叠的根: 目标被别人删掉不再阻断整批
    staleTargets: 'missing',
    onProgress: (event) => {
      if (event.kind === 'phase' && event.status === 'done')
        console.log(`[sweep] ${event.phase} 完成 (${event.elapsedMs ?? 0}ms)`);
      if (event.kind === 'done')
        console.log(`[sweep] 本轮结束: ${event.status} (${event.elapsedMs}ms)`);
      if (event.kind === 'failed')
        console.error(
          `[sweep] 失败 ${event.failure.code}: ${event.failure.target}`,
        );
    },
  });

  const summary = summarizeReport(report);
  const targets = (kind: string) =>
    report.entries.filter((e) => e.outcome.kind === kind).map((e) => e.target);

  console.log(
    JSON.stringify({
      status: report.status, // 'executed' | 'rejected' | 'nothing-to-do'
      // 严格口径 (与 CLI 包同源): 有未处理项或失败即不算成功
      ok:
        summary.failed === 0 &&
        summary.unprocessed === 0 &&
        !summary.aborted &&
        report.status !== 'rejected',
      counts: summary.counts, // 逐 kind 计数, 库里新增 kind 时这里跟着来
      removed: targets('removed'),
      missing: targets('missing'), // 删除阶段核验确认已不存在 (EC-01)
      stale: report.stale, // 安全闸之前已不存在, 被摘出 (未进入删除面)
      failed: report.removal?.failed ?? [],
      aborted: report.removal?.aborted ?? null,
      rejected: report.validation?.rejected ?? [],
      skipped: report.plan.skipped.map((item) => ({
        target: item.target,
        reason: item.reason,
        note: item.note,
      })),
      warnings: report.plan.warnings, // 根不存在等环境告警: code + 中文 message
      releasedBytes: report.releasedBytes,
      releasedHuman: formatBytes(report.releasedBytes),
    }),
  );

  process.exitCode =
    summary.failed === 0 && summary.unprocessed === 0 && !summary.aborted
      ? 0
      : 1;
} catch (error) {
  // isSweepError 不依赖类身份, 打包 / 多实例环境同样可靠 (跨包场景用它; 同实例可用 instanceof)
  if (isSweepError(error)) {
    const details = error.details;
    console.error(
      JSON.stringify({
        ok: false,
        code: error.code, // 'CONFIG_*' / 'INVALID_ARGUMENT' / 'CANCELLED' / …
        message: error.message,
        details: details ?? null,
        // 取消落在删除阶段时, 这里带着已产生的部分结果 (phase 为 'remove' 时才出现)
        partial:
          details !== undefined && 'partial' in details
            ? (details.partial ?? null)
            : null,
      }),
    );
    process.exitCode = 1;
  } else {
    throw error; // 未预期异常原样冒泡 (不吞错)
  }
}
```

原语层等价写法 (需要逐步控制时): `createScanner().scan({ roots, exclude, include })` → `createSizer().measure(...)` → `validateTargets(targets, { roots })` → `removeTargets(accepted, { roots: await toTrustRoots(roots) })`, 或者直接用写侧编排 `removeBatch(targets, { roots })` 吃掉后半链。

### 8.2 场景 2: 磁盘体检与趋势快照 (只读原语层)

```ts
// snapshot.ts: 每日快照, 只读, 不触碰任何删除路径
import { appendFile } from 'node:fs/promises';

import {
  DEFAULT_EXCLUDE,
  SweepError,
  classifyTarget,
  createScanner,
  createSizer,
} from '@iyowei/sweep-node-modules';

const roots = ['/Users/me/workspace/development', '/Users/me/self/development'];
const snapshotPath = '/Users/me/work/monitoring/sweep-snapshots.jsonl';

const signal = AbortSignal.timeout(10 * 60_000); // 休眠唤醒后干净退出

try {
  const scanner = createScanner();
  const sizer = createSizer();
  const basis = sizer.basis; // 调用前即可读到本次口径

  const scan = await scanner.scan({
    roots,
    exclude: [...DEFAULT_EXCLUDE],
    include: [],
    signal,
    onProgress: (event) => console.error(`[snapshot] 命中 ${event.hit.target}`),
  });

  const size = await sizer.measure(
    scan.hits.map((hit) => hit.target),
    { signal },
  );

  // 三桶互斥且完备 (契约), 故这里没有「unknown」兜底分支:
  //   entries (测到了) / unmeasured (存在但测不到) / gone (测量时已不存在)
  const bytesOf = new Map(
    size.entries.map((entry) => [entry.target, entry.bytes]),
  );
  const unmeasuredOf = new Map(
    size.unmeasured.map((item) => [item.target, item]),
  );
  const goneSet = new Set(size.gone);

  const items = scan.hits.map((hit) => {
    const cls = classifyTarget(hit.target); // 安装树单列口径, 不计入「项目占用」
    const unmeasured = unmeasuredOf.get(hit.target);
    const bytes = bytesOf.get(hit.target);
    return {
      root: hit.root, // 根归属: 多根结果可直接分组
      project: hit.project,
      target: hit.target,
      kind: cls.kind,
      kindReason: cls.reason ?? null,
      bytes: bytes ?? null, // 0 与未测到严格可分
      unmeasuredCode: unmeasured?.code ?? null, // 长期序列可机器归因
      unmeasuredReason: unmeasured?.reason ?? null,
      bucket:
        bytes !== undefined
          ? 'measured'
          : goneSet.has(hit.target)
            ? 'gone'
            : 'unmeasured',
    };
  });

  await appendFile(
    snapshotPath,
    `${JSON.stringify({
      ts: new Date().toISOString(),
      schema: 1,
      roots,
      basis, // 'disk-usage' | 'logical-bytes': 口径切换在序列里留痕
      items, // hits 已按 target 升序, 快照天然可跨日 diff
      warnings: [...scan.warnings, ...size.warnings], // 都为 { code, message, path?, errno? }
      // 两个字段恒在 (必填, 空数组表达无名单), 落盘 schema 不随调用参数漂移
      nameMatches: {
        exclude: scan.excludeMatches,
        include: scan.includeMatches,
      },
      projectBytes: items
        .filter((item) => item.kind === 'project' && item.bytes !== null)
        .reduce((sum, item) => sum + (item.bytes ?? 0), 0),
    })}\n`,
  );
} catch (error) {
  if (error instanceof SweepError) {
    console.error(`[snapshot] 本次未记录: ${error.code} ${error.message}`);
    process.exitCode = 1;
  } else {
    throw error;
  }
}
```

### 8.3 场景 6: 内嵌进自研 CLI 作为库 (编排层 + 对账 + 自绘)

```ts
// wsm clean: 复用 sweep 的能力与安全语义, 输出完全自绘
import { basename } from 'node:path';

import {
  type EntryOutcome,
  SweepError,
  createSweeper,
  formatBytes,
  isSuccessOutcome,
  sanitizeLine,
  summarizeReport,
} from '@iyowei/sweep-node-modules';

export async function cleanCommand(flags: {
  roots: string[];
  exclude: string[];
  include: string[];
  force: boolean;
  yes: boolean;
}): Promise<number> {
  // 参数错误在构造期同步抛; 异步入口的错误走 reject
  let sweeper: ReturnType<typeof createSweeper>;
  try {
    sweeper = createSweeper({
      roots: flags.roots,
      exclude: flags.exclude,
      include: flags.include,
      policy: { releaseSuspects: flags.force }, // 对应 sweep 的 `--force`
    });
  } catch (error) {
    return reportFailure(error);
  }

  // 只读面: 扫描 + 体积 + 类别 + 设备 + 批次构造
  const plan = await sweeper.plan();
  printMyOwnPreview(plan);
  if (!flags.yes) return 0;

  let report;
  try {
    report = await sweeper.run({
      // 对账: 只删「用户刚点头的那份清单 ∩ 此刻仍在的清单」;
      // 确认期间新冒出来的 node_modules 不删, 记进 drift.added
      expectedBatch: plan.batch,
      staleTargets: 'missing', // 用户点头之后被自己删掉的目录, 不算失败
    });
  } catch (error) {
    return reportFailure(error);
  }

  if (
    report.drift !== undefined &&
    (report.drift.added.length > 0 || report.drift.removed.length > 0)
  ) {
    console.error(
      `[wsm clean] 预览与实际执行有出入 (新增 ${report.drift.added.length} 项未处理, 消失 ${report.drift.removed.length} 项), 已按实际结果汇报`,
    );
  }

  renderMyOwnReport(report);
  // 宽松口径 (交互式): 只有真失败与整批中止算失败; 跳过 / 未处理只作提示
  const summary = summarizeReport(report);
  return summary.failed === 0 &&
    !summary.aborted &&
    report.status !== 'rejected'
    ? 0
    : 1;
}

function printMyOwnPreview(plan: {
  entries: readonly {
    target: string;
    project: string;
    bytes?: number;
    inBatch: boolean;
    skipNote?: string;
    skipReason?: string;
  }[];
  batch: readonly string[];
}): void {
  for (const entry of plan.entries) {
    const size = entry.bytes === undefined ? '?' : formatBytes(entry.bytes);
    // skipNote 随条目携带, 不必再按 target 去 plan.skipped 里 join
    const note = entry.inBatch
      ? ''
      : `  (${entry.skipNote ?? entry.skipReason ?? '未进批'})`;
    console.log(
      `${entry.inBatch ? '*' : '-'} ${size.padStart(9)}  ${sanitizeLine(basename(entry.project))}  ${sanitizeLine(entry.target)}${note}`,
    );
  }
  console.log(`将清理 ${plan.batch.length} 处`);
}

function renderMyOwnReport(report: {
  entries: readonly {
    target: string;
    outcome: EntryOutcome;
  }[];
  releasedBytes: number;
  removal?: { aborted?: { code: string; message: string } };
}): void {
  for (const entry of report.entries) {
    const mark = isSuccessOutcome(entry.outcome) ? 'v' : 'x';
    // partialRisk 是自绘 CLI 唯一能据此提示「请人工复查目录残留」的机器标记
    const detail =
      entry.outcome.kind === 'failed'
        ? `  ${entry.outcome.failure.code}${entry.outcome.failure.partialRisk ? ' [可能残留]' : ''}`
        : '';
    console.log(
      `${mark} ${sanitizeLine(entry.target)}  ${entry.outcome.kind}${detail}`,
    );
  }
  console.log(`释放 ${formatBytes(report.releasedBytes)}`);
  if (report.removal?.aborted !== undefined)
    console.log(
      `整批中止 (${report.removal.aborted.code}): ${report.removal.aborted.message}`,
    );
}

function reportFailure(error: unknown): number {
  if (error instanceof SweepError) {
    console.error(`清理未完成 (${error.code}): ${error.message}`);
    return 1;
  }
  throw error;
}
```

### 8.4 场景 5 (写侧原语) 与场景 4 (断点续跑)

```ts
// clean 任务内核: 目标由构建图给出, 不做全盘扫描
import { join } from 'node:path';

import {
  removeBatch,
  removeTargets,
  toTrustRoots,
  validateTargets,
} from '@iyowei/sweep-node-modules';

export async function cleanPackages(pkgDirs: string[], workspaceRoot: string) {
  const targets = pkgDirs.map((dir) => join(dir, 'node_modules')); // 末段必须是 node_modules

  // 写法 A (推荐): 一次调用吃掉「安全闸 + 整批拒绝 + 配对 + 删除」
  const bundled = await removeBatch(targets, { roots: [workspaceRoot] });
  if (bundled.status === 'rejected')
    return { ok: false as const, rejected: bundled.rejected }; // 与 CLI 同一保守语义: 零删除

  return {
    ok:
      bundled.removal.aborted === undefined &&
      bundled.removal.failed.length === 0,
    accepted: bundled.accepted,
    mappings: bundled.mappings, // original → realpath, 显示原始拼写不必再靠位次对齐
    removal: bundled.removal,
  };
}

// 断点续跑 (场景 4 的阶段 2): 工单里混进已被删掉的目标不再阻断整批
export async function resume(order: { roots: string[]; targets: string[] }) {
  const outcome = await removeBatch(order.targets, {
    roots: order.roots,
    staleTargets: 'missing', // 已不存在的目标记入 stale, 不触发整批拒绝
  });

  if (outcome.status === 'rejected')
    return { status: 'batch-rejected', rejected: outcome.rejected };

  return {
    status:
      outcome.removal.aborted === undefined &&
      outcome.removal.failed.length === 0
        ? 'ok'
        : 'partial',
    executed: outcome.accepted, // 过闸并进入删除面的目标
    stale: outcome.stale, // 安全闸之前已不存在 (未进入删除面), 审计留痕用
    missing: outcome.removal.missing, // 删除阶段核验确认已不存在 (EC-01)
    retry: outcome.removal.failed.map((f) => ({
      target: f.target,
      code: f.code,
      errno: f.errno ?? null,
      partialRisk: f.partialRisk,
    })),
    aborted: outcome.removal.aborted ?? null,
  };
}

// 写法 B (需要逐步控制时): 原语逐段接; 自定义流程里可用 code 摘除已消失的目标
async function validateOnly(targets: string[], workspaceRoot: string) {
  const { accepted, rejected, mappings } = await validateTargets(targets, {
    roots: [workspaceRoot],
  });
  // 程序分流只看 code 与 errno, 不匹配中文 message
  const stale = rejected.filter((item) => item.code === 'GUARD_TARGET_MISSING');
  const hard = rejected.filter((item) => item.code !== 'GUARD_TARGET_MISSING');
  if (hard.length > 0) return { ok: false as const, rejected: hard };
  const removal = await removeTargets(accepted, {
    roots: await toTrustRoots([workspaceRoot]),
  });
  return { ok: true as const, mappings, stale, removal };
}
```

### 8.5 场景 7 的关键提示 (实读要求平移进文档)

删除侧的信任锚要求根及其祖先链逐级为真目录 (BC-39), 而 macOS 的 `tmpdir()` 天然经过 `/var` 符号链接: 先 `realpath` 再当根用 (`const root = await realpath(await mkdtemp(...))`), 这样 `toTrustRoots([root])` 的 `configured` 与 `real` 同时是真路径形态。这条与代码示例一并写在 API 文档的快速上手处 (场景 7 的文档义务)。

### 8.6 编辑器集成参考实现 (新增, 回答体验报告 3-1 / 3-2 / U6)

库不提供 `watch()`, 但这门桥接有标准写法; 终结事件 (§4.1) 到位后, 下面的实现约 20 行, 覆盖体验报告列出的四件事 (背压队列 / 结束判定 / 错误转发 / 提前 break 自动取消)。

```ts
import type { SweepProgressEvent, Sweeper } from '@iyowei/sweep-node-modules';

/** 把 plan() 的回调事件桥成异步迭代器; 末事件为 plan-done, 中断时以 throw 收场 */
async function* watchPlan(
  sweeper: Sweeper,
  options: { signal?: AbortSignal } = {},
): AsyncIterable<SweepProgressEvent> {
  const queue: SweepProgressEvent[] = [];
  let wake: (() => void) | null = null;
  let failure: unknown = null;
  let closed = false;

  const push = (event: SweepProgressEvent): void => {
    queue.push(event);
    wake?.(); // ① 背压: 生产端只入队, 消费端按需取
    wake = null;
  };

  const done = sweeper
    .plan({ signal: options.signal, onProgress: push })
    .then(() => {
      closed = true;
      wake?.();
    }) // ② 结束判定: 终结事件已入队, 标记生产端结束
    .catch((error: unknown) => {
      failure = error;
      closed = true;
      wake?.();
    }); // ③ 错误转发

  try {
    for (;;) {
      const next = queue.shift();
      if (next !== undefined) {
        yield next;
        if (next.kind === 'plan-done') return; // 契约: 终结事件之后不再有事件
        continue;
      }
      if (failure !== null) throw failure;
      if (closed) return;
      await new Promise<void>((resolve) => {
        wake = resolve;
      });
    }
  } finally {
    await done;
    // ④ 提前 break: 由调用方在 for await 外层持 controller, 在 finally 里 abort
  }
}

// 消费侧 (面板进度条):
async function refreshPanel(sweeper: Sweeper, controller: AbortController) {
  try {
    for await (const event of watchPlan(sweeper, {
      signal: controller.signal,
    })) {
      if (event.kind === 'hit') panel.add(event.hit);
      if (event.kind === 'measured')
        panel.updateBytes(event.target, event.bytes);
      if (event.kind === 'warning')
        output.appendLine(sanitizeLine(event.warning.message));
      if (event.kind === 'plan-done') return paintPlan(event.plan);
    }
  } catch (error) {
    if (isSweepError(error) && error.code === 'CANCELLED') return; // 取消是编辑器的正常路径
    throw error;
  } finally {
    if (!controller.signal.aborted) controller.abort(); // 提前 break 时不再空跑扫描
  }
}
```

> 未做成库 API 的理由 (Q7 的定夺依据): CLI 包不需要它 (它直接消费回调), 只有编辑器一类宿主需要; 补进库要连带定义 `watch` 与 `run` 的关系、提前 break 的取消语义与背压策略, 属真实需要出现前的投机面。若后续出现第二个需要迭代形态的宿主, 再提升为 `sweeper.watch()`。

---

## 9. 开放问题清单

> 状态口径:「已定夺」= 取向已定并写进上文 (由本文档给出, 或由决策者拍板 / 由已接受的 ADR 裁定, 各自注明来源)。定稿后本清单不再留待决项; 后续若出现新的待决问题, 按本仓惯例追加新条目而不是改写已有取向。

| #              | 问题                                                                                                                                        | 状态                                              | 取向 / 说明                                                                                                                                                                                                                                                                                                                                                                                                                              |
| -------------- | ------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Q1a**        | 两个包名与各自职责: 程序化使用方引哪个包?                                                                                                   | **已定夺**                                        | 按任务给定的拆分: 库与程序化使用引 `@iyowei/sweep-node-modules` (API 包), 命令行走 `@iyowei/sweep-node-modules-cli` (CLI 薄壳包)。第三方 CLI 作者要嵌库就引前者, 不必碰后者 (回答体验报告 5-6 的前半)                                                                                                                                                                                                                                    |
| **Q1b**        | 存量分发的迁移路径: 今天 `@iyowei/sweep-node-modules` 已发布到 0.4.0 且自带 CLI, 已全局安装的用户升级后会拿到一个没有 `bin` 的库            | **已定夺 (2026-09-29 拍板)**                      | **不保留过渡期转发 `bin`**: API 包保持纯库形态 (无 `bin` 字段), 不背 CLI 入口; 存量安装者的迁移指引放在 API 包 README 的「包定位变更说明」(同名包内容由 CLI 翻转为 API, CLI 迁至 `@iyowei/sweep-node-modules-cli`) 与 release notes 里。理由: 保持 API 包纯净: 转发入口会把 CLI 的依赖与入口逻辑重新拉回库包, 与「CLI 薄壳、业务语义全归 API 包」的切分原则相反, 且 ADR 0010 已显式接受该版本语义变化 (0.x 内), 不值得为它长期留一扇后门 |
| Q2             | `run()` 是否接受既有 `plan` (复用计划, 不重扫)?                                                                                             | **已定夺**                                        | 仍不接受「拿旧计划执行」; 但新增 `expectedBatch` 与 `drift`, 让「用户批准的清单」成为本次执行的**范围上界**: 仍重跑扫描与安全闸 (每个事实都是此刻的事实), 只是新出现的目标不进删除面, 并被显式报出来。既保住 ADR 0002 的预览-执行承诺, 又消掉体验报告 5-1 的对账缺口                                                                                                                                                                     |
| Q3             | `warnings` 从 `string[]` 变结构化对象, 是本期一次做掉还是分两版?                                                                            | **已定夺**                                        | 一次做掉 (§1.3 的窗口期论证); 拆码也落在同一窗口                                                                                                                                                                                                                                                                                                                                                                                         |
| Q4             | 编排层的进度事件是否也给「精简形态」(只留阶段事件)?                                                                                         | **已定夺**                                        | 全给, 由调用方按 `kind` 自己筛; 终结事件 (`plan-done` / `done`) 让流的结束可判定                                                                                                                                                                                                                                                                                                                                                         |
| Q5             | 是否提供 `./readonly` 子路径导出 (只读面), 还是单入口 + `sideEffects: false` 足够?                                                          | **已定夺**                                        | 单入口 + 声明 `sideEffects: false` 足够 (模块零副作用已是事实); 子路径作为可选优化后置                                                                                                                                                                                                                                                                                                                                                   |
| Q6             | 类型声明的产出通道: 包态 (编译产物) 的 `.d.ts` 从哪来? 今天只有 `bin/sweep-nm.d.mts` 这种手写投影先例 (实读)                                | **已定夺** (依 ADR 0010 决策 5)                   | ADR 0010 定 `bun build` 出 JS + `tsc --emitDeclarationOnly` 出 `.d.ts`; 手写投影 (实读先例) 不作为 API 包方案, 它只用于 launcher 单测。该通道已在本仓实测落地 (`packages/sweep-node-modules/scripts/build.ts` 与 `tsconfig.build.json`; 见修订记录 2026-09-29 行)                                                                                                                                                                        |
| Q7             | 是否提供异步迭代入口 (`watch()`)?                                                                                                           | **已定夺**                                        | 不新增 API; 改由文档给完整参考实现 (§8.6, 约 20 行), 并更正初稿的「三行」估价: 体验报告实测约 50 行, 终结事件到位后降至约 20 行。再出现第二个迭代型宿主时复议                                                                                                                                                                                                                                                                            |
| Q8             | `SweepPolicy` 是否再加字段 (跨设备显式化 / home 防线开关)?                                                                                  | **已定夺**                                        | 不加: 跨设备不可放行是安全底线; `home` 的关闭由 `SweepOptions.home = null` 表达; 新增的 `staleTargets` 刻意**不放进** `SweepPolicy`, 因为它是执行期的容忍度 (不许影响只读的 `plan()`)                                                                                                                                                                                                                                                    |
| Q9             | `findCrossDeviceTargets` 的返回形态 (Map 还是数组)?                                                                                         | **已定夺**                                        | 改返回 `CrossDeviceEntry[]` (可序列化, 保输入顺序), 另给 `crossDeviceIndex()`; 初稿的「Map 例外」取消 (回答体验报告 4-4)                                                                                                                                                                                                                                                                                                                 |
| Q10            | monorepo 目录布局与既有发布基建 (ADR 0009 的 `dist/manifest.json`、`verify-release.ts`、`PACK_FILES_EXPECTED` 白名单) 如何被两个包各自承担? | **已定夺 (结构层, 依 ADR 0010 决策 1 / 2)**       | 结构定为 bun 原生 workspaces + Turborepo 编排; 发布闸门「结构与判定不变, 落位点与配置变」在 ADR 0010 的权衡取舍段列为实施阶段义务, 其细则仍未推演, 但已不阻塞本 API 设计                                                                                                                                                                                                                                                                 |
| Q11            | `Sweeper` 的实例语义: 是否允许同一实例被并发调用?                                                                                           | **已定夺**                                        | 不允许 (文档写死「重入未定义」); 需要并发就建两个实例 (工厂无 IO, 成本为零)                                                                                                                                                                                                                                                                                                                                                              |
| Q12            | 是否给错误对象自带本地化入口?                                                                                                               | **已定夺**                                        | 不做: code + details + message 三件已足够调用方自造文案; 拆码后本地化文案可精确到「已不存在」与「不可读」两条 (体验报告 3-3 的诉求由此满足)                                                                                                                                                                                                                                                                                              |
| **Q13** (新增) | `staleTargets` 的默认值该取 `'reject'` 还是 `'missing'`?                                                                                    | **已定夺**                                        | 缺省 `'reject'` (不放宽既有保守语义); 调用方在知道自己手上清单可能陈旧时显式开启 (CI 并发 / 断点续跑 / 交互确认)                                                                                                                                                                                                                                                                                                                         |
| **Q14** (新增) | 库是否内置「本次运行算不算成功」的 `ok` 判据?                                                                                               | **已定夺**                                        | 不内置: 退出码是产品口径不是数据事实 (CLI 包的口径见 BC-26, 交互式 CLI 往往更宽松)。库给 `isSuccessOutcome` + `SweepSummary` + 三档配方 (§2.7)                                                                                                                                                                                                                                                                                           |
| **Q15** (新增) | `SkipCandidate` 是否干脆改用 `SweepEntry[]` 作入参 (彻底消除误传)?                                                                          | **已定夺**                                        | 不采用: 会把原语层的门槛抬高 (场景 5 / 7 式的最小用法被迫填 `root` / `project` / `kind` 等无关字段)。取「`suspect` 必填 + `toSkipCandidates()` 构造器」的组合, 误传当场报错, 同时保留最小用法                                                                                                                                                                                                                                            |
| **Q16** (新增) | 场景 4 阶段 1 写进审计的 `skipReason` 能否在阶段 2 直接喂回, 免去重判?                                                                      | **已定夺**                                        | 不提供「按旧判定执行」的入口: 重判是刻意设计 (磁盘状态会漂移, 安全闸必须看此刻的事实)。文档写明该意图; 阶段 2 走 `removeBatch` 重判, 成本是一次 realpath 链 (远低于一次全量扫描)                                                                                                                                                                                                                                                         |
| **Q17** (新增) | API 包何时进入发布流程 (根 `multi-release.ignorePackages` 豁免的移除时机)?                                                                  | **已定夺 (2026-09-29 拍板), 已执行 (2026-09-29)** | 公开面改造收口 (发布刀) 时从根 `package.json` 的 `multi-release.ignorePackages` 移除 `packages/sweep-node-modules`, 使 API 包进入 semrel 发版流程; 首发按 **0.5.x 过渡**一轮、不直接上 1.0 (成熟度未到; 2026-09-29 移出预演实测: 无 tag 包的 first-release 直接取 package.json 现值, 首发即 0.5.0, 旧稿「历史 `feat!` 会算出 1.0.0」的担忧经实测不成立)。豁免已于同日清空, 随批推送发布                                                  |

> **与 ADR 0010 的对齐 (定稿副作用)**: 本次定稿期间, 仓库新增并接受了 [ADR 0010](../../../../docs/adrs/0010-dual-package-monorepo.md)「双包 monorepo 结构与可编程 API」(2026-09-29 已接受), 它替本清单定了三件事: 包边界与切分原则 (= 本文档 §2.1, 一致)、包名翻转与 0.x 内接受该版本语义变化 (= Q1a 的定夺来源)、API 包分发形态与仓库结构 (= Q6 / Q10)。Q1b 的收窄与拍板亦随该决定完成: ADR 0010 未涉及过渡期转发入口, 该子项由决策者于 2026-09-29 拍板 (不保留, 见上表)。
> 状态汇总: 共 18 条目 (Q1 拆为 Q1a / Q1b), **18 条全部已定夺** (其中 Q1b 与 Q17 的取向由决策者拍板, 其余由本文档给出并写进上文)。

---

## 10. [证据缺口] 清单

| 缺口                                             | 缺失依据                                                                                 | 影响                                                                                       |
| ------------------------------------------------ | ---------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------ |
| 编辑器宿主对高频同步回调的实际容忍度             | 未实测 (无编辑器宿主环境); 体验报告只做了「写代码」层面的验证, 未做真机压测              | 只影响 §4.4 的节流建议与 §8.6 的背压实现细节, 不影响事件形态                               |
| `not-expected` 与 `drift` 在真机交互流程下的手感 | 库已实现, 真机交互手感 (非预期流的实际摩擦) 仍未实测; 体验验证只到「照签名写代码」这一层 | 收窄 Q2 的定夺粒度: 若真机上 `expectedBatch` 的摩擦大于收益, 复议为「只报 drift 不设上界」 |

---

## 11. 与需求侧场景清单的差异一览

| 场景清单里的写法                                                           | 本文档                                                                                                     | 差异理由                                                                    |
| -------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| 场景 1 自行 `roots.map(async (root) => ({ configured: root, real: ... }))` | `toTrustRoots(roots)` / `removeBatch(targets, { roots })`                                                  | 配对是安全防线的一半, 不该由每个调用方各写一遍 (§7.1)                       |
| 场景 1 / 2 自行 `reduce` 累计释放量                                        | `SweepReport.releasedBytes`                                                                                | 口径 (成功侧) 属契约, 单源比各处重算好                                      |
| 场景 4 用 `collectSkips(entries, crossDevice, opts.force)`                 | 第三参换 `SweepPolicy`; 第一参的 `suspect` 改必填; 候选由 `toSkipCandidates` 组装                          | 裸 boolean 在调用点不可读; `suspect` 可选会让安全语义静默消失 (§7.5 / §2.5) |
| 场景 4 直接用 `size.entries` 当候选数组                                    | 同上: `size.entries` 不再能当候选 (缺 `suspect`), 必须过 `toSkipCandidates`                                | 体验报告 4-1: 这是本文档里唯一一处类型系统替调用方掩盖安全语义的地方        |
| 场景 3 期望 `watch()` 异步迭代                                             | 不提供库 API; 文档给约 20 行参考实现 (§8.6)                                                                | 见 Q7                                                                       |
| 场景 6 期望 `run({ force, onProgress })`                                   | `force` 上移到 `createSweeper({ policy })`; `run` 收 `{ onProgress, signal, expectedBatch, staleTargets }` | policy 属判定模型 (构造期), 对账与容忍属执行期 (§2.7)                       |
| 场景 5 期望「抛 typed error 与返回结果对象二选一」                         | 两者并存, 分界线写死 (§3.1)                                                                                | 域内失败必须能带结果返回; 无法开始的失败必须响亮                            |
| 场景 3 期望错误对象可本地化                                                | 拆码 + `details.errno` + `details` 结构化, 文案不再含糊                                                    | 一个 code 不能盖两种处置方向相反的语义 (§3.2 硬纪律)                        |

---

## 12. 反馈处置记录 (v2 新增)

> 来源: `api_ux_review.md` 与 `experience/` 五份代码 (仓外反馈材料, 不随仓保存; 共 57 条: 逐场景堵点 27 条 + 「草案未覆盖」15 条 + 「需要猜测」9 条 + 「最想改的 3 处」3 条 + 代码内注顺带指出 3 条)。
> 计数: **采纳 49 / 部分采纳 7 / 驳回 1**。0 条因「与 ADR 硬约束冲突」被驳回: 逐条核过后, 除下述 7 条在形态上做了取舍、1 条判定为不成立, 其余都能在不动 ADR 0003 / 0006 的前提下落地; 采纳不等于照抄, 凡与使用方给出的形态不同的地方, 一律写在「理由」列。
> 改动位置列指向 v2 正文的节号, 可逐条回查。

### 表 A: 逐场景堵点 (27 条)

| #   | 堵点                                                                 | 处置              | 改动位置                                                                 | 理由                                                                                                                                                               |
| --- | -------------------------------------------------------------------- | ----------------- | ------------------------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 1-1 | `GUARD_REALPATH_FAILED` 一个码盖两种语义, 并发清理被整批否决堵死     | 采纳              | §3.2 拒绝表 (拆三码)、§2.3 `RejectionDetails.errno`、§2.4 `staleTargets` | 拆码 (ENOENT / EACCES-EPERM / 其余) + 补 `errno`; 另给显式容忍开关, 使「别人已经删掉」既不阻断整批也不需匹配中文                                                   |
| 1-2 | 「成功侧 = removed + missing」无代码出口                             | 采纳              | §2.7 `isSuccessOutcome` / `summarizeReport`                              | 判据与库同源, 新增 kind 不静默漏判; 另给三档退出码配方                                                                                                             |
| 1-3 | `SweepErrorDetails` 类型未定义                                       | 采纳              | §3.6 判别联合 + code → details 表                                        | 原为悬空引用, 现已逐 code 对齐                                                                                                                                     |
| 1-4 | 进度事件无整轮终结事件                                               | 采纳              | §4.1 `done` / `plan-done`                                                | 终结契约已登记为 BC-44 (见 §3.4)                                                                                                                                   |
| 1-5 | `SweepEntry` 不带跳过文案                                            | 采纳              | §2.7 `SweepEntry.skipNote`                                               | 与 `plan.skipped[].note` 恒等, 复核表不必再 join                                                                                                                   |
| 1-6 | `INVALID_ARGUMENT` 抛出时机未写                                      | 采纳              | §2.7 `createSweeper` 注释、§3.1                                          | 同款疑问见 5-5; 规则统一为「同步入口同步抛, 异步入口以 rejected promise 抛出」                                                                                     |
| 1-7 | `SweepWarningCode` 未定义且不在别名清单                              | 采纳              | §2.8 别名全表                                                            | 明确定为 `ScanWarningCode \| SizeWarningCode`, 并给穷举 `switch` 的写法建议                                                                                        |
| 2-1 | `SIZE_TARGET_VANISHED` 归属桶无解                                    | 采纳              | §3.2 体积表拆两张 + 归属列、§2.2 `SizeResult.gone`                       | 明确只进 `gone` 桶与 `warnings` 事件, 绝不进 `unmeasured`                                                                                                          |
| 2-2 | 无桶完备性恒等式                                                     | 采纳              | §2.2 恒等式、已登记为 BC-43 (见 §3.4)                                    | 三桶互斥且完备, 取消调用方的 `'unknown'` 兜底                                                                                                                      |
| 2-3 | 两个名单字段 optional 而缺席条件未写                                 | 采纳              | §2.2 `ScanResult`                                                        | 改必填 (空数组表达无名单): 对外只见胜出门面 (实读), 必填成立; 落盘 schema 因此不漂移                                                                               |
| 3-1 | `watch()` 缺席, 自桥估价「三行」低估                                 | 部分采纳          | §4.4 修订估价、§8.6 参考实现、Q7                                         | 不新增库 API (只有编辑器需要); 承认估价错误并给出约 20 行完整实现 (终结事件到位后)                                                                                 |
| 3-2 | 事件流无终结事件, 迭代器判不出流结束                                 | 采纳              | §4.1                                                                     | 同 1-4; §8.6 的桥接因此不再需要自造哨兵                                                                                                                            |
| 3-3 | 拒绝码不区分「不存在 / 不可读」, 本地化只能含糊                      | 采纳              | §3.2、§2.3                                                               | 拆码后本地化可精确两分                                                                                                                                             |
| 3-4 | 扩展打包后 `instanceof SweepError` 不可靠                            | 采纳              | §3.6 `isSweepError`                                                      | 推翻 v1 的 YAGNI 判断: 使用方给出真实失效场景 (同进程双实例), 理由成立                                                                                             |
| 3-5 | 用户在 Finder 删掉后点「清理这一个」得到语义错误的拒绝               | 采纳              | §2.4 `staleTargets`                                                      | 与 1-1 同源; 开启后该情形落 `stale`, 不再弹红条                                                                                                                    |
| 3-6 | 面板行只能显示机器码                                                 | 采纳              | §2.7 `skipNote`                                                          | 同 1-5                                                                                                                                                             |
| 4-1 | `SkipCandidate.suspect` 可选 → 疑似安装树静默进批                    | 采纳 (方案 a + c) | §2.5 `SkipCandidate.suspect` 必填 + `toSkipCandidates()`、§5.2           | 双管: 必填让误传当场类型报错, 构造器让正确写法更省事。**未采纳方案 b** (入参收成 `SweepEntry[]`): 会把原语层门槛抬高, 场景 5 / 7 式最小用法被迫填无关字段 (见 Q15) |
| 4-2 | 断点续跑被整批否决挡死                                               | 采纳              | §2.4 `staleTargets` + `BatchOutcome.executed.stale`                      | 见下 U2 的取舍说明                                                                                                                                                 |
| 4-3 | 机器码与人话分属两入口, 需调两次再对齐                               | 采纳              | §2.5 `SkipBook.entries`                                                  | 一次调用同时给出码与话; `hints` / `trailer` 保留供 CLI 现有渲染路径                                                                                                |
| 4-4 | `findCrossDeviceTargets` 返回 `Map`, 落盘丢列                        | 采纳              | §2.3 改返回 `CrossDeviceEntry[]` + `crossDeviceIndex()`、§7.9            | 取消 v1 的 Map 例外, 让 §5.1 的可序列化承诺无条件成立                                                                                                              |
| 4-5 | `SkippedTarget.note` 在未测到体积时无来源                            | 采纳              | §2.5 note 来源段、§2.7 `skipNote`                                        | 单源化: 未测到者取「体积统计失败: <unmeasuredReason>」, 与 CLI 现行行尾注记同源                                                                                    |
| 5-1 | `run()` 恒重跑 plan, 预览与实际执行不可对账                          | 采纳              | §2.7 `expectedBatch` + `SweepDrift`、Q2 修订                             | 新增执行范围上界与差集字段; 仍重跑判定链, 不退回「拿旧计划执行」                                                                                                   |
| 5-2 | 成功侧判据无出口; `skipped` / `not-attempted` 落失败侧与库的定性打架 | 部分采纳          | §2.7 三档配方、§7.8                                                      | 判据与计数按诉求给出; **不内置 `ok` 字段**: 退出码是产品口径 (CLI 包按 BC-26 把跳过算失败侧是刻意的, 交互式 CLI 可更宽松), 库给配方而不代决                        |
| 5-3 | `sanitizeLine` 与 `sanitizeOutputLine` 分工未写                      | 采纳              | §2.6 逐函数语义                                                          | 明写: 单行字段用前者, 多行块用后者 (唯一差别是保留行首缩进)                                                                                                        |
| 5-4 | 预览行要 join 两份数组                                               | 采纳              | §2.7 `skipNote`                                                          | 同 1-5                                                                                                                                                             |
| 5-5 | `INVALID_ARGUMENT` 时机未写                                          | 采纳              | §2.7 / §3.1                                                              | 同 1-6                                                                                                                                                             |
| 5-6 | Q1 未决, 第三方 CLI 作者不知引哪个包                                 | 部分采纳          | §9 Q1a / Q1b (均已定夺)                                                  | 「引哪个包」由本次拆分定义可确定, 写进 Q1a; 「存量 CLI 用户怎么迁移」属发布策略, 体验报告提出时尚未拍板, 定稿时已由决策者拍板 (不保留过渡转发 `bin`, 见 §9 Q1b)    |

### 表 B: 「草案未覆盖」15 条

| #   | 缺的东西                            | 处置     | 改动位置                                            | 理由                                                                                                                                                                                                           |
| --- | ----------------------------------- | -------- | --------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| U1  | `SweepErrorDetails` 完整定义        | 采纳     | §3.6                                                | 判别联合 + 逐 code 对应表                                                                                                                                                                                      |
| U2  | 「陈旧目标」的处理出口              | 部分采纳 | §2.4 `staleTargets` / `BatchOutcome.executed.stale` | 拆 code + `errno` 与开关都采纳; **不采纳「并入 `RemovalResult.missing`」**: 未过安全闸的路径不该以「删除器核验过」的桶对外呈现, 改单列 `stale` 保来源可辨, 并由库的成功侧判据把它与 removed / missing 同侧计入 |
| U3  | 成功侧判据                          | 采纳     | §2.7 `isSuccessOutcome` + `summarizeReport`         | 形态取函数而非 `report.summary` 字段: 派生量不入报告对象, 免与 `entries` 漂移                                                                                                                                  |
| U4  | 每目标的跳过文案                    | 采纳     | §2.7 `SweepEntry.skipNote`                          | 采用 `skipNote` 而非 `entryIndex` 回指: 复用与 `kindReason` 同款的现成写法, 调用方零 join                                                                                                                      |
| U5  | 进度流终结事件                      | 采纳     | §4.1                                                | `plan-done` 带完整计划, 省掉自造哨兵                                                                                                                                                                           |
| U6  | 异步迭代桥接参考实现                | 部分采纳 | §8.6                                                | 给完整实现而非 `watch()` (见 Q7); 估价更正为约 20 行                                                                                                                                                           |
| U7  | 错误类型守卫                        | 采纳     | §3.6 `isSweepError`                                 | 不依赖类身份, 走 `name` + `code` 判别                                                                                                                                                                          |
| U8  | `SweepWarningCode` 定义与归属       | 采纳     | §2.8 全表                                           | 并集别名 + 穷举写法建议                                                                                                                                                                                        |
| U9  | `SIZE_TARGET_VANISHED` 归属桶       | 采纳     | §3.2 + §2.2                                         | 表拆两张加归属列; 只进 `gone` 与事件                                                                                                                                                                           |
| U10 | 桶完备性恒等式                      | 采纳     | §2.2、§3.4                                          | 三桶互斥完备, 写进契约                                                                                                                                                                                         |
| U11 | 名单字段缺席语义                    | 采纳     | §2.2                                                | 改必填 (使用方给的两个选项里选前者的强化版: 恒在且恒为数组)                                                                                                                                                    |
| U12 | `SkipBook` 码 + 人话单入口          | 采纳     | §2.5 `SkipBook.entries`                             | 采用, 并保留 `hints` / `trailer` 以免动 CLI 现有渲染接线                                                                                                                                                       |
| U13 | `crossDevice` 落盘形态              | 采纳     | §2.3、§7.9                                          | 取「返回数组」而非「补转换器」: 转换器留不住 Map 这一陷阱本身                                                                                                                                                  |
| U14 | `INVALID_ARGUMENT` 抛出时机         | 采纳     | §2.7 / §3.1                                         | 构造期同步抛 (与使用方的倾向一致)                                                                                                                                                                              |
| U15 | `SkippedTarget.note` 未测到时的来源 | 采纳     | §2.5                                                | 取 `unmeasuredReason` 组装, 与 CLI 现行注记同源                                                                                                                                                                |

### 表 C: 「需要猜测」9 条 (逐条消除)

| #   | 原猜测内容                                         | 处置 | 消除方式                                                                           |
| --- | -------------------------------------------------- | ---- | ---------------------------------------------------------------------------------- |
| G1  | `SweepErrorDetails` 形状                           | 采纳 | §3.6 给出判别联合与 code → details 表                                              |
| G2  | `INVALID_ARGUMENT` 抛出时机                        | 采纳 | §2.7 写死构造期同步抛; §3.1 给出同步 / 异步两条通道的统一规则                      |
| G3  | `SIZE_TARGET_VANISHED` 进 warnings 还是 unmeasured | 采纳 | §3.2 归属列 + §2.2 `gone` 桶: 两者都不是, 进 `gone` 与 `warnings` 事件             |
| G4  | 名单字段何时缺席                                   | 采纳 | §2.2 改必填, 永不缺席                                                              |
| G5  | `sanitizeLine` / `sanitizeOutputLine` 分工         | 采纳 | §2.6 逐函数语义 (唯一差别是行首缩进保留与否)                                       |
| G6  | `SweepWarningCode` 是否并集                        | 采纳 | §2.8 明确定为并集, 并给前缀分组 + `default` 记录的写法建议                         |
| G7  | `plan.skipped` 与 `inBatch === false` 是否恒等     | 采纳 | §2.7 `SweepEntry.skipReason` / `skipNote` 注释写死恒等, 让 join 与落空分支一并消失 |
| G8  | `CANCELLED` 的 `details.phase` 取值域              | 采纳 | §3.6 写死为 `SweepPhase` 全集, 且 `partial` 只在 `phase === 'remove'` 出现         |
| G9  | 报告 `plan` 与先前 `plan()` 不一致以谁为准         | 采纳 | §2.7 `SweepReport.plan` 注释写死「以报告为准」, 差异由 `drift` 显式给出            |

### 表 D: 使用方「最想改的 3 处」

| #   | 建议                                                                                                             | 处置     | 改动位置                     | 理由                                                                     |
| --- | ---------------------------------------------------------------------------------------------------------------- | -------- | ---------------------------- | ------------------------------------------------------------------------ |
| D1  | 第一处: `SkipCandidate.suspect` 必填 (或收成 `SweepEntry[]`)                                                     | 采纳     | §2.5、§5.2、§11              | 取必填 + 构造器; 不取 `SweepEntry[]` 入参 (理由见 4-1 行)                |
| D2  | 第二处: 拆 `GUARD_REALPATH_FAILED` + `RejectionDetails.errno` + `staleTargets` 开关                              | 部分采纳 | §3.2、§2.3、§2.4             | 三项全采纳; 仅落点从「并入 `missing` 桶」改为独立 `stale` 字段 (见 U2)   |
| D3  | 第三处: 缝合层五件 (summary / isSuccessOutcome + skipNote + 终态事件 + `SweepErrorDetails` + `SweepWarningCode`) | 采纳     | §2.7、§4.1、§3.6、§2.8、§7.8 | 五件全给, 另补 `SkipBook.entries` 与三档退出码配方; 不内置 `ok` (见 5-2) |

### 表 E: 代码内注顺带指出的 3 条 (未进正式堵点表)

| #   | 意见                                                        | 处置     | 改动位置               | 理由                                                                                                                                                                                  |
| --- | ----------------------------------------------------------- | -------- | ---------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| E1  | 编排层没有体积口径单值, 要取口径只能拿首条 entry            | 采纳     | §2.7 `SweepPlan.basis` | 与 `Sizer.basis` 对称; 契约写明与逐条 `entry.basis` 同源同值                                                                                                                          |
| E2  | 场景 4 阶段 1 写进审计的 `skipReason` 无法在阶段 2 直接喂回 | 部分采纳 | §9 Q16                 | 不提供「按旧判定执行」的入口 (重判是刻意设计, 磁盘状态会漂移); 按使用方建议把该意图写进文档                                                                                           |
| E3  | 需要「跨设备形态 → 人话标签」的映射 (`deviceLabel`)         | 驳回     | —                      | 库已提供 `crossDeviceNote(kind)` (实读 `skip.ts`, 两形态各一句文案); 使用方那份带「同设备」默认分支的实现是其自定义标签, 不是库缺件。若确需第三种措辞, 属调用方文案偏好, 不该由库内置 |

### 逐条处置之外的说明

- **0 条驳回不等于照单全收**: 表 A 至 D 里 7 条「部分采纳」的取舍点已逐条写在「理由」列, 主要是三处形态分歧 (陈旧目标落桶 / 退出码口径归属 / 异步迭代入口) 与一处未采纳子方案 (写侧入参类型)。
- **本批唯一被判不成立的是 E3**: 库已有 `crossDeviceNote`; 使用方的实现是自定义标签。
- **未处理的使用方表扬项** (PathMapping / `Sizer.basis` / `ScanHit.root` / `partialRisk` / `SweepPolicy`) 在 v2 中全部保留, 未作改动。
