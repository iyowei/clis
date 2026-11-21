/**
 * 工作区拓扑解析器、传递产品域反查与依赖方向模拟器。
 *
 * 关键规则:
 * - 从根 package.json workspaces 确定性发现包并推导分类 (cli / public-lib / private-lib);
 * - 优先按 CLI -> API 绑定归并双包产品域 (无论 API 包是否已首发或标 private: true);
 * - 提供传递可达业务产品域计算 (computeTransitiveConsumerDomains), 用于识别退化共享库与防止中间库误回收;
 * - 提供假想新包加入后的依赖方向 / 环依赖 / public-lib 链深 (<= 2) 确定性预检。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import type {
  PackageKind,
  PackageLayer,
  WorkspaceEdge,
  WorkspaceGraph,
  WorkspacePackageNode,
} from './types.ts';

interface RawPackage {
  name: string;
  dir: string;
  manifest: Record<string, unknown>;
}

function readDeps(manifest: Record<string, unknown>): { all: string[] } {
  const names = new Set<string>();
  for (const field of ['dependencies', 'devDependencies'] as const) {
    const bag = manifest[field];
    if (bag !== null && typeof bag === 'object' && !Array.isArray(bag)) {
      for (const key of Object.keys(bag as Record<string, unknown>)) {
        names.add(key);
      }
    }
  }
  return { all: [...names].sort() };
}

/** 确定性推导包分类 (与 docs/designs/package-classification.md 同源) */
export function classifyPackageKind(
  manifest: Record<string, unknown>,
): PackageKind {
  if (manifest.bin !== undefined) return 'cli';
  return manifest.private === true ? 'private-lib' : 'public-lib';
}

function listRawPackages(repoRoot: string): RawPackage[] {
  const rootPkgPath = join(repoRoot, 'package.json');
  if (!existsSync(rootPkgPath)) {
    throw new Error(`未找到根 package.json: ${rootPkgPath}`);
  }
  const rootManifest = JSON.parse(readFileSync(rootPkgPath, 'utf8')) as {
    workspaces?: unknown;
  };
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : [];
  const packages: RawPackage[] = [];

  for (const pattern of patterns) {
    if (typeof pattern !== 'string') continue;
    const match = pattern.match(/^([^/*]+)\/\*$/);
    if (match === null) continue;
    const parent = match[1]!;
    const parentAbs = join(repoRoot, parent);
    if (!existsSync(parentAbs)) continue;

    const entries = readdirSync(parentAbs, { withFileTypes: true }).sort(
      (a, b) => a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const manifestPath = join(repoRoot, dir, 'package.json');
      if (!existsSync(manifestPath)) continue;
      const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as Record<
        string,
        unknown
      >;
      if (typeof manifest.name !== 'string') continue;
      packages.push({ name: manifest.name, dir, manifest });
    }
  }

  return packages.sort((a, b) => a.dir.localeCompare(b.dir));
}

/** 检查依赖图是否满足无环、方向单向与 public-lib 链深 <= 2 */
export function validateDependencyGraph(
  nodes: ReadonlyMap<string, PackageKind>,
  adj: ReadonlyMap<string, readonly string[]>,
): string[] {
  const violations: string[] = [];

  for (const [from, deps] of adj.entries()) {
    const fromKind = nodes.get(from);
    if (fromKind === undefined) continue;
    for (const to of deps) {
      if (from === to) {
        violations.push(`${from} 存在自依赖`);
        continue;
      }
      const toKind = nodes.get(to);
      if (toKind === undefined) continue;
      if (fromKind === 'cli' && toKind === 'cli') {
        violations.push(`禁止 CLI ↔ CLI 依赖: ${from} → ${to}`);
      } else if (fromKind !== 'cli' && toKind === 'cli') {
        violations.push(`禁止库反向依赖 CLI: ${from} [${fromKind}] → ${to}`);
      }
    }
  }

  const color = new Map<string, number>();
  const stack: string[] = [];
  const seenCycles = new Set<string>();

  const dfs = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of adj.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const idx = stack.indexOf(next);
        const cycle = [...stack.slice(idx), next].join(' → ');
        if (!seenCycles.has(cycle)) {
          seenCycles.add(cycle);
          violations.push(`禁止循环依赖: ${cycle}`);
        }
      } else if (state === 0) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const name of nodes.keys()) {
    if ((color.get(name) ?? 0) === 0) dfs(name);
  }

  const checkDepth = (node: string, chain: string[]): void => {
    if (chain.length - 1 > 2) {
      violations.push(`公开库依赖链深度超过 2: ${chain.join(' → ')}`);
      return;
    }
    for (const next of adj.get(node) ?? []) {
      if (nodes.get(next) !== 'public-lib') continue;
      if (chain.includes(next)) continue;
      checkDepth(next, [...chain, next]);
    }
  };

  for (const [name, kind] of nodes.entries()) {
    if (kind === 'public-lib') checkDepth(name, [name]);
  }

  return violations;
}

/** 构造完整工作区拓扑与双包独立产品域 */
export function buildWorkspaceGraph(repoRoot: string): WorkspaceGraph {
  const raws = listRawPackages(repoRoot);
  const byName = new Map(raws.map((p) => [p.name, p]));
  const kinds = new Map<string, PackageKind>();
  const adj = new Map<string, string[]>();
  const cliInDegree = new Map<string, number>();

  for (const raw of raws) {
    kinds.set(raw.name, classifyPackageKind(raw.manifest));
    const internal = readDeps(raw.manifest).all.filter((d) => byName.has(d));
    adj.set(raw.name, internal);
    if (kinds.get(raw.name) === 'cli') {
      for (const dep of internal) {
        if (kinds.get(dep) !== 'cli') {
          cliInDegree.set(dep, (cliInDegree.get(dep) ?? 0) + 1);
        }
      }
    }
  }

  // 判断是否为共享库: 显式声明 clisRole === 'shared-lib' 或被多个 CLI 依赖且无对称双包命名
  const hasSymmetricCli = (apiRaw: RawPackage): boolean =>
    raws.some(
      (cli) =>
        kinds.get(cli.name) === 'cli' &&
        (cli.name === `${apiRaw.name}-cli` || cli.dir === `${apiRaw.dir}-cli`),
    );

  const isSharedLib = (raw: RawPackage): boolean => {
    if (raw.manifest.clisRole === 'shared-lib') return true;
    const kind = kinds.get(raw.name);
    if (kind === 'cli') return false;
    if (hasSymmetricCli(raw)) return false;
    return (
      raw.manifest.private === true || (cliInDegree.get(raw.name) ?? 0) > 1
    );
  };

  const domainMap = new Map<string, string>();
  const layerMap = new Map<string, PackageLayer>();

  for (const raw of raws) {
    const kind = kinds.get(raw.name)!;
    if (kind !== 'cli') continue;
    const deps = adj.get(raw.name) ?? [];
    const apiCandidates = deps
      .map((d) => byName.get(d))
      .filter((t): t is RawPackage => t !== undefined && !isSharedLib(t));

    if (apiCandidates.length === 0) {
      layerMap.set(raw.name, 'cli');
      domainMap.set(raw.name, `domain:${raw.dir}`);
      continue;
    }

    const symmetric = apiCandidates.find(
      (t) => raw.name === `${t.name}-cli` || raw.dir === `${t.dir}-cli`,
    );
    const primaryApi = symmetric ?? apiCandidates[0]!;
    const domainId = `domain:${primaryApi.dir}`;
    domainMap.set(raw.name, domainId);
    domainMap.set(primaryApi.name, domainId);
    layerMap.set(raw.name, 'cli');
    layerMap.set(primaryApi.name, 'api');
  }

  for (const raw of raws) {
    if (!domainMap.has(raw.name)) {
      domainMap.set(raw.name, `domain:${raw.dir}`);
    }
    if (!layerMap.has(raw.name)) {
      if (kinds.get(raw.name) === 'cli') {
        layerMap.set(raw.name, 'cli');
      } else if (isSharedLib(raw)) {
        layerMap.set(raw.name, 'shared-lib');
      } else {
        layerMap.set(raw.name, 'api');
      }
    }
  }

  const packages: WorkspacePackageNode[] = [];
  const edges: WorkspaceEdge[] = [];
  const layerDomains: Record<PackageLayer, Set<string>> = {
    cli: new Set(),
    api: new Set(),
    'shared-lib': new Set(),
  };

  for (const raw of raws) {
    const allDeps = readDeps(raw.manifest).all;
    const internalDeps = allDeps.filter((d) => byName.has(d));
    const externalDeps = allDeps.filter((d) => !byName.has(d));
    const kind = kinds.get(raw.name)!;
    const layer = layerMap.get(raw.name)!;
    const domainId = domainMap.get(raw.name)!;

    layerDomains[layer].add(domainId);
    for (const dep of internalDeps) edges.push({ from: raw.name, to: dep });

    packages.push({
      name: raw.name,
      dir: raw.dir,
      language: 'ts-bun',
      kind,
      layer,
      domainId,
      isPrivate: raw.manifest.private === true,
      hasBin: raw.manifest.bin !== undefined,
      internalDeps,
      externalDeps,
    });
  }

  return {
    repoRoot,
    packages,
    edges,
    layerDomainCounts: {
      cli: layerDomains.cli.size,
      api: layerDomains.api.size,
      'shared-lib': layerDomains['shared-lib'].size,
    },
    existingViolations: validateDependencyGraph(kinds, adj),
  };
}

/** 沿着反向依赖边反查某个库最终支撑了多少个独立业务产品域 (CLI / API) */
export function computeTransitiveConsumerDomains(
  graph: WorkspaceGraph,
  targetPkgName: string,
): {
  directConsumers: string[];
  transitiveBusinessConsumers: string[];
  transitiveConsumerDomains: string[];
} {
  const pkgByName = new Map(graph.packages.map((p) => [p.name, p]));
  const revAdj = new Map<string, string[]>();
  for (const edge of graph.edges) {
    const list = revAdj.get(edge.to) ?? [];
    list.push(edge.from);
    revAdj.set(edge.to, list);
  }

  const directConsumers = [...(revAdj.get(targetPkgName) ?? [])].sort();
  const visited = new Set<string>([targetPkgName]);
  const queue: string[] = [...directConsumers];
  const businessConsumers = new Set<string>();
  const consumerDomains = new Set<string>();

  while (queue.length > 0) {
    const cur = queue.shift()!;
    if (visited.has(cur)) continue;
    visited.add(cur);

    const node = pkgByName.get(cur);
    if (node !== undefined && (node.layer === 'cli' || node.layer === 'api')) {
      businessConsumers.add(node.name);
      consumerDomains.add(node.domainId);
    }
    for (const parent of revAdj.get(cur) ?? []) {
      if (!visited.has(parent)) queue.push(parent);
    }
  }

  return {
    directConsumers,
    transitiveBusinessConsumers: [...businessConsumers].sort(),
    transitiveConsumerDomains: [...consumerDomains].sort(),
  };
}

/** 模拟加入新抽取的库包后, 验证是否打破依赖方向或超深上限 */
export function simulateNewLibraryExtraction(
  graph: WorkspaceGraph,
  newPkgName: string,
  newPkgKind: 'private-lib' | 'public-lib',
  consumers: readonly string[],
  newPkgInternalDeps: readonly string[],
): string[] {
  const kinds = new Map<string, PackageKind>();
  const adj = new Map<string, string[]>();
  const consumerSet = new Set(consumers);

  for (const pkg of graph.packages) {
    kinds.set(pkg.name, pkg.kind);
    const deps = [...pkg.internalDeps];
    if (consumerSet.has(pkg.name) && !deps.includes(newPkgName)) {
      deps.push(newPkgName);
    }
    adj.set(pkg.name, deps);
  }

  kinds.set(newPkgName, newPkgKind);
  adj.set(newPkgName, [...newPkgInternalDeps]);

  return validateDependencyGraph(kinds, adj);
}
