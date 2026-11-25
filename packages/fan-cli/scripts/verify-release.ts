/**
 * 发布侧闸门 (`@iyowei/fan-cli`): 委托仓根 `scripts/lib/release-cli.ts` 统一判定。
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
