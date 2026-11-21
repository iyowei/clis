/**
 * 反向生命周期管理:
 * 1. 检测退化/闲置共享库 (传递可达业务产品域 <= 1), 引入冷静观察期防架构重构半途引发震荡;
 * 2. 到期且仍无新产品域接入时转为可回收候选 (`reabsorb-candidate` / `dead-unused`), 已发布公开库禁自动删除;
 * 3. 识别抽包后业务侧遗漏删除旧代码产生的「迁移残余/自我克隆回声」(排除通用构建脚手架脚本);
 * 4. 配合持久台账追踪首日退化时间, 消费域恢复 >= 2 时由台账同步自动清零。
 */
import { sha256Short } from './fingerprint.ts';
import type {
  DegeneratedLibFinding,
  ExtractLedger,
  FileProfile,
  ScanOptions,
  SimilarityCluster,
  WorkspaceGraph,
} from './types.ts';
import { computeTransitiveConsumerDomains } from './workspace-graph.ts';

export const DEFAULT_REABSORB_COOLDOWN_DAYS = 14;
export const DEFAULT_DEAD_COOLDOWN_DAYS = 7;
const MS_PER_DAY = 86_400_000;

function degenFingerprint(pkgName: string): string {
  return `degen::${sha256Short(pkgName, 12)}`;
}

function roundTwo(value: number): number {
  return Math.round(Math.max(0, value) * 100) / 100;
}

/** 分离正常新抽候选簇与「迁移残余/自我克隆回声」簇 (忽略纯脚手架脚本同构) */
export function partitionMigrationResidues(
  clusters: readonly SimilarityCluster[],
  graph: WorkspaceGraph,
  ledger: ExtractLedger,
): {
  extractionCandidates: SimilarityCluster[];
  migrationResidues: SimilarityCluster[];
} {
  const pkgByName = new Map(graph.packages.map((p) => [p.name, p]));
  const acceptedLibNames = new Set(
    ledger.records
      .filter((r) => r.status === 'accepted' && r.packageName !== undefined)
      .map((r) => r.packageName!),
  );

  const extractionCandidates: SimilarityCluster[] = [];
  const migrationResidues: SimilarityCluster[] = [];

  for (const cluster of clusters) {
    if (cluster.isInfraOnly) {
      extractionCandidates.push(cluster);
      continue;
    }

    const sharedLibMembers = cluster.members.filter((m) => {
      const node = pkgByName.get(m.pkgName);
      return node?.layer === 'shared-lib' || acceptedLibNames.has(m.pkgName);
    });
    const sharedLibNames = new Set(sharedLibMembers.map((m) => m.pkgName));

    // 仅当存在「已由本流程接受抽出的新库」与业务侧非脚手架克隆, 或 exact-clone 来自共享库公共入口 src/index.ts 且消费方已依赖它时才判迁移残余
    const isEcho = cluster.members.some((m) => {
      if (m.isInfra || sharedLibNames.has(m.pkgName)) return false;
      const node = pkgByName.get(m.pkgName);
      if (node === undefined) return false;
      return sharedLibMembers.some(
        (libMember) =>
          !libMember.isInfra &&
          (acceptedLibNames.has(libMember.pkgName) ||
            (cluster.kind === 'exact-clone' &&
              libMember.file.endsWith('/src/index.ts') &&
              node.internalDeps.includes(libMember.pkgName))),
      );
    });

    if (sharedLibNames.size > 0 && isEcho) {
      migrationResidues.push({ ...cluster, kind: 'migration-residue' });
    } else {
      extractionCandidates.push(cluster);
    }
  }

  return { extractionCandidates, migrationResidues };
}

/** 扫描全仓既有 shared-lib, 结合时间冷却窗口检出观察中与到期可回收的退化共享库 */
export function collectDegeneratedLibs(
  graph: WorkspaceGraph,
  files: readonly FileProfile[],
  ledger: ExtractLedger,
  options: ScanOptions = {},
): DegeneratedLibFinding[] {
  const ledgerByFp = new Map(ledger.records.map((r) => [r.fingerprint, r]));
  const watches = ledger.degenerationWatches ?? {};
  const nowDate = options.now ?? new Date();
  const nowMs = nowDate.getTime();
  const cooldownDays = options.cooldownDays ?? DEFAULT_REABSORB_COOLDOWN_DAYS;
  const deadCooldownDays =
    options.deadCooldownDays ?? DEFAULT_DEAD_COOLDOWN_DAYS;
  const findings: DegeneratedLibFinding[] = [];

  for (const pkg of graph.packages) {
    if (pkg.layer !== 'shared-lib') continue;

    const {
      directConsumers,
      transitiveBusinessConsumers,
      transitiveConsumerDomains,
    } = computeTransitiveConsumerDomains(graph, pkg.name);

    // 传递可达的独立业务产品域 >= 2 即说明仍有跨项目存在价值
    if (transitiveConsumerDomains.length >= 2) continue;

    const pkgFiles = files.filter((f) => f.pkgName === pkg.name && !f.isInfra);
    const totalSloc = pkgFiles.reduce((sum, f) => sum + f.sloc, 0);
    const fp = degenFingerprint(pkg.name);

    const rec = ledgerByFp.get(fp);
    const currentSignature = transitiveBusinessConsumers.join(',');
    const suppressed =
      rec !== undefined &&
      (rec.status === 'deferred' || rec.status === 'rejected') &&
      rec.memberDigests[pkg.name] === currentSignature;

    if (!pkg.isPrivate) {
      findings.push({
        fingerprint: fp,
        pkgName: pkg.name,
        pkgDir: pkg.dir,
        kind: 'public-lib',
        directConsumers,
        transitiveConsumerDomains,
        transitiveBusinessConsumers,
        sloc: totalSloc,
        fileCount: pkgFiles.length,
        status: 'orphaned-public-lib',
        suppressed,
        suppressReason: suppressed ? `${rec.status}: ${rec.reason}` : undefined,
        reason: `已对外发布公开库仅剩 ${transitiveConsumerDomains.length} 个仓内业务域 (${transitiveBusinessConsumers.join(', ') || '无'}), 严禁自动删除, 请人工评估继续独立维护或走 npm deprecate`,
      });
      continue;
    }

    const isZero = transitiveConsumerDomains.length === 0;
    const windowDays = isZero ? deadCooldownDays : cooldownDays;
    const existingWatch = watches[pkg.name];
    // 从零消费回到单消费说明重获使用, 重新以单消费窗口起算; 由单消费跌至零消费沿用更早起点
    const reuseWatch =
      existingWatch !== undefined &&
      !(existingWatch.watchKind === 'zero-consumer' && !isZero);
    const firstObservedAt = reuseWatch
      ? existingWatch.firstObservedAt
      : nowDate.toISOString();
    const parsedStart = Date.parse(firstObservedAt);
    const elapsedRaw = Number.isFinite(parsedStart)
      ? Math.max(0, (nowMs - parsedStart) / MS_PER_DAY)
      : 0;
    const elapsedDays = roundTwo(elapsedRaw);
    const remainingDays = roundTwo(Math.max(0, windowDays - elapsedRaw));
    const matured = windowDays <= 0 || elapsedRaw >= windowDays;

    let status: DegeneratedLibFinding['status'];
    let reason: string;
    if (!matured) {
      status = 'cooling-down';
      reason = isZero
        ? `私有共享库暂无消费者, 进入 ${windowDays} 天冷静观察期 (已观察 ${elapsedDays} 天, 剩余 ${remainingDays} 天), 期满仍无接入再行清理`
        : `私有共享库退化为仅被唯一产品域 (${transitiveConsumerDomains[0]}) 使用 (消费者: ${transitiveBusinessConsumers.join(', ')}), 进入 ${windowDays} 天冷静观察期 (已观察 ${elapsedDays} 天, 剩余 ${remainingDays} 天); 若期间新产品接回则自动清零`;
    } else if (isZero) {
      status = 'dead-unused';
      reason = `私有共享库传递可达业务域为 0 且已观察满 ${elapsedDays}/${windowDays} 天, 确认零引用后可直接退役清理`;
    } else {
      status = 'reabsorb-candidate';
      reason = `私有共享库已连续 ${elapsedDays} 天 (达 ${windowDays} 天冷静门槛) 仅被唯一产品域 (${transitiveConsumerDomains[0]}) 使用 (消费者: ${transitiveBusinessConsumers.join(', ')}), 建议以独立子模块形态内联回唯一消费方`;
    }

    findings.push({
      fingerprint: fp,
      pkgName: pkg.name,
      pkgDir: pkg.dir,
      kind: 'private-lib',
      directConsumers,
      transitiveConsumerDomains,
      transitiveBusinessConsumers,
      sloc: totalSloc,
      fileCount: pkgFiles.length,
      status,
      firstObservedAt,
      elapsedDays,
      cooldownDays: windowDays,
      remainingDays,
      suppressed,
      suppressReason: suppressed ? `${rec.status}: ${rec.reason}` : undefined,
      reason,
    });
  }

  return findings;
}
