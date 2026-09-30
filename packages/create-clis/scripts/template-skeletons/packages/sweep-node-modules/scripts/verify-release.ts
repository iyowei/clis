/**
 * 发布侧闸门 (API 包): 共享判定库 (scripts/lib/release-verify.ts, 与 CLI 包同源, 结构对称)
 * + API 专属项 —— d.ts specifier 复查 (消费方 TS 解析的硬前提)。
 *
 * 判定序: 检出可信 (git 可读 / 有提交 / 工作树干净) → 产物就位 (存在 / 非空 / 可读) →
 * 清单与提交、产物对账 → d.ts 复查 (专属) → 面包白名单。
 *
 * 由 package.json 的 prepublishOnly (`npm run build && npm run verify:release`) 在构建后调用,
 * 手动复核即 `bun run verify:release`。
 *
 * 模板骨架: 替换示例实现时, 须同步 PACK_FILES_EXPECTED 与 dist 实际产物 (本仓的判定链测试
 * scripts/verify-release.test.ts 是快照资产, 导出面保持不变即可继续覆盖判定).
 *
 * 用法: bun scripts/verify-release.ts
 * 退出码: 0 通过; 1 拒绝 (原因与处置见 stderr)
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgeRelease as judgeReleaseCommon,
  normalizeCommit,
  readDistState,
  readGitText,
  readPackFiles,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/**
 * 发行面包的期望文件集: files 白名单 (dist) 的物化 + npm 强制包含项 (README / LICENSE /
 * package.json)。增删产物文件 (如新增源模块的 .d.ts) 须同步本表, 闸门拒绝时会指出差集。
 */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/manifest.json',
];

/** API 侧闸门坐标 (差异面收口) */
const PROFILE: VerifyProfile = {
  entryFile: 'index.js',
  manifestFile: 'manifest.json',
  shaField: 'entrySha256',
  schemaVersion: 1,
  packExpected: PACK_FILES_EXPECTED,
};

/** 构建侧写下的自证清单 (scripts/build.ts 第 5 步; 字段契约见该处) */
export interface DistManifest {
  schemaVersion: number;
  entry: string;
  entrySha256: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string;
}

/** 判定所需的全部事实 (采集纯读取; 测试可注入构造的现场) */
export type VerifyFacts = ReleaseFacts & {
  /** 含 '.ts' specifier 残留的 d.ts 文件名; 空数组即干净 */
  dtsTsSpecifierHits: string[];
};

export type VerifyVerdict = ReleaseVerdict;

/** d.ts specifier 残留检查: 后处理 (build.ts 第 4 步) 失效或手工产物混入的确定性信号 */
const dtsHits = (distDir: string): string[] => {
  const hits: string[] = [];
  try {
    for (const file of readdirSync(distDir)) {
      if (!file.endsWith('.d.ts')) continue;
      const text = readFileSync(join(distDir, file), 'utf8');
      if (
        /from\s+['"]\.[^'"]+\.ts['"]/.test(text) ||
        /import\s+['"]\.[^'"]+\.ts['"]/.test(text)
      )
        hits.push(file);
    }
  } catch {
    // dist 不在: 产物缺失由判定层统一报出, 此处保持空集
  }
  return hits;
};

/**
 * 采事实: 两条只读 git 命令 + 读 dist 产物与清单 + d.ts 复查 + 一次只读的 npm pack。
 * 外部副作用：无 (全部只读)。
 */
export const collectFacts = (root: string): VerifyFacts => {
  const distDir = join(root, 'dist');
  return {
    gitStatus: readGitText(root, ['status', '--porcelain']),
    gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dist: readDistState(distDir, PROFILE),
    dtsTsSpecifierHits: dtsHits(distDir),
    pack: readPackFiles(root),
  };
};

/**
 * 判定 (纯函数): 委托共享库按统一判定序执行; API 专属项 (d.ts 残留) 作为扩展判定注入
 * (位于产物链检查之后、面包白名单之前)。
 */
export const judgeRelease = (facts: VerifyFacts): VerifyVerdict =>
  judgeReleaseCommon(facts, PROFILE, () =>
    facts.dtsTsSpecifierHits.length > 0
      ? `d.ts 残留 '.ts' specifier (消费方 TS 解析不了): ${facts.dtsTsSpecifierHits.join(', ')}; 检查 build 的 d.ts 后处理`
      : null,
  );

/** 输出面 (注入以便测试捕获; CLI 直写 process) */
export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 跑一次发布前置校验: 采事实 → judgeRelease → 输出结论与退出码 */
export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  facts: VerifyFacts = collectFacts(root),
): number => {
  const verdict = judgeRelease(facts);
  if (verdict.ok) {
    io.out(
      `发布前置校验通过: 提交 ${verdict.commit.slice(0, 7)} · 产物摘要 ${verdict.sha256.slice(0, 7)}`,
    );
    return 0;
  }
  io.err(`发布前置校验未通过: ${verdict.reason}`);
  io.err(
    '  处置: 工作树不干净就提交或 stash 后重新构建再发 (bun run build 会同时写产物与清单);' +
      ' 发行面包内文件与白名单不符就清掉多余文件或同步 PACK_FILES_EXPECTED。',
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
