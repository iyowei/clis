/**
 * 核心编排引擎: `createSweeper` 的只读预览面 (`plan`) 与执行清理面 (`run`), CLI 退化为组装选项与渲染的薄壳。
 * 契约基准: packages/sweep/docs/designs/api-surface.md §2.7 / §4 / §7.7 / §7.8。
 * 阶段推进顺序 (成对发 `phase` start/done 携带耗时, 阶段内抛错不发 done):
 * `scan` -> `measure` -> `classify` -> `device` -> `plan` -> `validate` -> `remove`。
 * 关键规则与红线:
 * - 多预设/自定义规则与双动作通路: `classify` 仅对 `node` 预设启用安装树语义闸, 非 `node` 预设与规则直归 `project`;
 *   `validate` / `remove` 开启 `allowGeneralTargets: true` 并以活跃预设/规则的 `allowedLeaf` 收紧, 按 `actionByReal` 分流 `delete` 与 `trash`;
 * - 事件桥接与取消: 原语层取消自带 `phase`, 编排层在阶段边界补检; `measure` 的 `gone` 不进编排事件面 (仅入 `SIZE_TARGET_VANISHED` 与 `SizeResult.gone`, BC-13);
 *   `remove` 的 `removed` / `trashed` / `missing` 统一桥接为 `{ kind: 'removed', target, outcome }`; `plan` 以 `plan-done`、`run` 以 `done` 终结。
 */
import { type Classification, classifyTarget } from './classify.ts';
import type { CleanupAction, SweepPhase } from './codes.ts';
import { type RemovalResult, removeTargets, toTrustRoots } from './delete.ts';
import { SweepError } from './errors.ts';
import type { PathMapping, RejectedTarget, ValidationResult } from './guard.ts';
import {
  crossDeviceIndex,
  findCrossDeviceTargets,
  validateTargets,
} from './guard.ts';
import { matchesAnyActivePresetLeaf } from './presets.ts';
import { matchesAnyRuleLeaf } from './rules.ts';
import { createScanner } from './scan.ts';
import { createSizer } from './size.ts';
import { collectSkips, deletionBatch, skipReasonOf } from './skip.ts';
import { splitStaleRejections } from './stale.ts';
import { isSuccessOutcome } from './summary.ts';
import { resolveSweepOptions } from './sweep-options.ts';
import type { TrashDeps } from './trash.ts';
import type {
  EntryOutcome,
  HitSource,
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

/** 可注入运行时钩子 (测试控制时间基准与回收站桩) */
interface RuntimeHooks {
  nowMs?: number;
  trashDeps?: TrashDeps;
}

/**
 * 只读面全链: `scan -> measure -> classify -> device -> plan`, 零清理副作用。
 * `run()` 复用本函数保证只读面与执行面计划同源; `plan-done` 终结事件由外层 `plan()` 发出。
 *
 * ### 数据流转示例
 * ```text
 * Input: resolved = { roots: ['/w'], presets: { node: {}, rust: { action: 'trash' } }, exclude: ['.nvm'], include: [] }
 *   磁盘树 = /w/alpha/node_modules (4.6 GB), /w/pkg/lib/node_modules (80 KB, 命中 lib 形态),
 *            /w/rs/target (120 MB, 含 Cargo.toml), /w/vol/proj/node_modules (4 KB, 跨设备挂载点)
 * 步骤 1 (scan): 命中 4 条并升序输出, 逐条发 hit 与 warning 事件
 * 步骤 2 (measure): 测得 4 条体积 (du 快路径 basis 'disk-usage'; gone 条目在 plan 阶段剔除, 不产 entry)
 * 步骤 3 (classify): 仅 node 预设走 classifyTarget -> pkg/lib 判 suspect-install-tree; rust 命中 rs/target 直归 project
 * 步骤 4 (device): vol/proj/node_modules 检出跨设备 'on-path'
 * 步骤 5 (plan): 构造批次与跳过集册 -> alpha(delete) 与 rs/target(trash) 入批; pkg/lib(suspect) 与 vol(cross-device) 进 skipped 并发事件
 * Output: { entries: [alpha inBatch, pkg/lib skipped, rs/target inBatch(trash), vol skipped],
 *           batch: ['/w/alpha/node_modules', '/w/rs/target'], skipped: [pkg/lib, vol], basis: 'disk-usage' }
 * ```
 */
async function executePlan(
  resolved: Readonly<ResolvedSweepOptions>,
  options: SweepPlanOptions | undefined,
  signal: AbortSignal | undefined,
  hooks: RuntimeHooks = {},
): Promise<SweepPlan> {
  const emit = options?.onProgress;
  const roots = [...resolved.roots];

  const scanResult = await withPhase('scan', emit, signal, async () => {
    const result = await createScanner().scan({
      roots: [...roots],
      exclude: [...resolved.exclude],
      include: [...resolved.include],
      presets: resolved.presets,
      rules: resolved.rules,
      home: resolved.home,
      excludeExplicit: resolved.excludeExplicit,
      nowMs: hooks.nowMs,
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
    scanResult.hits.map((hit) => {
      const isNodePreset =
        hit.source === undefined ||
        (hit.source.kind === 'preset' && hit.source.name === 'node');
      if (!isNodePreset) return { kind: 'project' } satisfies Classification;
      return classifyTarget(hit.target, {
        home: resolved.home,
        style: resolved.style,
      });
    }),
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
      const source: HitSource = hit.source ?? { kind: 'preset', name: 'node' };
      entries.push({
        target: hit.target,
        project: hit.project,
        root: hit.root,
        entryKind: hit.entryKind ?? 'dir',
        action: hit.action ?? 'delete',
        source,
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
      policy: { releaseSuspects: policy.releaseSuspects },
      // 体积口径单值: 与逐条 entry.basis 同源; 无任何条目时缺省
      basis: entries.length > 0 ? sizeResult.basis : undefined,
      entries,
      batch,
      skipped: [...book.entries],
      trailer: [...book.trailer],
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
 * 逐条 `outcome` 组装: 与 `plan.entries` 同序同长, 覆盖全部 9 种 `EntryOutcomeKind`。
 * 判定优先级: 批次外 (`skipped`) -> 期望批次挡下 (`not-expected`) -> 陈旧摘出 (`stale`) ->
 * 安全闸整批拒绝 (`rejected` / `BATCH_REJECTED`) -> 经 `mappings` 映射 `real` 后查四桶 (`removed` / `trashed` / `missing` / `failed`) -> 中止未派发 (`not-attempted`)。
 *
 * ### 数据流转示例
 * ```text
 * Input: plan.entries = [alpha(delete), cache(trash), lib(inBatch=false), vol(inBatch=true), ghost(inBatch=true)]
 *        expectedSet = Set { alpha, cache, ghost } (vol 在期望外); stale = [ghost]; rejected = []
 *        removal = { removed: [real(alpha)], trashed: [real(cache)], missing: [], failed: [] }
 * 步骤 1: 按优先级逐条归位:
 *   alpha -> 查 removedSet(real) -> 'removed'; cache -> 查 trashedSet(real) -> 'trashed'
 *   lib -> !inBatch -> 'skipped'; vol -> !expectedSet -> 'not-expected'; ghost -> staleSet -> 'stale'
 * Output: [alpha removed, cache trashed, lib skipped('suspect-install-tree'), vol not-expected, ghost stale]
 * ```
 */
function buildOutcomeEntries(
  plan: SweepPlan,
  expectedSet: ReadonlySet<string> | undefined,
  stale: readonly string[],
  rejected: readonly RejectedTarget[],
  mappings: readonly PathMapping[],
  removal: RemovalResult | undefined,
): SweepOutcomeEntry[] {
  const staleSet = new Set(stale);
  let rejectedMap: Map<string, RejectedTarget> | undefined;
  if (rejected.length > 0) {
    rejectedMap = new Map<string, RejectedTarget>();
    for (const item of rejected) {
      if (!rejectedMap.has(item.target)) rejectedMap.set(item.target, item);
    }
  }
  // removeTargets 接收的是安全闸已 realpath 化的 accepted 路径, 其返回分桶中存的是 real 形态;
  // 按 validation.mappings 把原拼写映射到 real 后再查桶, 消除 original !== real 时查桶失配崩溃
  const realOf = new Map(
    mappings.map((item): [string, string] => [item.original, item.real]),
  );
  const removedSet = new Set(removal?.removed ?? []);
  const trashedSet = new Set(removal?.trashed ?? []);
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
    // 整批拒绝 (BC-22): 直接被安全闸拒收的条目归 rejected (必带拒绝理由);
    // 同批通过闸门、因整批零删除而连带未删的健康条目归 not-attempted ('BATCH_REJECTED')
    if (rejectedMap !== undefined) {
      const rejection = rejectedMap.get(entry.target);
      return rejection !== undefined
        ? { kind: 'rejected', rejection }
        : { kind: 'not-attempted', code: 'BATCH_REJECTED' };
    }
    // 已执行: 按 real 路径查删除/回收站桶
    const realTarget = realOf.get(entry.target) ?? entry.target;
    if (removedSet.has(realTarget)) return { kind: 'removed' };
    if (trashedSet.has(realTarget)) return { kind: 'trashed' };
    if (missingSet.has(realTarget)) return { kind: 'missing' };
    const failure = failedMap.get(realTarget);
    if (failure !== undefined) return { kind: 'failed', failure };
    // 未出桶的批次内条目只可能是整批中止触发条或其后未派发的条目
    // (并发窗口内已派发条目均会完成并出桶, 完备性见 delete.ts 循环)
    return { kind: 'not-attempted', code: removal!.aborted!.code };
  };

  return plan.entries.map((entry) => ({ ...entry, outcome: outcomeOf(entry) }));
}

/**
 * 执行面全链: 重跑 `executePlan` -> 对账 (`expectedBatch` 与 `drift`) -> `validate` 安全闸 -> `remove` 清理 -> 报告 + `done` 事件。
 *
 * ### 数据流转示例
 * ```text
 * Input: resolved = { roots: ['/w'], presets: { node: {}, rust: { action: 'trash' } } },
 *        options = { expectedBatch: ['/w/alpha/node_modules', '/w/rs/target'], staleTargets: 'missing' }
 *        实时批次 = ['/w/alpha/node_modules', '/w/rs/target', '/w/beta/node_modules'] (beta 为确认期间新增)
 * 步骤 1 (plan): 重跑全只读链确保事实实时有效 -> plan.batch = [alpha, rs/target, beta]
 * 步骤 2 (对账): face = 期望 ∩ 实时 = [alpha, rs/target]; drift = { added: [beta], removed: [] }
 * 步骤 3 (validate): 启用 allowGeneralTargets: true + allowedLeaf (活跃预设/规则白名单) 校验 face;
 *        按 staleTargets 拆出 GUARD_TARGET_MISSING 至 stale (有剩余硬拒绝则零清理返回 status: 'rejected')
 * 步骤 4 (remove): 按 mappings 映射 actionByReal, 调 removeTargets 分流 fs.rm 与 moveToTrash
 * 步骤 5 (汇总): buildOutcomeEntries 逐条归位, releasedBytes 累加成功侧 (removed + trashed + missing + stale), 发 done 终结事件
 * Output: { status: 'executed', entries: [alpha removed, rs/target trashed, beta not-expected],
 *           drift: { added: [beta], removed: [] }, stale: [], releasedBytes }
 * ```
 */
async function executeRun(
  resolved: Readonly<ResolvedSweepOptions>,
  options: SweepRunOptions | undefined,
  signal: AbortSignal | undefined,
  hooks: RuntimeHooks = {},
): Promise<SweepReport> {
  const emit = options?.onProgress;
  const startedAt = Date.now();
  const plan = await executePlan(resolved, options, signal, hooks);

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
    const allowedLeaf = (leaf: string): boolean =>
      matchesAnyActivePresetLeaf(leaf, resolved.presets) ||
      matchesAnyRuleLeaf(leaf, resolved.rules);
    const raw = await withPhase('validate', emit, signal, () =>
      validateTargets(face, {
        roots: [...resolved.roots],
        home: resolved.home,
        style: resolved.style,
        signal,
        allowGeneralTargets: true,
        allowedLeaf,
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
      const actionByOriginal = new Map<string, CleanupAction>(
        plan.entries.map((entry): [string, CleanupAction] => [
          entry.target,
          entry.action,
        ]),
      );
      const actionByReal = new Map<string, CleanupAction>();
      for (const { original, real } of raw.mappings) {
        const act = actionByOriginal.get(original);
        if (act !== undefined) actionByReal.set(real, act);
      }

      removal = await withPhase('remove', emit, signal, async () =>
        removeTargets(raw.accepted, {
          roots: await toTrustRoots([...resolved.roots]),
          style: resolved.style,
          signal,
          actions: actionByReal,
          allowGeneralTargets: true,
          trashDeps: hooks.trashDeps,
          onProgress: (event) => {
            // removed / trashed / missing 在编排事件面合并为一条 removed (outcome 区分); failed / aborted 同形透传
            if (
              event.kind === 'removed' ||
              event.kind === 'trashed' ||
              event.kind === 'missing'
            ) {
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
    validation?.mappings ?? [],
    removal,
  );
  // 释放量 = 成功侧 (removed + trashed + missing + stale) 的体积累计, 口径与 CLI 汇总行同源
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
 * 构造清理编排器 (`plan` 只读预览 + `run` 核验执行)。
 * 参数错误 (如 `roots` 为空/相对路径) 在构造期同步抛 `SweepError('INVALID_ARGUMENT', ..., { field })`;
 * 异步入口 (`plan` / `run`) 的运行期与取消错误一律以 rejected Promise 抛出。
 *
 * ### 数据流转示例
 * ```text
 * Input: sweeper = createSweeper({ roots: ['/w'], presets: { node: {}, rust: { action: 'trash' } } })
 * 步骤 1 (构造): resolveSweepOptions 同步校验并冻结只读快照 sweeper.options
 * 步骤 2 (预览): plan = await sweeper.plan() -> 只读跑 scan..plan 并以 plan-done 终结, 取 plan.batch 供用户确认
 * 步骤 3 (执行): report = await sweeper.run({ expectedBatch: plan.batch, staleTargets: 'missing' })
 *                -> 重跑实时 plan -> 与 expectedBatch 对账 -> 安全闸 -> delete/trash 执行 -> 以 done 终结
 * Output: report (含 status / plan / validation / removal / entries / stale / releasedBytes / drift)
 * ```
 */
export function createSweeper(options: SweepOptions): Sweeper {
  const resolved = resolveSweepOptions(options);
  const hooks: RuntimeHooks = {
    nowMs: options.nowMs,
    trashDeps: options.trashDeps,
  };
  return {
    options: resolved,
    async plan(planOptions?: SweepPlanOptions): Promise<SweepPlan> {
      const startedAt = Date.now();
      const plan = await executePlan(
        resolved,
        planOptions,
        planOptions?.signal,
        hooks,
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
      return executeRun(resolved, runOptions, runOptions?.signal, hooks);
    },
  };
}
