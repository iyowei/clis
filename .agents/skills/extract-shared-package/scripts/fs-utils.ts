/**
 * 共享文件枚举、相对路径解析、指纹快照与基础设施路径判定工具 (单向底盘, 无循环引用)。
 */
import { existsSync, readdirSync } from 'node:fs';
import {
  dirname,
  extname,
  isAbsolute,
  join,
  normalize,
  relative,
  resolve,
} from 'node:path';

import type { SimilarityCluster } from './types.ts';

/** 强制检验目标路径严格位于 repoRoot 内部, 彻底杜绝 ../ 越界删改外部目录 */
export function assertInsideRepo(
  repoRoot: string,
  relPath: string,
  label: string,
): string {
  const rootAbs = resolve(repoRoot);
  const cleaned = relPath.trim();
  if (cleaned === '' || isAbsolute(cleaned)) {
    throw new Error(
      `路径越界拒绝 (${label}): 必须为仓库内相对路径, 收到 "${relPath}"`,
    );
  }
  const targetAbs = resolve(rootAbs, cleaned);
  const rel = relative(rootAbs, targetAbs).replaceAll('\\', '/');
  if (rel === '' || rel === '.' || rel === '..' || rel.startsWith('../')) {
    throw new Error(
      `路径越界拒绝 (${label}): "${relPath}" 试图脱离仓库根目录 ${rootAbs}`,
    );
  }
  return rel;
}

const PROD_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);
const TS_EXTS = new Set(['.ts', '.tsx', '.mts']);

const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'assets',
  'template',
  'template-skeletons',
  'bench',
  'docs',
  'mutants',
]);

const SKIP_PROD_SUFFIXES = [
  '.test.ts',
  '.test.tsx',
  '.test.js',
  '.test.mjs',
  '.fixtures.ts',
  '.smoke.ts',
  '.node-smoke.ts',
  '.d.ts',
  '.d.mts',
];

export function isInfraPath(relPath: string): boolean {
  return (
    relPath.includes('/scripts/') ||
    relPath.includes('/bin/') ||
    relPath.endsWith('.mjs')
  );
}

export function isProductionSourceFile(relPath: string): boolean {
  const ext = extname(relPath);
  if (!PROD_EXTS.has(ext)) return false;
  return !SKIP_PROD_SUFFIXES.some((s) => relPath.endsWith(s));
}

/** 递归遍历指定子目录下全部生产脚本 (用于 analyzer 与 package-lint 共享) */
export function walkFilesUnder(
  repoRoot: string,
  rootRelDir: string,
  filterFn: (relPath: string) => boolean,
): string[] {
  const out: string[] = [];
  const startAbs = join(repoRoot, rootRelDir);
  if (!existsSync(startAbs)) return out;

  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      const abs = join(dir, entry.name);
      const rel = relative(repoRoot, abs).replaceAll('\\', '/');
      if (filterFn(rel)) out.push(rel);
    }
  };
  walk(startAbs);
  return out.sort();
}

export function walkPackageSourceFiles(
  repoRoot: string,
  pkgDir: string,
): string[] {
  return walkFilesUnder(repoRoot, pkgDir, isProductionSourceFile);
}

export function walkTsFiles(repoRoot: string, relDir: string): string[] {
  return walkFilesUnder(repoRoot, relDir, (rel) => TS_EXTS.has(extname(rel)));
}

/** 将相对导入解析到仓内真实存在的文件 (兼容 ESM `.js -> .ts` 与省略扩展名/目录索引) */
export function resolveRelativeModuleTarget(
  fromRepoRel: string,
  specifier: string,
  candidateFiles: ReadonlySet<string>,
): string | null {
  const baseDir = dirname(fromRepoRel);
  const raw = normalize(join(baseDir, specifier)).replaceAll('\\', '/');
  if (candidateFiles.has(raw)) return raw;

  if (raw.endsWith('.js') || raw.endsWith('.mjs')) {
    const stem = raw.slice(0, raw.endsWith('.mjs') ? -4 : -3);
    for (const tsExt of ['.ts', '.tsx', '.mts']) {
      if (candidateFiles.has(`${stem}${tsExt}`)) return `${stem}${tsExt}`;
    }
  }

  for (const ext of ['.ts', '.mts', '.js', '.mjs', '/index.ts', '/index.js']) {
    const candidate = `${raw}${ext}`;
    if (candidateFiles.has(candidate)) return candidate;
  }
  return null;
}

/** 构造用于台账抑制判定的统一成员摘要快照 */
export function buildMemberDigests(
  cluster: Pick<SimilarityCluster, 'members'>,
): Record<string, string> {
  const digests: Record<string, string> = {};
  for (const m of cluster.members) {
    digests[`${m.file}#${m.symbolName}`] = m.rawDigest;
  }
  return digests;
}
