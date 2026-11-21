/**
 * 删除安全闸、锚点判定与设备边界 (上游: `sweep.ts`、`delete.ts`、`scan-parallel.ts`、`config` 写入侧; 下游: `guard-device.ts`)。
 * 五道不变量: ① 末段合规 (缺省恰为 `node_modules`; 开启 `allowGeneralTargets` / `allowedLeaf` 时过安全叶名 + 白名单)
 * / ② `realpath` 严格位于某 root 之下 / ③ 非文件系统根与 `home` 本体 / ④ `realpath` 去重 / ⑤ 根锚点链无符号链接。
 * 兼供任意写入目标锚点判定 (`firstSymlinkOnTarget`, 见 packages/sweep/docs/protocol/behavior-contract.md BC-40)
 * 与设备边界探测 (`findCrossDeviceTargets`, 见 BC-41 与 packages/sweep/docs/designs/deletion-guard.md「设备边界」)。
 * 分层红线: 路径判定均为可注入 `PathStyle` 的纯函数; IO 集中于 `validateTargets`、`firstSymlinkOnTarget` 与 `fsDeviceProbe`。
 * 设计: packages/sweep/docs/designs/deletion-guard.md; 可移植性: packages/sweep/docs/adrs/0007-platform-portability.md。
 */
import { lstat, realpath, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import type { GuardCode } from './codes.ts';
import { SweepError } from './errors.ts';
import { runCrossDeviceProbe } from './guard-device.ts';

/** 纯判定依赖的最小 path 能力集 (node:path 的 posix / win32 均满足) */
export type PathOps = Pick<
  typeof posix,
  | 'sep'
  | 'basename'
  | 'relative'
  | 'isAbsolute'
  | 'parse'
  | 'join'
  | 'resolve'
  | 'dirname'
  | 'normalize'
>;

export interface PathStyle {
  name: 'posix' | 'win32';
  ops: PathOps;
  /** win32 文件系统大小写不敏感: 一切路径比较前先折叠大小写 */
  caseInsensitive: boolean;
}

export const POSIX_STYLE: PathStyle = Object.freeze({
  name: 'posix',
  ops: posix,
  caseInsensitive: false,
});
export const WIN32_STYLE: PathStyle = Object.freeze({
  name: 'win32',
  ops: win32,
  caseInsensitive: true,
});

/** 当前平台的判定风格 */
export function nativeStyle(): PathStyle {
  return process.platform === 'win32' ? WIN32_STYLE : POSIX_STYLE;
}

/** 大小写折叠: 仅 win32 生效, 不依赖 path 实现的内部大小写行为 */
function fold(p: string, style: PathStyle): string {
  return style.caseInsensitive ? p.toLowerCase() : p;
}

/** 去重键: realpath 折叠后的形态 (不变量 ④ 的比较基准) */
export function dedupeKey(realPath: string, style: PathStyle): string {
  return fold(realPath, style);
}

/** 不变量 ①: 路径末段恰为 node_modules (win32 大小写不敏感) */
export function hasNodeModulesLeaf(target: string, style: PathStyle): boolean {
  return fold(style.ops.basename(target), style) === 'node_modules';
}

/** 通用清理安全叶名判定: 拒绝空串、`.`、`..`、`.git`、`*` 及文件系统根 */
export function hasSafeTargetLeaf(target: string, style: PathStyle): boolean {
  if (target === '' || target.endsWith('/') || target.endsWith('\\')) {
    return false;
  }
  if (isFilesystemRootBody(target, style)) return false;
  const leaf = style.ops.basename(target);
  if (
    leaf === '' ||
    leaf === '.' ||
    leaf === '..' ||
    leaf === '.git' ||
    leaf === '*'
  ) {
    return false;
  }
  return true;
}

/**
 * 不变量 ②: realPath 严格位于某个 root 之下。
 * 以 path.relative 语义判定 (禁字符串前缀比较): 结果为空串 (等于 root 本体)、
 * 以 '..' 起头 (上溯逃逸) 或为绝对路径 (win32 跨盘) 均视为不通过。
 */
export function insideAnyRoot(
  realPath: string,
  roots: string[],
  style: PathStyle,
): boolean {
  if (realPath === '') return false;
  return roots.some((root) => {
    // 空串 root 在 path.relative 里会锚定 cwd, 必须直接拒绝
    if (root === '') return false;
    const rel = style.ops.relative(fold(root, style), fold(realPath, style));
    if (rel === '' || style.ops.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${style.ops.sep}`);
  });
}

/** 不变量 ③ a: realPath 是文件系统根本体 (posix 的 /、win32 的盘根; 先 normalize 消去正斜杠与冗余分隔符) */
export function isFilesystemRootBody(
  realPath: string,
  style: PathStyle,
): boolean {
  if (realPath === '') return false;
  const normalized = style.ops.normalize(realPath);
  const root = style.ops.parse(normalized).root;
  return root !== '' && fold(root, style) === fold(normalized, style);
}

/** 不变量 ③ b: realPath 是 home 本体 (用 relative === '' 消去尾分隔符与正反斜杠差异); home 传 null 即关闭该防线 */
export function isHomeBody(
  realPath: string,
  home: string | null,
  style: PathStyle,
): boolean {
  if (home === null || home === '' || realPath === '') return false;
  return style.ops.relative(fold(home, style), fold(realPath, style)) === '';
}

/**
 * 不变量 ⑤ 的判定输入: 根锚点链上单级的形态。
 * `symlink` 由 lstat 判得 (不跟进末段): 链接指向何处、是否悬空, 均不影响判定 ——
 * 「配置拼写的根路径上有符号链接介入」这一事实本身, 就是信任锚可能被换位的证据。
 */
export interface AnchorLink {
  /** 该级路径 (拒绝文案的定位依据) */
  path: string;
  /** 该级是否为符号链接 */
  symlink: boolean;
}

/**
 * 不变量 ⑤: 根锚点链 (配置拼写的根及其祖先, 自根的一级子目录至根自身) 不得出现符号链接。
 * 检出首个符号链接即返回其路径 (供拒绝文案定位); 全链为真目录返回 null。
 *
 * 判在「配置拼写」而非 realpath 上的原因: realpath 是同义反复 —— 无论配置里的名字被换成
 * 什么, 它都只报告「此刻的解析结果」, 映射被改动这一事实无处可显; 且复核链与 insideAnyRoot
 * 的比较两侧都取 realpath, 根被换位时一起漂移, 比较恒真。信任锚的完整性只能判在拼写上。
 * 系统固有链接 (macOS 的 /var、/tmp) 同样命中: 用户环境与攻击在拼写层不可区分, 故统一拒,
 * 由用户改写成真实路径形态来表达「我知道这里是什么」(显式即授权, 与 BC-11 的扫描侧同源)。
 *
 * 数据追踪示例:
 *   Input  links = [
 *     { path: '/Users', symlink: false },
 *     { path: '/Users/x/ws', symlink: true },        // 根被换成指向他处的符号链接
 *     { path: '/Users/x/ws/app', symlink: false },   // 经链接解析到的仍是真目录, 不报
 *   ]
 *   Output return '/Users/x/ws'
 *
 * 系统固有链接同样命中 (与攻击在拼写层不可区分): root = '/var/w' 时 links[0] 即
 *   { path: '/var', symlink: true } → 拒; 改写成 '/private/var/w' 即放行。
 */
export function firstSymlinkOnAnchor(links: AnchorLink[]): string | null {
  for (const link of links) {
    if (link.symlink) return link.path;
  }
  return null;
}

/**
 * 锚链末端 (扫描根 / 任意写入目标) 路径的逐级前缀 (自文件系统根的一级子目录至末端点自身,
 * 末端点含; 文件系统根本身不入链, 它不可能是符号链接): 不变量 ⑤ 的采集坐标。
 * 末端点不拘形态: 目录 (扫描根) 与文件 (写入目标) 走同一条采集, 链语义不因末端点而异。
 * 相对拼写先按注入风格绝对化 (与 lstat 同一坐标系)。
 *
 * 数据追踪示例:
 *   Input  root = '/Users/x/ws/app' (posix)
 *   Output return ['/Users', '/Users/x', '/Users/x/ws', '/Users/x/ws/app']
 */
export function anchorChainPaths(root: string, style: PathStyle): string[] {
  const absolute = style.ops.isAbsolute(root)
    ? style.ops.normalize(root)
    : style.ops.resolve(root);
  const prefix = style.ops.parse(absolute).root;
  const tail = absolute.slice(prefix.length);
  const parts =
    style.name === 'win32' ? tail.split(/[\\/]+/) : tail.split(style.ops.sep);
  const chain: string[] = [];
  let cursor = prefix;
  for (const part of parts) {
    if (part === '') continue;
    cursor = style.ops.join(cursor, part);
    chain.push(cursor);
  }
  return chain;
}

export interface ValidateOptions {
  /**
   * 扫描根 (调用方给定, 须保留配置里的原始拼写): 内部先 realpath 归一供不变量 ② 比较,
   * 原始拼写另供不变量 ⑤ 的锚点链采集 (realpath 会抹掉「名字 → 真实路径」的映射改动)。
   */
  roots: string[];
  /** home 本体防线; 缺省取 os.homedir(), 显式传 null 关闭 */
  home?: string | null;
  /** path 判定风格; 缺省随当前平台 */
  style?: PathStyle;
  /** 取消信号; 检查点在逐目标之间 */
  signal?: AbortSignal;
  /**
   * 泛化目标放行开关:
   * - 缺省 false: 严格要求末段恰为 node_modules (兼容既有单原语调用);
   * - true: 允许通过预设/规则命中的通用安全叶名 (仍强制拦截空串 / `.` / `..` / `.git` / `*` / 根 / home 本体 / 根外 / 锚点软链)。
   */
  allowGeneralTargets?: boolean;
  /** 可选叶名白名单校验器 (如编排层按激活预设与规则生成), 与 allowGeneralTargets 叠加收紧 */
  allowedLeaf?: (leaf: string) => boolean;
}

/** 拒绝的结构化上下文 (定位信息做字段, 本地化调用方不必去 message 里抠路径) */
export interface RejectionDetails {
  /** 原始 errno (realpath 失败类) */
  errno?: string;
  /** 锚点类拒绝: 配置里的根 */
  root?: string;
  /** 锚点类拒绝: 检出符号链接的级 */
  symlink?: string;
}

export interface RejectedTarget {
  /** 调用方传入的原始目标 */
  target: string;
  /** 机器可判别的拒绝码 (程序分流只许看它, 严禁对 message 做字符串匹配或前缀解析) */
  code: GuardCode;
  /** 中文人话理由 (文案逐字保留现状) */
  message: string;
  /** 拒绝的结构化上下文 */
  details?: RejectionDetails;
}

/** 原始目标 → realpath 归一的配对 (显示侧要原拼写, 删除侧要归一形态) */
export interface PathMapping {
  /** 调用方传入的拼写 */
  original: string;
  /** realpath 归一形态 */
  real: string;
}

export interface ValidationResult {
  /** 通过全部不变量、已 realpath 化并去重的可删目标 (保输入顺序); 空数组即无可删项 */
  accepted: string[];
  /** 未通过的目标与理由, 与输入逐条对应 */
  rejected: RejectedTarget[];
  /** 与 accepted 逐位对应的配对表 (长度与 accepted 相等, mappings[i].real === accepted[i]) */
  mappings: PathMapping[];
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * 采集锚点链 (扫描根与写入目标同一采集): 并发 lstat 各级并按链序归并 (不变量 ⑤ 的 IO 层)。
 * lstat 失败的级直接跳过; 悬空链接在本层照常判得 (lstat 不跟进末段, 链接自身即结果)。
 */
async function collectAnchorLinks(
  root: string,
  style: PathStyle,
): Promise<AnchorLink[]> {
  const paths = anchorChainPaths(root, style);
  const probed = await Promise.all(
    paths.map(async (path): Promise<AnchorLink | null> => {
      try {
        return { path, symlink: (await lstat(path)).isSymbolicLink() };
      } catch {
        return null;
      }
    }),
  );
  const links: AnchorLink[] = [];
  for (const item of probed) {
    if (item !== null) links.push(item);
  }
  return links;
}

/** 安全闸与设备探针只读元数据并发上限 */
const GUARD_CONCURRENCY = 32;

/** 有界并发按索引映射, 派发前检查取消信号, 保持输出与输入下标严格对齐 */
async function mapConcurrent<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  signal?: AbortSignal,
): Promise<R[]> {
  const out: R[] = Array.from({ length: items.length });
  if (items.length === 0) return out;
  let next = 0;
  let cancelled = false;
  const workerCount = Math.min(limit, items.length);
  await Promise.all(
    Array.from({ length: workerCount }, async () => {
      while (!cancelled) {
        if (signal?.aborted) {
          cancelled = true;
          return;
        }
        const idx = next;
        if (idx >= items.length) return;
        next += 1;
        out[idx] = await fn(items[idx]!, idx);
      }
    }),
  );
  if (cancelled || signal?.aborted) {
    throw new SweepError('CANCELLED', '安全闸校验在逐目标检查点被取消', {
      phase: 'validate',
    });
  }
  return out;
}

/**
 * 任意路径 (写入目标 / 根) 的锚点链上首个符号链接的路径: 采集 (逐级 lstat) 与检出一步到位,
 * 全链为真身或各级均不可核验时返回 null。
 *
 * 与「根」共用同一判定: 链语义不因末端点是目录还是文件而异 (末端点同样入链), 差别只在调用方
 * 拿它判什么: 删除侧判信任根 (根被换位), 写入侧判落盘目标 (写入会跟随链接改写其目标);
 * 两侧各自实现即会漂移成「向导放行、`--yes` 全拒」这类实现分家, 故判定标准唯此一处。
 */
export async function firstSymlinkOnTarget(
  target: string,
): Promise<string | null> {
  return firstSymlinkOnAnchor(await collectAnchorLinks(target, nativeStyle()));
}

/**
 * 向导逐根校验的入口名 (扫描根锚点链上首个符号链接的路径): 与 `firstSymlinkOnTarget` 同一实现,
 * 保留独立名只因调用点的话术不同 (向导按「扫描根的信任锚」读, 写入侧按「配置的落盘目标」读)。
 * 删除侧不经本入口: 安全闸整链判定在 `validateTargets` 内直接消费 `firstSymlinkOnAnchor`,
 * 删前实时复核的根祖先链探测则在 `delete-review.ts` 的 `reviewPathOnDisk` 内执行。
 */
export async function firstSymlinkOnRoot(root: string): Promise<string | null> {
  return firstSymlinkOnTarget(root);
}

/** 逐根采集的锚点状态 (不变量 ⑤ 的判定素材) */
interface RootAnchor {
  /** 配置里的原始拼写 */
  configured: string;
  /** realpath 归一形态; 不可解析为 null (该根下不可能有已通过本闸的目标) */
  real: string | null;
  /** 锚点链上首个符号链接的路径; null 表示全链为真目录 */
  link: string | null;
}

/**
 * 对候选清理目标执行五道不变量校验 (阶段 A 32 路有界并发 `realpath`, 阶段 B 同步按输入序逐条短路裁决)。
 *
 * 判定顺序 (逐条短路):
 * 1. 原始路径末段校验失败 -> 拒 (缺省要求 `node_modules` 报 `GUARD_LEAF_NOT_NODE_MODULES`;
 *    启用 `allowGeneralTargets` / `allowedLeaf` 时走 `hasSafeTargetLeaf` + 可选白名单, 失败报 `GUARD_INVALID_LEAF`);
 * 2. `realpath` 失败 -> 拒 (按 errno 三分: `GUARD_TARGET_MISSING` / `GUARD_TARGET_UNREADABLE` / `GUARD_REALPATH_FAILED`);
 * 3. `realpath` 落入锚点链含符号链接的根下 -> 拒 (`GUARD_ROOT_ANCHOR_SYMLINK`);
 * 4. `realpath` 是文件系统根本体或 `home` 本体 -> 拒 (`GUARD_FILESYSTEM_ROOT_BODY` / `GUARD_HOME_BODY`);
 * 5. `realpath` 后末段未通过同一叶名校验 (如符号链接指向别处) -> 拒 (`GUARD_REAL_LEAF_NOT_NODE_MODULES` / `GUARD_INVALID_LEAF`);
 * 6. `realpath` 不在任何 root 之下 -> 拒 (`GUARD_OUTSIDE_ROOTS`);
 * 7. `realpath` 与已通过项重复 -> 拒 (`GUARD_DUPLICATE_TARGET`)。
 *
 * ### 数据流转示例
 * ```text
 * Input (严格模式): targets = ['/work/zone/app/node_modules', '/work/zone/app'],
 *                   options = { roots: ['/work/zone'] } (全链为真目录)
 * 步骤 1: 阶段 A -> 首项过末段校验并 realpath 得 '/work/zone/app/node_modules'; 次项末段为 app 标记 leafInvalid
 * 步骤 2: 阶段 B -> 首项过锚点/根与 home/real 末段/根内/去重; 次项归 rejected
 * Output: accepted = ['/work/zone/app/node_modules'], mappings = [{ original, real }],
 *         rejected = [{ target: '/work/zone/app', code: 'GUARD_LEAF_NOT_NODE_MODULES', message: '路径末段不是 node_modules' }]
 *
 * 对照分支:
 * - 泛化模式 (`allowGeneralTargets: true, allowedLeaf: (l) => l === 'target'`):
 *   '/work/zone/rust-app/target' -> 通过; '/work/zone/app/.git' -> 拒 (GUARD_INVALID_LEAF)
 * - 根锚点被换位 (`/w` -> 指向 `/evil` 的软链):
 *   '/w/app/node_modules' 的 real 落入 brokenAnchors -> 拒 (GUARD_ROOT_ANCHOR_SYMLINK)
 * ```
 */
export async function validateTargets(
  targets: string[],
  options: ValidateOptions,
): Promise<ValidationResult> {
  // 入口取消预检: 即便 targets 为空数组, 已中止的 signal 仍须立即抛 CANCELLED
  if (options.signal?.aborted) {
    throw new SweepError('CANCELLED', '安全闸校验在逐目标检查点被取消', {
      phase: 'validate',
    });
  }
  const style = options.style ?? nativeStyle();
  const homeOption = options.home === undefined ? homedir() : options.home;

  // 并发采集各根锚点链与 realpath, 同时解析 home
  const [anchors, resolvedHome] = await Promise.all([
    Promise.all(
      options.roots.map(async (root): Promise<RootAnchor> => {
        const [real, links] = await Promise.all([
          tryRealpath(root),
          collectAnchorLinks(root, style),
        ]);
        return {
          configured: root,
          real,
          link: firstSymlinkOnAnchor(links),
        };
      }),
    ),
    homeOption === null ? Promise.resolve(null) : tryRealpath(homeOption),
  ]);

  const brokenAnchors = anchors.filter(
    (anchor): anchor is RootAnchor & { real: string; link: string } =>
      anchor.real !== null && anchor.link !== null,
  );
  const roots: string[] = [];
  for (const anchor of anchors) {
    if (anchor.real !== null) roots.push(anchor.real);
  }
  const home = homeOption === null ? null : (resolvedHome ?? homeOption);

  const allowGeneral =
    options.allowGeneralTargets === true || options.allowedLeaf !== undefined;
  const checkLeaf = (candidate: string): boolean => {
    if (!allowGeneral) return hasNodeModulesLeaf(candidate, style);
    if (!hasSafeTargetLeaf(candidate, style)) return false;
    if (options.allowedLeaf !== undefined) {
      return options.allowedLeaf(style.ops.basename(candidate));
    }
    return true;
  };

  // 阶段 A: 对通过同步末段校验的目标有界并发执行 realpath (严控并发上限并响应取消)
  type RealProbe =
    | { leafInvalid: true }
    | { leafInvalid: false; real: string; errno?: undefined }
    | { leafInvalid: false; real: null; errno: string | undefined };

  const probedTargets = await mapConcurrent(
    targets,
    GUARD_CONCURRENCY,
    async (target): Promise<RealProbe> => {
      if (!checkLeaf(target)) return { leafInvalid: true };
      try {
        return { leafInvalid: false, real: await realpath(target) };
      } catch (error) {
        return {
          leafInvalid: false,
          real: null,
          errno: (error as { code?: string }).code,
        };
      }
    },
    options.signal,
  );

  // 阶段 B: 按输入顺序同步执行全部不变量与去重裁决, 产出的 accepted / rejected / mappings 逐项保序
  const accepted: string[] = [];
  const rejected: RejectedTarget[] = [];
  const mappings: PathMapping[] = [];
  const seen = new Set<string>();

  for (let i = 0; i < targets.length; i += 1) {
    const target = targets[i]!;
    const probed = probedTargets[i]!;
    if (probed.leafInvalid) {
      rejected.push({
        target,
        code: allowGeneral
          ? 'GUARD_INVALID_LEAF'
          : 'GUARD_LEAF_NOT_NODE_MODULES',
        message: allowGeneral
          ? '路径末段不合法或不在本次允许清理目标范围内'
          : '路径末段不是 node_modules',
      });
      continue;
    }

    const real = probed.real;
    if (real === null) {
      let code: GuardCode = 'GUARD_REALPATH_FAILED';
      if (probed.errno === 'ENOENT') code = 'GUARD_TARGET_MISSING';
      else if (probed.errno === 'EACCES' || probed.errno === 'EPERM') {
        code = 'GUARD_TARGET_UNREADABLE';
      }
      rejected.push({
        target,
        code,
        message: 'realpath 失败 (目标不存在或不可读)',
        details: { errno: probed.errno },
      });
      continue;
    }

    const brokenAnchor = brokenAnchors.find((anchor) =>
      insideAnyRoot(real, [anchor.real], style),
    );
    if (brokenAnchor !== undefined) {
      rejected.push({
        target,
        code: 'GUARD_ROOT_ANCHOR_SYMLINK',
        message: `根锚点被换位为符号链接 (根: ${brokenAnchor.configured}; 符号链接: ${brokenAnchor.link}), 请把配置根改为不含符号链接的真实路径`,
        details: { root: brokenAnchor.configured, symlink: brokenAnchor.link },
      });
      continue;
    }

    if (isFilesystemRootBody(real, style)) {
      rejected.push({
        target,
        code: 'GUARD_FILESYSTEM_ROOT_BODY',
        message: '目标是文件系统根本体',
      });
      continue;
    }

    if (isHomeBody(real, home, style)) {
      rejected.push({
        target,
        code: 'GUARD_HOME_BODY',
        message: '目标是 home 本体',
      });
      continue;
    }

    if (!checkLeaf(real)) {
      rejected.push({
        target,
        code: allowGeneral
          ? 'GUARD_INVALID_LEAF'
          : 'GUARD_REAL_LEAF_NOT_NODE_MODULES',
        message: allowGeneral
          ? 'realpath 后的末段不合法或不在本次允许清理目标范围内'
          : 'realpath 后的末段不是 node_modules',
      });
      continue;
    }

    if (!insideAnyRoot(real, roots, style)) {
      rejected.push({
        target,
        code: 'GUARD_OUTSIDE_ROOTS',
        message: 'realpath 后不在任何 root 之下',
      });
      continue;
    }

    const key = dedupeKey(real, style);
    if (seen.has(key)) {
      rejected.push({
        target,
        code: 'GUARD_DUPLICATE_TARGET',
        message: '重复目标 (realpath 去重)',
      });
      continue;
    }
    seen.add(key);
    accepted.push(real);
    mappings.push({ original: target, real });
  }

  return { accepted, rejected, mappings };
}

/**
 * 设备号探针: 读路径的 st_dev (所在文件系统的设备号)。
 * `follow` 决定 stat 语义 (解析末段符号链接) 还是 lstat 语义 (不解析), 按判定对象分流:
 * 根取 stat (根指向的实际目录才是参照面, 与扫描侧「根为符号链接照常扫描」同向), 目标取 lstat
 * (与 fs.rm 的末段语义对齐 —— 目标是符号链接时 rm 只删链接、不跨设备); 不可核验 (路径消失 /
 * 权限不足) 返回 null。
 */
export type DeviceProbe = (
  path: string,
  follow: boolean,
) => Promise<number | null>;

/** 真实文件系统探针 (缺省实现) */
export const fsDeviceProbe: DeviceProbe = async (path, follow) => {
  try {
    return (await (follow ? stat : lstat)(path)).dev;
  } catch {
    return null;
  }
};

/** 跨设备探测选项 (归属按最具体根, 解除路径见 packages/sweep/docs/designs/deletion-guard.md「设备边界」) */
export interface CrossDeviceOptions {
  /** 候选目标所属的扫描根 (配置原始拼写, 与目标拼写同源; 归属按最具体根) */
  roots: string[];
  /** 路径判定风味; 缺省随当前平台 */
  style?: PathStyle;
  /** 设备号探针; 缺省读真实文件系统 (测试注入用) */
  probe?: DeviceProbe;
}

/** 跨设备目标形态 (`on-path`: 挂载点在根与目标之间; `target-itself`: 目标本体即挂载点) */
export type CrossDeviceKind = 'on-path' | 'target-itself';

/** 跨设备目标条目 (保输入顺序; 普通对象, 可 JSON.stringify 进审计) */
export interface CrossDeviceEntry {
  /** 目标绝对路径 */
  target: string;
  /** 跨设备形态 */
  kind: CrossDeviceKind;
}

/**
 * 找出与最具体归属根位于不同文件系统的目标并分辨跨设备形态 (委托 `guard-device.ts` 32 路并发探测)。
 * 根用 `stat`、目标用 `lstat`、跨设备时再用 `stat(dirname)` 区分挂载点位于路径中途还是目标本体。
 *
 * ### 数据流转示例
 * ```text
 * Input: targets = ['/w/a/node_modules', '/w/mnt/b/node_modules', '/w/c/node_modules'],
 *        options = { roots: ['/w'] }
 *   设备号: /w -> dev 1; /w/a/node_modules -> dev 1; /w/mnt 及 /w/mnt/b/node_modules -> dev 2;
 *           /w/c -> dev 1, /w/c/node_modules -> dev 3 (目标本体即挂载点)
 * 步骤 1: 为每条目标解析最具体归属根 (/w) 并探测唯一根设备号 (dev 1)
 * 步骤 2: 有界并发探测目标 lstat 设备号 -> a 同 dev 1 放行; b/c 与 dev 1 不同, 追查父目录 stat 设备号:
 *   - b 父目录 /w/mnt/b 为 dev 2 === targetDev -> 'on-path'
 *   - c 父目录 /w/c 为 dev 1 !== targetDev (dev 3) -> 'target-itself'
 * Output: [{ target: '/w/mnt/b/node_modules', kind: 'on-path' },
 *          { target: '/w/c/node_modules', kind: 'target-itself' }]
 * ```
 */
export async function findCrossDeviceTargets(
  targets: string[],
  options: CrossDeviceOptions,
): Promise<CrossDeviceEntry[]> {
  return runCrossDeviceProbe({
    targets,
    roots: options.roots,
    style: options.style ?? nativeStyle(),
    probe: options.probe ?? fsDeviceProbe,
    concurrency: GUARD_CONCURRENCY,
    insideAnyRoot,
  });
}

/**
 * 跨设备条目数组 → 查询索引 (供需要 has / get 的消费方: skip.ts 三个函数的第二参形态)。
 * 与 findCrossDeviceTargets 的数组形态配套: 落盘用数组, 查询用索引。
 */
export function crossDeviceIndex(
  entries: readonly CrossDeviceEntry[],
): ReadonlyMap<string, CrossDeviceKind> {
  return new Map(entries.map((entry) => [entry.target, entry.kind]));
}
