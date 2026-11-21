/**
 * 发布前置闸门 (`@iyowei/sweep` API 包): 复用根仓共享判定库 (`scripts/lib/release-verify.ts`) + API 专属 d.ts specifier 复查。
 * 上下游: 验收 `scripts/build.ts` 产出的 `dist/` 与 `dist/manifest.json`; 由 `package.json` 的 `prepublishOnly` 或 `bun run verify:release` 触发。
 * 判定序: 检出可信 (git 可读 / 有提交 / 工作树干净) -> 产物就位 -> 清单与提交/摘要对账 -> d.ts 残留复查 (专属) -> 24 项发行包 (npm pack) 白名单。
 * 核心红线: 全流程严格只读零副作用; 任一项失败打印原因与处置建议并返回退出码 1 (仅直接执行时写 process.exitCode)。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  type PackFacts,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgeRelease as judgeReleaseCommon,
  normalizeCommit,
  readDistState,
  readGitText,
  readPackFiles,
  shortHash,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/**
 * 发行包 (`npm pack`) 24 项白名单: 4 个根元文件 (LICENSE / README.md / README.zh-CN.md / package.json)
 * + `dist/index.js` + `dist/manifest.json` + 18 个公开 `.d.ts`。
 * 14 个内部模块的 `.d.ts` 已由 `scripts/build.ts` 的 `INTERNAL_DTS_FILES` 剔除;
 * 增删公开产物文件须同步本表, 闸门拒绝时会指出差集。
 */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'dist/classify.d.ts',
  'dist/codes.d.ts',
  'dist/config.d.ts',
  'dist/delete.d.ts',
  'dist/display.d.ts',
  'dist/errors.d.ts',
  'dist/guard.d.ts',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/manifest.json',
  'dist/migrate.d.ts',
  'dist/presets.d.ts',
  'dist/rules.d.ts',
  'dist/scan.d.ts',
  'dist/size.d.ts',
  'dist/skip.d.ts',
  'dist/summary.d.ts',
  'dist/sweep.d.ts',
  'dist/trash.d.ts',
  'dist/types.d.ts',
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

/** 匹配残留相对 .ts specifier: from '...' / import '...' / import('./...ts') */
const DTS_TS_SPECIFIER_RE =
  /(?:from\s+['"]|import\s+['"]|import\(\s*['"])\.[^'"]+\.ts['"]/;

/** d.ts specifier 残留检查: 递归扫描 dist/ 全树 (后处理失效或手工产物混入的确定性信号) */
const dtsHits = (distDir: string): string[] => {
  const hits: string[] = [];
  const walk = (dir: string, prefix: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) {
        walk(abs, rel);
      } else if (entry.isFile() && entry.name.endsWith('.d.ts')) {
        const text = readFileSync(abs, 'utf8');
        if (DTS_TS_SPECIFIER_RE.test(text)) hits.push(rel);
      }
    }
  };
  try {
    walk(distDir, '');
  } catch {
    // dist 不在: 产物缺失由判定层统一报出, 此处保持空集
  }
  return hits.sort();
};

/**
 * 采事实: 两条只读 git 命令 + 读 dist 产物与清单 + d.ts 复查 + 一次只读的 npm pack。
 * 外部副作用: 无 (全部只读)。
 */
export const collectFacts = (
  root: string,
  packOverride?: PackFacts,
): VerifyFacts => {
  const distDir = join(root, 'dist');
  return {
    gitStatus: readGitText(root, ['status', '--porcelain']),
    gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dist: readDistState(distDir, PROFILE),
    dtsTsSpecifierHits: dtsHits(distDir),
    pack: packOverride ?? readPackFiles(root),
  };
};

/**
 * 判定 (纯函数): 委托共享库按统一判定序执行; API 专属项 (d.ts 残留) 作为扩展判定注入
 * (位于产物链检查之后、发行包白名单之前)。
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

/**
 * 跑一次发布前置校验: 采事实 -> judgeRelease -> 输出结论与退出码。
 *
 * ### 数据流转示例
 * - Input: `PACKAGE_ROOT` (及可注入的 `io` / `facts`)
 * - 流程: `collectFacts` (git + dist + `dtsHits` + `npm pack --dry-run`) -> `judgeRelease` (共享 4 关 + d.ts 残留复查 + 24 项白名单对账)
 * - Output: 全部通过打印提交与摘要短哈希返回 `0`; 任一失败向 `io.err` 打印原因与处置提示返回 `1`
 */
export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  facts: VerifyFacts = collectFacts(root),
): number => {
  const verdict = judgeRelease(facts);
  if (verdict.ok) {
    io.out(
      `发布前置校验通过: 提交 ${shortHash(verdict.commit)} · 产物摘要 ${shortHash(verdict.sha256)}`,
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
