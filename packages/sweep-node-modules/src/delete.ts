/**
 * 删除执行器: 对安全闸已校验 (realpath 化、去重) 的目标按有界并发 (≤4 路, 实测校准) 逐条
 * 执行 fs.rm(recursive)。
 * 语义 (设计: docs/sweep/designs/deletion-guard.md「执行语义」): 逐条删除、单条失败不中断整批、
 * 末尾分桶汇总。ENOENT 分两种, 不可混同: rm 阶段的 ENOENT 一律复核目标本体, 确认已消失才归
 * missing, 视为成功侧 (目标已达成的语义, 不计失败)。双运行时语义分叉 (本机实测 2026-09-27:
 * Node 只在目标本体缺失时抛 ENOENT, 递归中途内部条目消失被归一为成功; Bun 会把后者冒泡为顶层
 * ENOENT, 且错误形态与前者逐字段同形, 无法从错误对象区分), 故不看错误码定论而直接复核;
 * 复核发现目标仍在或复核不可达 → 归 failed (内部条目消失不等于目标消失, 报成功会伪造成功报告
 * 与退出码 0, 脚本化调用方无从察觉); 复核阶段的组件级 ENOENT 同样归 failed (组件消失时目标
 * 可能只是被 mv 走仍在占盘)。
 *
 * 安全复核 (HIGH-1: 中间组件替换 → root 外任意删除): fs.rm 只对末段取 lstat 语义,
 * 中间组件一律跟随符号链接; guard 的 realpath 只固定校验时刻的解析结果, 二者之间把某个
 * 中间组件换成指向 root 外的符号链接, rm 就会删到 root 外。故每条删除前自 root 向下逐级
 * lstat 复核 (末段除外: 链接本体由 fs.rm 自身安全处理), 检出替换即整批中止。
 * 链头替换 (ANCHOR-REANCHOR: 根自身被换成符号链接 → 删除导向他树): 复核链从 realpath 后的根
 * 开始, 链头看到的仍是「此刻解析出的真目录」, 而 target 与 root 的 realpath 在换位后一起漂移,
 * 任何按 realpath 的比较都恒真 —— 拼写形态是唯一能识破的证据。故链头处另对信任根的配置拼写
 * 补一次 lstat 类型判定 (是符号链接即整批中止), 与 guard 的第五道不变量互为纵深。
 * 残余风险 (复核只缩短窗口, 不构成零窗口保证): 复核与 rm 之间仍有竞态窗口, 路径级 API
 * 无法彻底消除 (需 fd 级 openat / O_NOFOLLOW, Node 未暴露); 同型真实目录的整目录换位
 * lstat 亦不可识别。调用方须传与 target 同源拼写的 real (建议即 guard 判根用的 realpath 结果),
 * 并保留配置里的原始拼写供链头判定 (见 TrustRoot)。
 */
import { lstat, realpath, rm } from 'node:fs/promises';
import { isAbsolute, join, relative, sep } from 'node:path';

import type { AbortCode, RemoveFailureCode } from './codes.ts';
import { SweepError } from './errors.ts';
import {
  type PathMapping,
  type PathStyle,
  type RejectedTarget,
  validateTargets,
} from './guard.ts';

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
  /** 实际删除成功的目标 (保输入顺序) */
  removed: string[];
  /** rm 报 ENOENT 且复核确认目标本体已不存在的目标; 目标已达成, 计成功侧 (保输入顺序) */
  missing: string[];
  /** 删除失败与复核未完成 (组件消失 / 不可核验) 的目标及原因 (保输入顺序); 后者未执行删除 */
  failed: TargetFailure[];
  /** 安全复核未通过即中止整批, 其间条目一律不删; 未触发时缺省 */
  aborted?: AbortedBatch;
}

/** 删除操作的进度事件 (每条目标出桶即发一条) */
export type RemovalProgressEvent =
  | { kind: 'removed'; target: string }
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
  /** 取消信号; 只在条目之间检查, 绝不在单条 rm 中途中断 (那会制造新的半删状态) */
  signal?: AbortSignal;
  /** 进度回调; 粒度: 每条目标出桶即发一条 */
  onProgress?: (event: RemovalProgressEvent) => void;
}

/** 常见错误码的人话映射, 未收录的码回落通用提示 */
const ERROR_HINTS: Record<string, string> = {
  EACCES: '权限不足, 拒绝删除',
  EPERM: '操作不被允许',
  EBUSY: '目标被占用',
  ENOTEMPTY: '目录非空',
  EROFS: '目标位于只读文件系统',
};

/** fs 错误对象的最小形态 (避免依赖 NodeJS 命名空间) */
interface FsError {
  code?: string;
  message?: string;
}

/**
 * 失败桶统一附带的复查提示: rm 递归是先删内容、最后删壳, 中途失败时内容往往已残缺
 * (实测父目录只读场景: 内容清空、只剩空壳), 不提示会误导用户以为「依赖还安全」。
 */
const PARTIAL_DELETION_HINT = '注意: 目录内容可能已被部分或全部删除, 请复查';

/** 错误码到人话前缀 */
function describeCode(error: unknown): string {
  const fsError = error as FsError | null;
  const code = fsError?.code;
  if (typeof code !== 'string' || code === '') {
    return `未知错误: ${fsError?.message ?? String(error)}`;
  }
  return `${code}: ${ERROR_HINTS[code] ?? '删除未成功'}`;
}

/** 拼「错误码 + 人话 + 目标定位 + 复查提示」的删除失败串 */
function describeRemovalError(target: string, error: unknown): string {
  return `${describeCode(error)} (目标: ${target}; ${PARTIAL_DELETION_HINT})`;
}

/** 复核阶段自身出错 (未尝试删除, 故不附「内容可能已残缺」提示) */
function describeReviewError(
  target: string,
  path: string,
  error: unknown,
): string {
  return `安全复核未完成 (${describeCode(error)}) (目标: ${target}; 组件: ${path}; 未执行删除)`;
}

/**
 * 复核时链上组件消失 (ENOENT) 的可读串: 组件消失不等于目标消失 (可能只是被 mv 走仍存活),
 * 故要求复查, 并附「确已不存在可忽略」的降噪说明; 未尝试删除, 同样不附「内容可能已残缺」提示。
 */
function describeVanishedReview(target: string, path: string): string {
  return `安全复核未完成 (ENOENT: 路径组件消失) (目标: ${target}; 组件: ${path}; 请复查目标是否仍存在; 未执行删除; 若目标确已不存在, 可忽略此条)`;
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

/** 严格包含判定 (path.relative 语义, 与 guard 的 insideAnyRoot 同型): 等于根本体或越界均不通过 */
function isUnder(root: string, target: string): boolean {
  const rel = relative(root, target);
  if (rel === '' || isAbsolute(rel)) return false;
  return rel !== '..' && !rel.startsWith(`..${sep}`);
}

/**
 * 复核链: 自 root 至 target 父目录 (root 含, target 本体不含)。
 * 末段不查: 若 target 本体是符号链接, fs.rm 按 lstat 语义只删链接、不跟进, 本已安全。
 * 例: root=/w, target=/w/a/b/node_modules → ['/w', '/w/a', '/w/a/b']
 */
function componentChain(root: string, target: string): string[] {
  const chain = [root];
  let cursor = root;
  for (const part of relative(root, target).split(sep).slice(0, -1)) {
    cursor = join(cursor, part);
    chain.push(cursor);
  }
  return chain;
}

type ReviewFinding =
  | { kind: 'unsafe'; path: string }
  | { kind: 'vanished'; path: string }
  | { kind: 'unverified'; path: string; error: unknown };

/**
 * 链头判定: 配置拼写的信任根自身是否为符号链接 (lstat 不跟进末段)。
 * 不可核验 (lstat 失败) 时返回 false 而不据此拒绝: 未检出即无替换证据, 避免把权限噪声
 * 升级成整批中止; 该情形下 realpath 亦不可解析, 目标会在更早的判定里被拒。
 */
async function isSymlinkHead(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isSymbolicLink();
  } catch {
    return false;
  }
}

/** 逐级复核链上组件: 全通过返回 null; 符号链接与非目录统一由 isDirectory 判定拦下 (lstat 不 follow 末段) */
async function reviewComponents(
  chain: string[],
): Promise<ReviewFinding | null> {
  for (const path of chain) {
    try {
      const stats = await lstat(path);
      if (!stats.isDirectory()) return { kind: 'unsafe', path };
    } catch (error) {
      const code = (error as FsError | null)?.code;
      if (code === 'ENOENT') return { kind: 'vanished', path };
      return { kind: 'unverified', path, error };
    }
  }
  return null;
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
  | { kind: 'missing'; target: string }
  | { kind: 'failed'; failure: TargetFailure }
  | { kind: 'aborted' };

/**
 * 逐条复核并删除目标, 失败不中断整批, 复核不通过则整批中止, 按结果分桶
 * (removed / missing / failed 均保输入顺序)。
 *
 * 并发模型 (为什么可并发、以及安全模型为何不变, 三条论证):
 * ① rm 不可中断的纪律与「复核紧跟删除」的条内时序逐字保留 (并发收益不来自砍复核 —— 复核
 *    实测仅占 3%), 单条 rm 仍绝不在中途中断;
 * ② 目标间不嵌套 (扫描对 node_modules 命中即剪枝), 任一目标的复核链 (root → 父目录) 不可能
 *    落在别条目标的删除面上, 故并发 rm 不会污染彼此的复核读;
 * ③ 中止 / 取消定义为「停止派发新条 + 在飞条目跑完」: aborted 取**批次序最前**的触发条
 *    (多条并发检出时按索引比较, 与串行「首个触发条」一致, 不随调度漂动);
 *    取消时 partial = 全部已派发条目的桶 (派发序确定, 已派发集合是批次的连续前缀; 前缀长度
 *    随调度水位, 仅影响中止 / 取消快照的粒度, 不影响任何安全判定)。
 * 桶恒按输入顺序输出 (收集后按批次索引重排, 与并发完成序无关); 进度事件为完成序
 * (事件顺序本不承诺, 见 §4.4)。
 *
 * 数据追踪示例:
 *   Input  targets = ['/w/zeta/node_modules', '/w/lock/node_modules', '/w/bare/node_modules'],
 *          options.roots = [{ configured: '/w', real: '/w' }]  (三者父链均为真目录)
 *   步骤 0  逐条复核: 先判链头 (配置拼写 /w 非符号链接), 再自 /w 向下 lstat 至目标父目录;
 *           链头或组件检出符号链接即整批中止 (停止派发, 在飞跑完), 链上组件 ENOENT 归 failed
 *   步骤 1  首项 rm 成功 → removed
 *   步骤 2  次项 rm 抛 EACCES (父目录只读) → failed, 错误串 'EACCES: 权限不足, 拒绝删除
 *            (目标: ...; 注意: 目录内容可能已被部分或全部删除, 请复查)'
 *   步骤 3  末项复核通过, rm 抛 ENOENT 且复核确认目标本体已消失 → missing, 不中断
 *           (若复核发现目标本体仍在或不可达, 如 Bun 把内部条目 ENOENT 冒泡为顶层, 则归 failed)
 *   Output { removed: ['/w/zeta/node_modules'], missing: ['/w/bare/node_modules'], failed: [...] }
 *          (aborted 缺省; 若 /w 被换成指向他树的符号链接, 则中止, 未派发条目不在任何桶)
 */
export async function removeTargets(
  targets: string[],
  options: RemovalOptions,
): Promise<RemovalResult> {
  // 防 JS 调用方漏传选项: 无信任根即无可信复核, 一律中止 (保守)
  const roots = options?.roots ?? [];
  const signal = options?.signal;
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

  /** 已中止或已取消 (停止派发新条) */
  const halted = (): boolean => cancelled || aborted !== undefined;

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
      const root = roots.find((candidate) => isUnder(candidate.real, target));
      if (root === undefined) {
        const info: AbortedBatch = {
          target,
          code: 'REVIEW_NOT_UNDER_ANY_ROOT',
          message: `安全复核失败 (目标不在任何 roots 之下): ${target}`,
          path: target,
        };
        recordAbort(index, info);
        slots[index] = { kind: 'aborted' };
        emit?.({ kind: 'aborted', aborted: info });
        return;
      }

      // 链头判定先于组件复核: 根被换位时链上其余组件全是「此刻的真目录」, 只有拼写形态能识破
      if (await isSymlinkHead(root.configured)) {
        const info: AbortedBatch = {
          target,
          code: 'REVIEW_HEAD_SYMLINK',
          message: `安全复核失败 (根被替换为符号链接): ${root.configured}`,
          path: root.configured,
        };
        recordAbort(index, info);
        slots[index] = { kind: 'aborted' };
        emit?.({ kind: 'aborted', aborted: info });
        return;
      }

      // 复核紧跟删除: 尽可能压缩两者之间的替换窗口
      const finding = await reviewComponents(componentChain(root.real, target));
      if (finding !== null) {
        if (finding.kind === 'vanished') {
          // 组件消失 ≠ 目标消失 (可能只是被 mv 走): 归 missing 会伪报成功, 必须交回人工复查
          const vanished: TargetFailure = {
            target,
            code: 'REVIEW_COMPONENT_VANISHED',
            message: describeVanishedReview(target, finding.path),
            partialRisk: false,
          };
          slots[index] = { kind: 'failed', failure: vanished };
          emit?.({ kind: 'failed', failure: vanished });
          return;
        }
        if (finding.kind === 'unsafe') {
          const info: AbortedBatch = {
            target,
            code: 'REVIEW_COMPONENT_REPLACED',
            message: `安全复核失败 (路径组件被替换): ${finding.path}`,
            path: finding.path,
          };
          recordAbort(index, info);
          slots[index] = { kind: 'aborted' };
          emit?.({ kind: 'aborted', aborted: info });
          return;
        }
        // 复核不可达但无替换证据: 只拒该条, 不牵连整批
        const unverified: TargetFailure = {
          target,
          code: 'REVIEW_UNVERIFIED',
          message: describeReviewError(target, finding.path, finding.error),
          partialRisk: false,
        };
        slots[index] = { kind: 'failed', failure: unverified };
        emit?.({ kind: 'failed', failure: unverified });
        return;
      }

      try {
        await rm(target, { recursive: true, force: false });
        slots[index] = { kind: 'removed', target };
        emit?.({ kind: 'removed', target });
      } catch (error) {
        if ((error as FsError | null)?.code === 'ENOENT') {
          // 不以错误码本身定论: Bun 侧会把内部条目 ENOENT 冒泡为顶层拒绝且形态与顶层缺失同形
          // (实测见文件头注释), 须复核目标本体后再分桶
          const state = await checkGone(target);
          if (state === 'gone') {
            slots[index] = { kind: 'missing', target };
            emit?.({ kind: 'missing', target });
            return;
          }
          const survivor: TargetFailure = {
            target,
            code: 'REMOVE_ENOENT_SURVIVOR',
            message: describeSurvivor(target, state),
            partialRisk: true,
          };
          slots[index] = { kind: 'failed', failure: survivor };
          emit?.({ kind: 'failed', failure: survivor });
          return;
        }
        const failure: TargetFailure = {
          target,
          code: 'REMOVE_FAILED',
          errno: (error as { code?: string } | null)?.code,
          message: describeRemovalError(target, error),
          partialRisk: true,
        };
        slots[index] = { kind: 'failed', failure };
        emit?.({ kind: 'failed', failure });
      }
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
  const result: RemovalResult = { removed: [], missing: [], failed: [] };
  for (const slot of slots) {
    if (slot === undefined) continue;
    switch (slot.kind) {
      case 'removed':
        result.removed.push(slot.target);
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
}

/**
 * 陈旧容忍分拣 (removeBatch 与编排层 sweep.ts 共用, 规则只此一处):
 * staleTargets 为 'missing' 时把 GUARD_TARGET_MISSING 一类无安全信号的拒绝摘出
 * (目标已达成, EC-01 语义), 其余任何拒绝码一律留在 rejected 侧
 * (不可读等拒绝没有任何「已达成」的语义), 维持整批拒绝。两侧均保输入顺序。
 */
export function splitStaleRejections(
  rejected: RejectedTarget[],
  staleTargets: 'reject' | 'missing' | undefined,
): { rejected: RejectedTarget[]; stale: string[] } {
  if (staleTargets !== 'missing') return { rejected, stale: [] };
  const rest: RejectedTarget[] = [];
  const stale: string[] = [];
  for (const item of rejected) {
    if (item.code === 'GUARD_TARGET_MISSING') stale.push(item.target);
    else rest.push(item);
  }
  return { rejected: rest, stale };
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
 * 写侧编排入口: 配对 + 安全闸 + 整批拒绝 + 陈旧容忍 + 删除收成一个入口,
 * 调用方不必知道 TrustRoot 的存在也能安全删除。
 * 外部副作用：完整删除链 (安全闸只读; 删除按批次执行, 任一硬拒绝即零删除)。
 */
export async function removeBatch(
  targets: string[],
  options: RemoveBatchOptions,
): Promise<BatchOutcome> {
  const validation = await validateTargets(targets, {
    roots: options.roots,
    home: options.home,
    style: options.style,
    signal: options.signal,
  });

  // staleTargets 的窄例外: 仅 GUARD_TARGET_MISSING 被摘出 (规则见 splitStaleRejections)
  const { rejected, stale } = splitStaleRejections(
    validation.rejected,
    options.staleTargets,
  );

  if (rejected.length > 0) {
    return { status: 'rejected', rejected };
  }

  const removal = await removeTargets(validation.accepted, {
    roots: await toTrustRoots(options.roots),
    signal: options.signal,
    onProgress: options.onProgress,
  });
  return {
    status: 'executed',
    accepted: validation.accepted,
    mappings: validation.mappings,
    stale,
    removal,
  };
}
