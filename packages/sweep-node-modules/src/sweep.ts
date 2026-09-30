/**
 * 编排层: createSweeper 的只读面 (plan) 与执行面 (run)。
 * 契约基准: packages/sweep-node-modules/docs/designs/api-surface.md §2.7 / §4 / §7.7 / §7.8。
 *
 * CLI 的处理链 (扫描 → 体积 → 类别 → 设备 → 批次 → 安全闸 → 删除 → 报告) 以本模块为
 * 单一事实来源, CLI 包退化为「组装 SweepOptions → 调 plan / run → 渲染」的薄壳。
 *
 * 实现时落定的细节 (设计留白处的裁定, 逐条记此):
 * - SweepPhase 推进: scan → measure → classify → device → plan → validate → remove;
 *   每阶段成对发 start / done 事件 (done 携带阶段耗时), 阶段内抛错时当前阶段不发 done;
 * - CANCELLED 的 phase: 原语层抛点自带 phase (scan / measure / validate / remove,
 *   remove 附 partial); 编排层在阶段边界补一次检查, 抛「即将进入的阶段」——与各原语的
 *   「工作单元开始前检查」同款语义 (该阶段未完成);
 * - drift 的元素: target 原拼写 (string); added 保实时批次顺序, removed 保期望批次顺序;
 * - gone 目标 (BC-13): 测量时已不存在者不产生 entry、不进候选 / 批次 / 跳过集册,
 *   信号只在 SIZE_TARGET_VANISHED 告警与 SizeResult.gone 里 (与 CLI 现行清单口径一致);
 * - 进度事件面没有 gone 分支 (types.ts SweepProgressEvent 的冻结形态), measure 的
 *   gone 事件在此过滤。
 */
import { homedir } from 'node:os';

import { type Classification, classifyTarget } from './classify.ts';
import type { SweepPhase } from './codes.ts';
import { DEFAULT_EXCLUDE, mergeNames } from './config.ts';
import {
  type RemovalResult,
  removeTargets,
  splitStaleRejections,
  toTrustRoots,
} from './delete.ts';
import { SweepError } from './errors.ts';
import type { RejectedTarget, ValidationResult } from './guard.ts';
import {
  crossDeviceIndex,
  findCrossDeviceTargets,
  nativeStyle,
  validateTargets,
} from './guard.ts';
import { createScanner } from './scan.ts';
import { createSizer } from './size.ts';
import { collectSkips, deletionBatch, skipReasonOf } from './skip.ts';
import { isSuccessOutcome } from './summary.ts';
import type {
  EntryOutcome,
  ResolvedSweepOptions,
  ScanHit,
  SkipCandidate,
  SweepDrift,
  SweepEntry,
  SweepOptions,
  SweepOutcomeEntry,
  SweepPlan,
  SweepPlanOptions,
  SweepProgressEvent,
  SweepReport,
  SweepRunOptions,
  SweepRunStatus,
  Sweeper,
} from './types.ts';

/** 进度回调的入参形态 (缺省 undefined 即静默跑) */
type ProgressSink = ((event: SweepProgressEvent) => void) | undefined;

// 构造期校验与选项解析

/** 构造期参数错误的统一出口 (同步抛; INVALID_ARGUMENT 的 details.field 指首个不符字段) */
const invalidArgument = (field: string, message: string): SweepError =>
  new SweepError('INVALID_ARGUMENT', `${message} (字段: ${field})`, { field });

/** 名单类字段 (roots / exclude / include) 的形状校验: 非空字符串数组; roots 另要求非空 */
function assertNameArray(
  value: unknown,
  field: string,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) throw invalidArgument(field, '为必填项');
    return;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  )
    throw invalidArgument(field, '必须是非空字符串数组');
  if (required && value.length === 0)
    throw invalidArgument(field, '不能为空数组');
}

/**
 * 构造期同步校验 (回答体验报告 1-6 / 5-5 / U14): 同步 API 同步抛, 让调用方尽早失败,
 * 也为 CLI 侧省掉一层 try 缩进; 其余异步入口 (plan / run) 的错误一律走 rejected promise。
 */
function assertShape(options: SweepOptions): void {
  if (typeof options !== 'object' || options === null)
    throw invalidArgument('options', '构造选项必须是对象');
  assertNameArray(options.roots, 'roots', true);
  assertNameArray(options.exclude, 'exclude', false);
  assertNameArray(options.include, 'include', false);
  if (
    options.home !== undefined &&
    options.home !== null &&
    typeof options.home !== 'string'
  )
    throw invalidArgument('home', '必须是字符串或 null');
  if (
    options.policy !== undefined &&
    (typeof options.policy !== 'object' ||
      options.policy === null ||
      typeof options.policy.releaseSuspects !== 'boolean')
  )
    throw invalidArgument('policy', 'releaseSuspects 必须是布尔值');
}

/**
 * 合并缺省并取只读快照: 名单过 mergeNames 收口 (去重 + 静默剔除永不生效名, BC-34),
 * 数组拷贝隔离调用方后续改动, 顶层 freeze 固化快照语义。
 */
function resolveOptions(options: SweepOptions): Readonly<ResolvedSweepOptions> {
  assertShape(options);
  return Object.freeze({
    roots: [...options.roots],
    exclude: mergeNames(options.exclude ?? [...DEFAULT_EXCLUDE], []),
    include: mergeNames(options.include ?? [], []),
    home: options.home === undefined ? homedir() : options.home,
    style: options.style ?? nativeStyle(),
    policy: Object.freeze({
      releaseSuspects: options.policy?.releaseSuspects ?? false,
    }),
  });
}

// 阶段推进 (phase 事件与取消边界检查)

/** 阶段边界检查点的取消错误 (phase 取即将进入的阶段: 该阶段未完成) */
const cancelledAt = (phase: SweepPhase): SweepError =>
  new SweepError('CANCELLED', `清理在 ${phase} 阶段被取消`, { phase });

/**
 * 阶段包装: 入口补一次取消检查 (§4.2 编排层「阶段切换处补一次」), 发 start 事件,
 * 跑 work, 发 done 事件 (携带阶段耗时); work 抛错时当前阶段不发 done (取消与失败
 * 均以抛错收场, 半截阶段不得报完成)。
 */
async function withPhase<T>(
  phase: SweepPhase,
  emit: ProgressSink,
  signal: AbortSignal | undefined,
  work: () => T | Promise<T>,
): Promise<T> {
  if (signal?.aborted) throw cancelledAt(phase);
  const startedAt = Date.now();
  emit?.({ kind: 'phase', phase, status: 'start' });
  const value = await work();
  emit?.({
    kind: 'phase',
    phase,
    status: 'done',
    elapsedMs: Date.now() - startedAt,
  });
  return value;
}

// 只读面 (plan)

/** 计划组装中间物: 逐命中的三件数据 (跳过 gone 之后与命中一一对应) */
interface PreparedTarget {
  hit: ScanHit;
  classification: Classification;
  candidate: SkipCandidate;
}

/**
 * 只读面全链: 扫描 → 体积 → 类别 → 设备 → 批次构造, 零删除。
 * run() 的 plan 段复用本函数, 保证只读面与执行面对计划的理解同源;
 * plan-done 终结事件不在此发出 (那是 plan() 的收尾, run() 以 done 收尾)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   resolved.roots = ['/w'], exclude = ['.git'], include = []
 *   磁盘树 = /w/alpha/node_modules (4.6 GB), /w/pkg/lib/node_modules (80 KB, 命中 lib 形态),
 *            /w/vol/proj/node_modules (4 KB, /w/vol 是挂在根下的另一文件系统)
 *
 * 步骤 1：扫描 → 三条命中 (target 升序), 告警逐条发 warning 事件
 *
 * 步骤 2：体积 → entries 三条全测到 (basis 'disk-usage', du 快路径)
 *
 * 步骤 3：类别 (纯函数) → alpha 为 project; lib 条目命中「父目录为 lib」→ suspect-install-tree
 *
 * 步骤 4：设备 → /w/vol/proj/node_modules 与根不同设备 (on-path)
 *
 * 步骤 5：批次构造 → 候选三条; alpha 进批; lib (疑似, 未放行) 与 vol (跨设备) 被挡;
 *         组装 entries 与 skipped, 逐条发 skipped 事件
 *
 * Output（数据契约）
 *   plan.entries = [alpha inBatch, lib skipReason 'suspect-install-tree', vol 'cross-device:on-path']
 *   plan.batch = ['/w/alpha/node_modules']; plan.skipped 两条; basis = 'disk-usage'
 * ```
 */
async function executePlan(
  resolved: Readonly<ResolvedSweepOptions>,
  options: SweepPlanOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<SweepPlan> {
  const emit = options?.onProgress;
  const roots = resolved.roots;

  const scanResult = await withPhase('scan', emit, signal, async () => {
    const result = await createScanner().scan({
      roots,
      exclude: resolved.exclude,
      include: resolved.include,
      signal,
      onProgress: (event) => emit?.(event),
    });
    // 告警在阶段内逐条发出 (扫描段在前, 供面板在体积统计开始前就看到环境问题)
    for (const warning of result.warnings) emit?.({ kind: 'warning', warning });
    return result;
  });

  const targets = scanResult.hits.map((hit) => hit.target);

  const sizeResult = await withPhase('measure', emit, signal, async () => {
    const result = await createSizer().measure(targets, {
      signal,
      onProgress: (event) => {
        // gone (测量时已不存在) 不进编排事件面: 它不在计划任何桶里 (BC-13),
        // 信号由 SIZE_TARGET_VANISHED 告警承载 (见文件头「实现时落定的细节」)
        if (event.kind === 'gone') return;
        emit?.(event);
      },
    });
    for (const warning of result.warnings) emit?.({ kind: 'warning', warning });
    return result;
  });

  const classifications = await withPhase('classify', emit, signal, () =>
    scanResult.hits.map((hit) =>
      classifyTarget(hit.target, {
        home: resolved.home,
        style: resolved.style,
      }),
    ),
  );

  const crossDevice = await withPhase('device', emit, signal, async () =>
    crossDeviceIndex(
      await findCrossDeviceTargets(targets, {
        roots,
        style: resolved.style,
      }),
    ),
  );

  return withPhase('plan', emit, signal, () => {
    const policy = resolved.policy;
    const bytesOf = new Map(
      sizeResult.entries.map((entry): [string, number] => [
        entry.target,
        entry.bytes,
      ]),
    );
    const unmeasuredOf = new Map(
      sizeResult.unmeasured.map((item) => [item.target, item]),
    );
    const goneSet = new Set(sizeResult.gone);

    const prepared: PreparedTarget[] = [];
    for (let index = 0; index < scanResult.hits.length; index += 1) {
      const hit = scanResult.hits[index];
      const classification = classifications[index];
      // 索引由循环条件保证在界内, 此判仅为 noUncheckedIndexedAccess 的类型收窄
      if (hit === undefined || classification === undefined) continue;
      // BC-13: 测量时已不存在的目标不产生 entry, 也不进候选 (它没有任何可判定的事实)
      if (goneSet.has(hit.target)) continue;
      const bytes = bytesOf.get(hit.target);
      prepared.push({
        hit,
        classification,
        candidate: {
          target: hit.target,
          bytes,
          unmeasuredReason:
            bytes === undefined
              ? unmeasuredOf.get(hit.target)?.reason
              : undefined,
          suspect: classification.kind === 'suspect-install-tree',
        },
      });
    }

    const candidates = prepared.map((item) => item.candidate);
    const batch = deletionBatch(candidates, crossDevice, policy);
    // 跳过集册与批次同源同判定 (skip.ts 单源): skipped 与其 note 直接取集册产物,
    // 保证 SweepEntry.skipNote 与 plan.skipped[].note 恒等 (契约见 types.ts)
    const book = collectSkips(candidates, crossDevice, policy);
    const noteOf = new Map(
      book.entries.map((item): [string, string] => [item.target, item.note]),
    );

    const entries: SweepEntry[] = [];
    for (const { hit, classification, candidate } of prepared) {
      const reason = skipReasonOf(candidate, crossDevice, policy);
      const deviceKind = crossDevice.get(hit.target);
      const unmeasured = unmeasuredOf.get(hit.target);
      entries.push({
        target: hit.target,
        project: hit.project,
        root: hit.root,
        bytes: candidate.bytes,
        basis: candidate.bytes === undefined ? undefined : sizeResult.basis,
        kind: classification.kind,
        kindReason: classification.reason,
        crossDevice: deviceKind,
        unmeasuredCode: unmeasured?.code,
        unmeasuredReason: unmeasured?.reason,
        inBatch: reason === null,
        skipReason: reason ?? undefined,
        skipNote: reason === null ? undefined : noteOf.get(hit.target),
      });
      // 批次外条目在计划成型时逐条播报 (面板据此即时反映「哪些不进批、为什么」)
      if (reason !== null)
        emit?.({ kind: 'skipped', target: hit.target, reason });
    }

    return {
      roots: [...resolved.roots],
      exclude: [...resolved.exclude],
      include: [...resolved.include],
      policy,
      // 体积口径单值: 与逐条 entry.basis 同源; 无任何条目时缺省
      basis: entries.length > 0 ? sizeResult.basis : undefined,
      entries,
      batch,
      skipped: [...book.entries],
      warnings: [...scanResult.warnings, ...sizeResult.warnings],
      nameMatches: {
        exclude: scanResult.excludeMatches,
        include: scanResult.includeMatches,
      },
    };
  });
}

// 执行面 (run)

/**
 * 逐条 outcome 组装: 与 plan.entries 同序同长, 覆盖全部 kind。
 * 判定链的顺序即状态归属的优先级: 批次外 → 期望批次挡下 → 陈旧摘出 → 整批拒绝 → 删除桶。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   plan.entries = [alpha, lib, vol, ghost]  // lib 为疑似安装树 (inBatch=false, skipReason 'suspect-install-tree')
 *   expectedSet = Set { alpha, ghost }       // vol 在期望批次之外 (确认期间新冒出)
 *   stale = [ghost]                          // 期望里有, 但安全闸时已消失被摘出
 *   rejected = []; removal = { removed: [alpha], missing: [], failed: [] }
 *
 * 步骤 1：逐条按判定链归位 (批次外 → 期望挡下 → 陈旧 → 拒绝 → 删除桶)
 *   alpha → removed; lib → skipped; vol → not-expected; ghost → stale
 *
 * Output（数据契约）
 *   entries = [alpha { kind: 'removed' }, lib { kind: 'skipped', reason: 'suspect-install-tree' },
 *              vol { kind: 'not-expected' }, ghost { kind: 'stale' }]
 * ```
 */
function buildOutcomeEntries(
  plan: SweepPlan,
  expectedSet: ReadonlySet<string> | undefined,
  stale: readonly string[],
  rejected: readonly RejectedTarget[],
  removal: RemovalResult | undefined,
): SweepOutcomeEntry[] {
  const staleSet = new Set(stale);
  const rejectedMap =
    rejected.length > 0
      ? new Map(
          rejected.map((item): [string, RejectedTarget] => [item.target, item]),
        )
      : undefined;
  const removedSet = new Set(removal?.removed ?? []);
  const missingSet = new Set(removal?.missing ?? []);
  const failedMap = new Map(
    (removal?.failed ?? []).map((item): [string, typeof item] => [
      item.target,
      item,
    ]),
  );

  const outcomeOf = (entry: SweepEntry): EntryOutcome => {
    // 批次外: inBatch 为假时 skipReason 必在 (SweepEntry 契约, 与 plan.skipped 同源)
    if (!entry.inBatch) return { kind: 'skipped', reason: entry.skipReason! };
    // 期望批次挡下 (调用方给的范围, 非安全策略)
    if (expectedSet !== undefined && !expectedSet.has(entry.target))
      return { kind: 'not-expected' };
    // 安全闸前已消失, 按 staleTargets: 'missing' 摘出 (从未进入删除面)
    if (staleSet.has(entry.target)) return { kind: 'stale' };
    // 整批拒绝: 删除面内非 stale 条目必带拒绝理由 (零删除, BC-22)
    if (rejectedMap !== undefined)
      return { kind: 'rejected', rejection: rejectedMap.get(entry.target)! };
    // 已执行: 按删除桶给出
    if (removedSet.has(entry.target)) return { kind: 'removed' };
    if (missingSet.has(entry.target)) return { kind: 'missing' };
    const failure = failedMap.get(entry.target);
    if (failure !== undefined) return { kind: 'failed', failure };
    // 未出桶的批次内条目只可能是整批中止点及其之后 (从未被尝试):
    // removeTargets 对已尝试条目保证出桶, 故此处中止信息必在 (完备性见 delete.ts 循环)
    return { kind: 'not-attempted', code: removal!.aborted!.code };
  };

  return plan.entries.map((entry) => ({ ...entry, outcome: outcomeOf(entry) }));
}

/**
 * 执行面全链: 重跑 plan → 对账 (expectedBatch) → 安全闸 → 删除 → 报告。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   resolved.roots = ['/w']; options.expectedBatch = ['/w/alpha/node_modules'], staleTargets: 'missing'
 *   实时批次 = ['/w/alpha/node_modules', '/w/beta/node_modules']   // beta 是确认期间新冒出来的
 *
 * 步骤 1：重跑 plan → 实时计划 (判定链上的每个事实仍是此刻的事实)
 *   plan.batch = [alpha, beta]
 *
 * 步骤 2：对账 → 删除面 = 期望 ∩ 实时 = [alpha]; drift = { added: [beta], removed: [] }
 *
 * 步骤 3：安全闸 → alpha 通过; 若 alpha 校验时已不存在则摘入 stale (不触发整批拒绝)
 *
 * 步骤 4：删除 → alpha removed; beta 条目的 outcome 为 not-expected (从未进删除面)
 *
 * Output（数据契约）
 *   report.status = 'executed'; report.stale = [];
 *   report.entries = [alpha removed, beta not-expected]; report.drift = { added: [beta], removed: [] }
 * ```
 */
async function executeRun(
  resolved: Readonly<ResolvedSweepOptions>,
  options: SweepRunOptions | undefined,
  signal: AbortSignal | undefined,
): Promise<SweepReport> {
  const emit = options?.onProgress;
  const startedAt = Date.now();
  const plan = await executePlan(resolved, options, signal);

  // 删除面 = 实时批次 ∩ 期望批次 (expectedBatch 缺省时即实时批次本身)
  const expected = options?.expectedBatch;
  const expectedSet = expected === undefined ? undefined : new Set(expected);
  const face =
    expectedSet === undefined
      ? plan.batch
      : plan.batch.filter((target) => expectedSet.has(target));

  // 对账差集 (仅 expectedBatch 提供时给出): added / removed 保各自输入顺序, 元素为原拼写
  const liveSet = new Set(plan.batch);
  const drift: SweepDrift | undefined =
    expected === undefined || expectedSet === undefined
      ? undefined
      : {
          added: plan.batch.filter((target) => !expectedSet.has(target)),
          removed: expected.filter((target) => !liveSet.has(target)),
        };

  let validation: ValidationResult | undefined;
  let removal: RemovalResult | undefined;
  let stale: string[] = [];
  let rejected: RejectedTarget[] = [];

  if (face.length > 0) {
    const raw = await withPhase('validate', emit, signal, () =>
      validateTargets(face, {
        roots: resolved.roots,
        home: resolved.home,
        style: resolved.style,
        signal,
      }),
    );
    // 陈旧容忍: 摘出的已消失目标单列 stale (窄例外见 splitStaleRejections);
    // validation 报「进入删除面的判定结果」, rejected 为摘出 stale 后的剩余
    const split = splitStaleRejections(raw.rejected, options?.staleTargets);
    stale = split.stale;
    rejected = split.rejected;
    validation = {
      accepted: raw.accepted,
      rejected,
      mappings: raw.mappings,
    };

    if (rejected.length === 0) {
      removal = await withPhase('remove', emit, signal, async () =>
        removeTargets(raw.accepted, {
          roots: await toTrustRoots(resolved.roots),
          signal,
          onProgress: (event) => {
            // removed / missing 在编排事件面合并为一条 removed (outcome 区分); failed / aborted 同形透传
            if (event.kind === 'removed' || event.kind === 'missing') {
              emit?.({
                kind: 'removed',
                target: event.target,
                outcome: event.kind,
              });
              return;
            }
            emit?.(event);
          },
        }),
      );
    }
  }

  // 三态归位: 删除面为空 → nothing-to-do (零删除, validation / removal 缺省);
  // 安全闸有剩余拒绝 → rejected (零删除, removal 缺省); 其余 → executed
  let status: SweepRunStatus;
  if (face.length === 0) status = 'nothing-to-do';
  else if (rejected.length > 0) status = 'rejected';
  else status = 'executed';

  const entries = buildOutcomeEntries(
    plan,
    expectedSet,
    stale,
    rejected,
    removal,
  );
  // 释放量 = 成功侧 (removed + missing + stale) 的体积累计, 口径与 CLI 汇总行同源
  const releasedBytes = entries.reduce(
    (sum, entry) =>
      isSuccessOutcome(entry.outcome) ? sum + (entry.bytes ?? 0) : sum,
    0,
  );

  const report: SweepReport = {
    status,
    plan,
    validation,
    removal,
    entries,
    stale,
    releasedBytes,
    drift,
  };
  // 终结事件契约: run() 的最后事件, 之后不再有任何事件 (取消时终结事件不出现, 以抛错收场)
  emit?.({ kind: 'done', status, elapsedMs: Date.now() - startedAt });
  return report;
}

// 构造器

/**
 * 构造编排器。参数错误 (roots 为空 / 非字符串数组等) 在构造期**同步抛出**
 * (INVALID_ARGUMENT, details.field 指首个不符字段); 其余异步入口 (plan / run) 的
 * 参数与环境错误一律以 rejected promise 形式抛出。
 */
export function createSweeper(options: SweepOptions): Sweeper {
  const resolved = resolveOptions(options);
  return {
    options: resolved,
    async plan(planOptions?: SweepPlanOptions): Promise<SweepPlan> {
      const startedAt = Date.now();
      const plan = await executePlan(
        resolved,
        planOptions,
        planOptions?.signal,
      );
      // 终结事件契约: plan() 的最后事件, 携带完整计划 (§4.1)
      planOptions?.onProgress?.({
        kind: 'plan-done',
        plan,
        elapsedMs: Date.now() - startedAt,
      });
      return plan;
    },
    run(runOptions?: SweepRunOptions): Promise<SweepReport> {
      return executeRun(resolved, runOptions, runOptions?.signal);
    },
  };
}
