/**
 * 发布自证闸门 (create-clis 生成器包) 的声明式适配层:
 * 通用逻辑全部收拢于仓根 scripts/lib/release-cli.ts 与 scripts/lib/release-verify.ts。
 */
import { statSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CliDistManifest,
  type GitFacts,
  type PackExpectation,
  buildCliManifest,
  collectGitFacts,
  judgeCliRelease,
  readAssetPackExpectation,
  writeCliDistManifest,
} from '../../../scripts/lib/release-cli.ts';
import {
  type DistState,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  readDistState as readDistStateCommon,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const CLI_FILE = 'create-clis.js';
/** 产物单文件体积上限 (256 KiB): 防止未来重构漏掉 --external 重新内联 prettier 等重依赖 */
export const MAX_CLI_BUNDLE_BYTES = 256 * 1024;
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const ASSET_DIR = 'assets';
export const ASSET_TEMPLATE_DIR = 'template';
export const ASSET_MANIFEST_FILE = 'manifest.json';
export const ASSET_MANIFEST_SCHEMA_VERSION = 1;

export const NPM_UNSHIPPABLE_BASENAMES: readonly string[] = [
  '.gitignore',
  '.npmrc',
];

export const PACK_FILES_BASE: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'bin/bunfig.toml',
  'bin/create-clis',
  'bin/create-clis.cmd',
  'bin/create-clis.mjs',
  `dist/${CLI_FILE}`,
  `dist/${MANIFEST_FILE}`,
];

export const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: [],
};

export type DistManifest = CliDistManifest;
export type { GitFacts, PackExpectation };

export interface AssetManifest {
  schemaVersion: number;
  files: string[];
}

export const readPackExpectation = (root: string): PackExpectation =>
  readAssetPackExpectation(root, {
    baseFiles: PACK_FILES_BASE,
    assetDir: ASSET_DIR,
    templateDir: ASSET_TEMPLATE_DIR,
    manifestFile: ASSET_MANIFEST_FILE,
    schemaVersion: ASSET_MANIFEST_SCHEMA_VERSION,
    unshippableBasenames: NPM_UNSHIPPABLE_BASENAMES,
  });

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

export { collectGitFacts, writeCliDistManifest };

export const readDistState = (distDir: string): DistState =>
  readDistStateCommon(distDir, PROFILE);

export const judgePackFiles = (
  files: string[],
  expected: readonly string[],
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, expected);

export const judgeBundleSize = (entrySize: number): string | null =>
  entrySize > MAX_CLI_BUNDLE_BYTES
    ? `产物 dist/${CLI_FILE} 体积超限 (${entrySize} B > 上限 ${MAX_CLI_BUNDLE_BYTES} B), 疑似误内联重依赖 (检查 build 脚本的 --external 配置)`
    : null;

export const checkBundleSizeAt = (root: string): string | null => {
  try {
    return judgeBundleSize(statSync(join(root, 'dist', CLI_FILE)).size);
  } catch {
    return null;
  }
};

export const judgeRelease = (
  facts: ReleaseFacts,
  expectation: PackExpectation,
): ReleaseVerdict =>
  judgeCliRelease(facts, PROFILE, expectation, () =>
    judgeBundleSize(facts.dist.entrySize),
  );

export const buildManifest = (fields: {
  cliSha256: string;
  git: GitFacts;
  builtAt: string;
}): DistManifest =>
  buildCliManifest({ ...fields, schemaVersion: MANIFEST_SCHEMA_VERSION });
