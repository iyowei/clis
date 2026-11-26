/**
 * `runSelfUpdate` 流程辅助函数: 来源文案、跨 PM 阴影警示、动态实查复核与升级后轻复核 (中英双语)。
 */
import { existsSync, readFileSync } from 'node:fs';

import { type Locale, t } from '@iyowei/cli-i18n';

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
import { compareSemver } from './semver.ts';
import { type UpdateUi, createUpdateUi, sanitizeText } from './ui.ts';

export interface PackageMetaRef {
  name: string;
  version: string;
  isPrivate?: boolean;
  rawPackageRoot: string;
  packageRoot: string;
}

export interface UpdateIORef {
  out: (line: string) => void;
  err: (line: string) => void;
}

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
  ui?: UpdateUi;
  locale?: Locale;
}

export function sanitize(raw: string): string {
  return sanitizeText(raw);
}

export function formatVersionLabel(spec: string): string {
  return /^\d/.test(spec) ? `v${spec}` : spec;
}

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

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

const ORIGIN_REASON_EN: Readonly<Record<string, string>> = {
  '命中 Volta 全局工具安装目录': 'Volta global directory',
  '命中 Bun 全局安装目录 (~/.bun)': 'Bun global directory (~/.bun)',
  '命中 pnpm 全局安装目录': 'pnpm global directory',
  '命中 Yarn 全局安装目录': 'Yarn global directory',
  '命中 npm 全局安装目录': 'npm global directory',
  '命中标准 <prefix>/lib/node_modules 全局目录':
    'standard <prefix>/lib/node_modules',
  '位于环境变量 VOLTA_HOME 目录内': 'VOLTA_HOME directory',
  '位于环境变量 BUN_INSTALL 目录内': 'BUN_INSTALL directory',
  '位于环境变量 BUN_INSTALL_GLOBAL_DIR 目录内':
    'BUN_INSTALL_GLOBAL_DIR directory',
  '位于环境变量 PNPM_HOME 目录内': 'PNPM_HOME directory',
  '位于环境变量 NPM_CONFIG_PREFIX 目录内': 'NPM_CONFIG_PREFIX directory',
  '位于 npx 临时缓存目录 (_npx)': 'npx cache (_npx)',
  '位于 bunx 临时执行目录': 'bunx cache',
  '位于 pnpm dlx 临时缓存目录': 'pnpm dlx cache',
  '位于 yarn dlx 临时执行目录': 'yarn dlx cache',
  '位于 Deno npm 缓存目录 (/deno/npm/)': 'Deno npm cache (/deno/npm/)',
};

function translateOriginReason(reason: string): string {
  const mapped = ORIGIN_REASON_EN[reason];
  if (mapped !== undefined) return mapped;
  const probed = /^匹配\s+(\S+)\s+实查全局目录\s+\((.+)\)$/.exec(reason);
  if (probed !== null) return `probed ${probed[1]} global root (${probed[2]})`;
  return reason;
}

/** 构造人读的安装来源描述 */
export function describeOrigin(
  origin: InstallOrigin,
  locale: Locale = 'zh',
): string {
  if (locale === 'en') {
    switch (origin.kind) {
      case 'global':
        return `${origin.pm} global install (${translateOriginReason(origin.reason)})`;
      case 'standalone':
        return `standalone script install (${origin.packageRoot})`;
      case 'ephemeral':
        return `${origin.runner} temporary run (${translateOriginReason(origin.reason)})`;
      case 'source':
        return `local source checkout (${origin.packageRoot})`;
      case 'local-project':
        return `local project dependency (${origin.projectDir})`;
      case 'unknown':
        return `unrecognized location (${origin.packageRoot})`;
    }
  }
  switch (origin.kind) {
    case 'global':
      return `${origin.pm} 全局安装 (${origin.reason})`;
    case 'standalone':
      return `独立脚本安装 (${origin.packageRoot})`;
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
  ui: UpdateUi = createUpdateUi({ stdout: false, stderr: false }),
  locale: Locale = 'zh',
): void {
  if (origin.kind === 'global' && origin.pm !== targetPm) {
    io.out(
      ui.warn(
        t(
          locale,
          `注意: 当前命令实际由 ${origin.pm} 全局安装, 改用 ${targetPm} 安装会在磁盘产生双份副本, PATH 靠前的旧副本可能遮蔽新版本!`,
          `Note: Currently installed globally via ${origin.pm}; installing via ${targetPm} creates a second copy that may be shadowed in PATH.`,
        ),
      ),
    );
    return;
  }
  if (origin.kind === 'standalone') {
    io.out(
      ui.warn(
        t(
          locale,
          `注意: 当前运行在独立脚本安装目录 (${sanitize(origin.packageRoot)}), 通过 ${targetPm} 全局安装会产生独立全局副本, 请核对 PATH 优先级避免版本阴影!`,
          `Note: Currently installed via standalone script (${sanitize(origin.packageRoot)}); installing globally via ${targetPm} creates a separate global copy.`,
        ),
      ),
    );
    return;
  }
  if (origin.kind === 'source') {
    io.out(
      ui.warn(
        t(
          locale,
          `注意: 当前运行在本地源码工作树 (${sanitize(origin.packageRoot)}), 通过 ${targetPm} 全局安装会产生独立全局副本, 请核对 PATH 优先级避免版本阴影!`,
          `Note: Running from local source (${sanitize(origin.packageRoot)}); installing globally via ${targetPm} creates a separate global copy.`,
        ),
      ),
    );
    return;
  }
  if (origin.kind === 'local-project') {
    io.out(
      ui.warn(
        t(
          locale,
          `注意: 当前运行在项目本地依赖 (${sanitize(origin.projectDir)}), 通过 ${targetPm} 全局安装不会更新项目本地依赖, 且可能被本地副本遮蔽!`,
          `Note: Running from local project dependency (${sanitize(origin.projectDir)}); a global install via ${targetPm} will not update the project dependency.`,
        ),
      ),
    );
  }
}

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
    readText: deps.readText,
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

export function verifyPostUpgrade(input: PostUpgradeCheckInput): void {
  const locale = input.locale ?? 'zh';
  const ui =
    input.ui ?? createUpdateUi({ stdout: false, stderr: false }, locale);
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
          ui.warn(
            t(
              locale,
              `提示: 原安装目录 (${sanitize(input.meta.packageRoot)}) 的版本仍为 ${formatVersionLabel(sanitize(afterVersion))}, 新版本可能安装到了其他位置, 请运行 ${sanitize(input.binName)} --version 核查。`,
              `Note: Version in ${sanitize(input.meta.packageRoot)} is still ${formatVersionLabel(sanitize(afterVersion))}; verify active binary with '${sanitize(input.binName)} --version'.`,
            ),
          ),
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
      ui.warn(
        t(
          locale,
          `提示: 当前 PATH 中的 ${sanitize(input.binName)} 仍指向旧路径 (${sanitize(resolvedBin.path)}), 可能遮蔽 ${input.targetPm} 新安装的版本, 请检查 PATH 优先级。`,
          `Note: '${sanitize(input.binName)}' in PATH still resolves to ${sanitize(resolvedBin.path)}, which may shadow the ${input.targetPm} install.`,
        ),
      ),
    );
  }
}
