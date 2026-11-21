/**
 * 发布前自证闸门入口 (`@iyowei/sweep-cli`): 上游由 `prepublishOnly` / 发布检查脚本执行,
 * 下游结合 `release-artifact.ts` 的 `PROFILE` 委托仓根 `runVerifyReleaseCli` 校验 git 干净态、
 * `dist/cli.js` 与 `dist/manifest.json` 同源性及 `npm pack` 白名单。
 * 红线: 任一校验不过返回退出码 1 阻断发布; 导出 `verifyRelease` 供单测注入 `io` / `packFacts`。
 */
import {
  type ReleaseIo,
  runVerifyReleaseCli,
} from '../../../scripts/lib/release-cli.ts';
import {
  PACKAGE_ROOT,
  PROFILE,
  type PackFacts,
  readPackFiles,
} from './release-artifact.ts';

export type { ReleaseIo };

export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  packFacts: PackFacts = readPackFiles(root),
): number => runVerifyReleaseCli(root, PROFILE, io, packFacts);

if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
