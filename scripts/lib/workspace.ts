/**
 * 工作区坐标派生 (单一事实来源: 根 package.json 的 workspaces)。
 *
 * 派生规则 (与「依赖方向纪律」同构):
 * - **双包产品对 (ProductPair)**: 带 `bin` 的 CLI 包, 其 dependencies 或 devDependencies
 *   引用某个仓内无 `bin` 包 (API 包), 按依赖关系单向锚定。
 * - `listWorkspacePackages` 按目录字典序稳定输出, 消除跨 OS readdir 顺序差异。
 * - 当仓内同时存在多个双包产品 (如 sweep 与 codd) 时, 调用方应使用 `resolveProductPairs`
 *   或为 `resolveCliAndApi` 传入明确的产品包名/目录提示, 不靠数组首项碰运气。
 *
 * 已知的单点同步 (无法运行时派生): `tsconfig.json` 的 paths 是静态配置, 新增 API 包或
 * 改包名时需在此一处手动同步。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

/** 工作区内的一个包 */
export interface WorkspacePackage {
  /** 包名 (如 @scope/name) */
  name: string;
  /** 仓库相对目录 (如 packages/name) */
  dir: string;
  /** 解析后的 package.json (供需要字段的调用方复用) */
  manifest: Record<string, unknown>;
}

/** 一组双包产品: CLI 薄壳包 + 所依赖的仓内 API 包 */
export interface ProductPair {
  cli: WorkspacePackage;
  api: WorkspacePackage;
}

/** 提取包清单里的全部依赖名 (dependencies + devDependencies) */
export function listDeclaredDeps(pkg: WorkspacePackage): string[] {
  const deps = pkg.manifest.dependencies;
  const devDeps = pkg.manifest.devDependencies;
  const names = new Set<string>();
  if (deps !== null && typeof deps === 'object' && !Array.isArray(deps)) {
    for (const key of Object.keys(deps as Record<string, unknown>)) {
      names.add(key);
    }
  }
  if (
    devDeps !== null &&
    typeof devDeps === 'object' &&
    !Array.isArray(devDeps)
  ) {
    for (const key of Object.keys(devDeps as Record<string, unknown>)) {
      names.add(key);
    }
  }
  return [...names].sort();
}

/** 读根 package.json 的 workspaces 并展开为包清单 (按目录字典序稳定输出) */
export function listWorkspacePackages(root: string): WorkspacePackage[] {
  const rootManifest = JSON.parse(
    readFileSync(join(root, 'package.json'), 'utf8'),
  ) as { workspaces?: unknown };
  const patterns = Array.isArray(rootManifest.workspaces)
    ? rootManifest.workspaces
    : [];
  const packages: WorkspacePackage[] = [];
  for (const pattern of patterns) {
    const match =
      typeof pattern === 'string' ? pattern.match(/^([^/*]+)\/\*$/) : null;
    if (match === null) {
      throw new Error(
        `workspaces 形态暂不支持派生: ${String(pattern)} (需形如 packages/*)`,
      );
    }
    const parent = match[1]!;
    const entries = readdirSync(join(root, parent), {
      withFileTypes: true,
    }).sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const dir = `${parent}/${entry.name}`;
      const manifestPath = join(root, dir, 'package.json');
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

/**
 * 派生仓内全部「CLI → API」双包产品对 (稳定排序)。
 * 判据: CLI 包带 `bin`, 且在 dependencies 或 devDependencies 中引用某个仓内无 `bin` 包。
 */
export function resolveProductPairs(root: string): ProductPair[] {
  const packages = listWorkspacePackages(root);
  const byName = new Map(packages.map((pkg) => [pkg.name, pkg]));
  const pairs: ProductPair[] = [];
  for (const pkg of packages) {
    if (pkg.manifest.bin === undefined) continue;
    for (const depName of listDeclaredDeps(pkg)) {
      const target = byName.get(depName);
      if (
        target !== undefined &&
        target !== pkg &&
        target.manifest.bin === undefined
      ) {
        pairs.push({ cli: pkg, api: target });
        break;
      }
    }
  }
  return pairs;
}

/**
 * 派生指定 (或唯一) 产品的 CLI + API 两包。
 * - 未传 productHint 且仓内仅有一对时, 直接返回该唯一对 (兼容单产品模板仓);
 * - 仓内存在多对双包产品时, 必须通过 productHint (CLI 或 API 的包名或相对目录) 显式指定,
 *   防跨 OS 目录序或静默命中错误产品。
 */
export function resolveCliAndApi(
  root: string,
  productHint?: string,
): ProductPair {
  const pairs = resolveProductPairs(root);
  if (pairs.length === 0) {
    throw new Error('未找到主 CLI 包 (带 bin 且依赖仓内无 bin 包)');
  }
  if (productHint !== undefined) {
    const matched = pairs.find(
      ({ cli, api }) =>
        cli.name === productHint ||
        api.name === productHint ||
        cli.dir === productHint ||
        api.dir === productHint,
    );
    if (matched === undefined) {
      const available = pairs
        .map(({ cli, api }) => `${cli.name} → ${api.name}`)
        .join(', ');
      throw new Error(
        `未找到匹配 ${productHint} 的双包产品 (现有: ${available})`,
      );
    }
    return matched;
  }
  if (pairs.length > 1) {
    const available = pairs
      .map(({ cli, api }) => `${cli.name} → ${api.name}`)
      .join(', ');
    throw new Error(
      `仓内存在 ${pairs.length} 组双包产品 (${available}), 请传入 productHint 显式指定`,
    );
  }
  return pairs[0]!;
}
