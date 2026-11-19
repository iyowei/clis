/**
 * 发布自证闸门 (@iyowei/codd) 适配层: 复用根共享库 scripts/lib/release-verify.ts,
 * 对齐 dist/cli.js + dist/manifest.json + assets/manifest.json 发行面白名单。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

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

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const CLI_FILE = 'cli.js';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const ASSET_DIR = 'assets';
export const ASSET_TEMPLATE_DIR = 'template';
export const ASSET_MANIFEST_FILE = 'manifest.json';
export const ASSET_MANIFEST_SCHEMA_VERSION = 1;

export const NPM_UNSHIPPABLE_BASENAMES = new Set([
  '.gitignore',
  '.npmrc',
  '.dockerignore',
  '.helmignore',
]);

export const PACK_FILES_BASE: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'bin/codd',
  'bin/codd.cmd',
  'bin/codd.mjs',
  `dist/${CLI_FILE}`,
  `dist/${MANIFEST_FILE}`,
];

const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: [],
};

export interface DistManifest {
  schemaVersion: number;
  commit: string | null;
  dirty: boolean | null;
  cliSha256: string;
  builtAt: string;
}

export interface GitFacts {
  commit: string | null;
  dirty: boolean | null;
}

export interface PackExpectation {
  files: readonly string[] | null;
  issue: string | null;
}

export const readPackExpectation = (root: string): PackExpectation => {
  const label = `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`;
  const path = join(root, ASSET_DIR, ASSET_MANIFEST_FILE);
  if (!existsSync(path)) {
    return {
      files: null,
      issue: `模板资产清单缺失 (${label} 不存在), 请先执行 bun run build`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      files: null,
      issue: `模板资产清单 (${label}) 读取失败或非合法 JSON`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { files: null, issue: '模板资产清单应为 JSON 对象' };
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION) {
    return {
      files: null,
      issue: `模板资产清单 schemaVersion 不受支持 (期望 ${ASSET_MANIFEST_SCHEMA_VERSION})`,
    };
  }
  if (
    !Array.isArray(fields.files) ||
    fields.files.some((file) => typeof file !== 'string' || file === '')
  ) {
    return {
      files: null,
      issue: '模板资产清单 files 字段形状不符 (应为非空字符串数组)',
    };
  }
  const assets = fields.files as string[];
  const unshippable = assets.filter((file) =>
    NPM_UNSHIPPABLE_BASENAMES.has(basename(file)),
  );
  if (unshippable.length > 0) {
    return {
      files: null,
      issue: `模板资产含易被包管理器忽略的隐藏文件: ${unshippable.join(', ')}`,
    };
  }
  return {
    files: [
      ...PACK_FILES_BASE,
      `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`,
      ...assets.map((file) => `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/${file}`),
    ],
    issue: null,
  };
};

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

export const readDistState = (distDir: string): DistState =>
  readDistStateCommon(distDir, PROFILE);

export const judgePackFiles = (
  files: string[],
  expected: readonly string[],
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, expected);

export const judgeRelease = (
  facts: ReleaseFacts,
  expectation: PackExpectation,
): ReleaseVerdict => {
  const issue = expectation.issue;
  return judgeReleaseCommon(
    facts,
    { ...PROFILE, packExpected: expectation.files ?? [] },
    issue === null ? undefined : () => issue,
  );
};

export const collectGitFacts = (root: string): GitFacts => {
  const status = readGitText(root, ['status', '--porcelain']);
  return {
    commit: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dirty: status === null ? null : status.trim() !== '',
  };
};

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
