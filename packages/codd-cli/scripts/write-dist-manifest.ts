/**
 * 构建侧入口 (@iyowei/codd-cli): 给 dist/cli.js 写入自证清单 dist/manifest.json。
 */
import { runWriteDistManifestCli } from '../../../scripts/lib/release-cli.ts';
import {
  type DistManifest,
  type GitFacts,
  PACKAGE_ROOT,
  PROFILE,
  writeCliDistManifest,
} from './release-artifact.ts';

export const writeDistManifest = (
  distDir: string,
  git: GitFacts,
  builtAt: string,
): DistManifest | null => writeCliDistManifest(distDir, PROFILE, git, builtAt);

if (import.meta.main) {
  process.exitCode = runWriteDistManifestCli(PACKAGE_ROOT, PROFILE);
}
