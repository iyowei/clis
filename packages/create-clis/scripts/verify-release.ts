/**
 * 发布侧闸门 (create-clis): 委托仓根 scripts/lib/release-cli.ts 统一判定。
 */
import {
  type ReleaseIo,
  runVerifyReleaseCli,
} from '../../../scripts/lib/release-cli.ts';
import {
  PACKAGE_ROOT,
  PROFILE,
  type PackExpectation,
  type PackFacts,
  checkBundleSizeAt,
  readPackExpectation,
  readPackFiles,
} from './release-artifact.ts';

export type { ReleaseIo };

export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  packFacts: PackFacts = readPackFiles(root),
  expectation: PackExpectation = readPackExpectation(root),
): number =>
  runVerifyReleaseCli(root, PROFILE, io, packFacts, expectation, () =>
    checkBundleSizeAt(root),
  );

if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
