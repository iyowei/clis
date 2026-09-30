/**
 * 工作区坐标派生 (单一事实来源: 根 package.json 的 workspaces)。
 *
 * 派生规则 (与「依赖方向纪律」同构): **CLI 包** = 带 `bin` 字段的包; **API 包** = CLI 包的
 * devDependencies 引用的那个仓内包 (工具 → 库 单向唯一确定)。包目录改名或包名变更时, 依赖
 * 本模块的脚本 (ci.ts / make-mutants.ts) 零修改。
 *
 * 已知的单点同步 (无法运行时派生): `tsconfig.json` 的 paths 是静态配置, 改包名时需在此一处
 * 手动同步 (见 docs/designs/collection-relocation.md 的重建清单)。
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

/** 读根 package.json 的 workspaces 并展开为包清单 (支持 'dir/*' 形态; 其它形态显式报错) */
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
    for (const entry of readdirSync(join(root, parent), {
      withFileTypes: true,
    })) {
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
  return packages;
}

/** 派生两包坐标: CLI 包 (带 bin) 与 API 包 (被 CLI 包 devDependencies 引用的仓内包) */
export function resolveCliAndApi(root: string): {
  cli: WorkspacePackage;
  api: WorkspacePackage;
} {
  const packages = listWorkspacePackages(root);
  const cli = packages.find((pkg) => pkg.manifest.bin !== undefined);
  if (cli === undefined) {
    throw new Error('未找到带 bin 的 CLI 包 (workspaces 内)');
  }
  const devDeps = (cli.manifest.devDependencies ?? {}) as Record<
    string,
    unknown
  >;
  const api = packages.find(
    (pkg) => pkg.name !== cli.name && pkg.name in devDeps,
  );
  if (api === undefined) {
    throw new Error(`未找到 CLI 包 (${cli.name}) 所依赖的仓内 API 包`);
  }
  return { cli, api };
}
