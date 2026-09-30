/**
 * 发布侧闸门: 只有「干净检出 + 本提交构建的产物 + 清单自洽 + 资产清单可用 + 发行面包内文件与
 * 白名单相符」五者齐备才放行发布。
 *
 * 由 package.json 的 prepublishOnly (`build && verify:release && heavy-smoke`) 在构建后调用,
 * 手动复核即 `bun run verify:release`。分工: 事实采集 (含发行面清单, 跑一次只读的 npm pack) 与
 * 判定都在 release-artifact.ts (判定是纯函数, 事实可注入), 本文件只负责坐标 (PACKAGE_ROOT) 与
 * 输出面 (文案 + 退出码)。
 *
 * 用法: bun scripts/verify-release.ts
 * 退出码: 0 通过; 1 拒绝 (原因与处置见 stderr)
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

/** 输出面 (注入以便测试捕获; CLI 直写 process) */
export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/**
 * 跑一次发布前置校验: 采事实 (git 状态 / HEAD + dist 现状 + 发行面包内清单) 与白名单期望
 * (读资产清单的默认路径) → judgeRelease → 输出结论。
 * root 是包根 (默认 PACKAGE_ROOT; 测试注入临时仓库, 判定因此不依赖当前工作树状态)。
 * packFacts 默认现场采集 (跑一次只读的 npm pack, 需要 npm); 两项均可注入, 测试借此摆脱
 * npm 与构建产物依赖。
 * 外部副作用：只读 (两条只读 git 命令 + 读 dist/ 产物与清单 + 读资产清单 + 一次 npm pack)。
 */
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
    '  处置: 工作树不干净就提交或 stash 后重新构建再发 (bun run build 会同时写产物、清单与资产);' +
      ' 发行面包内文件与白名单不符就清掉包根的多余文件 (如备份移出仓库), 或同步同名清单常量。',
  );
  return 1;
};

// 被测试 import 时不得跑入口 (只有直接运行才落退出码)
if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
