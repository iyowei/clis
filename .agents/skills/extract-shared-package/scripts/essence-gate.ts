/**
 * 四道社区级本质闸门预审器:
 * 1. 仅按独立业务产品域计数 (不计 shared-lib 自凑数; D<=3 时要求该主导层全覆盖, D>=4 时至少 3);
 * 2. 驼峰/蛇形分词防业务词泄漏 (抓出业务字段换皮透传);
 * 3. 包名与导出符号垃圾桶词汇禁令 + 单句多职责连接词检查;
 * 4. 模拟加入新包后校验依赖方向与公开库深度 <= 2。
 */
import { deriveDomainLeakTerms, findMatchedTerms } from './domain-terms.ts';
import type {
  EssenceGateResult,
  PackageLayer,
  ProposalCheckInput,
  WorkspaceGraph,
  WorkspacePackageNode,
} from './types.ts';
import { simulateNewLibraryExtraction } from './workspace-graph.ts';

const JUNK_BAG_WORDS: readonly string[] = [
  'utils',
  'util',
  'helpers',
  'helper',
  'common',
  'commons',
  'shared',
  'misc',
  'tools',
  'toolkit',
  'stuff',
];

const MULTI_DUTY_CONNECTORS: readonly RegExp[] = [
  /\b(?:and|or)\b/i,
  /以及/,
  /和(?!平)/,
  /兼/,
];

const PACKAGE_NAME_RE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*$/;

/** 计算业务消费方所属主职责层下的最低独立产品域门槛 (D<=3 要求全覆盖, D>=4 至少 3) */
export function computeMinRequiredDomains(
  graph: WorkspaceGraph,
  businessConsumers: readonly WorkspacePackageNode[],
): {
  minRequiredDomains: number;
  totalInDominantLayer: number;
  dominantLayer: PackageLayer;
  domainsInDominantLayer: number;
} {
  const layerCounts = new Map<PackageLayer, number>();
  const layerDomains = new Map<PackageLayer, Set<string>>();

  for (const node of businessConsumers) {
    layerCounts.set(node.layer, (layerCounts.get(node.layer) ?? 0) + 1);
    const dSet = layerDomains.get(node.layer) ?? new Set<string>();
    dSet.add(node.domainId);
    layerDomains.set(node.layer, dSet);
  }

  let dominantLayer: PackageLayer = 'cli';
  let bestCount = -1;
  let bestTotal = -1;
  for (const layer of ['cli', 'api'] as const) {
    const cnt = layerCounts.get(layer) ?? 0;
    const tot = graph.layerDomainCounts[layer] ?? 0;
    if (cnt > bestCount || (cnt === bestCount && tot > bestTotal)) {
      bestCount = cnt;
      bestTotal = tot;
      dominantLayer = layer;
    }
  }

  const totalInLayer = graph.layerDomainCounts[dominantLayer] ?? 0;
  // packages(独立产品域)少 (<= 3) 时须该层全覆盖; 多了 (>= 4) 时至少需覆盖 3 个独立域
  const minRequired = totalInLayer <= 3 ? Math.max(2, totalInLayer) : 3;

  return {
    minRequiredDomains: minRequired,
    totalInDominantLayer: totalInLayer,
    dominantLayer,
    domainsInDominantLayer: layerDomains.get(dominantLayer)?.size ?? 0,
  };
}

/** 对抽离提案执行四道本质闸门预审 */
export function evaluateEssenceProposal(
  graph: WorkspaceGraph,
  input: ProposalCheckInput,
): EssenceGateResult {
  const violations: string[] = [];
  const warnings: string[] = [];
  const byName = new Map(graph.packages.map((p) => [p.name, p]));
  const consumerNodes = input.consumers
    .map((c) => byName.get(c))
    .filter((n): n is NonNullable<typeof n> => n !== undefined);

  if (consumerNodes.length !== input.consumers.length) {
    const missing = input.consumers.filter((c) => !byName.has(c));
    violations.push(`存在未知消费包: ${missing.join(', ')}`);
  }

  // 业务消费域仅统计 CLI / API 层产品包, 不允许 shared-lib 自算一个独立产品域凑数
  const businessConsumers = consumerNodes.filter(
    (c) => c.layer === 'cli' || c.layer === 'api',
  );
  const businessDomainSet = new Set(businessConsumers.map((c) => c.domainId));
  const distinctDomains = new Set(consumerNodes.map((c) => c.domainId)).size;
  const consumerLayers = [...new Set(consumerNodes.map((c) => c.layer))].sort();
  const threshold = computeMinRequiredDomains(graph, businessConsumers);

  if (businessDomainSet.size < threshold.minRequiredDomains) {
    violations.push(
      `有效独立业务产品域不足: 当前仅覆盖 ${businessDomainSet.size} 个独立业务域 (shared-lib 不计入业务域数), 主职责层 ${threshold.dominantLayer} 共 ${threshold.totalInDominantLayer} 个独立域, 要求至少覆盖 ${threshold.minRequiredDomains} 个独立域`,
    );
  }

  if (!PACKAGE_NAME_RE.test(input.packageName)) {
    violations.push(`包名不符合 npm 规范: ${input.packageName}`);
  }

  const barePkgName = input.packageName.replace(/^@[^/]+\//, '');
  const pkgSegments = barePkgName.split('-');
  for (const junk of JUNK_BAG_WORDS) {
    if (pkgSegments.includes(junk)) {
      violations.push(`包名含垃圾桶/泛化命名词 "${junk}": 必须按行为本质命名`);
    }
  }

  const domainTerms = deriveDomainLeakTerms(graph);
  const nameLeaks = findMatchedTerms(barePkgName, domainTerms);
  if (nameLeaks.length > 0) {
    violations.push(
      `包名泄漏了原业务领域词 (${nameLeaks.join(', ')}), 未抽象到社区通用本质`,
    );
  }

  const desc = input.description.trim();
  if (desc.length < 12) {
    violations.push('description 过短, 须清晰陈述单一本质行为');
  }
  const descLeaks = findMatchedTerms(desc, domainTerms);
  if (descLeaks.length > 0) {
    violations.push(`description 泄漏了原业务领域词 (${descLeaks.join(', ')})`);
  }
  // 中文复合连词或疑似逗号并列两类职责时发警告; 排除英文常见介词/定语列举误伤仅保留强连接信号
  for (const re of MULTI_DUTY_CONNECTORS) {
    if (re.test(desc)) {
      warnings.push(
        `description 含并列连接词 (${re.source}), 请确认只承载单一本质职能而非拼接多个模块`,
      );
    }
  }

  if (input.exportedSymbols.length === 0) {
    violations.push('必须声明至少 1 个公开导出符号');
  }
  for (const sym of input.exportedSymbols) {
    const symWords = sym
      .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
      .replace(/[_-]+/g, ' ')
      .toLowerCase()
      .split(/\s+/);
    for (const junk of JUNK_BAG_WORDS) {
      if (symWords.includes(junk)) {
        violations.push(
          `导出符号 ${sym} 含垃圾桶/泛化命名词 "${junk}": 请按本质动作命名`,
        );
      }
    }
    const symLeaks = findMatchedTerms(sym, domainTerms);
    if (symLeaks.length > 0) {
      violations.push(
        `导出符号 ${sym} 泄漏了原业务领域词 (${symLeaks.join(', ')})`,
      );
    }
  }
  for (const sig of input.apiSignatures ?? []) {
    const sigLeaks = findMatchedTerms(sig, domainTerms);
    if (sigLeaks.length > 0) {
      violations.push(
        `导出签名/参数字段 "${sig}" 泄漏了原业务领域词 (${sigLeaks.join(', ')})`,
      );
    }
  }

  const targetKind = input.targetKind ?? 'private-lib';
  const depViolations = simulateNewLibraryExtraction(
    graph,
    input.packageName,
    targetKind,
    input.consumers,
    input.internalDeps ?? [],
  );
  for (const v of depViolations) violations.push(`依赖拓扑违规: ${v}`);

  return {
    passed: violations.length === 0,
    violations,
    warnings,
    metrics: {
      distinctConsumers: consumerNodes.length,
      distinctDomains,
      businessConsumerDomains: businessDomainSet.size,
      consumerLayers,
      minRequiredDomains: threshold.minRequiredDomains,
      layerCoverageLabel: `${threshold.domainsInDominantLayer}/${threshold.totalInDominantLayer} (${threshold.dominantLayer})`,
    },
  };
}
