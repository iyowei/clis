/**
 * 确定性全量源码分析引擎:
 * 遍历工作区全部包源码与脚本, 计算剥离切割代价 (cutCost), 调用跨包聚类与台账自愈抑制。
 */
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { dirname, extname, join, normalize, relative } from 'node:path';

import {
  collectCapabilityClusters,
  collectFilenameAlignedClusters,
  collectFunctionCloneClusters,
} from './clustering.ts';
import { analyzeSourceFile } from './tokenizer.ts';
import type {
  ExtractLedger,
  FileProfile,
  ScanReport,
  SimilarityCluster,
  SymbolUnit,
  WorkspacePackageNode,
} from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const SOURCE_EXTS = new Set(['.ts', '.tsx', '.js', '.jsx', '.mts', '.mjs']);

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

const SKIP_FILE_SUFFIXES = [
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

function isProductionSource(relPath: string): boolean {
  const ext = extname(relPath);
  if (!SOURCE_EXTS.has(ext)) return false;
  return !SKIP_FILE_SUFFIXES.some((s) => relPath.endsWith(s));
}

function walkPackageSourceFiles(repoRoot: string, pkgDir: string): string[] {
  const out: string[] = [];
  const pkgAbs = join(repoRoot, pkgDir);
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
        continue;
      }
      const abs = join(dir, entry.name);
      const relToRepo = relative(repoRoot, abs).replaceAll('\\', '/');
      if (isProductionSource(relToRepo)) out.push(relToRepo);
    }
  };
  if (existsSync(pkgAbs)) walk(pkgAbs);
  return out.sort();
}

function resolveRelativeTarget(
  fromRepoRel: string,
  specifier: string,
  allPackageFiles: ReadonlySet<string>,
): string | null {
  const baseDir = dirname(fromRepoRel);
  const raw = normalize(join(baseDir, specifier)).replaceAll('\\', '/');
  if (allPackageFiles.has(raw)) return raw;
  for (const ext of ['.ts', '.js', '.mts', '.mjs', '/index.ts', '/index.js']) {
    const candidate = `${raw}${ext}`;
    if (allPackageFiles.has(candidate)) return candidate;
  }
  return null;
}

function computeInternalClosureCount(
  startFile: string,
  relMap: ReadonlyMap<string, readonly string[]>,
): number {
  const visited = new Set<string>();
  const queue: string[] = [...(relMap.get(startFile) ?? [])];
  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (cur === startFile || visited.has(cur)) continue;
    visited.add(cur);
    for (const next of relMap.get(cur) ?? []) {
      if (!visited.has(next)) queue.push(next);
    }
  }
  return visited.size;
}

function applyLedgerSuppression(
  clusters: readonly SimilarityCluster[],
  ledger: ExtractLedger,
): { active: SimilarityCluster[]; suppressed: SimilarityCluster[] } {
  const byFp = new Map(ledger.records.map((r) => [r.fingerprint, r]));
  const active: SimilarityCluster[] = [];
  const suppressed: SimilarityCluster[] = [];

  for (const cluster of clusters) {
    const rec = byFp.get(cluster.fingerprint);
    if (rec === undefined || rec.status === 'accepted') {
      active.push(cluster);
      continue;
    }

    const currentDigests: Record<string, string> = {};
    for (const m of cluster.members) {
      currentDigests[`${m.file}#${m.symbolName}`] = m.rawDigest;
    }
    const unchanged =
      rec.distinctDomains === cluster.distinctDomainCount &&
      Object.entries(currentDigests).every(
        ([k, v]) => rec.memberDigests[k] === v,
      ) &&
      Object.keys(rec.memberDigests).length ===
        Object.keys(currentDigests).length;

    if (unchanged) {
      suppressed.push({
        ...cluster,
        suppressed: true,
        suppressReason: `${rec.status}: ${rec.reason}`,
      });
    } else {
      active.push(cluster);
    }
  }

  active.sort((a, b) => b.priorityScore - a.priorityScore);
  suppressed.sort((a, b) => b.priorityScore - a.priorityScore);
  return { active, suppressed };
}

/** 对工作区所有最新包执行全量确定性扫描 */
export function scanWorkspace(
  repoRoot: string,
  ledger: ExtractLedger,
  maxRoundsAllowed = 5,
): ScanReport {
  const graph = buildWorkspaceGraph(repoRoot);
  const allSymbols: SymbolUnit[] = [];
  const allFileProfiles: FileProfile[] = [];
  const fileDigests = new Map<string, string>();

  const analyzePkg = (pkg: WorkspacePackageNode): void => {
    const files = walkPackageSourceFiles(repoRoot, pkg.dir);
    const fileSet = new Set(files);
    const relGraph = new Map<string, string[]>();
    const parsedByFile = new Map<
      string,
      ReturnType<typeof analyzeSourceFile>
    >();

    for (const relFile of files) {
      const content = readFileSync(join(repoRoot, relFile), 'utf8');
      fileDigests.set(
        relFile,
        createHash('sha256').update(content).digest('hex').slice(0, 12),
      );
      const parsed = analyzeSourceFile(pkg, relFile, content);
      parsedByFile.set(relFile, parsed);

      const targets: string[] = [];
      for (const spec of parsed.relativeImports) {
        const resolved = resolveRelativeTarget(relFile, spec, fileSet);
        if (resolved !== null) targets.push(resolved);
      }
      relGraph.set(relFile, targets);
    }

    for (const relFile of files) {
      const parsed = parsedByFile.get(relFile)!;
      const closureCount = computeInternalClosureCount(relFile, relGraph);
      for (const sym of parsed.symbols) allSymbols.push(sym);

      allFileProfiles.push({
        pkgName: pkg.name,
        pkgDir: pkg.dir,
        domainId: pkg.domainId,
        layer: pkg.layer,
        file: relFile,
        sloc: parsed.sloc,
        builtins: parsed.builtins,
        externalDeps: parsed.externalDeps,
        relativeImports: parsed.relativeImports,
        internalClosureCount: closureCount,
        symbolCount: parsed.symbols.length,
        exportedSymbolCount: parsed.symbols.filter((s) => s.exported).length,
        sideEffects: parsed.sideEffects,
        cutCost: closureCount + parsed.internalTypeImports.length,
        rustReadiness: parsed.rustReadiness,
      });
    }
  };

  for (const pkg of graph.packages) analyzePkg(pkg);

  const rawClusters: SimilarityCluster[] = [
    ...collectFunctionCloneClusters(allSymbols),
    ...collectFilenameAlignedClusters(allFileProfiles, fileDigests),
    ...collectCapabilityClusters(allFileProfiles, fileDigests),
  ];

  const { active, suppressed } = applyLedgerSuppression(rawClusters, ledger);

  let shouldStop = false;
  let stopReason = '存在待审校跨包本质复用候选';
  if (ledger.roundsExecuted >= maxRoundsAllowed) {
    shouldStop = true;
    stopReason = `已达到单次连续抽包安全上限 (${maxRoundsAllowed} 轮), 自动熔断收口`;
  } else if (active.length === 0) {
    shouldStop = true;
    stopReason = '全仓已无跨越独立产品域的活跃复用候选簇, 本轮循环自然收敛结束';
  }

  return {
    schemaVersion: 1,
    scannedAt: new Date().toISOString(),
    repoRoot,
    graph,
    stats: {
      totalPackages: graph.packages.length,
      totalFiles: allFileProfiles.length,
      totalSymbols: allSymbols.length,
      activeClusters: active.length,
      suppressedClusters: suppressed.length,
    },
    clusters: active,
    suppressed,
    files: allFileProfiles,
    convergence: {
      shouldStop,
      reason: stopReason,
      activeRoundsExecuted: ledger.roundsExecuted,
      maxRoundsAllowed,
    },
  };
}
