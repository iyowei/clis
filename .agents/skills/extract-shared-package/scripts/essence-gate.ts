/**
 * 四道社区级本质闸门与落盘新包确定性体检器。
 *
 * 闸门列表:
 * 1. 独立消费域达标校验 (小层须 100% 全覆盖, 大层至少 >= 2~3 个独立域, 严禁同一双包产品内部自算多方);
 * 2. 单一职能与去大杂烩校验 (禁止 utils/common/helpers/shared/misc 与双职责拼接词);
 * 3. 去业务领域词泄漏校验 (新包名、描述、导出符号与落盘源码/README 不得出现原产品领域词汇);
 * 4. 社区规格与依赖安全校验 (必须标 "private": true 隔离首发、sideEffects: false、exports、合规依赖方向与链深 <= 2)。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  EssenceGateResult,
  PackageLayer,
  ProposalCheckInput,
  WorkspaceGraph,
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
  /\band\b/i,
  /以及/,
  /和(?!平)/,
  /兼/,
];

const PACKAGE_NAME_RE = /^(?:@[a-z0-9-]+\/)?[a-z0-9][a-z0-9-]*$/;

/** 从工作区现有产品包自动派生领域专有词表 (防抽出的社区包携带原项目上下文词) */
export function deriveDomainLeakTerms(graph: WorkspaceGraph): string[] {
  const terms = new Set<string>(['clis', 'create-clis']);
  for (const pkg of graph.packages) {
    // 只从业务产品包 (api / cli / scaffold) 派生禁词, 不封杀通用基础设施词
    if (pkg.layer === 'shared-lib') continue;
    const shortDir = pkg.dir.replace(/^packages\//, '');
    const stem = shortDir.replace(/-cli$/, '');
    if (stem.length >= 4) terms.add(stem);
    for (const part of stem.split('-')) {
      // 过滤过短或纯粹通用的动词/技术词, 保留明显产品特征词
      if (
        part.length >= 4 &&
        part !== 'node' &&
        part !== 'modules' &&
        part !== 'create'
      ) {
        terms.add(part);
      }
    }
    if (shortDir.includes('node-modules')) terms.add('node_modules');
    if (shortDir.includes('codd')) terms.add('mongodb');
  }
  return [...terms].sort();
}

function findMatchedTerms(text: string, terms: readonly string[]): string[] {
  const hits: string[] = [];
  for (const term of terms) {
    const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(
      `(?:^|[^a-zA-Z0-9])${escaped}(?:$|[^a-zA-Z0-9])`,
      'i',
    );
    if (re.test(text)) hits.push(term);
  }
  return hits;
}

/** 计算消费方所属主职责层下的最低独立产品域门槛 */
export function computeMinRequiredDomains(
  graph: WorkspaceGraph,
  consumerLayers: readonly PackageLayer[],
): {
  minRequiredDomains: number;
  totalInDominantLayer: number;
  dominantLayer: PackageLayer;
} {
  const counts = new Map<PackageLayer, number>();
  for (const layer of consumerLayers) {
    counts.set(layer, (counts.get(layer) ?? 0) + 1);
  }
  let dominantLayer: PackageLayer = consumerLayers[0] ?? 'cli';
  let bestCount = -1;
  for (const [layer, cnt] of counts.entries()) {
    if (cnt > bestCount) {
      bestCount = cnt;
      dominantLayer = layer;
    }
  }

  const totalInLayer = graph.layerDomainCounts[dominantLayer] ?? 0;
  // packages(独立产品域)少时要求该层全部复用; 较多时要求至少 2~3 个独立域复用
  let minRequired = 2;
  if (totalInLayer <= 2) minRequired = Math.max(2, totalInLayer);
  else if (totalInLayer === 3) minRequired = 2;
  else minRequired = 3;

  return {
    minRequiredDomains: minRequired,
    totalInDominantLayer: totalInLayer,
    dominantLayer,
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

  const distinctDomains = new Set(consumerNodes.map((c) => c.domainId)).size;
  const consumerLayers = [...new Set(consumerNodes.map((c) => c.layer))].sort();
  const threshold = computeMinRequiredDomains(graph, consumerLayers);

  if (distinctDomains < threshold.minRequiredDomains) {
    violations.push(
      `有效独立产品域不足: 当前覆盖 ${distinctDomains} 个独立域, 主职责层 ${threshold.dominantLayer} 共 ${threshold.totalInDominantLayer} 个独立域, 要求至少覆盖 ${threshold.minRequiredDomains} 个独立域 (双包产品内部不重复计数)`,
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
  for (const re of MULTI_DUTY_CONNECTORS) {
    if (re.test(desc)) {
      warnings.push(
        `description 疑似用连接词 (${re.source}) 拼接多个职能, 请核验是否违背单一职能原则`,
      );
    }
  }

  if (input.exportedSymbols.length === 0) {
    violations.push('必须声明至少 1 个公开导出符号');
  }
  for (const sym of input.exportedSymbols) {
    const symLeaks = findMatchedTerms(sym, domainTerms);
    if (symLeaks.length > 0) {
      violations.push(
        `导出符号 ${sym} 泄漏了原业务领域词 (${symLeaks.join(', ')})`,
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
      consumerLayers,
      minRequiredDomains: threshold.minRequiredDomains,
      layerCoverageLabel: `${distinctDomains}/${threshold.totalInDominantLayer} (${threshold.dominantLayer})`,
    },
  };
}

/** 落盘后对实际新建的包目录和仓级挂载点执行确定性体检 */
export function lintExtractedPackage(
  repoRoot: string,
  graph: WorkspaceGraph,
  pkgDirRel: string,
): { passed: boolean; violations: string[] } {
  const violations: string[] = [];
  const pkgAbs = join(repoRoot, pkgDirRel);
  const manifestPath = join(pkgAbs, 'package.json');

  if (!existsSync(manifestPath)) {
    return { passed: false, violations: [`缺少 ${pkgDirRel}/package.json`] };
  }

  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
    string,
    unknown
  >;
  const pkgName = typeof manifest.name === 'string' ? manifest.name : '';

  if (manifest.private !== true) {
    violations.push(`${pkgDirRel}/package.json 必须默认标为 "private": true`);
  }
  if (manifest.bin !== undefined) {
    violations.push(`${pkgDirRel} 抽离的是共享库包, 不得声明 bin 字段`);
  }
  if (manifest.sideEffects !== false) {
    violations.push(`${pkgDirRel}/package.json 必须声明 "sideEffects": false`);
  }
  if (manifest.exports === undefined) {
    violations.push(`${pkgDirRel}/package.json 必须声明 exports 导出面`);
  }
  if (manifest.type !== 'module') {
    violations.push(`${pkgDirRel}/package.json 必须声明 "type": "module"`);
  }

  const scripts =
    manifest.scripts !== null &&
    typeof manifest.scripts === 'object' &&
    !Array.isArray(manifest.scripts)
      ? (manifest.scripts as Record<string, unknown>)
      : {};
  for (const requiredScript of ['build', 'typecheck', 'test']) {
    if (typeof scripts[requiredScript] !== 'string') {
      violations.push(
        `${pkgDirRel}/package.json 缺少 scripts.${requiredScript}`,
      );
    }
  }

  const srcAbs = join(pkgAbs, 'src');
  if (!existsSync(srcAbs)) {
    violations.push(`${pkgDirRel} 缺少 src/ 目录`);
  } else {
    const entries = readdirSync(srcAbs);
    const hasTest = entries.some((f) => f.endsWith('.test.ts'));
    if (!hasTest) {
      violations.push(
        `${pkgDirRel}/src/ 至少须包含 1 个独立单元测试 (*.test.ts)`,
      );
    }
    const domainTerms = deriveDomainLeakTerms(graph);
    for (const file of entries) {
      if (!file.endsWith('.ts') || file.endsWith('.test.ts')) continue;
      const text = readFileSync(join(srcAbs, file), 'utf8');
      const leaks = findMatchedTerms(text, domainTerms);
      if (leaks.length > 0) {
        violations.push(
          `${pkgDirRel}/src/${file} 仍残留原业务领域词 (${leaks.join(', ')})`,
        );
      }
    }
  }

  const readmePath = join(pkgAbs, 'README.md');
  if (!existsSync(readmePath)) {
    violations.push(`${pkgDirRel} 缺少社区化 README.md`);
  } else {
    const readmeText = readFileSync(readmePath, 'utf8');
    const leaks = findMatchedTerms(readmeText, deriveDomainLeakTerms(graph));
    if (leaks.length > 0) {
      violations.push(
        `${pkgDirRel}/README.md 仍残留原业务领域词 (${leaks.join(', ')})`,
      );
    }
  }

  const rootTsconfigPath = join(repoRoot, 'tsconfig.json');
  if (existsSync(rootTsconfigPath)) {
    const tsconfigText = readFileSync(rootTsconfigPath, 'utf8');
    if (pkgName !== '' && !tsconfigText.includes(`"${pkgName}"`)) {
      violations.push(`根 tsconfig.json paths 尚未登记 "${pkgName}"`);
    }
  }

  const tmPath = join(
    repoRoot,
    'packages/create-clis/scripts/template-manifest.ts',
  );
  if (existsSync(tmPath)) {
    const tmText = readFileSync(tmPath, 'utf8');
    const normalizedDir = pkgDirRel.endsWith('/') ? pkgDirRel : `${pkgDirRel}/`;
    if (!tmText.includes(normalizedDir) && !tmText.includes(pkgDirRel)) {
      violations.push(
        `packages/create-clis/scripts/template-manifest.ts 尚未登记 ${normalizedDir}`,
      );
    }
  }

  return { passed: violations.length === 0, violations };
}
