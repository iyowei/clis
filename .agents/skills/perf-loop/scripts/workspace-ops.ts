/**
 * 工作区操作、包发现、源码索引、文档提示、环境哈希与策略越界检查。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { makeTmpRoot } from '../../../../scripts/lib/tmp-root.ts';
import {
  type WorkspacePackage,
  listWorkspacePackages,
  resolveProductPairs,
} from '../../../../scripts/lib/workspace.ts';
import { collectAdrIndex } from '../../../../scripts/lint-doc-references.ts';
import {
  computeBenchDirHashes,
  diffSnapshotFiles,
  listMutablePackageFiles,
  restorePackageSnapshot,
  savePackageSnapshot,
  sha256File,
  walkRelFiles,
} from './fs-hash.ts';
import type {
  DiscoveredPackage,
  DocDistillationHints,
  EnvFingerprint,
  SourceFileSummary,
} from './types.ts';

export {
  computeBenchDirHashes,
  diffSnapshotFiles,
  listMutablePackageFiles,
  restorePackageSnapshot,
  savePackageSnapshot,
  sha256File,
};

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

/** 生成包当前环境指纹 (用于双队列精准解封判据, 含同产品配对包 src/ 哈希) */
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

  try {
    const pairs = resolveProductPairs(options.repoRoot);
    for (const pair of pairs) {
      let compDir: string | null = null;
      if (pair.api.dir === options.pkgDir) compDir = pair.cli.dir;
      else if (pair.cli.dir === options.pkgDir) compDir = pair.api.dir;
      if (compDir === null) continue;
      const compSrc = join(options.repoRoot, compDir, 'src');
      for (const rel of walkRelFiles(compSrc, new Set())) {
        sourceHashes[`${compDir}/src/${rel}`] = sha256File(join(compSrc, rel));
      }
    }
  } catch {
    // 忽略非标准工作区沙箱
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

function isPathInsideAllowedDirs(
  rawPart: string,
  allowedPrefixes: readonly string[],
  allowedExact: ReadonlySet<string>,
): boolean {
  const cleaned = rawPart.trim().replace(/^"(.*)"$/, '$1');
  return (
    allowedExact.has(cleaned) ||
    allowedPrefixes.some((prefix) => cleaned.startsWith(prefix))
  );
}

/** 记录除允许包作用域之外全部工作区包与 docs/ 的 git status 指纹 (防静默越界改动) */
export function computeOutsideScopeDigest(
  repoRoot: string,
  pkgDirOrDirs: string | readonly string[],
): string {
  const res = spawnSync('git', ['status', '--porcelain'], {
    cwd: repoRoot,
    encoding: 'utf8',
  });
  if (res.status !== 0) return 'no-git';
  const dirs =
    typeof pkgDirOrDirs === 'string' ? [pkgDirOrDirs] : [...pkgDirOrDirs];
  const allowedPrefixes = dirs.map((d) => `${d.replace(/\/+$/, '')}/`);
  const allowedExact = new Set(dirs.map((d) => d.replace(/\/+$/, '')));

  const lines = (res.stdout ?? '')
    .split('\n')
    .filter((line) => line.trim() !== '')
    .filter((line) => {
      const pathExpr = line.slice(3).trim();
      const parts = pathExpr.includes(' -> ')
        ? pathExpr.split(' -> ')
        : [pathExpr];
      return !parts.every((p) =>
        isPathInsideAllowedDirs(p, allowedPrefixes, allowedExact),
      );
    })
    .sort();
  return createHash('sha256').update(lines.join('\n')).digest('hex');
}

function findTamperedBenchFile(
  repoRoot: string,
  pkgDir: string,
  baselineHashes: Record<string, string>,
): string | null {
  const currBench = computeBenchDirHashes(repoRoot, pkgDir);
  const keys = new Set([
    ...Object.keys(baselineHashes),
    ...Object.keys(currBench),
  ]);
  for (const k of keys) {
    if (baselineHashes[k] !== currBench[k]) {
      return `优化回合禁止修改基准文件: ${pkgDir}/bench/${k}`;
    }
  }
  return null;
}

/** 校验 bench/ 不可篡改 + 单包/双包产品对作用域越界修改防护 */
export function checkPolicyViolations(options: {
  repoRoot: string;
  pkgDir: string;
  baselineBenchHashes: Record<string, string>;
  baselineOutsideDigest: string;
  allowCrossPkg: boolean;
  companionPackages?: ReadonlyArray<{
    pkgDir: string;
    baselineBenchHashes: Record<string, string>;
  }>;
  baselineOutsidePairDigest?: string;
}): string | null {
  const primaryBenchViolation = findTamperedBenchFile(
    options.repoRoot,
    options.pkgDir,
    options.baselineBenchHashes,
  );
  if (primaryBenchViolation !== null) return primaryBenchViolation;

  const companions = options.companionPackages ?? [];
  for (const comp of companions) {
    const compBenchViolation = findTamperedBenchFile(
      options.repoRoot,
      comp.pkgDir,
      comp.baselineBenchHashes,
    );
    if (compBenchViolation !== null) return compBenchViolation;
  }

  if (!options.allowCrossPkg) {
    const currOutside = computeOutsideScopeDigest(
      options.repoRoot,
      options.pkgDir,
    );
    if (currOutside !== options.baselineOutsideDigest) {
      return `检测到目标包 (${options.pkgDir}) 之外的文件被未授权改动, 如确需双包协同请显式传入 --allow-cross-pkg`;
    }
    return null;
  }

  if (options.baselineOutsidePairDigest !== undefined) {
    const allowedDirs = [options.pkgDir, ...companions.map((c) => c.pkgDir)];
    const currPairOutside = computeOutsideScopeDigest(
      options.repoRoot,
      allowedDirs,
    );
    if (currPairOutside !== options.baselineOutsidePairDigest) {
      if (companions.length === 0) {
        return `目标包 (${options.pkgDir}) 无同产品配对包, 禁止通过 --allow-cross-pkg 修改外部文件`;
      }
      return `检测到双包协同作用域 (${allowedDirs.join(', ')}) 之外的文件被未授权改动`;
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

/** 预建隔离家目录内的标准配置子目录 (对齐 scripts/ci.ts, Windows 上 SHGetKnownFolderPath 校验 AppData\Roaming 存在) */
export function prepareIsolatedHome(home: string): void {
  for (const sub of [
    '.config/turborepo',
    '.config/vercel',
    'AppData/Roaming',
    'AppData/Local',
  ]) {
    mkdirSync(join(home, ...sub.split('/')), { recursive: true });
  }
}

/** 构造隔离 HOME / XDG / AppData / Turbo / Vercel 环境变量映射 (对齐 scripts/ci.ts) */
export function buildIsolatedHomeEnv(
  home: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  const configDir = join(home, '.config');
  return {
    ...baseEnv,
    HOME: home,
    USERPROFILE: home,
    XDG_CONFIG_HOME: configDir,
    APPDATA: join(home, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(home, 'AppData', 'Local'),
    TURBO_CONFIG_DIR_PATH: join(configDir, 'turborepo'),
    VERCEL_CONFIG_DIR_PATH: join(configDir, 'vercel'),
  };
}

/** 判断目标包是否声明了 scripts.build 且已存在 dist/ 目录 (避免包内测试读取陈旧构建产物) */
export function shouldRebuildPackageDist(
  repoRoot: string,
  pkgDir: string,
): boolean {
  const pkgAbs = join(repoRoot, pkgDir);
  if (!existsSync(join(pkgAbs, 'dist'))) return false;
  const manifestPath = join(pkgAbs, 'package.json');
  if (!existsSync(manifestPath)) return false;
  try {
    const { scripts } = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      scripts?: Record<string, unknown>;
    };
    return typeof scripts?.build === 'string' && scripts.build.trim() !== '';
  } catch {
    return false;
  }
}

function formatCmdOutput(res: {
  stdout: string | null;
  stderr: string | null;
}): string {
  return `${res.stdout ?? ''}\n${res.stderr ?? ''}`.trim();
}

/** 跑静态类型检查、oxlint、(必要时) 包级 build 与目标包测试 (隔离 HOME, 与 CI 一致) */
export function runPackageValidationGates(
  repoRoot: string,
  pkgDir: string,
  changedRelFiles: readonly string[],
  options?: { skipBuild?: boolean },
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
      output: formatCmdOutput(typeRes),
    };
  }

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
      return { ok: false, stage: 'oxlint', output: formatCmdOutput(lintRes) };
    }
  }

  const isolatedHome = makeTmpRoot('perf-loop-home-');
  try {
    prepareIsolatedHome(isolatedHome);
    const isolatedEnv = buildIsolatedHomeEnv(isolatedHome);
    if (
      options?.skipBuild !== true &&
      shouldRebuildPackageDist(repoRoot, pkgDir)
    ) {
      const buildRes = spawnSync('bun', ['run', 'build'], {
        cwd: pkgAbs,
        encoding: 'utf8',
        env: isolatedEnv,
        timeout: 60000,
      });
      if (buildRes.status !== 0) {
        return { ok: false, stage: 'build', output: formatCmdOutput(buildRes) };
      }
    }
    const testRes = spawnSync('bun', ['test'], {
      cwd: pkgAbs,
      encoding: 'utf8',
      env: isolatedEnv,
    });
    if (testRes.status !== 0) {
      return { ok: false, stage: 'test', output: formatCmdOutput(testRes) };
    }
  } finally {
    rmSync(isolatedHome, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
  return { ok: true, stage: 'all', output: '' };
}

/** 定位工作区根目录 */
export function resolveRepoRoot(fromMetaDir: string): string {
  return resolve(fromMetaDir, '..', '..', '..', '..');
}
