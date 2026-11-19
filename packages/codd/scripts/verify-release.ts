/**
 * 发布侧闸门 (@iyowei/codd API 包):
 * 校验干净检出 + dist/index.js 摘要 + 递归 .d.ts 零 .ts 残留 + assets/manifest.json + npm pack 白名单。
 *
 * 用法: bun scripts/verify-release.ts
 * 退出码: 0 通过; 1 拒绝 (原因与处置见 stderr)
 */
import { join } from 'node:path';

import {
  PACKAGE_ROOT,
  type PackExpectation,
  type VerifyFacts,
  findDtsTsSpecifiers,
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

export const collectFacts = (root: string): VerifyFacts => {
  const distDir = join(root, 'dist');
  return {
    gitStatus: readGitText(root, ['status', '--porcelain']),
    gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dist: readDistState(distDir),
    dtsTsSpecifierHits: findDtsTsSpecifiers(distDir),
    pack: readPackFiles(root),
  };
};

export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  facts: VerifyFacts = collectFacts(root),
  expectation: PackExpectation = readPackExpectation(root),
): number => {
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
