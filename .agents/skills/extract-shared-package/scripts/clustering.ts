/**
 * 跨包同构聚类器: 按独立产品域聚合函数结构克隆、同构文件对齐与宿主能力指纹簇。
 */
import { createHash } from 'node:crypto';

import type {
  ClusterMember,
  FileProfile,
  SimilarityCluster,
  SymbolUnit,
} from './types.ts';

function jaccardSimilarity(a: readonly string[], b: readonly string[]): number {
  if (a.length === 0 && b.length === 0) return 0;
  const setA = new Set(a);
  const setB = new Set(b);
  let inter = 0;
  for (const item of setA) {
    if (setB.has(item)) inter += 1;
  }
  const union = setA.size + setB.size - inter;
  return union === 0 ? 0 : inter / union;
}

function clusterFingerprint(
  kind: SimilarityCluster['kind'],
  keys: readonly string[],
): string {
  const sorted = [...keys].sort().join('|');
  return createHash('sha256')
    .update(`${kind}::${sorted}`)
    .digest('hex')
    .slice(0, 14);
}

function computePriorityScore(
  kind: SimilarityCluster['kind'],
  distinctDomains: number,
  members: readonly ClusterMember[],
  similarity: number,
): number {
  const kindBonus: Record<SimilarityCluster['kind'], number> = {
    'exact-clone': 45,
    'structural-clone': 30,
    'filename-aligned': 15,
    'capability-cluster': 0,
  };
  const totalSloc = members.reduce((sum, m) => sum + m.sloc, 0);
  const avgCut =
    members.length === 0
      ? 0
      : members.reduce((sum, m) => sum + m.cutCost, 0) / members.length;
  const avgRust =
    members.length === 0
      ? 0
      : members.reduce((sum, m) => sum + m.rustReadinessScore, 0) /
        members.length;
  const score =
    kindBonus[kind] +
    distinctDomains * 30 +
    Math.min(totalSloc, 200) * 0.25 +
    similarity * 25 +
    avgRust * 0.15 -
    avgCut * 6;
  return Math.round(score * 100) / 100;
}

/** 聚合跨独立产品域的函数级克隆 (exact-clone / structural-clone) */
export function collectFunctionCloneClusters(
  symbols: readonly SymbolUnit[],
): SimilarityCluster[] {
  const fnSymbols = symbols.filter(
    (s) => s.symbolKind === 'function' && s.sloc >= 5 && s.shingles.length >= 4,
  );
  const n = fnSymbols.length;
  const adj = new Map<number, number[]>();
  const edgeSims = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = fnSymbols[i]!;
      const b = fnSymbols[j]!;
      if (a.domainId === b.domainId) continue;
      const sim =
        a.normalizedDigest === b.normalizedDigest
          ? 1
          : jaccardSimilarity(a.shingles, b.shingles);
      if (sim < 0.45) continue;

      const listA = adj.get(i) ?? [];
      listA.push(j);
      adj.set(i, listA);
      const listB = adj.get(j) ?? [];
      listB.push(i);
      adj.set(j, listB);
      edgeSims.set(`${i}-${j}`, sim);
    }
  }

  const visited = new Set<number>();
  const clusters: SimilarityCluster[] = [];

  for (let i = 0; i < n; i += 1) {
    if (visited.has(i) || !adj.has(i)) continue;
    const comp: number[] = [];
    const queue: number[] = [i];
    visited.add(i);
    while (queue.length > 0) {
      const cur = queue.shift()!;
      comp.push(cur);
      for (const next of adj.get(cur) ?? []) {
        if (!visited.has(next)) {
          visited.add(next);
          queue.push(next);
        }
      }
    }

    const units = comp.map((idx) => fnSymbols[idx]!);
    const domainSet = new Set(units.map((u) => u.domainId));
    if (domainSet.size < 2) continue;

    let simSum = 0;
    let simCount = 0;
    for (let x = 0; x < comp.length; x += 1) {
      for (let y = x + 1; y < comp.length; y += 1) {
        const a = Math.min(comp[x]!, comp[y]!);
        const b = Math.max(comp[x]!, comp[y]!);
        const s = edgeSims.get(`${a}-${b}`);
        if (s !== undefined) {
          simSum += s;
          simCount += 1;
        }
      }
    }
    const avgSim =
      simCount === 0 ? 0.5 : Math.round((simSum / simCount) * 100) / 100;
    const kind = avgSim >= 0.99 ? 'exact-clone' : 'structural-clone';
    const members: ClusterMember[] = units.map((u) => ({
      pkgName: u.pkgName,
      pkgDir: u.pkgDir,
      domainId: u.domainId,
      layer: u.layer,
      file: u.file,
      symbolName: u.name,
      startLine: u.startLine,
      endLine: u.endLine,
      sloc: u.sloc,
      rawDigest: u.rawDigest,
      cutCost: u.relativeImports.length,
      rustReadinessScore: u.rustReadiness.score,
      sideEffects: u.sideEffects,
      builtins: u.builtins,
    }));

    const commonBuiltins = units[0]!.builtins.filter((b) =>
      units.every((u) => u.builtins.includes(b)),
    );
    clusters.push({
      fingerprint: clusterFingerprint(
        kind,
        units.map((u) => `${u.file}#${u.name}`),
      ),
      kind,
      similarity: avgSim,
      priorityScore: computePriorityScore(
        kind,
        domainSet.size,
        members,
        avgSim,
      ),
      distinctPackageCount: new Set(units.map((u) => u.pkgName)).size,
      distinctDomainCount: domainSet.size,
      sharedLayers: [...new Set(units.map((u) => u.layer))].sort(),
      commonBuiltins,
      members,
      suppressed: false,
    });
  }

  return clusters;
}

/** 聚合跨包同构文件模式 */
export function collectFilenameAlignedClusters(
  files: readonly FileProfile[],
  fileDigests: ReadonlyMap<string, string>,
): SimilarityCluster[] {
  const byStem = new Map<string, FileProfile[]>();
  const ignoredNames = new Set([
    'index.ts',
    'types.ts',
    'codes.ts',
    'errors.ts',
    'config.ts',
  ]);

  for (const fp of files) {
    const base = fp.file.split('/').pop()!;
    if (ignoredNames.has(base) || fp.sloc < 12) continue;
    const list = byStem.get(base) ?? [];
    list.push(fp);
    byStem.set(base, list);
  }

  const clusters: SimilarityCluster[] = [];
  for (const [base, group] of byStem.entries()) {
    const domainSet = new Set(group.map((g) => g.domainId));
    if (domainSet.size < 2) continue;
    const members: ClusterMember[] = group.map((g) => ({
      pkgName: g.pkgName,
      pkgDir: g.pkgDir,
      domainId: g.domainId,
      layer: g.layer,
      file: g.file,
      symbolName: `<file:${base}>`,
      startLine: 1,
      endLine: g.sloc,
      sloc: g.sloc,
      rawDigest: fileDigests.get(g.file) ?? '',
      cutCost: g.cutCost,
      rustReadinessScore: g.rustReadiness.score,
      sideEffects: g.sideEffects,
      builtins: g.builtins,
    }));
    const commonBuiltins = group[0]!.builtins.filter((b) =>
      group.every((g) => g.builtins.includes(b)),
    );
    clusters.push({
      fingerprint: clusterFingerprint(
        'filename-aligned',
        group.map((g) => g.file),
      ),
      kind: 'filename-aligned',
      similarity: 0.7,
      priorityScore: computePriorityScore(
        'filename-aligned',
        domainSet.size,
        members,
        0.7,
      ),
      distinctPackageCount: new Set(group.map((g) => g.pkgName)).size,
      distinctDomainCount: domainSet.size,
      sharedLayers: [...new Set(group.map((g) => g.layer))].sort(),
      commonBuiltins,
      members,
      suppressed: false,
    });
  }

  return clusters;
}

const SPECIFIC_CAPABILITIES = new Set([
  'node:child_process',
  'node:readline',
  'node:crypto',
  'node:http',
  'node:https',
  'node:os',
  'node:zlib',
  'node:worker_threads',
]);

/** 聚合底层能力指纹簇 (要求至少含 1 个非平凡特异能力模块, 过滤纯 fs+path 泛噪音) */
export function collectCapabilityClusters(
  files: readonly FileProfile[],
  fileDigests: ReadonlyMap<string, string>,
): SimilarityCluster[] {
  const candidates = files.filter(
    (f) =>
      f.builtins.length >= 2 &&
      f.sloc >= 15 &&
      f.builtins.some((b) => SPECIFIC_CAPABILITIES.has(b)),
  );
  const bySignature = new Map<string, FileProfile[]>();

  for (const fp of candidates) {
    const key = fp.builtins.join('+');
    const list = bySignature.get(key) ?? [];
    list.push(fp);
    bySignature.set(key, list);
  }

  const clusters: SimilarityCluster[] = [];
  for (const [sig, group] of bySignature.entries()) {
    const domainSet = new Set(group.map((g) => g.domainId));
    if (domainSet.size < 2) continue;
    const members: ClusterMember[] = group.map((g) => ({
      pkgName: g.pkgName,
      pkgDir: g.pkgDir,
      domainId: g.domainId,
      layer: g.layer,
      file: g.file,
      symbolName: `<capability:${sig}>`,
      startLine: 1,
      endLine: g.sloc,
      sloc: g.sloc,
      rawDigest: fileDigests.get(g.file) ?? '',
      cutCost: g.cutCost,
      rustReadinessScore: g.rustReadiness.score,
      sideEffects: g.sideEffects,
      builtins: g.builtins,
    }));
    clusters.push({
      fingerprint: clusterFingerprint(
        'capability-cluster',
        group.map((g) => g.file),
      ),
      kind: 'capability-cluster',
      similarity: 0.65,
      priorityScore: computePriorityScore(
        'capability-cluster',
        domainSet.size,
        members,
        0.65,
      ),
      distinctPackageCount: new Set(group.map((g) => g.pkgName)).size,
      distinctDomainCount: domainSet.size,
      sharedLayers: [...new Set(group.map((g) => g.layer))].sort(),
      commonBuiltins: group[0]!.builtins,
      members,
      suppressed: false,
    });
  }

  return clusters;
}
