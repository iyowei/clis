/**
 * 工作区坐标派生 (单一事实来源: 根 package.json 的 workspaces)。
 *
 * 派生规则 (与「依赖方向纪律」同构): **CLI 包** = 带 `bin` 且其 devDependencies 引用某个无
 * `bin` 仓内包的包; **API 包** = 被它引用的那个无 `bin` 包 (工具 → 库 单向唯一确定)。仓内可有
 * 多个带 `bin` 的工具包 (如生成器包), 主产品线以依赖关系锚定; 包目录改名或包名变更时, 依赖
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

/**
 * 派生主产品两包: 带 bin 且依赖某个无 bin 仓内包的, 是主 CLI 包; 被它引用的无 bin 包是 API 包。
 * (判据依据: 「依赖方向纪律」工具 → 库单向; 仓内可有多个带 bin 的工具包, 主产品线以依赖关系锚定。)
 */
export function resolveCliAndApi(root: string): {
  cli: WorkspacePackage;
  api: WorkspacePackage;
} {
  const packages = listWorkspacePackages(root);
  const cli = packages.find((pkg) => {
    if (pkg.manifest.bin === undefined) return false;
    const devDeps = (pkg.manifest.devDependencies ?? {}) as Record<
      string,
      unknown
    >;
    return packages.some(
      (other) =>
        other !== pkg &&
        other.manifest.bin === undefined &&
        other.name in devDeps,
    );
  });
  if (cli === undefined) {
    throw new Error('未找到主 CLI 包 (带 bin 且依赖仓内无 bin 包)');
  }
  const devDeps = (cli.manifest.devDependencies ?? {}) as Record<
    string,
    unknown
  >;
  const api = packages.find(
    (pkg) =>
      pkg.name !== cli.name &&
      pkg.manifest.bin === undefined &&
      pkg.name in devDeps,
  );
  if (api === undefined) {
    throw new Error(`未找到 CLI 包 (${cli.name}) 所依赖的仓内 API 包`);
  }
  return { cli, api };
}
