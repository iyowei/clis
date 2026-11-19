/**
 * 发布侧闸门: 校验干净检出 + dist/cli.js 产物摘要 + assets/manifest.json + npm pack 发行面白名单。
 */
import { join } from 'node:path';

import {
  PACKAGE_ROOT,
  type PackExpectation,
  type PackFacts,
  type ReleaseFacts,
  judgeRelease,
  normalizeCommit,
  readDistState,
  readGitText,
  readPackExpectation,
  readPackFiles,
  shortHash,
} from './release-artifact.ts';

export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  packFacts: PackFacts = readPackFiles(root),
  expectation: PackExpectation = readPackExpectation(root),
): number => {
  const facts: ReleaseFacts = {
    gitStatus: readGitText(root, ['status', '--porcelain']),
    gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dist: readDistState(join(root, 'dist')),
    pack: packFacts,
  };
  const verdict = judgeRelease(facts, expectation);
  if (verdict.ok) {
    io.out(
      `发布前置校验通过: 提交 ${shortHash(verdict.commit)} · 产物摘要 ${shortHash(verdict.sha256)}`,
    );
    return 0;
  }
  io.err(`发布前置校验未通过: ${verdict.reason}`);
  io.err(
    '  处置: 工作树不干净请先提交或 stash 后重新执行 bun run build; 发行面不符请核对 PACK_FILES_BASE 与模板资产清单。',
  );
  return 1;
};

if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
