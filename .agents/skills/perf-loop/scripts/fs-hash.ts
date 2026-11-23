/**
 * perf-loop 底层纯文件遍历、SHA-256 摘要与单包文件级快照原语 (零内部模块依赖, 严防循环引用)。
 */
import { createHash } from 'node:crypto';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative } from 'node:path';

export const EXCLUDED_WALK_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'assets',
  'docs',
  'bench',
]);

export const EXCLUDED_BENCH_SUBDIRS: ReadonlySet<string> = new Set([
  'ledger',
  'results',
]);

/** 计算文件 SHA-256 */
export function sha256File(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

/** 确定性字典序遍历目录下所有相对文件路径 */
export function walkRelFiles(
  rootDir: string,
  excludedDirs: ReadonlySet<string>,
): string[] {
  if (!existsSync(rootDir)) return [];
  const files: string[] = [];
  const visit = (dir: string): void => {
    const entries = readdirSync(dir, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (entry.isDirectory()) {
        if (!excludedDirs.has(entry.name)) visit(join(dir, entry.name));
      } else if (entry.isFile()) {
        files.push(
          relative(rootDir, join(dir, entry.name)).replaceAll('\\', '/'),
        );
      }
    }
  };
  visit(rootDir);
  return files;
}

/** 列出目标包下可修改并受快照保护的源码相对路径 (跳过 bench / dist / docs 等) */
export function listMutablePackageFiles(
  repoRoot: string,
  pkgDir: string,
): string[] {
  return walkRelFiles(join(repoRoot, pkgDir), EXCLUDED_WALK_DIRS);
}

/** 计算包级 bench 目录综合哈希 (排除 ledger 与 results) */
export function computeBenchDirHashes(
  repoRoot: string,
  pkgDir: string,
): Record<string, string> {
  const benchRoot = join(repoRoot, pkgDir, 'bench');
  const files = walkRelFiles(benchRoot, EXCLUDED_BENCH_SUBDIRS);
  const out: Record<string, string> = {};
  for (const rel of files) {
    out[rel] = sha256File(join(benchRoot, rel));
  }
  return out;
}

/** 把目标包当前可变文件快照写入目标目录 */
export function savePackageSnapshot(
  repoRoot: string,
  pkgDir: string,
  snapshotDir: string,
): string[] {
  rmSync(snapshotDir, { recursive: true, force: true });
  mkdirSync(snapshotDir, { recursive: true });
  const files = listMutablePackageFiles(repoRoot, pkgDir);
  const pkgAbs = join(repoRoot, pkgDir);
  for (const rel of files) {
    const src = join(pkgAbs, rel);
    const dst = join(snapshotDir, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
  writeFileSync(
    join(snapshotDir, '.snapshot-manifest.json'),
    JSON.stringify({ pkgDir, files }, null, 2),
  );
  return files;
}

/** 从快照目录精确恢复目标包文件 (仅覆盖并清理多余新增文件) */
export function restorePackageSnapshot(
  repoRoot: string,
  pkgDir: string,
  snapshotDir: string,
): void {
  const manifestPath = join(snapshotDir, '.snapshot-manifest.json');
  if (!existsSync(manifestPath)) {
    throw new Error(`快照清单不存在: ${manifestPath}`);
  }
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
    files: string[];
  };
  const keepSet = new Set(manifest.files);
  const pkgAbs = join(repoRoot, pkgDir);

  for (const currentRel of listMutablePackageFiles(repoRoot, pkgDir)) {
    if (!keepSet.has(currentRel)) {
      rmSync(join(pkgAbs, currentRel), { force: true });
    }
  }
  for (const rel of manifest.files) {
    const src = join(snapshotDir, rel);
    const dst = join(pkgAbs, rel);
    mkdirSync(dirname(dst), { recursive: true });
    copyFileSync(src, dst);
  }
}

/** 比较基线快照与当前候选文件差异 */
export function diffSnapshotFiles(
  baselineDir: string,
  candidateDir: string,
): string[] {
  const baseManifest = JSON.parse(
    readFileSync(join(baselineDir, '.snapshot-manifest.json'), 'utf8'),
  ) as { files: string[] };
  const candManifest = JSON.parse(
    readFileSync(join(candidateDir, '.snapshot-manifest.json'), 'utf8'),
  ) as { files: string[] };
  const all = new Set([...baseManifest.files, ...candManifest.files]);
  const changed: string[] = [];

  for (const rel of [...all].sort()) {
    const basePath = join(baselineDir, rel);
    const candPath = join(candidateDir, rel);
    if (!existsSync(basePath) || !existsSync(candPath)) {
      changed.push(rel);
      continue;
    }
    if (sha256File(basePath) !== sha256File(candPath)) {
      changed.push(rel);
    }
  }
  return changed;
}
