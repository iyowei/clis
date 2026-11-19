/**
 * CLI 自更新主流程编排: 读包元数据 → 探测安装来源 → 查远端最新版 → 构造并隔离执行对应包管理器更新。
 *
 * 所有外部副作用 (fetch / spawn / fs / stdout / stderr / env / platform) 均可注入,
 * 保证全状态机分支 (全局 5 管理器 / 临时运行 / 源码开发态 / 本地项目依赖 / 未知路径 /
 * 已是最新 / 有更新 / --check / --pm 覆盖 / --force / 404 未发布 / 断网 / Yarn Berry / Windows EBUSY 提示)
 * 均可无副作用确定性测试。
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type UpdateOptions,
  formatUpdateHelp,
  parseUpdateArgs,
} from './args.ts';
import {
  type EphemeralRunner,
  type GlobalRootMap,
  type InstallOrigin,
  type PackageManager,
  detectInstallOriginFromPath,
  safeRealpath,
} from './detect.ts';
import {
  type SpawnLike,
  buildUpgradePlan,
  executeUpgradePlan,
  formatUpgradeDisplayCommand,
  probeGlobalRoots,
  probeYarnVersion,
} from './executor.ts';
import {
  type FetchVersionResult,
  fetchLatestVersion,
  resolveRegistry,
} from './registry.ts';
import { isNewerVersion } from './semver.ts';

/** 当前 CLI 包的基本元数据 */
export interface PackageMeta {
  name: string;
  version: string;
  isPrivate: boolean;
  /** 未解软链的包根目录 */
  rawPackageRoot: string;
  /** 解析软链后的真实包根目录 */
  packageRoot: string;
}

/** 自更新输出通道 */
export interface UpdateIO {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** runSelfUpdate 入口选项 */
export interface SelfUpdateRunOptions {
  /** 命令展示名 (如 sweep-nm / codd / create-clis) */
  binName: string;
  /** CLI 入口模块的 import.meta.url (用于定位相邻 package.json 与包目录) */
  entryMetaUrl?: string;
  /** 若调用方已读好包元数据可直接传入 (测试或自定义布局) */
  meta?: PackageMeta;
  /** `update` 子命令之后的参数数组 */
  argv: readonly string[];
  /** 可选覆盖输出流 (默认 stdout / stderr) */
  io?: UpdateIO;
  /** 可选注入项 (供单元测试隔离系统环境) */
  deps?: {
    platform?: NodeJS.Platform;
    env?: NodeJS.ProcessEnv;
    homeDir?: string;
    argvEntry?: string;
    pathExists?: (path: string) => boolean;
    isFile?: (path: string) => boolean;
    readText?: (path: string) => string | null;
    fetchLatest?: (
      packageName: string,
      registry: string,
    ) => Promise<FetchVersionResult>;
    probeRoots?: () => GlobalRootMap;
    probeYarn?: () => string | null;
    execPlan?: typeof executeUpgradePlan;
    spawnFn?: SpawnLike;
  };
}

/** 净化外部字符串中的控制字符 (防止远端或路径文本污染终端) */
function sanitize(raw: string): string {
  return raw
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 从 CLI 入口模块 URL 向上定位包根目录并读取 package.json 元数据 */
export function readPackageMeta(entryMetaUrl: string): PackageMeta {
  const entryPath = fileURLToPath(entryMetaUrl);
  // 源码态 src/cli.ts 与打包态 dist/cli.js 均位于包根下一级目录
  const rawPackageRoot = dirname(dirname(entryPath));
  const packageRoot = safeRealpath(rawPackageRoot);
  const pkgPath = join(packageRoot, 'package.json');
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    name?: unknown;
    version?: unknown;
    private?: unknown;
  };
  if (typeof parsed.name !== 'string' || parsed.name === '') {
    throw new Error(`无法从 ${pkgPath} 读取合法包名`);
  }
  const version =
    typeof parsed.version === 'string' && parsed.version !== ''
      ? parsed.version
      : '0.0.0';
  return {
    name: parsed.name,
    version,
    isPrivate: parsed.private === true,
    rawPackageRoot,
    packageRoot,
  };
}

/** 生成临时运行器对应的最新版调用命令建议 */
function ephemeralHintCommand(
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
  }
}

/** 生成项目本地依赖对应的更新命令建议 */
function localProjectHintCommand(
  pm: 'bun' | 'pnpm' | 'yarn' | 'npm',
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
function describeOrigin(origin: InstallOrigin): string {
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

/** 探测安装来源 (先快路径纯路径识别, 仅 unknown 且位于 node_modules 内时触发动态实查兜底) */
function resolveOrigin(
  meta: PackageMeta,
  deps: NonNullable<SelfUpdateRunOptions['deps']>,
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
  if (firstPass.kind !== 'unknown' && firstPass.kind !== 'local-project') {
    return firstPass;
  }

  // 自定义 prefix / global-dir 兜底实查 (例如 pnpm/yarn 自定义全局目录内也含 package.json)
  if (
    meta.packageRoot
      .replaceAll('\\', '/')
      .toLowerCase()
      .includes('/node_modules/')
  ) {
    const globalRoots =
      deps.probeRoots !== undefined
        ? deps.probeRoots()
        : probeGlobalRoots(platform, env, deps.spawnFn);
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

/** 处理非全局受管场景 (源码态 / 临时运行态 / 项目本地依赖) 且未指定 --pm 的安全指引 */
async function handleNonGlobalOrigin(
  meta: PackageMeta,
  origin: Extract<
    InstallOrigin,
    { kind: 'source' | 'ephemeral' | 'local-project' }
  >,
  opts: UpdateOptions,
  io: UpdateIO,
  fetchVersion: (registry: string) => Promise<FetchVersionResult>,
  registry: string,
): Promise<number> {
  io.out(`当前版本: ${meta.name}@${meta.version}`);
  io.out(`安装方式: ${describeOrigin(origin)}`);

  // 尽量查一次远端最新版本供参考 (未发布私有包在源码态不做冗余报错)
  if (!meta.isPrivate || opts.registry !== undefined) {
    const remote = await fetchVersion(registry);
    if (remote.ok) {
      const status = isNewerVersion(meta.version, remote.version)
        ? `发现新版本 ${remote.version} (源: ${remote.registry})`
        : `远端最新版为 ${remote.version} (源: ${remote.registry})`;
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

/** 在确认存在目标包管理器且需更新后, 构造并执行升级计划 */
function performUpgrade(
  meta: PackageMeta,
  targetPm: PackageManager,
  latestVersion: string,
  opts: UpdateOptions,
  io: UpdateIO,
  deps: NonNullable<SelfUpdateRunOptions['deps']>,
): number {
  const platform = deps.platform ?? process.platform;
  const env = deps.env ?? process.env;
  let yarnVersion: string | null = null;
  if (targetPm === 'yarn') {
    yarnVersion =
      deps.probeYarn !== undefined
        ? deps.probeYarn()
        : probeYarnVersion(platform, env, deps.spawnFn);
  }

  const built = buildUpgradePlan({
    pm: targetPm,
    packageName: meta.name,
    targetSpec: latestVersion,
    explicitRegistry: opts.registry,
    platform,
    env,
    isFile: deps.isFile,
    yarnVersion,
  });

  if (!built.ok) {
    io.err(`无法自动更新: ${built.reason}`);
    if (built.fallbackCommand !== undefined) {
      io.err(`  手动更新命令: ${built.fallbackCommand}`);
    }
    return 1;
  }

  io.out(`即将执行: ${built.plan.displayCommand}`);
  const exec = deps.execPlan ?? executeUpgradePlan;
  const result = exec(built.plan, env, deps.spawnFn);

  if (result.error !== undefined) {
    io.err(`更新命令启动失败: ${sanitize(result.error.message)}`);
    io.err(`  手动更新命令: ${built.plan.displayCommand}`);
    return 1;
  }
  if (result.status !== 0) {
    io.err(`更新失败 (${targetPm} 退出码 ${String(result.status ?? 1)})`);
    if (platform === 'win32') {
      io.err(
        '  Windows 提示: 若报错含 EBUSY / EPERM, 请关闭其他占用该命令的终端后直接执行下方命令:',
      );
    }
    io.err(`  手动更新命令: ${built.plan.displayCommand}`);
    return 1;
  }

  io.out(`已通过 ${targetPm} 更新 ${meta.name} 至 v${latestVersion} ✓`);
  return 0;
}

/**
 * 统一 CLI 自更新入口 (返回进程退出码: 0 成功 / 已最新 / 仅检查; 1 失败 / 未发布 / 无法确定安装器)。
 */
export async function runSelfUpdate(
  options: SelfUpdateRunOptions,
): Promise<number> {
  const io: UpdateIO = options.io ?? {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  const deps = options.deps ?? {};

  const parsed = parseUpdateArgs(options.argv);
  if (!parsed.ok) {
    io.err(`参数错误: ${parsed.message}`);
    return 1;
  }
  const opts = parsed.options;

  let meta: PackageMeta;
  try {
    if (options.meta !== undefined) {
      meta = options.meta;
    } else if (options.entryMetaUrl !== undefined) {
      meta = readPackageMeta(options.entryMetaUrl);
    } else {
      throw new Error('缺少 entryMetaUrl 或 meta, 无法定位当前包信息');
    }
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    io.err(`读取当前包信息失败: ${sanitize(msg)}`);
    return 1;
  }

  if (opts.help) {
    io.out(formatUpdateHelp(options.binName, meta.name));
    return 0;
  }

  const origin = resolveOrigin(meta, deps);
  const detectedPm: PackageManager | undefined =
    origin.kind === 'global' ? origin.pm : undefined;
  const targetPm: PackageManager | undefined = opts.pm ?? detectedPm;

  const registry = resolveRegistry({
    packageName: meta.name,
    flagRegistry: opts.registry,
    pm: targetPm,
    env: deps.env,
    homeDir: deps.homeDir,
    readText: deps.readText,
  });

  const fetchVersion = (reg: string): Promise<FetchVersionResult> =>
    deps.fetchLatest !== undefined
      ? deps.fetchLatest(meta.name, reg)
      : fetchLatestVersion({ packageName: meta.name, registry: reg });

  // 非全局受管场景且用户未显式 --pm 覆盖: 安全告知对应更新路径, 不盲目装全局造成双份冲突
  if (
    opts.pm === undefined &&
    (origin.kind === 'source' ||
      origin.kind === 'ephemeral' ||
      origin.kind === 'local-project')
  ) {
    return await handleNonGlobalOrigin(
      meta,
      origin,
      opts,
      io,
      fetchVersion,
      registry,
    );
  }

  io.out(`当前版本: ${meta.name}@${meta.version}`);
  io.out(`安装方式: ${describeOrigin(origin)}`);
  if (opts.pm !== undefined && opts.pm !== detectedPm) {
    io.out(`目标安装器: ${opts.pm} (经 --pm 手动指定)`);
  }

  const remote = await fetchVersion(registry);
  if (!remote.ok) {
    if (remote.code === 'not-found') {
      io.err(
        `${meta.name} 尚未在 ${registry} 发布 (HTTP 404), 无法在线更新` +
          (meta.isPrivate ? ' (当前包标记为 private)' : ''),
      );
      io.err('  若已发布到私有源, 请加 --registry <url> 后重试');
      return 1;
    }
    io.err(`检查最新版本失败: ${sanitize(remote.message)}`);
    if (targetPm !== undefined) {
      const cmd = formatUpgradeDisplayCommand(
        targetPm,
        meta.name,
        'latest',
        opts.registry,
      );
      io.err(`  可稍后重试或手动执行: ${cmd}`);
    }
    return 1;
  }

  const hasUpdate = isNewerVersion(meta.version, remote.version);
  if (!hasUpdate && !opts.force) {
    io.out(
      `已是最新版本: v${meta.version} (远端最新 v${remote.version}, 源: ${remote.registry}) ✓`,
    );
    return 0;
  }

  if (hasUpdate) {
    io.out(
      `发现新版本: v${meta.version} → v${remote.version} (源: ${remote.registry})`,
    );
  } else {
    io.out(
      `强制重装模式 (--force): 将重新安装 v${remote.version} (源: ${remote.registry})`,
    );
  }

  if (opts.check) {
    if (targetPm !== undefined) {
      const cmd = formatUpgradeDisplayCommand(
        targetPm,
        meta.name,
        remote.version,
        opts.registry,
      );
      io.out(`运行 ${options.binName} update 即可升级 (将执行: ${cmd})`);
    } else {
      io.out(
        `未能自动识别安装器, 升级请运行: ${options.binName} update --pm <bun|npm|pnpm|yarn|volta>`,
      );
    }
    return 0;
  }

  if (targetPm === undefined) {
    io.err(
      '未能自动确认安装本命令的包管理器, 为避免在 PATH 中装出重复版本已停止自动执行',
    );
    io.err(
      `  请使用 --pm 显式指定你的包管理器后重试, 例如: ${options.binName} update --pm bun`,
    );
    return 1;
  }

  return performUpgrade(meta, targetPm, remote.version, opts, io, deps);
}
