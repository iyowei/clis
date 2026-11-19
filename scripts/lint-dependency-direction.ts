/**
 * 依赖方向闸门: 强制执行 docs/designs/dependency-direction.md 约定的包间依赖有向无环图。
 *
 * 包分类 (确定性字段, 与 docs/designs/package-classification.md 同源):
 * - cli:         package.json 有 `bin` 字段
 * - public-lib:  无 `bin`, 且 `private !== true`
 * - private-lib: 无 `bin`, 且 `private === true`
 *
 * 规则 (dependencies 与 devDependencies 一视同仁):
 * 1. 禁止 public-lib → cli 与 private-lib → cli (库不得反向依赖工具)
 * 2. 禁止 cli → cli (工具之间不得互相依赖; 共享需求抽库)
 * 3. 禁止任何环依赖 (有向无环图)
 * 4. 禁止 public-lib → public-lib 链条深度 > 2 (即边数 > 2, 超过 3 个公开库串联)
 *
 * 用法: bun scripts/lint-dependency-direction.ts
 * 退出码: 0 全绿; 1 存在违规。
 */
import {
  type WorkspacePackage,
  listDeclaredDeps,
  listWorkspacePackages,
} from './lib/workspace.ts';
import { REPO_ROOT } from './lint-doc-shared.ts';

export type PackageKind = 'cli' | 'public-lib' | 'private-lib';

/** 确定性推导包分类 */
export function classifyPackage(pkg: WorkspacePackage): PackageKind {
  if (pkg.manifest.bin !== undefined) return 'cli';
  return pkg.manifest.private === true ? 'private-lib' : 'public-lib';
}

/** 校验工作区所有包的内部依赖方向与无环约束, 返回违规人话列表 */
export function checkDependencyDirection(root: string = REPO_ROOT): string[] {
  const packages = listWorkspacePackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const kinds = new Map(
    packages.map((pkg) => [pkg.name, classifyPackage(pkg)]),
  );
  const graph = new Map<string, string[]>();
  const violations: string[] = [];

  for (const pkg of packages) {
    const fromKind = kinds.get(pkg.name)!;
    const internalDeps = listDeclaredDeps(pkg).filter((dep) => byName.has(dep));
    graph.set(pkg.name, internalDeps);

    for (const dep of internalDeps) {
      if (dep === pkg.name) {
        violations.push(`${pkg.name} 存在自依赖`);
        continue;
      }
      const toKind = kinds.get(dep)!;
      if (fromKind === 'cli' && toKind === 'cli') {
        violations.push(
          `禁止 CLI ↔ CLI 依赖: ${pkg.name} (${pkg.dir}) → ${dep} (共享能力请抽为库包)`,
        );
      } else if (fromKind !== 'cli' && toKind === 'cli') {
        violations.push(
          `禁止库反向依赖 CLI: ${pkg.name} [${fromKind}] → ${dep} [cli]`,
        );
      }
    }
  }

  // 有向环检测 (三色 DFS: 0 未访问 / 1 栈中 / 2 已完成)
  const color = new Map<string, number>();
  const stack: string[] = [];
  const reportedCycles = new Set<string>();

  const dfs = (node: string): void => {
    color.set(node, 1);
    stack.push(node);
    for (const next of graph.get(node) ?? []) {
      const state = color.get(next) ?? 0;
      if (state === 1) {
        const idx = stack.indexOf(next);
        const cycle = [...stack.slice(idx), next].join(' → ');
        if (!reportedCycles.has(cycle)) {
          reportedCycles.add(cycle);
          violations.push(`禁止循环依赖: ${cycle}`);
        }
      } else if (state === 0) {
        dfs(next);
      }
    }
    stack.pop();
    color.set(node, 2);
  };

  for (const pkg of packages) {
    if ((color.get(pkg.name) ?? 0) === 0) dfs(pkg.name);
  }

  // public-lib → public-lib 深度检测 (最大允许深度 2, 即至多 2 条边)
  const checkPublicDepth = (node: string, chain: string[]): void => {
    if (chain.length - 1 > 2) {
      violations.push(
        `公开库依赖链超过最大深度 2: ${chain.join(' → ')} (请先提炼中间层)`,
      );
      return;
    }
    for (const next of graph.get(node) ?? []) {
      if (kinds.get(next) !== 'public-lib') continue;
      if (chain.includes(next)) continue;
      checkPublicDepth(next, [...chain, next]);
    }
  };

  for (const pkg of packages) {
    if (kinds.get(pkg.name) === 'public-lib') {
      checkPublicDepth(pkg.name, [pkg.name]);
    }
  }

  return violations;
}

function main(): void {
  const violations = checkDependencyDirection();
  if (violations.length === 0) {
    process.stdout.write('依赖方向闸门全绿 ✓\n');
    return;
  }
  process.stderr.write(`依赖方向闸门检出 ${violations.length} 项违规:\n`);
  for (const item of violations) process.stderr.write(`  ✗ ${item}\n`);
  process.exitCode = 1;
}

if (import.meta.main) main();
