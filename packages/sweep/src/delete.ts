/**
 * 清理执行器与写侧编排入口 (`removeTargets` / `removeBatch`):
 * 上游: `sweep.ts` 与外部写侧调用方; 下游: `delete-review.ts` (删前实时复核)、`trash.ts` (回收站)、`guard.ts`、`stale.ts`。
 * 执行语义 (设计: packages/sweep/docs/designs/deletion-guard.md「执行语义」):
 * - 4 路有界并发 (`REMOVAL_CONCURRENCY = 4`), 按 `actions` 分流永久删除 (`fs.rm`) 与移入回收站 (`moveToTrash`), 末尾按输入序归四桶 (`removed` / `trashed` / `missing` / `failed`);
 * - 红线 1 (`trash` 严禁降级): 移入回收站失败一律归 `TRASH_FAILED` (`partialRisk: false`, 原文件完好), 绝不降级 `fs.rm`;
 * - 红线 2 (ENOENT 双运行时兜底): `fs.rm` 报 `ENOENT` 时必 `lstat` 复核目标本体, 确认已消失才归 `missing` (成功侧), 仍在或不可达归 `REMOVE_ENOENT_SURVIVOR` (防 Bun 冒泡内部条目 ENOENT 伪造成功);
 * - 红线 3 (防 TOCTOU 与锚点换位): 每条执行前由 `delete-review.ts` 同步校验形态 (受 `allowGeneralTargets` 控制) + 并发实时 `lstat` 信任根完整祖先链与父路径链, 检出替换即整批中止 (`aborted` 取批次序最前触发条); 残余竞态窗口限于路径级 API 边界, 须配套 `TrustRoot` 使用。
 */
import { lstat, realpath, rm } from 'node:fs/promises';

import type { AbortCode, CleanupAction, RemoveFailureCode } from './codes.ts';
import {
  type FsError,
  describeCode,
  prepareReviewRoots,
  resolveTargetRootSync,
  reviewPathOnDisk,
} from './delete-review.ts';
import { SweepError } from './errors.ts';
import {
  type PathMapping,
  type PathStyle,
  type RejectedTarget,
  nativeStyle,
  validateTargets,
} from './guard.ts';
import { splitStaleRejections } from './stale.ts';
import { type TrashDeps, moveToTrash } from './trash.ts';

export interface TargetFailure {
  /** 调用方传入的目标 (原样回显, 不做二次 realpath) */
  target: string;
  /** 机器可判别的失败码 (程序分流只许看它, 严禁对 message 做字符串匹配) */
  code: RemoveFailureCode;
  /** 原始 errno (EACCES / EBUSY / ENOENT …), 无则缺省 */
  errno?: string;
  /**
   * 「错误码: 人话 (目标: 路径; …)」形态的可读串 (文案逐字保留现状)。
   * 删除已尝试而失败时附复查提示 (内容可能已残缺); 复核未通过而根本未删则注明「未执行删除」。
   */
  message: string;
  /** 内容可能已被部分或全部删除 (EC-05 半完成语义的机器标记); false 意味着「未执行删除」 */
  partialRisk: boolean;
}

/** 整批中止信息 (首个复核未通过的目标) */
export interface AbortedBatch {
  /** 触发中止的目标 (未被删除) */
  target: string;
  /** 机器可判别的中止码 */
  code: AbortCode;
  /** 中文人话, 含定位 (文案逐字保留现状) */
  message: string;
  /** 定位路径 (触发中止的根 / 组件) */
  path?: string;
}

export interface RemovalResult {
  /** 实际永久删除成功的目标 (保输入顺序) */
  removed: string[];
  /** 实际移入系统回收站成功的目标 (保输入顺序) */
  trashed: string[];
  /** rm 报 ENOENT 且复核确认目标本体已不存在的目标; 目标已达成, 计成功侧 (保输入顺序) */
  missing: string[];
  /** 删除/回收站失败与复核未完成 (组件消失 / 不可核验) 的目标及原因 (保输入顺序); 回收站失败与复核失败均未删原文件 */
  failed: TargetFailure[];
  /** 安全复核未通过即中止整批 (触发后停止派发新条目, 并发窗口内已派发条目会完成并如实报告); 未触发时缺省 */
  aborted?: AbortedBatch;
}

/** 删除/回收站操作的进度事件 (每条目标出桶即发一条) */
export type RemovalProgressEvent =
  | { kind: 'removed'; target: string }
  | { kind: 'trashed'; target: string }
  | { kind: 'missing'; target: string }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted'; aborted: AbortedBatch };

/**
 * 信任根: 配置里的原始拼写与 realpath 归一形态成对出现 (配对由类型强制, 拆开即失去一层防线)。
 * - `configured`: 链头判定的对象 —— 配置里的名字被换成符号链接时, 只有拼写形态能检出;
 * - `real`: isUnder 与复核链的比较基准, 须与 targets 同源 (realpath 形态; 根不可解析时调用方保留原拼写)。
 */
export interface TrustRoot {
  configured: string;
  real: string;
}

export interface RemovalOptions {
  /**
   * 可删目标所属的信任根 (与 guard 同源)。`real` 拼写须与 targets 一致 (建议同为 realpath 化结果);
   * `configured` 供链头判定。目标不在任何根之下时无可信复核, 整批中止。
   */
  roots: TrustRoot[];
  /** 路径判定风味 (win32 大小写折叠与分隔符语义); 缺省随当前平台 */
  style?: PathStyle;
  /** 取消信号; 只在条目之间检查, 绝不在单条 rm 中途中断 (那会制造新的半删状态) */
  signal?: AbortSignal;
  /** 进度回调; 粒度: 每条目标出桶即发一条 */
  onProgress?: (event: RemovalProgressEvent) => void;
  /** 逐目标动作映射 (`'trash' | 'delete'`); 缺省均走 `'delete'` */
  actions?: ReadonlyMap<string, CleanupAction>;
  /** 泛化目标放行开关 (配合多预设/自定义规则使用, 仍强拦截尾斜杠 / `.` / `..` / `.git`) */
  allowGeneralTargets?: boolean;
  /** 可注入回收站依赖 (测试桩注入用) */
  trashDeps?: TrashDeps;
}

/**
 * 失败桶统一附带的复查提示: rm 递归是先删内容、最后删壳, 中途失败时内容往往已残缺
 * (实测父目录只读场景: 内容清空、只剩空壳), 不提示会误导用户以为「依赖还安全」。
 */
const PARTIAL_DELETION_HINT = '注意: 目录内容可能已被部分或全部删除, 请复查';

/** 拼「错误码 + 人话 + 目标定位 + 复查提示」的删除失败串 */
function describeRemovalError(target: string, error: unknown): string {
  return `${describeCode(error)} (目标: ${target}; ${PARTIAL_DELETION_HINT})`;
}

/** rm 阶段 ENOENT 后的目标本体复核结果 (三态) */
type GoneState = 'gone' | 'present' | 'unknown';

/**
 * 目标本体是否仍存在 (rm 阶段 ENOENT 后的复核, 双运行时语义分叉的兜底)。
 * 取 lstat 语义与 fs.rm 的末段判定对齐 (目标为符号链接时判链接本体); 复核不可达归 unknown,
 * 与 present 同侧处置 (无法证明已消失就不报成功), 方向落在安全侧。
 */
async function checkGone(path: string): Promise<GoneState> {
  try {
    await lstat(path);
    return 'present';
  } catch (error) {
    return (error as FsError | null)?.code === 'ENOENT' ? 'gone' : 'unknown';
  }
}

/**
 * rm 报 ENOENT 但目标本体仍在 (或复核不可达) 的可读串: rm 递归先删内容后删壳, 中途失败时
 * 内容往往已残缺, 必须复查; 与 missing (目标已消失, 成功侧) 严格区分。
 */
function describeSurvivor(target: string, state: GoneState): string {
  const review =
    state === 'present' ? '复核确认目标仍存在' : '目标是否仍存在未能核验';
  return `ENOENT: 删除中途失败 (${review}) (目标: ${target}; ${PARTIAL_DELETION_HINT})`;
}

/**
 * 删除的并发度 (2026-09-29 性能审计实测校准): rm 是删除面的墙钟大头 (1200 条实测: 裸 rm 串行
 * 约 800ms, 前置复核仅 35ms), 4 路并发实测 1.7× (约 530ms), 8 路回退 (APFS 元数据锁竞争),
 * 故取 4。
 */
const REMOVAL_CONCURRENCY = 4;

/**
 * 单条的处理归属 (按批次索引收集, 排空后重排; undefined = 未派发 / 取消前未尝试)。
 * 带 target 便于重排时直取, 免二次索引收窄。
 */
type RemovalSlot =
  | { kind: 'removed'; target: string }
  | { kind: 'trashed'; target: string }
  | { kind: 'missing'; target: string }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted' };

/** 执行单条移入回收站: 任何失败绝不静默降级为永久删除 (核心红线); 若目标已并发消失则同 rm 归 missing */
async function executeTrash(
  target: string,
  trashDeps?: TrashDeps,
): Promise<Exclude<RemovalSlot, { kind: 'aborted' }>> {
  const outcome = await moveToTrash(target, trashDeps);
  if (outcome.ok) {
    return { kind: 'trashed', target };
  }
  if (outcome.errno === 'ENOENT') {
    const state = await checkGone(target);
    if (state === 'gone') return { kind: 'missing', target };
  }
  return {
    kind: 'failed',
    failure: {
      target,
      code: 'TRASH_FAILED',
      errno: outcome.errno,
      message: outcome.message,
      partialRisk: false,
    },
  };
}

/** 执行单条 fs.rm 并在 ENOENT 时复核目标本体, 返回最终 slot (onProgress 留给调用方发射, 防回调抛错污染) */
async function executeRm(
  target: string,
): Promise<Exclude<RemovalSlot, { kind: 'aborted' }>> {
  try {
    await rm(target, { recursive: true, force: false });
    return { kind: 'removed', target };
  } catch (error) {
    if ((error as FsError | null)?.code === 'ENOENT') {
      const state = await checkGone(target);
      if (state === 'gone') return { kind: 'missing', target };
      return {
        kind: 'failed',
        failure: {
          target,
          code: 'REMOVE_ENOENT_SURVIVOR',
          errno: 'ENOENT',
          message: describeSurvivor(target, state),
          partialRisk: true,
        },
      };
    }
    return {
      kind: 'failed',
      failure: {
        target,
        code: 'REMOVE_FAILED',
        errno: (error as FsError | null)?.code,
        message: describeRemovalError(target, error),
        partialRisk: true,
      },
    };
  }
}

/** 排空后按批次索引重排组装结果: 桶恒保输入顺序, 与并发完成序无关 */
function assembleRemovalResult(
  slots: readonly (RemovalSlot | undefined)[],
  aborted: AbortedBatch | undefined,
): RemovalResult {
  const result: RemovalResult = {
    removed: [],
    trashed: [],
    missing: [],
    failed: [],
  };
  for (const slot of slots) {
    if (slot === undefined) continue;
    switch (slot.kind) {
      case 'removed':
        result.removed.push(slot.target);
        break;
      case 'trashed':
        result.trashed.push(slot.target);
        break;
      case 'missing':
        result.missing.push(slot.target);
        break;
      case 'failed':
        result.failed.push(slot.failure);
        break;
      case 'aborted':
        break;
    }
  }
  if (aborted !== undefined) result.aborted = aborted;
  return result;
}

/**
 * 逐条复核并执行清理 (永久删除或移入回收站), 单条失败不中断整批, 复核检出替换则整批中止,
 * 排空后按输入顺序组装四桶 (`removed` / `trashed` / `missing` / `failed`)。
 *
 * 并发模型 (为什么可 4 路并发且安全模型不变):
 * 1. 单条 rm 绝不在中途中断, 「复核紧跟执行」的条内时序逐字保留;
 * 2. 扫描对已命中目录目标即剪枝, 同批目标互不嵌套, 并发清理不污染彼此的父路径复核读;
 * 3. 中止/取消均定义为「停止派发新条 + 在飞条目跑完」: `aborted` 取批次序最前的触发条 (确定性不随调度漂移),
 *    取消时以 `partial` 交回全部已派发结果; 进度事件为完成序 (见 packages/sweep/docs/designs/api-surface.md §4.4)。
 *
 * ### 数据流转示例
 * ```text
 * Input: targets = ['/w/a/node_modules', '/w/b/cache', '/w/lock/node_modules', '/w/bare/node_modules'],
 *        options = { roots: [{ configured: '/w', real: '/w' }], allowGeneralTargets: true,
 *                    actions: Map { '/w/b/cache' => 'trash' } }
 * 步骤 1: 4 路池逐条过 resolveTargetRootSync + reviewPathOnDisk (任一级检出替换即停泵记 aborted)
 * 步骤 2: 按 actions 分流执行:
 *   - '/w/a/node_modules' -> fs.rm 成功 -> removed
 *   - '/w/b/cache' -> moveToTrash 成功 -> trashed (若失败则归 failed / TRASH_FAILED / partialRisk: false, 严禁降级 fs.rm)
 *   - '/w/lock/node_modules' -> fs.rm 抛 EACCES -> failed (REMOVE_FAILED, partialRisk: true)
 *   - '/w/bare/node_modules' -> fs.rm 抛 ENOENT 且 checkGone 确认已消失 -> missing (若仍在归 REMOVE_ENOENT_SURVIVOR)
 * 步骤 3: 池排空后按输入索引重排四桶输出
 * Output: { removed: ['/w/a/node_modules'], trashed: ['/w/b/cache'],
 *           missing: ['/w/bare/node_modules'], failed: [{ target: '/w/lock/node_modules', code: 'REMOVE_FAILED', ... }] }
 * ```
 */
export async function removeTargets(
  targets: string[],
  options: RemovalOptions,
): Promise<RemovalResult> {
  // 入口取消预检: 即便 targets 为空数组, 已中止的 signal 仍须立即抛 CANCELLED
  if (options?.signal?.aborted) {
    throw new SweepError('CANCELLED', '删除在条目间检查点被取消', {
      phase: 'remove',
      partial: { removed: [], trashed: [], missing: [], failed: [] },
    });
  }
  // 防 JS 调用方漏传选项: 无信任根即无可信复核, 一律中止 (保守)
  const style = options?.style ?? nativeStyle();
  const roots = prepareReviewRoots(options?.roots ?? [], style);
  const signal = options?.signal;
  const actions = options?.actions;
  const allowGeneralTargets = options?.allowGeneralTargets ?? false;
  const trashDeps = options?.trashDeps;
  /** 进度事件发射器 (options 省略时零开销) */
  const emit = options?.onProgress;

  /** 逐条归属 (按批次索引收集; 未派发 / 取消前未尝试的保持 undefined) */
  const slots: (RemovalSlot | undefined)[] = Array.from({
    length: targets.length,
  });
  /**
   * 中止信息与触发条索引: 设置后停止派发新条, 在飞条目照常跑完 (与串行「中止点起不再尝试」同精神)。
   * 多条并发检出中止时 (如同一个根被换位, 每条复核都会失败), 记录取**批次序最前**的触发条
   * (recordAbort 按索引比较), 与串行「首个触发条」的确定性一致, 报告不随调度水位漂动
   * (2026-09-29 CI 实翻: 首版按完成序先到先得, aborted.target 会随机落在任一条)。
   */
  let aborted: AbortedBatch | undefined;
  let abortedIndex = Number.POSITIVE_INFINITY;

  /** 记录中止: 只收批次序更靠前的触发条 (首个触发即停派发, 与报告取值解耦) */
  const recordAbort = (index: number, info: AbortedBatch): void => {
    if (index >= abortedIndex) return;
    aborted = info;
    abortedIndex = index;
  };
  /** 取消标记: 同上, 停止派发新条, 在飞条目照常跑完并入桶 (随 partial 交回) */
  let cancelled = false;
  /** 未预期异常暂存 (只留首个; 排空后原样抛出, 不因并发而静默丢弃) */
  const failures: unknown[] = [];
  let next = 0;
  let active = 0;
  let resolveDrained: (() => void) | null = null;
  const drained = new Promise<void>((resolve) => {
    resolveDrained = resolve;
  });

  /** 已中止、已取消或遇到未预期异常 (如 onProgress 抛错): 立即停止派发新条 */
  const halted = (): boolean =>
    cancelled || aborted !== undefined || failures.length > 0;

  /** 补齐并发空位; 排空 (无在飞且无待派发) 时释放等待方 */
  function pump(): void {
    while (active < REMOVAL_CONCURRENCY && next < targets.length && !halted()) {
      const index = next;
      next += 1;
      active += 1;
      void removeOne(index);
    }
    if (active === 0 && resolveDrained !== null) {
      const resolve = resolveDrained;
      resolveDrained = null;
      resolve();
    }
  }

  async function removeOne(index: number): Promise<void> {
    try {
      const target = targets[index];
      // 索引由派发器保证在界内, 此判仅为 noUncheckedIndexedAccess 的类型收窄
      if (target === undefined) return;
      // 取消检查点 (只在条目之间; 绝不在单条 rm 中途中断 — 那会制造新的半删状态):
      // 检出即停止派发, 本条从未尝试、不入桶; 在飞条目照常跑完, 结果随 partial 交回
      if (signal?.aborted) {
        cancelled = true;
        return;
      }

      // 同步前置校验 (零 await): 违约时在 pump() 派发下一条前即可同步置起 aborted 停泵
      const syncCheck = resolveTargetRootSync(
        target,
        roots,
        style,
        allowGeneralTargets,
      );
      if (syncCheck.kind === 'aborted') {
        recordAbort(index, syncCheck.aborted);
        slots[index] = { kind: 'aborted' };
        return;
      }

      const review = await reviewPathOnDisk(target, syncCheck.root, style);
      if (review.kind === 'aborted') {
        recordAbort(index, review.aborted);
        slots[index] = { kind: 'aborted' };
        return;
      }
      if (review.kind === 'failed') {
        slots[index] = { kind: 'failed', failure: review.failure };
        emit?.({ kind: 'failed', failure: review.failure });
        return;
      }

      // onProgress 移出执行 try/catch: 避免回调抛错被误判为删除/回收站失败;
      // action === 'trash' 走系统回收站, 失败严禁降级永久删除
      const action = actions?.get(target) ?? 'delete';
      const outcome =
        action === 'trash'
          ? await executeTrash(target, trashDeps)
          : await executeRm(target);
      slots[index] = outcome;
      emit?.(outcome);
    } catch (error) {
      // 取首个未预期异常为准 (复核函数自身的意外抛错等), 抛点推迟到池排空之后
      if (failures.length === 0) failures.push(error);
    } finally {
      // 条目完成时的取消补查: 派发点检查覆盖不了「全部已派发、取消随后到达」的窗口
      // (如最后几条在飞时才 abort), 不补则取消被静默吞掉、本次运行照常跑完并返回
      if (signal?.aborted) cancelled = true;
      active -= 1;
      pump();
    }
  }

  pump();
  await drained;
  if (failures.length > 0) throw failures[0];

  // 排空后按批次索引重排组装: 桶恒保输入顺序, 与并发完成序无关
  const result = assembleRemovalResult(slots, aborted);
  // 并发中止事件去重: 仅在池排空后对最终确定 (批次序最前) 的 aborted 发射一次
  if (aborted !== undefined) emit?.({ kind: 'aborted', aborted });
  // 取消: 已出桶的结果 (含检出时在飞、随后跑完的条目) 随错交回; 未派发条目从未尝试, 不入桶
  if (cancelled) {
    throw new SweepError('CANCELLED', '删除在条目间检查点被取消', {
      phase: 'remove',
      partial: result,
    });
  }
  return result;
}

/**
 * 信任根配对助手 (从 CLI 提升, 逻辑逐字不动): 配置拼写 (configured) + realpath 归一 (real) 逐根配对。
 * real 须与 target 同源拼写 (target 已由 guard realpath 化); configured 供删除层的链头判定
 * (根被换成符号链接时只有拼写形态能识破), 故原样透传配置里的拼写, 不做任何归一。
 * realpath 失败的根其 real 保留原拼写 —— 该根下不可能有已通过 guard 的目标, 不会误伤。
 */
export async function toTrustRoots(roots: string[]): Promise<TrustRoot[]> {
  return Promise.all(
    roots.map(async (root) => ({
      configured: root,
      real: (await realpath(root).catch(() => null)) ?? root,
    })),
  );
}

/** 写侧编排的调用选项 (配对 + 安全闸 + 整批拒绝 + 陈旧容忍 + 删除收成一个入口) */
export interface RemoveBatchOptions {
  /** 扫描根 (原始拼写): 安全闸判归属与锚点, 配对助手供给删除侧 */
  roots: string[];
  home?: string | null;
  style?: PathStyle;
  signal?: AbortSignal;
  onProgress?: (event: RemovalProgressEvent) => void;
  /**
   * 安全闸之前「目标已不存在」这一类拒绝如何处置。
   * - 'reject' (缺省, 保现状): 与其余拒绝同款, 触发整批拒绝、零删除 (BC-22);
   * - 'missing': 把这类目标从批次中摘出, 记入 executed 分支的 stale, 不触发整批拒绝,
   *   其余健康目标照删 (沿用 EC-01「目标已达成」的定性); 被摘出的目标不进入删除面。
   * 只对 GUARD_TARGET_MISSING 生效; GUARD_TARGET_UNREADABLE 与其余任何拒绝码
   * 一律维持整批拒绝 (不可读没有任何「已达成」的语义)。
   */
  staleTargets?: 'reject' | 'missing';
  /** 逐目标动作映射 (键为调用方原始拼写 target); 缺省走 `'delete'` */
  actions?: ReadonlyMap<string, CleanupAction>;
  /** 泛化目标放行开关 */
  allowGeneralTargets?: boolean;
  /** 可选叶名白名单校验器 */
  allowedLeaf?: (leaf: string) => boolean;
  /** 可注入回收站依赖 */
  trashDeps?: TrashDeps;
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

/**
 * 写侧编排入口: 配对 + 安全闸 + 整批拒绝 + 陈旧容忍 + 删除/回收站收成一个入口,
 * 调用方不必知道 TrustRoot 的存在也能安全清理。
 * 外部副作用: 完整清理链 (安全闸只读; 任一硬拒绝即零清理)。
 */
export async function removeBatch(
  targets: string[],
  options: RemoveBatchOptions,
): Promise<BatchOutcome> {
  const allowGeneralTargets =
    options.allowGeneralTargets === true || options.allowedLeaf !== undefined;
  const validation = await validateTargets(targets, {
    roots: options.roots,
    home: options.home,
    style: options.style,
    signal: options.signal,
    allowGeneralTargets,
    allowedLeaf: options.allowedLeaf,
  });

  // staleTargets 的窄例外: 仅 GUARD_TARGET_MISSING 被摘出 (规则见 splitStaleRejections)
  const { rejected, stale } = splitStaleRejections(
    validation.rejected,
    options.staleTargets,
  );

  if (rejected.length > 0) {
    return { status: 'rejected', rejected };
  }

  let realActions: Map<string, CleanupAction> | undefined;
  if (options.actions !== undefined) {
    realActions = new Map();
    for (const { original, real } of validation.mappings) {
      const act = options.actions.get(original);
      if (act !== undefined) realActions.set(real, act);
    }
  }

  const removal = await removeTargets(validation.accepted, {
    roots: await toTrustRoots(options.roots),
    style: options.style,
    signal: options.signal,
    onProgress: options.onProgress,
    actions: realActions,
    allowGeneralTargets,
    trashDeps: options.trashDeps,
  });
  return {
    status: 'executed',
    accepted: validation.accepted,
    mappings: validation.mappings,
    stale,
    removal,
  };
}
