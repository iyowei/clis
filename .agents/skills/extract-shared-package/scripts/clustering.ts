/**
 * 跨包多尺度聚类器 (防传递弱连、去门面/短壳/启动器混榜噪点):
 * - 函数级克隆 (sloc >= 6, shingles >= 6, sim >= 0.32 & 紧密团拆分防止 A~B~C 弱连误并);
 * - 文件级可执行指纹克隆 (排除纯导出入口 index.ts / index.mts);
 * - 同构文件对齐 (要求平均相似度 >= 0.30 与公共 Shingle >= 6);
 * - 混合 infra 启动器且剥离后非 infra 独立域 < 2 的簇自动降权防霸榜。
 */
import {
  clusterFingerprint,
  computePriorityScore,
  isEffectiveInfraOnly,
  pairAvgSim,
  shingleMetrics,
  splitDenseCliques,
} from './cluster-math.ts';
import type {
  ClusterMember,
  FileProfile,
  SimilarityCluster,
  SymbolUnit,
} from './types.ts';

/** 聚合跨独立产品域的函数级克隆 */
export function collectFunctionCloneClusters(
  symbols: readonly SymbolUnit[],
  cutCostByFile: ReadonlyMap<string, number>,
): SimilarityCluster[] {
  const fnSymbols = symbols.filter(
    (s) => s.symbolKind === 'function' && s.sloc >= 6 && s.shingles.length >= 6,
  );
  const n = fnSymbols.length;
  const adj = new Map<number, number[]>();
  const edgeSims = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = fnSymbols[i]!;
      const b = fnSymbols[j]!;
      if (a.domainId === b.domainId) continue;
      const metrics =
        a.normalizedDigest === b.normalizedDigest
          ? { jaccard: 1, intersection: a.shingles.length }
          : shingleMetrics(a.shingles, b.shingles);
      const matched =
        metrics.jaccard >= 0.99 ||
        (metrics.jaccard >= 0.32 && metrics.intersection >= 8);
      if (!matched) continue;

      const listA = adj.get(i) ?? [];
      listA.push(j);
      adj.set(i, listA);
      const listB = adj.get(j) ?? [];
      listB.push(i);
      adj.set(j, listB);
      edgeSims.set(`${i}-${j}`, metrics.jaccard);
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

    for (const dense of splitDenseCliques(
      comp,
      edgeSims,
      adj,
      (idx) => fnSymbols[idx]!.shingles,
    )) {
      const units = dense.map((idx) => fnSymbols[idx]!);
      const domainSet = new Set(units.map((u) => u.domainId));
      if (domainSet.size < 2) continue;

      const avgSim = pairAvgSim(dense, edgeSims, 0.5);
      const kind = avgSim >= 0.99 ? 'exact-clone' : 'structural-clone';
      const members: ClusterMember[] = units.map((u) => ({
        pkgName: u.pkgName,
        pkgDir: u.pkgDir,
        domainId: u.domainId,
        layer: u.layer,
        file: u.file,
        isInfra: u.isInfra,
        symbolName: u.name,
        startLine: u.startLine,
        endLine: u.endLine,
        sloc: u.sloc,
        rawDigest: u.rawDigest,
        cutCost: cutCostByFile.get(u.file) ?? u.relativeImports.length,
        rustReadinessScore: u.rustReadiness.score,
        sideEffects: u.sideEffects,
        builtins: u.builtins,
      }));

      const isInfraOnly = isEffectiveInfraOnly(members);
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
          isInfraOnly,
        ),
        isInfraOnly,
        distinctPackageCount: new Set(units.map((u) => u.pkgName)).size,
        distinctDomainCount: domainSet.size,
        sharedLayers: [...new Set(units.map((u) => u.layer))].sort(),
        commonBuiltins,
        members,
        suppressed: false,
      });
    }
  }

  return clusters;
}

/** 聚合跨文件可执行体结构克隆 (re-export 门面已在词法层剔除出可执行 token, 单文件核心库 src/index.ts 照常受检) */
export function collectFileCloneClusters(
  files: readonly FileProfile[],
  fileDigests: ReadonlyMap<string, string>,
): SimilarityCluster[] {
  const candidates = files.filter(
    (f) => f.sloc >= 15 && f.fileShingles.length >= 10,
  );
  const n = candidates.length;
  const adj = new Map<number, number[]>();
  const edgeSims = new Map<string, number>();

  for (let i = 0; i < n; i += 1) {
    for (let j = i + 1; j < n; j += 1) {
      const a = candidates[i]!;
      const b = candidates[j]!;
      if (a.domainId === b.domainId) continue;
      if (a.isInfra && b.isInfra) continue;
      const m = shingleMetrics(a.fileShingles, b.fileShingles);
      if (m.jaccard < 0.35 || m.intersection < 10) continue;
      const listA = adj.get(i) ?? [];
      listA.push(j);
      adj.set(i, listA);
      const listB = adj.get(j) ?? [];
      listB.push(i);
      adj.set(j, listB);
      edgeSims.set(`${i}-${j}`, m.jaccard);
    }
  }

  const visited = new Set<number>();
  const clusters: SimilarityCluster[] = [];
  for (let i = 0; i < n; i += 1) {
    if (visited.has(i) || !adj.has(i)) continue;
    const comp: number[] = [];
    const queue = [i];
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

    for (const dense of splitDenseCliques(
      comp,
      edgeSims,
      adj,
      (idx) => candidates[idx]!.fileShingles,
    )) {
      const group = dense.map((idx) => candidates[idx]!);
      const domainSet = new Set(group.map((g) => g.domainId));
      if (domainSet.size < 2) continue;

      const avgSim = pairAvgSim(dense, edgeSims, 0.45);
      const members: ClusterMember[] = group.map((g) => ({
        pkgName: g.pkgName,
        pkgDir: g.pkgDir,
        domainId: g.domainId,
        layer: g.layer,
        file: g.file,
        isInfra: g.isInfra,
        symbolName: `<file-body:${g.file.split('/').pop()!}>`,
        startLine: 1,
        endLine: g.sloc,
        sloc: g.sloc,
        rawDigest: fileDigests.get(g.file) ?? '',
        cutCost: g.cutCost,
        rustReadinessScore: g.rustReadiness.score,
        sideEffects: g.sideEffects,
        builtins: g.builtins,
      }));
      const isInfraOnly = isEffectiveInfraOnly(members);
      clusters.push({
        fingerprint: clusterFingerprint(
          'file-structural-clone',
          group.map((g) => g.file),
        ),
        kind: 'file-structural-clone',
        similarity: avgSim,
        priorityScore: computePriorityScore(
          'file-structural-clone',
          domainSet.size,
          members,
          avgSim,
          isInfraOnly,
        ),
        isInfraOnly,
        distinctPackageCount: new Set(group.map((g) => g.pkgName)).size,
        distinctDomainCount: domainSet.size,
        sharedLayers: [...new Set(group.map((g) => g.layer))].sort(),
        commonBuiltins: group[0]!.builtins.filter((b) =>
          group.every((g) => g.builtins.includes(b)),
        ),
        members,
        suppressed: false,
      });
    }
  }
  return clusters;
}

/** 聚合跨包同构文件模式 (仅跳过纯出口与纯类型文件; 要求均值 >= 0.30 且公共 Shingle >= 6 防误报) */
export function collectFilenameAlignedClusters(
  files: readonly FileProfile[],
  fileDigests: ReadonlyMap<string, string>,
): SimilarityCluster[] {
  const byStem = new Map<string, FileProfile[]>();
  const ignoredNames = new Set(['index.ts', 'types.ts']);

  for (const fp of files) {
    const base = fp.file.split('/').pop()!;
    if (ignoredNames.has(base) || fp.sloc < 8) continue;
    const list = byStem.get(base) ?? [];
    list.push(fp);
    byStem.set(base, list);
  }

  const clusters: SimilarityCluster[] = [];
  for (const [base, group] of byStem.entries()) {
    const domainSet = new Set(group.map((g) => g.domainId));
    if (domainSet.size < 2) continue;

    let maxPairInter = 0;
    let simSum = 0;
    let pairCount = 0;
    for (let i = 0; i < group.length; i += 1) {
      for (let j = i + 1; j < group.length; j += 1) {
        if (group[i]!.domainId === group[j]!.domainId) continue;
        const m = shingleMetrics(
          group[i]!.fileShingles,
          group[j]!.fileShingles,
        );
        simSum += m.jaccard;
        pairCount += 1;
        if (m.intersection > maxPairInter) maxPairInter = m.intersection;
      }
    }
    const avgSim =
      pairCount === 0 ? 0 : Math.round((simSum / pairCount) * 100) / 100;
    if (avgSim < 0.3 || maxPairInter < 6) continue;

    const members: ClusterMember[] = group.map((g) => ({
      pkgName: g.pkgName,
      pkgDir: g.pkgDir,
      domainId: g.domainId,
      layer: g.layer,
      file: g.file,
      isInfra: g.isInfra,
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
    const isInfraOnly = isEffectiveInfraOnly(members);
    clusters.push({
      fingerprint: clusterFingerprint(
        'filename-aligned',
        group.map((g) => g.file),
      ),
      kind: 'filename-aligned',
      similarity: avgSim,
      priorityScore: computePriorityScore(
        'filename-aligned',
        domainSet.size,
        members,
        avgSim,
        isInfraOnly,
      ),
      isInfraOnly,
      distinctPackageCount: new Set(group.map((g) => g.pkgName)).size,
      distinctDomainCount: domainSet.size,
      sharedLayers: [...new Set(group.map((g) => g.layer))].sort(),
      commonBuiltins: group[0]!.builtins.filter((b) =>
        group.every((g) => g.builtins.includes(b)),
      ),
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

/** 聚合底层能力指纹簇 */
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
      isInfra: g.isInfra,
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
    const isInfraOnly = isEffectiveInfraOnly(members);
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
        isInfraOnly,
      ),
      isInfraOnly,
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
