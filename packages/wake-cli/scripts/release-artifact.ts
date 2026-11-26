/**
 * 发布产物身份契约与校验配置 (`@iyowei/wake-cli`):
 * 声明 `CLI_FILE`、`MANIFEST_FILE`、`PACK_FILES_EXPECTED` 与 `PROFILE`, 委托根仓 `scripts/lib/release-cli.ts` 执行。
 */
import { resolve } from 'node:path';

import {
  type CliDistManifest,
  type GitFacts,
  buildCliManifest,
  collectGitFacts,
  formatGitSourceLabel,
  writeCliDistManifest,
} from '../../../scripts/lib/release-cli.ts';
import {
  type DistState,
  type PackFacts,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  judgeRelease as judgeReleaseCommon,
  normalizeCommit,
  readDistState,
  readGitText,
  readPackFiles,
  sha256File,
  shortHash,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');
export const CLI_FILE = 'cli.js';
export const MANIFEST_FILE = 'manifest.json';

/** 发行包 (`npm pack`) 严格白名单 */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'CHANGELOG.md',
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'bin/bunfig.toml',
  'bin/wake',
  'bin/wake.cmd',
  'bin/wake.mjs',
  'dist/cli.js',
  'dist/manifest.json',
  'package.json',
];

export const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: 1,
  packExpected: PACK_FILES_EXPECTED,
};

export type DistManifest = CliDistManifest;
export type VerifyFacts = ReleaseFacts;
export type VerifyVerdict = ReleaseVerdict;
export type PackVerdict = { ok: true } | { ok: false; reason: string };
export type { DistState, GitFacts, PackFacts };

export {
  buildCliManifest,
  collectGitFacts,
  formatGitSourceLabel,
  normalizeCommit,
  readPackFiles,
  sha256File,
  shortHash,
  writeCliDistManifest,
};

export const judgePackFiles = (files: readonly string[]): PackVerdict =>
  judgePackFilesCommon([...files], [...PACK_FILES_EXPECTED]);

export const judgeRelease = (facts: VerifyFacts): VerifyVerdict =>
  judgeReleaseCommon(facts, PROFILE);

export const collectFacts = (
  root: string,
  packOverride?: PackFacts,
): VerifyFacts => ({
  gitStatus: readGitText(root, ['status', '--porcelain']),
  gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
  dist: readDistState(resolve(root, 'dist'), PROFILE),
  pack: packOverride ?? readPackFiles(root),
});
