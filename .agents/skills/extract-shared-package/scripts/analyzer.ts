/**
 * 确定性全量源码分析引擎 (双向自均衡: 正向抽离发现 + 反向退化/迁移残余检测):
 * 1. 复用统一文件枚举与相对模块解析, 计算完整内部闭合依赖切割代价 (cutCost);
 * 2. 跨独立产品域聚合函数级、文件级、条件对齐同名文件与特异能力簇;
 * 3. 分离「迁移残余 (自我回声)」并扫描「冷静期 / 到期可回收私库」;
 * 4. 叠加持久台账防重弹抑制规则并生成确定性 `nextAction` 路由信号。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  collectCapabilityClusters,
  collectFileCloneClusters,
  collectFilenameAlignedClusters,
  collectFunctionCloneClusters,
} from './clustering.ts';
import {
  collectDegeneratedLibs,
  partitionMigrationResidues,
} from './degeneration.ts';
import { sha256Short } from './fingerprint.ts';
import {
  buildMemberDigests,
  isInfraPath,
  resolveRelativeModuleTarget,
  walkPackageSourceFiles,
} from './fs-utils.ts';
import { analyzeSourceFile } from './tokenizer.ts';
import type {
  DegeneratedLibFinding,
  ExtractLedger,
  FileProfile,
  ScanNextAction,
  ScanOptions,
  ScanReport,
  SimilarityCluster,
  SymbolUnit,
  WorkspaceGraph,
  WorkspacePackageNode,
} from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

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
  graph: WorkspaceGraph,
): { active: SimilarityCluster[]; suppressed: SimilarityCluster[] } {
  const byFp = new Map(ledger.records.map((r) => [r.fingerprint, r]));
  const pkgByName = new Map(graph.packages.map((p) => [p.name, p]));
  const active: SimilarityCluster[] = [];
  const suppressed: SimilarityCluster[] = [];

  for (const cluster of clusters) {
    const rec = byFp.get(cluster.fingerprint);
    if (rec === undefined || rec.status === 'reabsorbed') {
      active.push(cluster);
      continue;
    }

    const currentDigests = buildMemberDigests(cluster);
    const unchanged =
      rec.distinctDomains === cluster.distinctDomainCount &&
      Object.entries(currentDigests).every(
        ([k, v]) => rec.memberDigests[k] === v,
      ) &&
      Object.keys(rec.memberDigests).length ===
        Object.keys(currentDigests).length;

    if (rec.status === 'accepted') {
      const allConsumersLinked =
        rec.packageName !== undefined &&
        cluster.members.every((m) => {
          if (m.pkgName === rec.packageName) return true;
          const node = pkgByName.get(m.pkgName);
          return (
            node !== undefined && node.internalDeps.includes(rec.packageName!)
          );
        });
      if (allConsumersLinked && unchanged) {
        suppressed.push({
          ...cluster,
          suppressed: true,
          suppressReason: `accepted: 已由 ${rec.packageName} 承接且全部消费方均已接入`,
        });
      } else {
        active.push(cluster);
      }
      continue;
    }

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

function buildNextActionRoute(
  graph: WorkspaceGraph,
  activeReabsorbable: readonly DegeneratedLibFinding[],
  migrationResidues: readonly SimilarityCluster[],
  activeClusters: readonly SimilarityCluster[],
  shouldStop: boolean,
  stopReason: string,
): ScanNextAction {
  const cliBase =
    'bun .agents/skills/extract-shared-package/scripts/extract-loop.ts';
  if (graph.existingViolations.length > 0) {
    return {
      kind: 'fix-graph-violations',
      reason: `发现工作区依赖方向或环违规: ${graph.existingViolations[0]}`,
    };
  }
  const firstReabsorb = activeReabsorbable[0];
  if (firstReabsorb !== undefined) {
    if (firstReabsorb.status === 'dead-unused') {
      return {
        kind: 'cleanup-unused',
        targetPkgName: firstReabsorb.pkgName,
        targetDir: firstReabsorb.pkgDir,
        targetFingerprint: firstReabsorb.fingerprint,
        suggestedCommand: `${cliBase} begin-round --mode reabsorb --name "${firstReabsorb.pkgName}" --dir "${firstReabsorb.pkgDir}"`,
        reason: firstReabsorb.reason,
      };
    }
    const consumerPkg = graph.packages.find(
      (p) => p.name === firstReabsorb.transitiveBusinessConsumers[0],
    );
    const shortStem = firstReabsorb.pkgDir.replace(/^packages\//, '');
    const hintInto =
      consumerPkg !== undefined
        ? `${consumerPkg.dir}/src/${shortStem}`
        : `packages/<consumer>/src/${shortStem}`;
    return {
      kind: 'reabsorb',
      targetPkgName: firstReabsorb.pkgName,
      targetDir: firstReabsorb.pkgDir,
      targetFingerprint: firstReabsorb.fingerprint,
      suggestedCommand: `${cliBase} begin-round --mode reabsorb --name "${firstReabsorb.pkgName}" --dir "${firstReabsorb.pkgDir}" --into "${hintInto}"`,
      reason: firstReabsorb.reason,
    };
  }
  const firstResidue = migrationResidues[0];
  if (firstResidue !== undefined) {
    return {
      kind: 'cleanup-residue',
      targetFingerprint: firstResidue.fingerprint,
      suggestedCommand: `${cliBase} begin-round --mode residue --name "residue-${firstResidue.fingerprint}" --dir "${firstResidue.members[0]?.pkgDir ?? 'packages'}"`,
      reason: '发现新共享库上线后消费方残留的同构旧实现, 应先清理迁移残余',
    };
  }
  if (shouldStop || activeClusters.length === 0) {
    return {
      kind: 'stop',
      suggestedCommand: `${cliBase} summary`,
      reason: stopReason,
    };
  }
  const topProd =
    activeClusters.find((c) => !c.isInfraOnly) ?? activeClusters[0]!;
  return {
    kind: 'extract-or-triage',
    targetFingerprint: topProd.fingerprint,
    suggestedCommand: `${cliBase} reject --fingerprint "${topProd.fingerprint}" --status rejected --reason "<若判定不该抽离请填写依据>"`,
    reason: `优先审校高优先级候选簇 ${topProd.fingerprint} (${topProd.kind}, domains=${topProd.distinctDomainCount}, score=${topProd.priorityScore})`,
  };
}

/** 对工作区所有最新包执行全量确定性扫描 (正反双向检测, 含冷静期与路由) */
export function scanWorkspace(
  repoRoot: string,
  ledger: ExtractLedger,
  maxRoundsAllowed = 10,
  options: ScanOptions = {},
): ScanReport {
  const graph = buildWorkspaceGraph(repoRoot);
  const allSymbols: SymbolUnit[] = [];
  const allFileProfiles: FileProfile[] = [];
  const fileDigests = new Map<string, string>();
  const cutCostByFile = new Map<string, number>();

  const analyzePkg = (pkg: WorkspacePackageNode): void => {
    const files = walkPackageSourceFiles(repoRoot, pkg.dir);
    const fileSet = new Set(files);
    const relGraph = new Map<string, string[]>();
    const parsedByFile = new Map<
      string,
      ReturnType<typeof analyzeSourceFile>
    >();

    for (const relFile of files) {
      const abs = join(repoRoot, relFile);
      if (!existsSync(abs)) continue;
      const content = readFileSync(abs, 'utf8');
      fileDigests.set(relFile, sha256Short(content, 12));
      const parsed = analyzeSourceFile(pkg, relFile, content);
      parsedByFile.set(relFile, parsed);

      const targets: string[] = [];
      for (const spec of parsed.relativeImports) {
        const resolved = resolveRelativeModuleTarget(relFile, spec, fileSet);
        if (resolved !== null) targets.push(resolved);
      }
      relGraph.set(relFile, targets);
    }

    for (const relFile of files) {
      const parsed = parsedByFile.get(relFile)!;
      const closureCount = computeInternalClosureCount(relFile, relGraph);
      const cutCost = closureCount + parsed.internalTypeImports.length;
      cutCostByFile.set(relFile, cutCost);

      for (const sym of parsed.symbols) allSymbols.push(sym);

      allFileProfiles.push({
        pkgName: pkg.name,
        pkgDir: pkg.dir,
        domainId: pkg.domainId,
        layer: pkg.layer,
        file: relFile,
        isInfra: isInfraPath(relFile),
        sloc: parsed.sloc,
        builtins: parsed.builtins,
        externalDeps: parsed.externalDeps,
        relativeImports: parsed.relativeImports,
        internalClosureCount: closureCount,
        symbolCount: parsed.symbols.length,
        exportedSymbolCount: parsed.symbols.filter((s) => s.exported).length,
        fileShingles: parsed.fileShingles,
        fileNormalizedDigest: parsed.fileNormalizedDigest,
        sideEffects: parsed.sideEffects,
        cutCost,
        rustReadiness: parsed.rustReadiness,
      });
    }
  };

  for (const pkg of graph.packages) analyzePkg(pkg);

  const rawClusters: SimilarityCluster[] = [
    ...collectFunctionCloneClusters(allSymbols, cutCostByFile),
    ...collectFileCloneClusters(allFileProfiles, fileDigests),
    ...collectFilenameAlignedClusters(allFileProfiles, fileDigests),
    ...collectCapabilityClusters(allFileProfiles, fileDigests),
  ];

  const { extractionCandidates, migrationResidues } =
    partitionMigrationResidues(rawClusters, graph, ledger);
  const { active, suppressed } = applyLedgerSuppression(
    extractionCandidates,
    ledger,
    graph,
  );
  const degeneratedLibs = collectDegeneratedLibs(
    graph,
    allFileProfiles,
    ledger,
    options,
  );
  const coolingDownLibs = degeneratedLibs.filter(
    (d) => !d.suppressed && d.status === 'cooling-down',
  );
  const activeReabsorbable = degeneratedLibs.filter(
    (d) =>
      !d.suppressed &&
      (d.status === 'reabsorb-candidate' || d.status === 'dead-unused'),
  );

  const coolingNote =
    coolingDownLibs.length > 0
      ? ` (另有 ${coolingDownLibs.length} 个私库处于冷却观察期, 暂不动手)`
      : '';
  let shouldStop = false;
  let stopReason = `存在待审校跨包本质复用或减法回收候选${coolingNote}`;
  if (ledger.roundsExecuted >= maxRoundsAllowed) {
    shouldStop = true;
    stopReason = `已达到单次连续执行安全检查点上限 (${maxRoundsAllowed} 轮), 请确认后传入更大 --max-rounds 继续`;
  } else if (
    active.length === 0 &&
    migrationResidues.length === 0 &&
    activeReabsorbable.length === 0
  ) {
    shouldStop = true;
    stopReason = `全仓既无活跃跨独立域本质复用候选, 也无待清理迁移残余或已满冷却期的退化私库, 双向闭环自然收敛结束${coolingNote}`;
  }

  const nextAction = buildNextActionRoute(
    graph,
    activeReabsorbable,
    migrationResidues,
    active,
    shouldStop,
    stopReason,
  );

  return {
    schemaVersion: 1,
    scannedAt: (options.now ?? new Date()).toISOString(),
    repoRoot,
    graph,
    stats: {
      totalPackages: graph.packages.length,
      totalFiles: allFileProfiles.length,
      totalSymbols: allSymbols.length,
      activeClusters: active.length,
      suppressedClusters: suppressed.length,
      migrationResidueCount: migrationResidues.length,
      degeneratedLibCount: degeneratedLibs.length,
      coolingDownLibCount: coolingDownLibs.length,
      reabsorbableLibCount: activeReabsorbable.length,
    },
    clusters: active,
    migrationResidues,
    degeneratedLibs,
    suppressed,
    files: allFileProfiles,
    nextAction,
    convergence: {
      shouldStop,
      reason: stopReason,
      activeRoundsExecuted: ledger.roundsExecuted,
      maxRoundsAllowed,
    },
  };
}
