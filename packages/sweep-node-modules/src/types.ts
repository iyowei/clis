/**
 * 扫描契约: 候选实现共享的接口与返回形态 (设计: 分册「扫描与体积」)。
 * 候选差异只允许存在于接口内部, 调用方无感。
 */
import type { TargetKind } from './classify.ts';
import type {
  AbortCode,
  SizeBasis,
  SkipReason,
  SweepPhase,
  SweepWarningCode,
  UnmeasuredCode,
} from './codes.ts';
import type { AbortedBatch, RemovalResult, TargetFailure } from './delete.ts';
import type {
  CrossDeviceKind,
  PathStyle,
  RejectedTarget,
  ValidationResult,
} from './guard.ts';

export interface RenderEntry {
  /** node_modules 绝对路径 */
  target: string;
  /** 字节数; undefined = 体积测不到 (体积列显示 ?, 档位块转中性, 不计入合计总量) */
  bytes?: number;
  /** 项目名 */
  project: string;
  /** 执行模式: 删除是否成功 (缺省视为成功) */
  ok?: boolean;
  /** 执行模式: 失败原因 (ok === false 时附在行尾) */
  error?: string;
  /** 行尾补充说明 (如体积统计失败原因); 与失败原因同位并置, note 在前 */
  note?: string;
  /**
   * 疑似安装树 (工具 / 应用自身的安装树, 默认不进删除批; 判定见 classify.ts)。
   * 该行的路径不剥 node_modules 后缀: 剥掉后剩下的目录 (如 ~/.bun/install/global) 会被
   * 读成项目目录, 反而抹去唯一的类别提示; 保后缀与行尾标记互为印证。
   */
  suspect?: boolean;
}

export interface ScanOptions {
  /** 扫描根 (调用方保证为绝对路径) */
  roots: string[];
  /** 排除名单: 目录名; 从根到命中点的任意一级命中即整棵子树跳过 (装载层在配置省略该字段时缺省注入内置默认名单, 见 config.ts) */
  exclude: string[];
  /**
   * 包含名单 (白名单): 目录名; 从根到 node_modules 的任意一级命中即纳入。
   * 空数组 = 不过滤 (全部纳入); 与 exclude 同时命中时 exclude 优先 (先按白名单筛候选, 再排掉命中排除的)。
   */
  include: string[];
  /** 取消信号; 检查点在每个遍历任务开始前, 中断后 reject (SweepError CANCELLED) */
  signal?: AbortSignal;
  /** 进度回调; 粒度: 每命中一处发一条 hit 事件 */
  onProgress?: (event: ScanProgressEvent) => void;
}

/** 扫描的进度事件 */
export type ScanProgressEvent = { kind: 'hit'; hit: ScanHit };

export interface ScanHit {
  /** 直接包含 node_modules 的项目目录 */
  project: string;
  /** node_modules 绝对路径 */
  target: string;
  /**
   * 所属扫描根 (原拼写)。
   * 取值规则: 各根串行推进, 命中以 realpath 去重、先到者胜,
   * 故归属取输入顺序中首个遍历到该命中的根, 结果确定可复现。
   */
  root: string;
}

export interface ScanResult {
  /** 命中清单: 按 target 排序, 已按 realpath 去重 */
  hits: ScanHit[];
  /** 非致命告警 (结构化: 机器码 + 中文人话并存, 如不可读目录), 不中断扫描 */
  warnings: SweepWarning[];
  /**
   * 排除名单命中统计 (名称 → 命中次数); 未命中的名称也在列 (hits === 0)。
   * 性质: 破坏性动作的「保命名单」反馈通道 —— 名字打错/大小写不符时不得静默。
   * 例外: 内置默认名单项零命中不告警 (名单依平台与用户环境而异, 不是可修正的拼写错误;
   * 见 behavior-contract.md BC-09), 用户显式写出同名项时同样静默 (该项已由默认名单覆盖)。
   * 必填的理由: 落盘形态不得随调用参数漂移 —— 月级 JSONL 序列里键时有时无,
   * 下游 schema 校验器无从分辨「没配名单」与「版本不支持该字段」。
   */
  excludeMatches: NameMatch[];
  /**
   * 包含名单命中统计 (名称 → 命中该名的子树数); 未命中的名称也在列 (hits === 0)。
   * 计数独立于 exclude 优先: 名字命中白名单、随后被 exclude 截走的同样计入 (截走不等于没匹配上),
   * 否则被截走的名字会以 0 报「未匹配」, 诱导用户去排查不存在的拼写问题。
   * 性质: 与 excludeMatches 同款的名单反馈通道, 后果却更重: 白名单写错名字时扫描结果直接为空,
   * 更不能静默。
   */
  includeMatches: NameMatch[];
}

export interface Scanner {
  /** 候选中立名, 供基准与日志区分 */
  name: string;
  scan(options: ScanOptions): Promise<ScanResult>;
}

export interface SizeEntry {
  /** node_modules 绝对路径 (对应 ScanHit.target) */
  target: string;
  /** 字节数; 口径见 SizeResult.basis */
  bytes: number;
}

/** 存在但无法测量的目标 (权限等): 结构化上报, 下游不得静默移出清单 */
export interface UnmeasuredEntry {
  /** node_modules 绝对路径 (对应 ScanHit.target) */
  target: string;
  /** 机器可判别的未测到原因 */
  code: UnmeasuredCode;
  /** 人话中文原因 (不含路径本身, 与 target 字段各司其职) */
  reason: string;
}

export interface SizeResult {
  /** 可测量目标的体积, 按 target 升序 */
  entries: SizeEntry[];
  /** 本次调用实际生效的体积口径 (同一实例内恒定) */
  basis: SizeBasis;
  /** 非致命告警 (结构化); 含 SIZE_TARGET_VANISHED 事件条 */
  warnings: SweepWarning[];
  /** 存在但无法测量的目标 (如权限不足), 按 target 升序 */
  unmeasured: UnmeasuredEntry[];
  /**
   * 扫描命中、测量时已不存在 (BC-13) 的目标, 保输入顺序。
   * 「不存在」既不产生字节也不属「存在但测不到」, 故单列一桶, 与 warnings 里的
   * SIZE_TARGET_VANISHED 事件同源同判定 (事件供诊断, 本桶供划分)。
   * 划分完备性: entries ∪ unmeasured ∪ gone 恰好构成入参的全划分, 三者两两不相交。
   */
  gone: string[];
}

/** 体积测量的调用选项 (取消与进度透传) */
export interface MeasureOptions {
  /** 取消信号; 检查点在逐目标之间 (du 批量路径在批量调用前后各一次) */
  signal?: AbortSignal;
  /** 进度回调; 粒度: 每测到一个目标发一条事件 */
  onProgress?: (event: MeasureProgressEvent) => void;
}

/** 体积测量的进度事件 */
export type MeasureProgressEvent =
  | { kind: 'measured'; target: string; bytes: number; basis: SizeBasis }
  | { kind: 'unmeasured'; target: string; code: UnmeasuredCode; reason: string }
  | { kind: 'gone'; target: string };

export interface Sizer {
  /** 候选中立名 ('du' / 'js'), 供基准与日志区分 */
  name: string;
  /** 本实例的体积口径; 调用前即可读 */
  basis: SizeBasis;
  measure(targets: string[], options?: MeasureOptions): Promise<SizeResult>;
}

/**
 * 以下为编排层、跳过集册与诊断的类型 (设计基准: api-surface.md §2.5 / §2.7 / §3.5)。
 * 可序列化承诺: 全部域类型是普通对象与数组, JSON.stringify 无损 (无类实例 / Map / Set / 函数);
 * 时间无关 (库不打时间戳); 可跨会话复用 (形状不含运行时句柄)。
 */

/** 名单命中统计的命名形态 (ScanResult 的 excludeMatches / includeMatches 同形) */
export interface NameMatch {
  /** 名单项 (目录名) */
  name: string;
  /** 命中次数 (未命中的名称也在列, hits === 0) */
  hits: number;
}

/** 结构化告警: 机器可判别的 code + 中文人话并存 (替代裸 string) */
export interface SweepWarning {
  /** 机器可判别的告警码 */
  code: SweepWarningCode;
  /** 中文人话全文 (逐字保留现状文案, CLI 直接打印这一条即与今天逐字节一致) */
  message: string;
  /** 涉及的路径 (根 / 目录 / 目标), 从文案里提出做字段 */
  path?: string;
  /** 原始 errno (若有) */
  errno?: string;
}

/**
 * 跳过候选: 判定「这条会不会进删除批」所需的最小输入。
 * suspect 为必填是安全设计 (承载语义闸的全部信息): 留成可选时, 最顺手的
 * SizeEntry[] 就能通过类型检查喂进写侧函数, 疑似安装树静默进批且无报错;
 * 不想手填的调用方走 toSkipCandidates()。
 */
export interface SkipCandidate {
  /** node_modules 绝对路径 */
  target: string;
  /** undefined = 体积未测到 (未测到的条目不进删除批, BC-15) */
  bytes?: number;
  /** 疑似安装树 (语义闸判定, BC-37 / BC-38) */
  suspect: boolean;
}

/** 批次外的目标与原因 (机器码 + 人话并存) */
export interface SkippedTarget {
  /** node_modules 绝对路径 */
  target: string;
  /** 机器可判别的跳过原因 */
  reason: SkipReason;
  /** 中文人话行尾说明 (恒有值) */
  note: string;
}

/** 跳过集册: 码 + 人话一次给全; 与 plan.skipped 同源同值 */
export interface SkipBook {
  /** 跳过集册条目 (与 SweepEntry.skipReason / skipNote 逐条一致) */
  readonly entries: ReadonlyArray<SkippedTarget>;
  /** 末行说明行: 按类与形态各一行, 只在出现时出 */
  readonly trailer: string[];
  /** 目标 → 行尾说明 (只收测得体积的条目: 未测到者的行尾已有体积失败注记, 不混同) */
  readonly hints: ReadonlyMap<string, string>;
}

/**
 * 安全策略。
 * releaseSuspects 对应 CLI 的 --force (BC-38): 只影响批次构造, 不放宽安全闸不变量。
 * 跨设备目标不受本字段影响: 恒不进删除批 (BC-41), 解除路径是声明独立根或先卸载。
 */
export interface SweepPolicy {
  /** 连同疑似安装树一并纳入删除批; 缺省 false */
  releaseSuspects: boolean;
}

/** 编排器构造选项 */
export interface SweepOptions {
  /** 扫描根 (必填, 非空; 库不读平台配置, 由调用方决定扫什么) */
  roots: string[];
  /** 排除名单; 缺省取 DEFAULT_EXCLUDE (与配置省略该字段时的行为同源, BC-20) */
  exclude?: string[];
  /** 包含名单; 缺省 [] (不过滤) */
  include?: string[];
  /** 家目录 (清单缩写与隐藏目录形态判定共用的同一份语义); 缺省 os.homedir(), null 关闭 home 本体防线 */
  home?: string | null;
  /** 路径风味; 缺省平台原生 (测试注入用) */
  style?: PathStyle;
  /** 安全策略; 缺省 { releaseSuspects: false } */
  policy?: SweepPolicy;
}

/** 本次实际生效的选项 (合并缺省后的只读快照, 供审计与日志) */
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
  /** 进度回调; 阶段事件 + 原语层事件透传 (粒度见 api-surface.md §4.2) */
  onProgress?: (event: SweepProgressEvent) => void;
  /** 取消信号; 透传到各层 */
  signal?: AbortSignal;
}

/** 执行面调用选项 (run): 在只读面选项之上加「对账」与「陈旧容忍」两项 */
export interface SweepRunOptions extends SweepPlanOptions {
  /**
   * 期望批次 (通常是先前 plan().batch)。提供时本次删除面 = 期望批次 ∩ 本次实时批次:
   * 期望批次里已消失或被策略挡下的目标不再删 (报告里给 drift.removed);
   * 本次新出现、不在期望批次里的目标不删 (报告里给 drift.added, 条目结果为 not-expected)。
   * 无论提供与否, 判定链上的每个事实仍是此刻的事实 (仍重跑扫描与安全闸),
   * 故期望批次不是「拿旧计划执行」, 而是「给本次执行加一圈用户已批准的范围」。
   */
  expectedBatch?: readonly string[];
  /** 安全闸之前已不存在的目标如何处置; 缺省 'reject' */
  staleTargets?: 'reject' | 'missing';
}

/** 编排器: 只读面与执行面两段 */
export interface Sweeper {
  /** 本次实际生效的选项 (合并缺省后的只读快照, 供审计与日志) */
  readonly options: Readonly<ResolvedSweepOptions>;
  /** 只读: 扫描 + 体积 + 类别 + 设备 + 批次构造, 零删除 */
  plan(options?: SweepPlanOptions): Promise<SweepPlan>;
  /** 执行: 重跑 plan, 经安全闸删除, 出报告 */
  run(options?: SweepRunOptions): Promise<SweepReport>;
}

/** 逐目标的领域条目: 一次清理里一个 node_modules 的完整状态 */
export interface SweepEntry {
  /** node_modules 绝对路径 (扫描原拼写, 非 realpath 形态) */
  target: string;
  /** 直接包含 node_modules 的项目目录 (绝对路径) */
  project: string;
  /** 所属扫描根 (扫多根时按根分组的依据) */
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
  /** 体积未测到时的中文原因 */
  unmeasuredReason?: string;
  /** 是否进入删除批次 (policy 已应用) */
  inBatch: boolean;
  /** inBatch 为 false 时的机器可判别原因 (与 plan.skipped 逐条一致) */
  skipReason?: SkipReason;
  /**
   * inBatch 为 false 时的中文行尾说明。
   * 恒等于同 target 的 plan.skipped[].note 与 SkipBook.entries[].note;
   * 随条目携带, 是为了让「目标 + 为什么跳过」的复核表不必再按 target join 两份数组。
   */
  skipNote?: string;
}

/** 只读面的完整产物 */
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
  /** 逐目标领域条目: 保扫描的 target 升序 */
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

/** 一次执行的总体状态 */
export type SweepRunStatus =
  /** 批次非空且通过安全闸, 已执行删除 (逐条成败见 removal) */
  | 'executed'
  /** 安全闸整批拒绝, 零删除 (BC-22) */
  | 'rejected'
  /** 批次为空 (无可删目标), 零删除 */
  | 'nothing-to-do';

/** 逐目标的执行结果 (判别联合) */
export type EntryOutcome =
  /** 删除成功 */
  | { kind: 'removed' }
  /** 删除阶段核验确认目标已不存在 (EC-01 / EC-07), 计成功侧 */
  | { kind: 'missing' }
  /**
   * 安全闸之前目标已不存在, 按 staleTargets: 'missing' 从批次摘出。
   * 与 missing 的区别是出处: missing 由删除器核验过, stale 从未进入删除面;
   * 两者同属「目标已达成」, 同计成功侧。
   */
  | { kind: 'stale' }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'rejected'; rejection: RejectedTarget }
  /** 批次内但未轮到 (整批中止时中止点及其之后) */
  | { kind: 'not-attempted'; code: AbortCode }
  /**
   * 在期望批次之外 (提供了 expectedBatch, 且本目标不在其中)。
   * 与 skipped 的区别: skipped 是安全策略挡下, not-expected 是调用方给的范围挡下。
   */
  | { kind: 'not-expected' }
  | { kind: 'skipped'; reason: SkipReason };

/** 逐目标执行结果的 kind 取值集 */
export type EntryOutcomeKind = EntryOutcome['kind'];

/** 期望批次与实时批次的差集; 未提供 expectedBatch 时缺省 */
export interface SweepDrift {
  /** 在实时批次但不在期望批次: 本次新出现的目标 (未删) */
  added: string[];
  /** 在期望批次但不在实时批次: 已消失或被策略挡下的目标 (未删) */
  removed: string[];
}

/** 带执行结果的条目 (与 plan.entries 同序同长) */
export interface SweepOutcomeEntry extends SweepEntry {
  outcome: EntryOutcome;
}

/** 执行面的完整产物 */
export interface SweepReport {
  status: SweepRunStatus;
  /**
   * 本次执行所依据的实时计划。与先前 plan() 的结果不一致时,
   * 以本字段为准; 两者的差异另由 drift 显式给出。
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
  /** 期望批次与实时批次的差集; 未提供 expectedBatch 时缺省 */
  drift?: SweepDrift;
}

/** 结果计数摘要 (成功侧 / 未处理 / 真失败 / 整批中止四档) */
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

/**
 * 进度事件 (编排层)。
 * 终结事件契约: plan() 的事件流以 plan-done 收尾, run() 以 done 收尾, 两者之后不再有任何事件;
 * 「流已结束」因此可判定, 异步迭代桥接不再需要把 Promise 结果塞进队列当结束哨兵。
 */
export type SweepProgressEvent =
  | {
      kind: 'phase';
      phase: SweepPhase;
      status: 'start' | 'done';
      elapsedMs?: number;
    }
  | { kind: 'hit'; hit: ScanHit }
  | { kind: 'measured'; target: string; bytes: number; basis: SizeBasis }
  | {
      kind: 'unmeasured';
      target: string;
      code: UnmeasuredCode;
      reason: string;
    }
  | { kind: 'skipped'; target: string; reason: SkipReason }
  | { kind: 'removed'; target: string; outcome: 'removed' | 'missing' }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted'; aborted: AbortedBatch }
  | { kind: 'warning'; warning: SweepWarning }
  /** 只读面终结事件: plan() 的最后一个事件, 携带完整计划 */
  | { kind: 'plan-done'; plan: SweepPlan; elapsedMs: number }
  /** 执行面终结事件: run() 的最后一个事件 */
  | { kind: 'done'; status: SweepRunStatus; elapsedMs: number };
