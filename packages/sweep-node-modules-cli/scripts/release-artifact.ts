/**
 * 发布自证闸门 (CLI 包) 的适配层: 判定本体与事实读取在共享库 (scripts/lib/release-verify.ts,
 * 与 API 包同源, 结构对称), 本文件只表达 CLI 侧的坐标与口径差异 (产物文件名 / 清单摘要字段名 /
 * 面包白名单 / manifest 契约), 并向包内消费方 (verify-release / write-dist-manifest / 测试)
 * 保持稳定的导出面。
 *
 * 判定序 (共享库统一, 顺序即口径): 检出可信 (git 可读 / 有提交 / 工作树干净) → 产物就位
 * (存在 / 非空 / 可读) → 清单与提交、产物对账 → 面包白名单。
 */
import { resolve } from 'node:path';

import {
  type DistState,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  judgeRelease as judgeReleaseCommon,
  normalizeCommit,
  readDistState as readDistStateCommon,
  readGitText,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/** CLI 产物主文件 (dist/ 下) */
export const CLI_FILE = 'cli.js';

/** 产物清单文件名 (dist/ 下) */
export const MANIFEST_FILE = 'manifest.json';

/** 清单形状版本 */
export const MANIFEST_SCHEMA_VERSION = 1;

/**
 * 发行面包的期望文件集: files 白名单 (dist) 的物化 + npm 强制包含项 (README / LICENSE /
 * package.json 等文件由 npm 无条件收进包, 且官方没有任何「排除」通道 (npm docs configuring-npm/
 * package-json「files」节的排除语义 + 本机 npm-packlist 的 strict 规则, 见 ADR 0009 补记),
 * 仓库根多一份 README 备份就会被静默收进发行包。本常量把「包内应有什么」显式声明成契约,
 * 发布前逐项对账。
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

/** CLI 侧闸门坐标 (差异面收口) */
const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: PACK_FILES_EXPECTED,
};

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

/** 构建侧 git 事实 (collectGitFacts 的产物, 写清单用) */
export interface GitFacts {
  /** HEAD 提交的完整哈希 */
  commit: string | null;
  /** 工作树是否有未提交改动 (含未跟踪文件) */
  dirty: boolean | null;
}

// ---- 共享库直通导出 (包内消费方经本文件取用, 路径与命名保持稳定) ----

export {
  countDirtyEntries,
  normalizeCommit,
  parsePackFiles,
  previewDirtyEntries,
  readGitText,
  readPackFiles,
  sha256File,
  shortHash,
} from '../../../scripts/lib/release-verify.ts';
export type {
  DistState,
  PackFacts,
  ReleaseFacts,
  ReleaseVerdict,
} from '../../../scripts/lib/release-verify.ts';

/** 读产物目录现状 (CLI 口径) */
export const readDistState = (distDir: string): DistState =>
  readDistStateCommon(distDir, PROFILE);

/** 发行面包白名单判定 (CLI 口径) */
export const judgePackFiles = (
  files: string[],
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, PACK_FILES_EXPECTED);

/**
 * 发布闸门判定 (纯函数, 不碰文件系统): 委托共享库按统一判定序执行 (CLI 无专属判定项)。
 */
export const judgeRelease = (facts: ReleaseFacts): ReleaseVerdict =>
  judgeReleaseCommon(facts, PROFILE);

/** 采 git 事实 (构建侧写清单用): 在 root 内跑两条只读命令, 任一步读不到即落 null */
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
