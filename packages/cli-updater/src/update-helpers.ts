/**
 * `runSelfUpdate` 流程辅助函数: 来源文案、跨 PM 阴影警示、动态实查复核与升级后轻复核。
 */
import { existsSync, readFileSync } from 'node:fs';

import {
  type EphemeralRunner,
  type GlobalRootMap,
  type InstallOrigin,
  LIB_NODE_MODULES_HEURISTIC_REASON,
  type PackageManager,
  type ProjectPackageManager,
  detectInstallOriginFromPath,
  isWithinDir,
  joinForPath,
  safeRealpath,
} from './detect.ts';
import {
  type SpawnLike,
  probeGlobalRoots,
  resolveExecutableInPath,
} from './executor.ts';
import { type FetchVersionResult } from './registry.ts';
import { compareSemver } from './semver.ts';

/** 供 update-helpers 消费的最小包元数据结构 */
export interface PackageMetaRef {
  name: string;
  version: string;
  isPrivate?: boolean;
  rawPackageRoot: string;
  packageRoot: string;
}

/** 供 update-helpers 消费的输出通道 */
export interface UpdateIORef {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 供 resolveOrigin 使用的最小依赖集合 */
export interface OriginResolveDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  argvEntry?: string;
  pathExists?: (path: string) => boolean;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string | null;
  probeRoots?: () => GlobalRootMap;
  spawnFn?: SpawnLike;
}

/** 升级成功后的轻复核输入 */
export interface PostUpgradeCheckInput {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager;
  targetSpec: string;
  platform: NodeJS.Platform;
  env: NodeJS.ProcessEnv;
  readText?: (path: string) => string | null;
  isFile?: (path: string) => boolean;
  io: UpdateIORef;
}

/** 净化外部字符串中的控制字符 (防止远端或路径文本污染终端) */
export function sanitize(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 将纯数字开头的版本号格式化为 vX.Y.Z; 非数字 tag (如 latest) 保持原样 */
export function formatVersionLabel(spec: string): string {
  return /^\d/.test(spec) ? `v${spec}` : spec;
}

/** 安全读文本文件 (不存在或不可读返回 null) */
function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 生成临时运行器对应的最新版调用命令建议 */
export function ephemeralHintCommand(
  runner: EphemeralRunner,
  packageName: string,
): string {
  switch (runner) {
    case 'bunx':
      return `bunx ${packageName}@latest`;
    case 'npx':
      return `npx ${packageName}@latest`;
    case 'pnpm-dlx':
      return `pnpm dlx ${packageName}@latest`;
    case 'yarn-dlx':
      return `yarn dlx ${packageName}@latest`;
    case 'deno':
      return `deno run -A npm:${packageName}@latest`;
  }
}

/** 生成项目本地依赖对应的更新命令建议 */
export function localProjectHintCommand(
  pm: ProjectPackageManager,
  packageName: string,
): string {
  switch (pm) {
    case 'bun':
      return `bun add -D ${packageName}@latest`;
    case 'pnpm':
      return `pnpm add -D ${packageName}@latest`;
    case 'yarn':
      return `yarn add -D ${packageName}@latest`;
    case 'npm':
      return `npm install -D ${packageName}@latest`;
  }
}

/** 构造人读的安装来源描述 */
export function describeOrigin(origin: InstallOrigin): string {
  switch (origin.kind) {
    case 'global':
      return `${origin.pm} 全局安装 (${origin.reason})`;
    case 'ephemeral':
      return `${origin.runner} 临时运行 (${origin.reason})`;
    case 'source':
      return `本地源码开发态 (${origin.packageRoot})`;
    case 'local-project':
      return `项目本地依赖 (${origin.projectDir})`;
    case 'unknown':
      return `未知安装位置 (${origin.packageRoot})`;
  }
}

/** 当 --pm 跨安装器覆盖当前运行来源时, 输出醒目的双副本 PATH 阴影警示 */
export function warnCrossPmOverride(
  origin: InstallOrigin,
  targetPm: PackageManager,
  io: UpdateIORef,
): void {
  if (origin.kind === 'global' && origin.pm !== targetPm) {
    io.out(
      `注意: 当前命令实际由 ${origin.pm} 全局安装, 改用 ${targetPm} 安装会在磁盘产生双份副本, PATH 靠前的旧副本可能遮蔽新版本!`,
    );
    return;
  }
  if (origin.kind === 'source') {
    io.out(
      `注意: 当前运行在本地源码工作树 (${origin.packageRoot}), 通过 ${targetPm} 全局安装会产生独立全局副本, 请核对 PATH 优先级避免版本阴影!`,
    );
    return;
  }
  if (origin.kind === 'local-project') {
    io.out(
      `注意: 当前运行在项目本地依赖 (${origin.projectDir}), 通过 ${targetPm} 全局安装不会更新项目本地依赖, 且可能被本地副本遮蔽!`,
    );
  }
}

/**
 * 探测安装来源 (先快路径纯路径识别; 遇 unknown / local-project 或仅命中低置信度
 * `<prefix>/lib/node_modules` 启发式且位于 node_modules 内时触发动态实查兜底)。
 */
export function resolveOrigin(
  meta: PackageMetaRef,
  deps: OriginResolveDeps,
): InstallOrigin {
  const env = deps.env ?? process.env;
  const pathExists = deps.pathExists ?? existsSync;
  const platform = deps.platform ?? process.platform;
  const rawPaths: string[] = [meta.rawPackageRoot];
  const entryArg = deps.argvEntry ?? process.argv[1];
  if (typeof entryArg === 'string' && entryArg !== '') {
    rawPaths.push(entryArg);
  }

  const firstPass = detectInstallOriginFromPath({
    packageRoot: meta.packageRoot,
    rawPaths,
    env,
    pathExists,
  });

  const needsDynamicProbe =
    firstPass.kind === 'unknown' ||
    firstPass.kind === 'local-project' ||
    (firstPass.kind === 'global' &&
      firstPass.reason === LIB_NODE_MODULES_HEURISTIC_REASON);

  if (!needsDynamicProbe) return firstPass;

  if (
    meta.packageRoot
      .replaceAll('\\', '/')
      .toLowerCase()
      .includes('/node_modules/')
  ) {
    const globalRoots =
      deps.probeRoots !== undefined
        ? deps.probeRoots()
        : probeGlobalRoots(platform, env, deps.spawnFn, {
            homeDir: deps.homeDir,
            readText: deps.readText,
            pathExists,
            isFile: deps.isFile,
          });
    if (Object.keys(globalRoots).length > 0) {
      return detectInstallOriginFromPath({
        packageRoot: meta.packageRoot,
        rawPaths,
        env,
        pathExists,
        globalRoots,
      });
    }
  }
  return firstPass;
}

/** 升级 status === 0 后的轻复核: 检测原目录版本未变或 PATH 仍指向旧路径 */
export function verifyPostUpgrade(input: PostUpgradeCheckInput): void {
  const readText = input.readText ?? defaultReadText;
  const pkgText = readText(joinForPath(input.meta.packageRoot, 'package.json'));
  let unchangedAtOldRoot = false;

  if (pkgText !== null) {
    try {
      const parsed = JSON.parse(pkgText) as { version?: unknown };
      const afterVersion =
        typeof parsed.version === 'string' ? parsed.version : undefined;
      const expectedHigher =
        input.targetSpec !== 'latest' &&
        compareSemver(input.meta.version, input.targetSpec) === -1;
      if (
        expectedHigher &&
        afterVersion !== undefined &&
        afterVersion === input.meta.version
      ) {
        unchangedAtOldRoot = true;
        input.io.out(
          `提示: 原安装目录 (${input.meta.packageRoot}) 的版本仍为 ${formatVersionLabel(afterVersion)}, 新版本可能安装到了其他位置, 请运行 ${input.binName} --version 核查。`,
        );
      }
    } catch {
      // package.json 不可解析时不干扰成功结果
    }
  }

  const resolvedBin = resolveExecutableInPath(
    input.binName,
    input.platform,
    input.env,
    input.isFile,
  );
  if (resolvedBin === null) return;

  const resolvedReal = safeRealpath(resolvedBin.path);
  const oldGlobalPm =
    input.origin.kind === 'global' && input.origin.pm !== input.targetPm
      ? input.origin.pm
      : null;
  const isCrossGlobal = oldGlobalPm !== null;
  const pointsToOldRoot = isWithinDir(resolvedReal, input.meta.packageRoot);

  let pointsToOldPm = false;
  if (oldGlobalPm !== null) {
    const binOrigin = detectInstallOriginFromPath({
      packageRoot: resolvedReal,
      rawPaths: [resolvedBin.path],
      env: input.env,
      pathExists: () => false,
    });
    pointsToOldPm = binOrigin.kind === 'global' && binOrigin.pm === oldGlobalPm;
  }

  if (
    pointsToOldPm ||
    (pointsToOldRoot &&
      (isCrossGlobal || input.origin.kind === 'source' || unchangedAtOldRoot))
  ) {
    input.io.out(
      `提示: 当前 PATH 中的 ${input.binName} 仍指向旧路径 (${resolvedBin.path}), 可能遮蔽 ${input.targetPm} 新安装的版本, 请检查 PATH 优先级。`,
    );
  }
}

/** 处理非全局受管场景 (源码态 / 临时运行态 / 项目本地依赖) 且未指定 --pm 的安全指引 */
export async function handleNonGlobalOrigin(ctx: {
  meta: PackageMetaRef;
  origin: Extract<
    InstallOrigin,
    { kind: 'source' | 'ephemeral' | 'local-project' }
  >;
  hasExplicitRegistry: boolean;
  io: UpdateIORef;
  fetchVersion: (registry: string) => Promise<FetchVersionResult>;
  registry: string;
}): Promise<number> {
  const { meta, origin, hasExplicitRegistry, io, fetchVersion, registry } = ctx;
  io.out(`当前版本: ${meta.name}@${meta.version}`);
  io.out(`安装方式: ${describeOrigin(origin)}`);

  if (meta.isPrivate !== true || hasExplicitRegistry) {
    const remote = await fetchVersion(registry);
    if (remote.ok) {
      const cmp = compareSemver(meta.version, remote.version);
      let status: string;
      if (cmp === -1) {
        status = `发现新版本 ${remote.version} (源: ${remote.registry})`;
      } else if (cmp === null) {
        status = `远端版本为 ${remote.version} (无法按 SemVer 比较, 源: ${remote.registry})`;
      } else {
        status = `远端最新版为 ${remote.version} (源: ${remote.registry})`;
      }
      io.out(`版本检查: ${status}`);
    } else if (remote.code !== 'not-found') {
      io.out(`版本检查: 暂未获取远端版本 (${sanitize(remote.message)})`);
    }
  }

  if (origin.kind === 'source') {
    io.out('更新方式: 当前运行在本地源码工作树, 不通过包管理器覆盖。');
    io.out('  请在仓库根目录运行: git pull && bun install && bun run build');
    io.out(
      '  若要通过包管理器安装全局发布版, 可显式指定 --pm <bun|npm|pnpm|yarn|volta>',
    );
    return 0;
  }

  if (origin.kind === 'ephemeral') {
    io.out(`更新方式: 当前经 ${origin.runner} 临时运行, 无需原地升级。`);
    io.out(
      `  下次获取最新版请运行: ${ephemeralHintCommand(origin.runner, meta.name)}`,
    );
    io.out(
      '  若希望改为全局安装, 可运行带 --pm <bun|npm|pnpm|yarn|volta> 的 update 或直接全局安装',
    );
    return 0;
  }

  io.out(
    `更新方式: 当前作为项目本地依赖运行 (${origin.projectDir}), 为避免静默改写项目锁文件, 不自动覆盖。`,
  );
  io.out(
    `  请在项目目录执行: ${localProjectHintCommand(origin.suggestedPm, meta.name)}`,
  );
  return 0;
}
