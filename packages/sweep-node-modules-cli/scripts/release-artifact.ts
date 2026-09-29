/**
 * 发行产物自证核心: 清单形状、摘要计算与「产物 ↔ 清单 ↔ 提交」判定, 外加发行面包内文件的
 * 白名单判定, 供构建侧 (write-dist-manifest.ts) 与发布侧 (verify-release.ts) 共用;
 * 本模块不打印、不落退出码。
 *
 * 背景 (安全审计确证项: 发行面 dist/cli.js 与源码和提交无身份绑定): 构建从当前工作树现场
 * 取料, 工作树脏净不被检查; dist 不入库 (安装者拿不到源码), 产物停在旧提交时下游无从区分。
 * 本模块把「产物摘要 + 构建时的提交与脏净状态」固化成 dist/manifest.json: 发布闸门按它判定,
 * npm 启动器 (bin/sweep-nm.mjs) 在优先使用产物前按它核对摘要。
 * 启动器随包分发、由 node 直跑, 且包内不带源码, 无法跨语言复用本模块; 其核对逻辑 (清单缺失
 * 或摘要不符即拒收产物) 由 src/npm-launcher.smoke.test.ts 的集成用例钉住, 与本模块同口径。
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { cleanGitEnv } from './git-env.ts';

/** 包根 (packages/sweep-node-modules-cli; 本文件所在 scripts/ 上溯一级): dist/ 落点与 npm pack 的坐标; git 检查命令在此坐标下运行 (无 pathspec, 仍为全仓语义) */
export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** 产物文件名 (构建脚本的 outfile 与启动器的入口选择都以它为准) */
export const CLI_FILE = 'cli.js';

/** 自证清单文件名 (与产物同放 dist/: package.json 的 files 列的是 dist 目录, 清单随之进包) */
export const MANIFEST_FILE = 'manifest.json';

/** 清单形状版本; 形状变更即递增, 读方按它拒绝未知形状 (不猜字段) */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 发行面白名单: npm 包内应有的文件全集 (相对包根的路径, 顺序无关)。
 *
 * 为什么要有它: package.json 的 files 只列出「额外要收的白名单目录」, 仓库根的 README* / LICENSE*
 * 等文件由 npm 无条件收进包, 且官方没有任何「排除」通道 (npm docs configuring-npm/package-json
 * 「files」节的排除语义 + 本机 npm-packlist 的 strict 规则, 见 ADR 0009 补记), 仓库根多一份
 * README 备份就会被静默收进发行包。本常量把「包内应有什么」显式声明成契约, 发布前逐项对账。
 *
 * 改动义务: package.json 的 files / bin 变更, 或仓库根增删总是收录类文件时, 必须同步本清单,
 * 否则闸门会拒绝发布 (这正是它存在的目的: 发行面变化必须是一次显式决定, 不能靠静默)。
 */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'bin/sweep-nm.mjs',
  'dist/cli.js',
  'dist/manifest.json',
  'package.json',
];

/** 构建时的来源事实: null = 读不到 (非 git 检出 / 仓库尚无提交 / git 不可用) */
export interface GitFacts {
  /** HEAD 提交的完整哈希 */
  commit: string | null;
  /** 工作树是否有未提交改动 (含未跟踪文件) */
  dirty: boolean | null;
}

/** dist/manifest.json 的字段契约 (构建写入、闸门与启动器读, 两侧同源) */
export interface DistManifest {
  /** 形状版本, 恒为 MANIFEST_SCHEMA_VERSION */
  schemaVersion: number;
  /** 构建时 HEAD 的完整哈希; 非 git 检出为 null */
  commit: string | null;
  /** 构建时工作树是否不干净; 读不到为 null */
  dirty: boolean | null;
  /** 产物 (dist/cli.js) 的 sha256 十六进制 */
  cliSha256: string;
  /** 构建时刻 (ISO 8601), 仅供人读诊断; 时间不是判据, 判定只看提交与摘要 */
  builtAt: string;
}

/** 产物目录的磁盘现状 (缺失与形状不符都落成显式字段, 供判定与报错逐条取用) */
export interface DistState {
  /** dist/cli.js 是否为常规文件 */
  cliExists: boolean;
  /** 产物字节数 (缺失为 0) */
  cliSize: number;
  /** 产物 sha256 (缺失 / 不可读 / 零字节为 null) */
  cliSha256: string | null;
  /** dist/manifest.json 是否存在 */
  manifestExists: boolean;
  /** 解析且形状合格后的清单; null = 不可用 (原因见 manifestIssue) */
  manifest: DistManifest | null;
  /** 清单不可用的原因 (人话); null = 清单可用 */
  manifestIssue: string | null;
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

/** 判定结论: 通过时带上被判定的提交与摘要 (供输出), 否则带人话拒绝原因 */
export type ReleaseVerdict =
  | { ok: true; commit: string; cliSha256: string }
  | { ok: false; reason: string };

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
 * 清单形状体检: 合格返回 null, 否则返回人话病灶。
 * 只判字段形状与版本, 不判内容对错 (内容与提交 / 产物的对账归 judgeRelease); 值一律不回显,
 * 防清单里的低信任文本落进输出面。
 */
const manifestShapeProblem = (value: unknown): string | null => {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return '清单应为 JSON 对象';
  }
  const fields = value as Record<string, unknown>;
  if (fields.schemaVersion !== MANIFEST_SCHEMA_VERSION) {
    return `清单 schemaVersion 不受支持 (期望 ${MANIFEST_SCHEMA_VERSION})`;
  }
  if (fields.commit !== null && !isCommitHash(fields.commit)) {
    return '清单 commit 字段形状不符';
  }
  if (fields.dirty !== null && typeof fields.dirty !== 'boolean') {
    return '清单 dirty 字段形状不符';
  }
  if (!isSha256(fields.cliSha256)) return '清单 cliSha256 字段形状不符';
  if (typeof fields.builtAt !== 'string' || fields.builtAt === '') {
    return '清单 builtAt 字段形状不符';
  }
  return null;
};

/** 读清单: 缺失 / 读取失败 / 非 JSON / 形状不符都落成显式字段, 不抛错 (判定层据字段决定拒绝口径) */
const readManifest = (
  path: string,
): { exists: boolean; manifest: DistManifest | null; issue: string | null } => {
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
  const problem = manifestShapeProblem(parsed);
  if (problem !== null) return { exists: true, manifest: null, issue: problem };
  return { exists: true, manifest: parsed as DistManifest, issue: null };
};

/**
 * 读产物目录现状: 逐项探测 dist/cli.js 与 dist/manifest.json, 缺失 / 不可读 / 形状不符一律
 * 落成显式字段; 本函数只取事实, 不下判定 (判定归 judgeRelease)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   distDir = /repo/dist
 *   dist/cli.js        = console.log('hi')  (17 B)
 *   dist/manifest.json = {"schemaVersion":1,"commit":"a2109d72f4…","dirty":false,"cliSha256":"9f2c…","builtAt":"2026-09-26T08:00:00.000Z"}
 *
 * 步骤 1：探测产物
 *   cliExists = true; cliSize = 17; cliSha256 = "9f2c…"  (常规文件才读, 零字节不读)
 *
 * 步骤 2：探测清单
 *   manifestExists = true  (解析成功且形状体检通过)
 *   manifest = { 同上解析结果 }
 *   manifestIssue = null
 *
 * Output（数据契约）
 *   return { cliExists: true, cliSize: 17, cliSha256: "9f2c…", manifestExists: true, manifest: {…}, manifestIssue: null }
 * ```
 */
export const readDistState = (distDir: string): DistState => {
  const cliPath = join(distDir, CLI_FILE);
  let cliExists = false;
  let cliSize = 0;
  let cliSha256: string | null = null;
  try {
    const info = statSync(cliPath);
    cliExists = info.isFile();
    cliSize = info.size;
    if (cliExists && cliSize > 0) cliSha256 = sha256File(cliPath);
  } catch {
    // 缺失 / 不可达: 保持缺失态; 具体病灶由 judgeRelease 按字段报出, 此处不抢跑
  }
  const loaded = readManifest(join(distDir, MANIFEST_FILE));
  return {
    cliExists,
    cliSize,
    cliSha256,
    manifestExists: loaded.exists,
    manifest: loaded.manifest,
    manifestIssue: loaded.issue,
  };
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

/** 发行面包内文件清单的采集结果 (采不到与「采到空包」必须可区分) */
export interface PackFacts {
  /** 包内文件路径集 (相对包根); null = 采集失败, 原因见 issue */
  files: string[] | null;
  /** 采集失败的原因 (人话); null = 采集成功 */
  issue: string | null;
}

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
  return { files, issue: null };
};

/**
 * 采 git 事实 (构建侧写清单用): 在 root 内跑两条只读命令, 任一步读不到即落 null,
 * 由调用处决定是拒绝还是如实记录。
 */
export const collectGitFacts = (root: string): GitFacts => {
  const status = readGitText(root, ['status', '--porcelain']);
  return {
    commit: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dirty: status === null ? null : status.trim() !== '',
  };
};

/** 组装清单 (构建侧写入的正是这份数据; 字段形状即契约) */
export const buildManifest = (fields: {
  cliSha256: string;
  git: GitFacts;
  builtAt: string;
}): DistManifest => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  commit: fields.git.commit,
  dirty: fields.git.dirty,
  cliSha256: fields.cliSha256,
  builtAt: fields.builtAt,
});

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
): { ok: true } | { ok: false; reason: string } => {
  const actual = new Set(files);
  const expected = new Set(PACK_FILES_EXPECTED);
  const extra = [...actual].filter((path) => !expected.has(path)).sort();
  const missing = PACK_FILES_EXPECTED.filter((path) => !actual.has(path));
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
 * 顺序即口径: 先证「检出可信」(git 可读 / 有提交 / 工作树干净), 再证「产物就位」,
 * 然后让清单与提交、产物三者逐项对上, 最后对发行面包内文件与白名单。
 */
export const judgeRelease = (facts: ReleaseFacts): ReleaseVerdict => {
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
  if (!dist.cliExists) {
    return { ok: false, reason: `产物缺失 (dist/${CLI_FILE} 不存在)` };
  }
  if (dist.cliSize === 0) {
    return { ok: false, reason: `产物为空 (dist/${CLI_FILE} 是零字节文件)` };
  }
  if (dist.cliSha256 === null) {
    return { ok: false, reason: `产物不可读 (dist/${CLI_FILE} 的摘要算不出)` };
  }
  if (!dist.manifestExists) {
    return { ok: false, reason: `产物清单缺失 (dist/${MANIFEST_FILE} 不存在)` };
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
      reason: `产物清单记录的提交 ${shortHash(dist.manifest.commit)} 与 HEAD ${shortHash(gitHead)} 不一致, 产物不是本次提交构建的`,
    };
  }
  if (dist.manifest.cliSha256 !== dist.cliSha256) {
    return {
      ok: false,
      reason: '产物摘要与清单记录不符, 产物与清单不是同一次构建的产物',
    };
  }
  if (facts.pack.files === null) {
    return {
      ok: false,
      reason: `发行面包内文件清单采不到 (${facts.pack.issue ?? '原因不明'}), 该项检查需要 npm`,
    };
  }
  const packVerdict = judgePackFiles(facts.pack.files);
  if (!packVerdict.ok) return { ok: false, reason: packVerdict.reason };
  return { ok: true, commit: gitHead, cliSha256: dist.cliSha256 };
};
