/**
 * 发布自证闸门 (`@iyowei/sweep-cli`) 的声明式适配层: 上游供 `write-dist-manifest.ts` /
 * `verify-release.ts` 及包内单测导入, 下游委托仓根 `scripts/lib/release-cli.ts` 与 `release-verify.ts`。
 * 红线: `PACK_FILES_EXPECTED` 须与 `package.json` 的 `files` 白名单保持同步, 严防杂文件随包发布或漏收 `dist/` / `bin/bunfig.toml`。
 */
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type CliDistManifest,
  type GitFacts,
  buildCliManifest,
  collectGitFacts,
  writeCliDistManifest,
} from '../../../scripts/lib/release-cli.ts';
import {
  type DistState,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  judgeRelease as judgeReleaseCommon,
  readDistState as readDistStateCommon,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const CLI_FILE = 'cli.js';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;

/** 发行面包的期望文件集 (files 白名单物化 + npm 强制包含项) */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'bin/bunfig.toml',
  'bin/sweep.mjs',
  'dist/cli.js',
  'dist/manifest.json',
  'package.json',
];

export const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: PACK_FILES_EXPECTED,
};

export type DistManifest = CliDistManifest;
export type { GitFacts };

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
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, PACK_FILES_EXPECTED);

export const judgeRelease = (facts: ReleaseFacts): ReleaseVerdict =>
  judgeReleaseCommon(facts, PROFILE);

export const buildManifest = (fields: {
  cliSha256: string;
  git: GitFacts;
  builtAt: string;
}): DistManifest =>
  buildCliManifest({ ...fields, schemaVersion: MANIFEST_SCHEMA_VERSION });
