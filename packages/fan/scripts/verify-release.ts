/**
 * 发布前置闸门 (`@iyowei/fan` API 包): 复用仓根共享判定库 + API `.d.ts` specifier 复查。
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

/** 发行包 (`npm pack`) 14 项白名单: 4 个根元文件 + `dist/index.js` + `dist/manifest.json` + 8 个公开 `.d.ts` */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'dist/controller.d.ts',
  'dist/daemon.d.ts',
  'dist/errors.d.ts',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/manifest.json',
  'dist/smc-apple.d.ts',
  'dist/speed.d.ts',
  'dist/state.d.ts',
  'dist/types.d.ts',
];

const PROFILE: VerifyProfile = {
  entryFile: 'index.js',
  manifestFile: 'manifest.json',
  shaField: 'entrySha256',
  schemaVersion: 1,
  packExpected: PACK_FILES_EXPECTED,
};

export type VerifyFacts = ReleaseFacts & {
  dtsTsSpecifierHits: string[];
};

export type VerifyVerdict = ReleaseVerdict;

const DTS_TS_SPECIFIER_RE =
  /(?:from\s+['"]|import\s+['"]|import\(\s*['"])\.[^'"]+\.ts['"]/;

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
    // dist 缺失时交由判定层报出
  }
  return hits.sort();
};

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

export const judgeRelease = (facts: VerifyFacts): VerifyVerdict =>
  judgeReleaseCommon(facts, PROFILE, () =>
    facts.dtsTsSpecifierHits.length > 0
      ? `d.ts 残留 '.ts' specifier: ${facts.dtsTsSpecifierHits.join(', ')}`
      : null,
  );

export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

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
    '  处置: 工作树干净后在包目录重新执行 bun run build, 并核对 PACK_FILES_EXPECTED。',
  );
  return 1;
};

if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
