/**
 * SemVer 2.0.0 轻量解析/比较与自更新安全输入白名单校验 (纯函数, 零外部依赖)。
 *
 * 所有进入网络 URL 与子进程参数数组的包名、版本号、dist-tag 与 registry URL 均须通过
 * 本模块白名单校验, 杜绝命令注入、路径穿越与非 HTTP(S) 协议重定向。
 */

/** 解析后的 SemVer 结构 */
export interface ParsedSemver {
  major: number;
  minor: number;
  patch: number;
  prerelease: readonly string[];
}

/** 合法 npm 包名 (支持 @scope/name 与裸包名, 仅小写字母/数字/连字符/点/下划线) */
const PACKAGE_NAME_RE = /^(?:@[a-z0-9][a-z0-9._-]*\/)?[a-z0-9][a-z0-9._-]*$/;

/** 合法 SemVer 字符串 (允许可选前导 v, 支持预发布段与忽略 build metadata) */
const SEMVER_RE =
  /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*))?(?:\+[0-9A-Za-z.-]+)?$/;

/** 合法 dist-tag 或版本 specifier 白名单 (杜绝空白、引号与 shell 元字符) */
const TARGET_SPEC_RE = /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/;

/** 校验 npm 包名格式 */
export function isValidPackageName(name: string): boolean {
  return name.length > 0 && name.length <= 214 && PACKAGE_NAME_RE.test(name);
}

/** 校验 dist-tag 或目标版本号格式 */
export function isValidTargetSpec(spec: string): boolean {
  return TARGET_SPEC_RE.test(spec);
}

/** 校验 registry URL: 仅允许无凭据、无 query/hash 的 http / https 地址, 拒绝控制字符与空白 */
export function isValidRegistryUrl(raw: string): boolean {
  if (raw.length === 0 || /[\s"'`$|;&<>\\?#\p{Cc}]/u.test(raw)) return false;
  try {
    const parsed = new URL(raw);
    if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
      return false;
    }
    if (
      parsed.username !== '' ||
      parsed.password !== '' ||
      parsed.search !== '' ||
      parsed.hash !== ''
    ) {
      return false;
    }
    return parsed.hostname.length > 0;
  } catch {
    return false;
  }
}

/** 解析 SemVer 字符串; 不合法返回 null */
export function parseSemver(raw: string): ParsedSemver | null {
  const match = SEMVER_RE.exec(raw.trim());
  if (match === null) return null;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (
    !Number.isSafeInteger(major) ||
    !Number.isSafeInteger(minor) ||
    !Number.isSafeInteger(patch)
  ) {
    return null;
  }
  const prerelease = match[4] === undefined ? [] : match[4].split('.');
  return { major, minor, patch, prerelease };
}

/** 比较单个预发布标识符 (SemVer 2.0.0 §11.4: 纯数字按数值比且低于非数字) */
function comparePrereleaseId(a: string, b: string): number {
  const aNum = /^\d+$/.test(a);
  const bNum = /^\d+$/.test(b);
  if (aNum && bNum) return Math.sign(Number(a) - Number(b));
  if (aNum && !bNum) return -1;
  if (!aNum && bNum) return 1;
  if (a === b) return 0;
  return a < b ? -1 : 1;
}

/**
 * 比较两个 SemVer 版本号: 返回 -1 (a < b)、0 (a === b) 或 1 (a > b);
 * 任一输入不是合法 SemVer 时返回 null。
 */
export function compareSemver(a: string, b: string): -1 | 0 | 1 | null {
  const left = parseSemver(a);
  const right = parseSemver(b);
  if (left === null || right === null) return null;

  if (left.major !== right.major) return left.major < right.major ? -1 : 1;
  if (left.minor !== right.minor) return left.minor < right.minor ? -1 : 1;
  if (left.patch !== right.patch) return left.patch < right.patch ? -1 : 1;

  const lPre = left.prerelease;
  const rPre = right.prerelease;
  if (lPre.length === 0 && rPre.length === 0) return 0;
  // 正式版永远高于同主次补丁号的预发布版
  if (lPre.length === 0) return 1;
  if (rPre.length === 0) return -1;

  const limit = Math.min(lPre.length, rPre.length);
  for (let i = 0; i < limit; i += 1) {
    const diff = comparePrereleaseId(lPre[i]!, rPre[i]!);
    if (diff !== 0) return diff < 0 ? -1 : 1;
  }
  if (lPre.length === rPre.length) return 0;
  return lPre.length < rPre.length ? -1 : 1;
}

/** 判断远端版本是否严格高于当前版本 */
export function isNewerVersion(current: string, latest: string): boolean {
  return compareSemver(current, latest) === -1;
}
