/**
 * 工作区操作、包发现、源码索引、文档提示、环境哈希与安全文件级快照恢复。
 */
import { spawnSync } from 'node:child_process';
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
import { dirname, join, relative, resolve } from 'node:path';

import { makeTmpRoot } from '../../../../scripts/lib/tmp-root.ts';
import {
  type WorkspacePackage,
  listWorkspacePackages,
  resolveProductPairs,
} from '../../../../scripts/lib/workspace.ts';
import { collectAdrIndex } from '../../../../scripts/lint-doc-references.ts';
import type {
  DiscoveredPackage,
  DocDistillationHints,
  EnvFingerprint,
  SourceFileSummary,
} from './types.ts';

const EXCLUDED_WALK_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'assets',
  'docs',
  'bench',
]);

const EXCLUDED_BENCH_SUBDIRS = new Set(['ledger', 'results']);
export const BENCH_STUB_MARKER = '@perf-loop:stub';

/** 确定性识别包分类 */
export function classifyPkgKind(
  pkg: WorkspacePackage,
): 'cli' | 'public-lib' | 'private-lib' {
  if (pkg.manifest.bin !== undefined) return 'cli';
  return pkg.manifest.private === true ? 'private-lib' : 'public-lib';
}

/** 扫描仓库内全部工作区包并按名称/目录过滤 */
export function discoverTargetPackages(
  repoRoot: string,
  pkgHint?: string,
): DiscoveredPackage[] {
  const all = listWorkspacePackages(repoRoot).map((pkg) => {
    const scripts =
      pkg.manifest.scripts !== null &&
      typeof pkg.manifest.scripts === 'object' &&
      !Array.isArray(pkg.manifest.scripts)
        ? (pkg.manifest.scripts as Record<string, unknown>)
        : {};
    const hasBenchScript = typeof scripts.bench === 'string';
    const benchEntry = join(repoRoot, pkg.dir, 'bench', 'run.ts');
    const hasBenchEntry = existsSync(benchEntry);
    const benchText = hasBenchEntry ? readFileSync(benchEntry, 'utf8') : '';
    const isStubBench = hasBenchEntry && benchText.includes(BENCH_STUB_MARKER);
    const supportsJsonBench =
      hasBenchEntry && !isStubBench && benchText.includes('--json');

    return {
      name: pkg.name,
      dir: pkg.dir,
      kind: classifyPkgKind(pkg),
      hasBenchScript,
      hasBenchEntry,
      supportsJsonBench,
      isStubBench,
    };
  });

  if (pkgHint === undefined || pkgHint.trim() === '') return all;
  const normalized = pkgHint.trim();
  const matched = all.filter(
    (p) =>
      p.name === normalized ||
      p.dir === normalized ||
      p.dir === `packages/${normalized}` ||
      p.name.endsWith(`/${normalized}`),
  );
  if (matched.length === 0) {
    const avail = all.map((p) => `${p.name} (${p.dir})`).join(', ');
    throw new Error(`未找到匹配包 "${pkgHint}", 可选包: ${avail}`);
  }
  return matched;
}

/** 探测本机 Bun 与 Node 版本 */
export function detectRuntimes(): { bun: string | null; node: string | null } {
  const readVersion = (cmd: string): string | null => {
    const res = spawnSync(cmd, ['--version'], { encoding: 'utf8' });
    if (res.status !== 0) return null;
    const out = (res.stdout ?? '').trim();
    return out === '' ? null : out.replace(/^v/, '');
  };
  return {
    bun: readVersion('bun'),
    node: readVersion('node'),
  };
}

/** 计算文件 SHA-256 */
export function sha256File(absPath: string): string {
  return createHash('sha256').update(readFileSync(absPath)).digest('hex');
}

function walkRelFiles(
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

/** 扫描目标包 src/ 产出紧凑源码结构地图 (文件 / 行数 / 导出符号) */
export function buildPackageSourceMap(
  repoRoot: string,
  pkgDir: string,
): SourceFileSummary[] {
  const srcRoot = join(repoRoot, pkgDir, 'src');
  const files = walkRelFiles(srcRoot, new Set()).filter(
    (rel) =>
      rel.endsWith('.ts') &&
      !rel.endsWith('.test.ts') &&
      !rel.endsWith('.smoke.ts'),
  );
  const out: SourceFileSummary[] = [];
  for (const rel of files) {
    const content = readFileSync(join(srcRoot, rel), 'utf8');
    const lines = content.split('\n').length;
    const exports: string[] = [];
    for (const m of content.matchAll(
      /^export\s+(?:async\s+)?(?:function|const|class|type|interface)\s+([A-Za-z0-9_]+)/gm,
    )) {
      if (exports.length < 12) exports.push(m[1]!);
    }
    out.push({ file: `src/${rel}`, lines, exports });
  }
  return out;
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

/** 生成包当前环境指纹 (用于双队列精准解封判据) */
export function computeEnvFingerprint(options: {
  repoRoot: string;
  pkgDir: string;
  acceptedCountAtAttempt: number;
  highImpactAcceptedCountAtAttempt: number;
  runtimes: { bun: string | null; node: string | null };
}): EnvFingerprint {
  const srcRoot = join(options.repoRoot, options.pkgDir, 'src');
  const srcFiles = walkRelFiles(srcRoot, new Set());
  const sourceHashes: Record<string, string> = {};
  for (const rel of srcFiles) {
    sourceHashes[`src/${rel}`] = sha256File(join(srcRoot, rel));
  }

  const benchHashes = computeBenchDirHashes(options.repoRoot, options.pkgDir);
  const benchDigest = createHash('sha256');
  for (const [k, v] of Object.entries(benchHashes).sort((a, b) =>
    a[0].localeCompare(b[0]),
  )) {
    benchDigest.update(`${k}:${v}\n`);
  }

  return {
    sourceHashes,
    benchHash: benchDigest.digest('hex'),
    runtimeVersions: options.runtimes,
    acceptedCountAtAttempt: options.acceptedCountAtAttempt,
    highImpactAcceptedCountAtAttempt: options.highImpactAcceptedCountAtAttempt,
  };
}

/** 记录除目标包之外全部工作区包与 docs/ 的 git status 指纹 (防静默越界改动) */
export function computeOutsideScopeDigest(
  repoRoot: string,
  pkgDir: string,
): string {
  const res = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) return 'no-git';
  const pkgPrefix = `${pkgDir}/`;
  const lines = (res.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      const pathPart = line.slice(3).trim();
      return !pathPart.startsWith(pkgPrefix);
    })
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
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

/** 校验 bench/ 不可篡改 + 跨包越界修改防护 (传 allowCrossPkg 时跳过跨包检查) */
export function checkPolicyViolations(options: {
  repoRoot: string;
  pkgDir: string;
  baselineBenchHashes: Record<string, string>;
  baselineOutsideDigest: string;
  allowCrossPkg: boolean;
}): string | null {
  const currBench = computeBenchDirHashes(options.repoRoot, options.pkgDir);
  const keys = new Set([
    ...Object.keys(options.baselineBenchHashes),
    ...Object.keys(currBench),
  ]);
  for (const k of keys) {
    if (options.baselineBenchHashes[k] !== currBench[k]) {
      return `优化回合禁止修改基准文件: ${options.pkgDir}/bench/${k}`;
    }
  }
  if (!options.allowCrossPkg) {
    const currOutside = computeOutsideScopeDigest(
      options.repoRoot,
      options.pkgDir,
    );
    if (currOutside !== options.baselineOutsideDigest) {
      return `检测到目标包 (${options.pkgDir}) 之外的文件被未授权改动, 如确需双包协同请显式传入 --allow-cross-pkg`;
    }
  }
  return null;
}

/** 为保留 P0/P1 优化的文档融合步算出全局下一 ADR 编号与已有设计目录 */
export function collectDocHints(
  repoRoot: string,
  pkgDir: string,
): DocDistillationHints {
  const adrIndex = collectAdrIndex(repoRoot);
  let maxNum = 0;
  for (const key of adrIndex.keys()) {
    const num = Number(key);
    if (Number.isFinite(num) && num > maxNum) maxNum = num;
  }
  const nextGlobalAdrNumber = String(maxNum + 1).padStart(4, '0');

  // 若目标为 CLI 薄壳包, 解析所属主包承载完整设计文档
  let docOwnerDir = pkgDir;
  try {
    const pairs = resolveProductPairs(repoRoot);
    const matched = pairs.find((pair) => pair.cli.dir === pkgDir);
    if (matched !== undefined) docOwnerDir = matched.api.dir;
  } catch {
    // 忽略测试环境无标准 workspaces 情况
  }

  const designsAbs = join(repoRoot, docOwnerDir, 'docs', 'designs');
  const adrsAbs = join(repoRoot, docOwnerDir, 'docs', 'adrs');
  const readmeAbs = join(repoRoot, docOwnerDir, 'docs', 'README.md');

  const existingDesigns = existsSync(designsAbs)
    ? readdirSync(designsAbs)
        .filter((f) => f.endsWith('.md') && f !== 'README.md')
        .sort()
    : [];

  return {
    nextGlobalAdrNumber,
    pkgDesignsDir: existsSync(designsAbs)
      ? `${docOwnerDir}/docs/designs`
      : null,
    existingDesigns,
    pkgAdrsDir: existsSync(adrsAbs) ? `${docOwnerDir}/docs/adrs` : null,
    pkgDocsReadme: existsSync(readmeAbs)
      ? `${docOwnerDir}/docs/README.md`
      : null,
    repoDesignsDir: 'docs/designs',
  };
}

/** 跑静态类型检查、oxlint 与目标包测试 (隔离 HOME, 与 CI 一致) */
export function runPackageValidationGates(
  repoRoot: string,
  pkgDir: string,
  changedRelFiles: readonly string[],
): { ok: boolean; stage: string; output: string } {
  const pkgAbs = join(repoRoot, pkgDir);

  const typeRes = spawnSync('bun', ['check'], {
    cwd: pkgAbs,
    encoding: 'utf8',
  });
  if (typeRes.status !== 0) {
    return {
      ok: false,
      stage: 'typecheck',
      output: `${typeRes.stdout ?? ''}\n${typeRes.stderr ?? ''}`.trim(),
    };
  }

  if (changedRelFiles.length > 0) {
    const absChanged = changedRelFiles
      .map((rel) => join(pkgAbs, rel))
      .filter((abs) => existsSync(abs));
    if (absChanged.length > 0) {
      const lintRes = spawnSync(
        'bun',
        [
          'x',
          '--no-install',
          'oxlint',
          '--no-error-on-unmatched-pattern',
          ...absChanged,
        ],
        { cwd: repoRoot, encoding: 'utf8' },
      );
      if (lintRes.status !== 0) {
        return {
          ok: false,
          stage: 'oxlint',
          output: `${lintRes.stdout ?? ''}\n${lintRes.stderr ?? ''}`.trim(),
        };
      }
    }
  }

  const isolatedHome = makeTmpRoot('perf-loop-home-');
  try {
    const testRes = spawnSync('bun', ['test'], {
      cwd: pkgAbs,
      encoding: 'utf8',
      env: { ...process.env, HOME: isolatedHome, USERPROFILE: isolatedHome },
    });
    if (testRes.status !== 0) {
      return {
        ok: false,
        stage: 'test',
        output: `${testRes.stdout ?? ''}\n${testRes.stderr ?? ''}`.trim(),
      };
    }
  } finally {
    rmSync(isolatedHome, { recursive: true, force: true });
  }

  return { ok: true, stage: 'all', output: '' };
}

/** 定位工作区根目录 */
export function resolveRepoRoot(fromMetaDir: string): string {
  return resolve(fromMetaDir, '..', '..', '..', '..');
}
