/**
 * 删除安全闸与锚点判定: 五不变量 (末段恰为 node_modules / realpath 位于某 root 之下 /
 * 非根与 home 本体 / realpath 去重 / 根锚点链无符号链接) 的逐条判定与理由;
 * 另导出面向任意目标的锚点判定入口 (`firstSymlinkOnTarget`, 服务写入侧的落盘前检查,
 * 见 docs/protocol/behavior-contract.md BC-40), 与删除侧的根判定同一实现。
 * 分层: 字符串级判定是可注入 path 风格的纯函数 (posix / win32 语义可在任意平台测试),
 * lstat / realpath 等 IO 集中于 `validateTargets` 与 `firstSymlinkOnTarget` 两处; 是否整批拒绝由调用方定夺。
 * 设计: docs/designs/deletion-guard.md; 可移植性: docs/adrs/0007-platform-portability.md。
 */
import { lstat, realpath } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

/** 纯判定依赖的最小 path 能力集 (node:path 的 posix / win32 均满足) */
export type PathOps = Pick<
  typeof posix,
  'sep' | 'basename' | 'relative' | 'isAbsolute' | 'parse' | 'join' | 'resolve'
>;

export interface PathStyle {
  name: 'posix' | 'win32';
  ops: PathOps;
  /** win32 文件系统大小写不敏感: 一切路径比较前先折叠大小写 */
  caseInsensitive: boolean;
}

export const POSIX_STYLE: PathStyle = {
  name: 'posix',
  ops: posix,
  caseInsensitive: false,
};
export const WIN32_STYLE: PathStyle = {
  name: 'win32',
  ops: win32,
  caseInsensitive: true,
};

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
  return roots.some((root) => {
    const rel = style.ops.relative(fold(root, style), fold(realPath, style));
    if (rel === '' || style.ops.isAbsolute(rel)) return false;
    return rel !== '..' && !rel.startsWith(`..${style.ops.sep}`);
  });
}

/** 不变量 ③ a: realPath 是文件系统根本体 (posix 的 /、win32 的盘根) */
export function isFilesystemRootBody(
  realPath: string,
  style: PathStyle,
): boolean {
  return fold(style.ops.parse(realPath).root, style) === fold(realPath, style);
}

/** 不变量 ③ b: realPath 是 home 本体; home 传 null 即关闭该防线 */
export function isHomeBody(
  realPath: string,
  home: string | null,
  style: PathStyle,
): boolean {
  return home !== null && dedupeKey(realPath, style) === dedupeKey(home, style);
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
  const absolute = style.ops.isAbsolute(root) ? root : style.ops.resolve(root);
  const prefix = style.ops.parse(absolute).root;
  const chain: string[] = [];
  let cursor = prefix;
  for (const part of absolute.slice(prefix.length).split(style.ops.sep)) {
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
}

export interface RejectedTarget {
  /** 调用方传入的原始目标 */
  target: string;
  /** 拒绝理由 */
  reason: string;
}

export interface ValidationResult {
  /** 通过全部不变量、已 realpath 化并去重的可删目标 (保输入顺序); 空数组即无可删项 */
  accepted: string[];
  /** 未通过的目标与理由, 与输入逐条对应 */
  rejected: RejectedTarget[];
}

async function tryRealpath(p: string): Promise<string | null> {
  try {
    return await realpath(p);
  } catch {
    return null;
  }
}

/**
 * 采集锚点链 (扫描根与写入目标同一采集): 逐级 lstat 判形态 (不变量 ⑤ 的 IO 层)。
 * lstat 失败的级直接跳过: 未检出即不据此拒绝 (删除侧的理由是根不可达时其下也不可能有已通过
 * realpath 的目标; 写入侧同理: 祖先不可核验即不据此拒写, 与删除侧同一取舍);
 * 悬空链接在本层照常判得 (lstat 不跟进末段, 链接自身即结果)。
 */
async function collectAnchorLinks(
  root: string,
  style: PathStyle,
): Promise<AnchorLink[]> {
  const links: AnchorLink[] = [];
  for (const path of anchorChainPaths(root, style)) {
    try {
      links.push({ path, symlink: (await lstat(path)).isSymbolicLink() });
    } catch {
      // 不可核验的级: 跳过 (见上方说明)
    }
  }
  return links;
}

/**
 * 任意路径 (写入目标 / 根) 的锚点链上首个符号链接的路径: 采集 (逐级 lstat) 与检出一步到位,
 * 全链为真身或各级均不可核验时返回 null。
 *
 * 与「根」共用同一判定: 链语义不因末端点是目录还是文件而异 (末端点同样入链), 差别只在调用方
 * 拿它判什么 —— 删除侧判信任根 (根被换位), 写入侧判落盘目标 (写入会跟随链接改写其目标);
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
 * 删除侧不经本入口: 整链判定在 `validateTargets` 内直接消费 `firstSymlinkOnAnchor`, 链头判定另在
 * delete.ts 就地自判 (见其 `isSymlinkHead`)。
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
 * 对候选删除目标做五不变量判定。
 *
 * 判定顺序 (逐条短路):
 *   1. 末段不是 node_modules → 拒;
 *   2. realpath 失败 (不存在或不可读) → 拒;
 *   3. realpath 落在根锚点被换位的根下 → 拒 (两侧 realpath 一起漂移, 挑不出别的证据);
 *   4. realpath 是根本体或 home 本体 → 拒;
 *   5. realpath 末段不是 node_modules (符号链接指向别处) → 拒;
 *   6. realpath 不在任何 root 之下 → 拒;
 *   7. realpath 与已通过项重复 → 拒。
 *
 * 数据追踪示例:
 *   Input  targets = ['/work/zone/app/node_modules', '/work/zone/app']
 *          options.roots = ['/work/zone']  (全链为真目录)
 *   步骤 1  首项末段命中, 次项末段为 app 即拒; 首项 realpath 后仍在 zone 之下, 通过
 *   Output accepted = ['/work/zone/app/node_modules']
 *          rejected = [{ target: '/work/zone/app', reason: '路径末段不是 node_modules' }]
 *
 *   分支对照 (根被换位): options.roots = ['/w'], 而 /w 已被换成指向 /evil 的符号链接 →
 *          anchors = [{ configured: '/w', real: '/evil', link: '/w' }];
 *          target '/w/zone/app/node_modules' 的 real = '/evil/zone/app/node_modules' 命中该锚点 →
 *          rejected = [{ target, reason: '根锚点被换位为符号链接 (根: /w; 符号链接: /w), …' }]
 */
export async function validateTargets(
  targets: string[],
  options: ValidateOptions,
): Promise<ValidationResult> {
  const style = options.style ?? nativeStyle();
  const homeOption = options.home === undefined ? homedir() : options.home;

  // 不变量 ⑤ 的采集对象是配置拼写 (选项注释已说明为何不能用 realpath 形态);
  // 同时把 realpath 归一结果并入, 供不变量 ② 与 ⑤ 的归属比较共用一次解析
  const anchors: RootAnchor[] = [];
  for (const root of options.roots) {
    anchors.push({
      configured: root,
      real: await tryRealpath(root),
      link: firstSymlinkOnAnchor(await collectAnchorLinks(root, style)),
    });
  }
  const brokenAnchors = anchors.filter(
    (anchor): anchor is RootAnchor & { real: string; link: string } =>
      anchor.real !== null && anchor.link !== null,
  );

  // roots 与 home 先 realpath 归一: macOS 的 /tmp、/var 等符号链接下,
  // 未归一的 root 会把根内目标误判为逃逸; realpath 失败的 root 不可能包含存在的目标, 跳过
  const roots: string[] = [];
  for (const anchor of anchors) {
    if (anchor.real !== null) roots.push(anchor.real);
  }
  const home =
    homeOption === null
      ? null
      : ((await tryRealpath(homeOption)) ?? homeOption);

  const accepted: string[] = [];
  const rejected: RejectedTarget[] = [];
  const seen = new Set<string>();

  for (const target of targets) {
    if (!hasNodeModulesLeaf(target, style)) {
      rejected.push({ target, reason: '路径末段不是 node_modules' });
      continue;
    }

    const real = await tryRealpath(target);
    if (real === null) {
      rejected.push({ target, reason: 'realpath 失败 (目标不存在或不可读)' });
      continue;
    }

    const brokenAnchor = brokenAnchors.find((anchor) =>
      insideAnyRoot(real, [anchor.real], style),
    );
    if (brokenAnchor !== undefined) {
      rejected.push({
        target,
        reason: `根锚点被换位为符号链接 (根: ${brokenAnchor.configured}; 符号链接: ${brokenAnchor.link}), 请把配置根改为不含符号链接的真实路径`,
      });
      continue;
    }

    if (isFilesystemRootBody(real, style)) {
      rejected.push({ target, reason: '目标是文件系统根本体' });
      continue;
    }

    if (isHomeBody(real, home, style)) {
      rejected.push({ target, reason: '目标是 home 本体' });
      continue;
    }

    if (!hasNodeModulesLeaf(real, style)) {
      rejected.push({ target, reason: 'realpath 后的末段不是 node_modules' });
      continue;
    }

    if (!insideAnyRoot(real, roots, style)) {
      rejected.push({ target, reason: 'realpath 后不在任何 root 之下' });
      continue;
    }

    const key = dedupeKey(real, style);
    if (seen.has(key)) {
      rejected.push({ target, reason: '重复目标 (realpath 去重)' });
      continue;
    }
    seen.add(key);
    accepted.push(real);
  }

  return { accepted, rejected };
}
