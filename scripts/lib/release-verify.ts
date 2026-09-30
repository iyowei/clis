/**
 * 发布自证闸门的共享实现: 两包 (CLI / API) 的同名闸门共用本模块, 差异经 VerifyProfile
 * 参数注入 (产物文件名 / 清单摘要字段名 / schema 版本 / 面包白名单) 与专属判定钩子
 * (如 API 的 d.ts specifier 复查) 表达; 判定是纯函数, 事实可注入 (测试不依赖工作树)。
 *
 * 判定序 (两包统一, 顺序即口径): 先证「检出可信」(git 可读 / 有提交 / 工作树干净),
 * 再证产物就位 (存在 / 非空 / 可读), 然后让清单与提交、产物三者逐项对上, 专属判定,
 * 最后对发行面包内文件与白名单。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { cleanGitEnv } from './git-env.ts';

/** 一侧闸门的坐标与口径 (差异面全部收口于此) */
export interface VerifyProfile {
  /** 产物主文件名 (dist/ 下): 如 'cli.js' / 'index.js' */
  entryFile: string;
  /** 清单文件名 (dist/ 下) */
  manifestFile: string;
  /** 清单里记录产物摘要的字段名 ('cliSha256' / 'entrySha256'; 字段名不统一以保发布物契约) */
  shaField: string;
  /** 清单 schema 版本 */
  schemaVersion: number;
  /** 发行面包白名单 (files 白名单的物化 + npm 强制包含项) */
  packExpected: readonly string[];
}

/** 发布闸门判定输入: git 事实与产物现状分离采集, 判定是纯函数 (事实可注入, 测试不依赖工作树) */
export interface ReleaseFacts {
  /** git status --porcelain 原文; null = 读不到 */
  gitStatus: string | null;
  /** HEAD 提交的完整哈希 (已经 normalizeCommit 归一); null = 读不到 */
  gitHead: string | null;
  /** 产物目录现状 */
  dist: DistState;
  /** 发行面包内文件清单的采集结果 (白名单判定用) */
  pack: PackFacts;
}

/** 产物目录的磁盘现状 (缺失与形状不符都落成显式字段, 供判定与报错逐条取用) */
export interface DistState {
  /** 产物主文件是否为常规文件 */
  entryExists: boolean;
  /** 产物字节数 (缺失为 0) */
  entrySize: number;
  /** 产物 sha256 (缺失 / 不可读 / 零字节为 null) */
  entrySha256: string | null;
  /** 清单是否存在 */
  manifestExists: boolean;
  /** 解析且形状合格后的清单; null = 不可用 (原因见 manifestIssue) */
  manifest: Record<string, unknown> | null;
  /** 清单不可用的原因 (人话); null = 清单可用 */
  manifestIssue: string | null;
}

/** 发行面包内文件清单的采集结果 (采不到与「采到空包」必须可区分) */
export interface PackFacts {
  /** 包内文件路径集 (相对包根); null = 采集失败, 原因见 issue */
  files: string[] | null;
  /** 采集失败的原因 (人话); null = 采集成功 */
  issue: string | null;
}

/** 判定结论: 通过时带上被判定的提交与摘要 (供输出), 否则带人话拒绝原因 */
export type ReleaseVerdict =
  { ok: true; commit: string; sha256: string } | { ok: false; reason: string };

/** sha256 十六进制 (同步读全文件: 产物是单文件 JS, 量级几十 KB) */
export const sha256File = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** 完整提交哈希的形状 (git rev-parse 的输出形态; 短哈希形态也收, 阈值取 7) */
const isCommitHash = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{7,64}$/.test(value);

/** sha256 十六进制的形状 */
const isSha256 = (value: unknown): value is string =>
  typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);

/** 短哈希展示 (前 12 位; null 显示为占位符, 供人读诊断) */
export const shortHash = (value: string | null): string =>
  value === null ? '(无)' : value.slice(0, 12);

/**
 * 归一提交哈希: 去掉命令行输出自带的换行后校验形状; 形状不符 (含空串 / 多行) 一律视为读不到。
 * 归一后值只可能是十六进制串, 可安全进人读文案 (低信任输入不落进输出面)。
 */
export const normalizeCommit = (raw: string | null): string | null => {
  if (raw === null) return null;
  const trimmed = raw.trim();
  return isCommitHash(trimmed) ? trimmed : null;
};

/** 未提交改动条数 (porcelain 一行一条; 空行不计) */
export const countDirtyEntries = (porcelain: string): number =>
  porcelain.split('\n').filter((line) => line.trim() !== '').length;

/**
 * 未提交改动的路径预览: porcelain 行剥状态前缀 ("XY "), 至多 `limit` 条, 超出以省略号收敛。
 * 路径属仓库内已知文件, 落进人读文案可安全诊断「脏在哪里」; 不回显任何内容片段。
 */
export const previewDirtyEntries = (porcelain: string, limit = 3): string => {
  const paths = porcelain
    .split('\n')
    .filter((line) => line.trim() !== '')
    .map((line) => line.slice(3).trim());
  const shown = paths.slice(0, limit);
  return shown.join(', ') + (paths.length > limit ? ' …' : '');
};

/**
 * 跑一条只读 git 命令并收 stdout 原文; 失败返回 null (不抛)。
 * 失败与「输出为空」必须可区分: 非 git 检出是「不知道」, 空输出是「没有改动」。
 * 缓冲区取宽: 脏树可能列出成千上万条, 挤爆默认 1 MB 会把「工作树不干净」误报成「读不到状态」。
 * env 经 cleanGitEnv (见 git-env.ts): 调用点给的 root 是唯一坐标, 宿主的 GIT_DIR 等不得
 * 把只读探测改道到别的仓库 (在钩子环境里跑测试时, 宿主坐标曾让本模块读错仓库)。
 */
export const readGitText = (root: string, args: string[]): string | null => {
  try {
    return execFileSync('git', args, {
      cwd: root,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'ignore'],
      maxBuffer: 32 * 1024 * 1024,
      env: cleanGitEnv(),
    });
  } catch {
    return null;
  }
};

/**
 * 清单形状体检: 合格返回 null, 否则返回人话病灶。
 * 只判字段形状与版本, 不判内容对错 (内容与提交 / 产物的对账归 judgeRelease); 值一律不回显,
 * 防清单里的低信任文本落进输出面。
 */
const manifestShapeProblem = (
  value: unknown,
  profile: VerifyProfile,
): string | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '清单应为 JSON 对象';
  }
  const fields = value as Record<string, unknown>;
  if (fields.schemaVersion !== profile.schemaVersion) {
    return `清单 schemaVersion 不受支持 (期望 ${profile.schemaVersion})`;
  }
  if (fields.commit !== null && !isCommitHash(fields.commit)) {
    return '清单 commit 字段形状不符';
  }
  if (fields.dirty !== null && typeof fields.dirty !== 'boolean') {
    return '清单 dirty 字段形状不符';
  }
  if (!isSha256(fields[profile.shaField])) {
    return `清单 ${profile.shaField} 字段形状不符`;
  }
  if (typeof fields.builtAt !== 'string' || fields.builtAt === '') {
    return '清单 builtAt 字段形状不符';
  }
  return null;
};

/** 读清单: 缺失 / 读取失败 / 非 JSON / 形状不符都落成显式字段, 不抛错 (判定层据字段决定拒绝口径) */
export const readManifest = (
  path: string,
  profile: VerifyProfile,
): {
  exists: boolean;
  manifest: Record<string, unknown> | null;
  issue: string | null;
} => {
  if (!existsSync(path)) return { exists: false, manifest: null, issue: null };
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { exists: true, manifest: null, issue: '清单读取失败' };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { exists: true, manifest: null, issue: '清单不是合法 JSON' };
  }
  const problem = manifestShapeProblem(parsed, profile);
  if (problem !== null) return { exists: true, manifest: null, issue: problem };
  return {
    exists: true,
    manifest: parsed as Record<string, unknown>,
    issue: null,
  };
};

/**
 * 读产物目录现状: 逐项探测产物主文件与清单, 缺失 / 不可读 / 形状不符一律落成显式字段;
 * 本函数只取事实, 不下判定 (判定归 judgeRelease)。
 */
export const readDistState = (
  distDir: string,
  profile: VerifyProfile,
): DistState => {
  const entryPath = join(distDir, profile.entryFile);
  let entryExists = false;
  let entrySize = 0;
  let entrySha256: string | null = null;
  try {
    const info = statSync(entryPath);
    entryExists = info.isFile();
    entrySize = info.size;
    if (entryExists && entrySize > 0) entrySha256 = sha256File(entryPath);
  } catch {
    // 缺失 / 不可达: 保持缺失态; 具体病灶由 judgeRelease 按字段报出, 此处不抢跑
  }
  const loaded = readManifest(join(distDir, profile.manifestFile), profile);
  return {
    entryExists,
    entrySize,
    entrySha256,
    manifestExists: loaded.exists,
    manifest: loaded.manifest,
    manifestIssue: loaded.issue,
  };
};

/**
 * 解析 `npm pack --json` 的输出: 取首个元素的 files[].path。
 * 形状不符 (非数组 / 无 files / 条目缺 path) 一律返回 null, 不猜结构 (交由采集层落 issue)。
 */
export const parsePackFiles = (raw: string): string[] | null => {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed)) return null;
  const first: unknown = parsed[0];
  if (typeof first !== 'object' || first === null) return null;
  const { files } = first as { files?: unknown };
  if (!Array.isArray(files)) return null;
  const paths: string[] = [];
  for (const entry of files as unknown[]) {
    if (typeof entry !== 'object' || entry === null) return null;
    const { path } = entry as { path?: unknown };
    if (typeof path !== 'string' || path === '') return null;
    paths.push(path);
  }
  return paths;
};

/**
 * 跑 `npm pack --dry-run --json --ignore-scripts` 收发行面包内文件清单 (只读, 不落 tarball)。
 *
 * 两个旗标各有硬理由: --dry-run 不写盘; --ignore-scripts 必须带, 否则 pack 过程会再进一次
 * 脚本链 (在 prepublishOnly 语境下自我递归, 已实测)。为什么用 npm 而非 bun pm pack:
 * bun pm pack 只有人读文本输出、无 JSON 旗标 (bun 1.4.2 的 --help 实测), 清单解析没有稳定契约。
 * 采集失败 (npm 不在 PATH / 非零退出 / 输出非 JSON) 一律落 issue, 不抛: 判定层按「采不到就拒」处理。
 */
export const readPackFiles = (root: string): PackFacts => {
  // Windows 的 npm 是 npm.cmd, execFile 不走 shell 时不会自动补扩展名
  const npm = process.platform === 'win32' ? 'npm.cmd' : 'npm';
  let raw: string;
  try {
    raw = execFileSync(
      npm,
      ['pack', '--dry-run', '--json', '--ignore-scripts'],
      {
        cwd: root,
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'ignore'],
        maxBuffer: 32 * 1024 * 1024,
      },
    );
  } catch {
    return {
      files: null,
      issue: 'npm pack 跑不起来 (需要 npm: 不在 PATH 或非零退出)',
    };
  }
  const files = parsePackFiles(raw);
  if (files === null) {
    return { files: null, issue: 'npm pack 的输出不是预期的 JSON 形状' };
  }
  // 排序稳定化 (npm 输出顺序无契约; 判定是集合相等, 排序只为输出与测试的可复现)
  return { files: files.sort(), issue: null };
};

/**
 * 差异路径的人话呈现: 剔控制字符、超 5 项截断计总数。
 * 路径来自 npm 输出 (低信任输入), 直接回显会把不受控文本带进输出面, 故先降噪再列。
 */
const describePaths = (paths: string[]): string => {
  const cleaned = paths.map((path) => path.replace(/\p{Cc}/gu, '?'));
  const head = cleaned.slice(0, 5).join(', ');
  return cleaned.length > 5 ? `${head} 等 ${cleaned.length} 项` : head;
};

/**
 * 发行面包内文件清单的判定 (纯函数): 集合相等才算过, 差异分「多出」「缺少」两向人话列出。
 * 「多出」是杂质溜进发行面 (如仓库根的 README 备份), 「缺少」是发行面残缺 (如漏收产物)。
 */
export const judgePackFiles = (
  files: string[],
  expected: readonly string[],
): { ok: true } | { ok: false; reason: string } => {
  const actual = new Set(files);
  const expectedSet = new Set(expected);
  const extra = [...actual].filter((path) => !expectedSet.has(path)).sort();
  const missing = expected.filter((path) => !actual.has(path));
  if (extra.length === 0 && missing.length === 0) return { ok: true };
  const parts: string[] = [];
  if (extra.length > 0) parts.push(`多出 ${describePaths(extra)}`);
  if (missing.length > 0) parts.push(`缺少 ${describePaths(missing)}`);
  return {
    ok: false,
    reason: `发行面包内文件与白名单不符: ${parts.join('; ')}`,
  };
};

/**
 * 发布闸门判定 (纯函数, 不碰文件系统): 按固定次序短路, 首条不过即拒。
 * extraJudge 是侧专属判定 (在产物链检查之后、面包白名单之前调用; 返回 null 即通过, 返回人话即拒)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   facts.dist.entrySha256 = "9f2c…", facts.dist.manifest = { commit: "a2109d72f4…", dirty: false, cliSha256: "9f2c…" }
 *   facts.gitHead = "a2109d72f4…", facts.gitStatus = ""
 *   facts.pack.files = ["LICENSE", …, "dist/cli.js"]
 *   profile = { entryFile: "cli.js", shaField: "cliSha256", packExpected: [...] }
 *
 * 步骤 1：检出可信 (git 可读 / 有提交 / 干净) → 全部通过
 * 步骤 2：产物就位 (存在 / 非空 / 可读) → 全部通过
 * 步骤 3：清单对账 (dirty=false; commit == HEAD; shaField == 实测摘要) → 全部通过
 * 步骤 4：专属判定 (extraJudge) → null (通过)
 * 步骤 5：面包白名单 (集合相等) → 通过
 *
 * Output（数据契约）
 *   return { ok: true, commit: "a2109d72f4…", sha256: "9f2c…" }
 * ```
 */
export const judgeRelease = (
  facts: ReleaseFacts,
  profile: VerifyProfile,
  extraJudge?: () => string | null,
): ReleaseVerdict => {
  const { gitStatus, gitHead, dist } = facts;
  if (gitStatus === null) {
    return {
      ok: false,
      reason:
        '读不到 git 状态 (非 git 检出, 或 git 不可用), 产物无法与提交对应',
    };
  }
  if (gitHead === null) {
    return {
      ok: false,
      reason: '读不到 HEAD 提交 (仓库尚无提交, 或 git 不可用)',
    };
  }
  if (gitStatus.trim() !== '') {
    return {
      ok: false,
      reason: `工作树不干净 (未提交改动 ${countDirtyEntries(gitStatus)} 项: ${previewDirtyEntries(gitStatus)}), 产物无法与任何提交对应`,
    };
  }
  if (!dist.entryExists) {
    return {
      ok: false,
      reason: `产物缺失 (dist/${profile.entryFile} 不存在)`,
    };
  }
  if (dist.entrySize === 0) {
    return {
      ok: false,
      reason: `产物为空 (dist/${profile.entryFile} 是零字节文件)`,
    };
  }
  if (dist.entrySha256 === null) {
    return {
      ok: false,
      reason: `产物不可读 (dist/${profile.entryFile} 的摘要算不出)`,
    };
  }
  if (!dist.manifestExists) {
    return {
      ok: false,
      reason: `产物清单缺失 (dist/${profile.manifestFile} 不存在)`,
    };
  }
  if (dist.manifest === null) {
    return {
      ok: false,
      reason: `产物清单不可用: ${dist.manifestIssue ?? '原因不明'}`,
    };
  }
  if (dist.manifest.dirty !== false) {
    return {
      ok: false,
      reason: '产物清单记录的是脏工作树构建 (dirty=true), 产物不对应任何提交',
    };
  }
  if (dist.manifest.commit !== gitHead) {
    return {
      ok: false,
      reason: `产物清单记录的提交 ${shortHash(String(dist.manifest.commit))} 与 HEAD ${shortHash(gitHead)} 不一致, 产物不是本次提交构建的`,
    };
  }
  if (dist.manifest[profile.shaField] !== dist.entrySha256) {
    return {
      ok: false,
      reason: '产物摘要与清单记录不符, 产物与清单不是同一次构建的产物',
    };
  }
  if (extraJudge !== undefined) {
    const reason = extraJudge();
    if (reason !== null) return { ok: false, reason };
  }
  if (facts.pack.files === null) {
    return {
      ok: false,
      reason: `发行面包内文件清单采不到 (${facts.pack.issue ?? '原因不明'}), 该项检查需要 npm`,
    };
  }
  const packVerdict = judgePackFiles(facts.pack.files, profile.packExpected);
  if (!packVerdict.ok) return { ok: false, reason: packVerdict.reason };
  return { ok: true, commit: gitHead, sha256: dist.entrySha256 };
};
