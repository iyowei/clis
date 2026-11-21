/**
 * 构建后产物清单写入入口 (`@iyowei/sweep-cli`): 上游由包 `build` 脚本在 `bun build` 后调用,
 * 下游委托仓根 `runWriteDistManifestCli` 采集 `dist/cli.js` SHA-256 与 git 状态落盘 `dist/manifest.json`,
 * 供 `bin/sweep.mjs` 运行期自证与 `verify-release.ts` 发布前校验消费。
 * 红线: `dist/cli.js` 缺失或零字节时拒绝写盘并退 1; 导出 `writeDistManifest` 供单测直测。
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
