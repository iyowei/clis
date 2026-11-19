/**
 * CLI 自更新主流程编排: 读包元数据 → 探测安装来源 → 查远端最新版 → 构造并隔离执行对应包管理器更新。
 *
 * 所有外部副作用 (fetch / spawn / fs / stdout / stderr / env / platform) 均可注入,
 * 保证全状态机分支 (全局 5 管理器 / 临时运行 / 源码开发态 / 本地项目依赖 / 未知路径 /
 * 已是最新 / 有更新 / 非 SemVer / --check / --pm 覆盖 / --force / 401/403 鉴权失败 / 404 未发布 /
 * 断网 / 信号中断 / Yarn Berry / Windows 自锁 / pnpm setup / 升级后轻复核) 均可无副作用确定性测试。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type UpdateOptions,
  formatUpdateHelp,
  parseUpdateArgs,
} from './args.ts';
import {
  type GlobalRootMap,
  type InstallOrigin,
  type PackageManager,
  safeRealpath,
} from './detect.ts';
import {
  type SpawnLike,
  buildUpgradePlan,
  executeUpgradePlan,
  formatUpgradeDisplayCommand,
  probeYarnVersion,
} from './executor.ts';
import {
  type FetchVersionResult,
  fetchLatestVersion,
  resolveRegistry,
  resolveRegistryAuthToken,
} from './registry.ts';
import { compareSemver } from './semver.ts';
import {
  describeOrigin,
  formatVersionLabel,
  handleNonGlobalOrigin,
  resolveOrigin,
  sanitize,
  verifyPostUpgrade,
  warnCrossPmOverride,
} from './update-helpers.ts';

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

interface PerformUpgradeContext {
  binName: string;
  meta: PackageMeta;
  origin: InstallOrigin;
  targetPm: PackageManager;
  targetSpec: string;
  opts: UpdateOptions;
  io: UpdateIO;
  deps: NonNullable<SelfUpdateRunOptions['deps']>;
}

/** 在确认存在目标包管理器且需更新后, 构造并执行升级计划 */
function performUpgrade(ctx: PerformUpgradeContext): number {
  const { binName, meta, origin, targetPm, targetSpec, opts, io, deps } = ctx;
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
    targetSpec,
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
  if (result.signal !== undefined && result.signal !== null) {
    io.err(`更新进程被信号中断 (${result.signal})`);
    io.err(`  手动更新命令: ${built.plan.displayCommand}`);
    return 1;
  }
  if (result.status !== 0) {
    io.err(`更新失败 (${targetPm} 退出码 ${String(result.status ?? 1)})`);
    if (platform === 'win32') {
      io.err(
        `  Windows 提示: 当前正在运行的 ${binName} 自身可执行/shim 文件可能被系统锁定 (EBUSY / EPERM), 请退出当前命令并关闭其他占用终端后直接执行下方命令:`,
      );
    }
    if (targetPm === 'pnpm') {
      io.err(
        '  pnpm 提示: 若提示未配置全局 bin 目录, 请检查 PNPM_HOME 环境变量或先运行 pnpm setup。',
      );
    }
    io.err(`  手动更新命令: ${built.plan.displayCommand}`);
    return 1;
  }

  io.out(
    `已通过 ${targetPm} 更新 ${meta.name} 至 ${formatVersionLabel(targetSpec)} ✓`,
  );
  verifyPostUpgrade({
    binName,
    meta,
    origin,
    targetPm,
    targetSpec,
    platform,
    env,
    readText: deps.readText,
    isFile: deps.isFile,
    io,
  });
  return 0;
}

/** 远端版本查询失败时的分类汇报与 --force 兜底直装 */
function handleFetchFailure(ctx: {
  binName: string;
  meta: PackageMeta;
  origin: InstallOrigin;
  targetPm: PackageManager | undefined;
  registry: string;
  remote: Extract<FetchVersionResult, { ok: false }>;
  opts: UpdateOptions;
  io: UpdateIO;
  deps: NonNullable<SelfUpdateRunOptions['deps']>;
}): number {
  const { binName, meta, origin, targetPm, registry, remote, opts, io, deps } =
    ctx;

  if (opts.force && !opts.check && targetPm !== undefined) {
    io.err(`警示: 远端版本查询失败 (${sanitize(remote.message)})`);
    io.out(
      `强制重装模式 (--force): 跳过远端版本校验, 将直接通过 ${targetPm} 安装 ${meta.name}@latest`,
    );
    return performUpgrade({
      binName,
      meta,
      origin,
      targetPm,
      targetSpec: 'latest',
      opts,
      io,
      deps,
    });
  }

  if (remote.code === 'not-found') {
    io.err(
      `${meta.name} 尚未在 ${registry} 发布 (HTTP 404), 无法在线更新` +
        (meta.isPrivate ? ' (当前包标记为 private)' : ''),
    );
    io.err('  若已发布到私有源, 请加 --registry <url> 后重试');
    return 1;
  }

  if (remote.code === 'auth') {
    io.err(`检查最新版本失败: ${sanitize(remote.message)}`);
    io.err(
      '  请先完成源登录或在 ~/.npmrc / ~/.bunfig.toml 配置同源访问 token, 或加 --force 直接委托包管理器安装',
    );
  } else {
    io.err(`检查最新版本失败: ${sanitize(remote.message)}`);
  }

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
    for (const line of formatUpdateHelp(options.binName, meta.name).split(
      '\n',
    )) {
      io.out(line);
    }
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

  const fetchVersion = (reg: string): Promise<FetchVersionResult> => {
    if (deps.fetchLatest !== undefined) {
      return deps.fetchLatest(meta.name, reg);
    }
    const authToken = resolveRegistryAuthToken({
      packageName: meta.name,
      registry: reg,
      pm: targetPm,
      env: deps.env,
      homeDir: deps.homeDir,
      readText: deps.readText,
    });
    return fetchLatestVersion({
      packageName: meta.name,
      registry: reg,
      authToken,
    });
  };

  // 非全局受管场景且用户未显式 --pm 覆盖: 安全告知对应更新路径, 不盲目装全局造成双份冲突
  if (
    opts.pm === undefined &&
    (origin.kind === 'source' ||
      origin.kind === 'ephemeral' ||
      origin.kind === 'local-project')
  ) {
    return await handleNonGlobalOrigin({
      meta,
      origin,
      hasExplicitRegistry: opts.registry !== undefined,
      io,
      fetchVersion,
      registry,
    });
  }

  io.out(`当前版本: ${meta.name}@${meta.version}`);
  io.out(`安装方式: ${describeOrigin(origin)}`);
  if (opts.pm !== undefined && opts.pm !== detectedPm) {
    io.out(`目标安装器: ${opts.pm} (经 --pm 手动指定)`);
    warnCrossPmOverride(origin, opts.pm, io);
  }

  const remote = await fetchVersion(registry);
  if (!remote.ok) {
    return handleFetchFailure({
      binName: options.binName,
      meta,
      origin,
      targetPm,
      registry,
      remote,
      opts,
      io,
      deps,
    });
  }

  const cmp = compareSemver(meta.version, remote.version);
  if (cmp === null && !opts.force) {
    io.out(
      `版本比较: 当前版本 (${meta.version}) 与远端版本 (${remote.version}, 源: ${remote.registry}) 无法按标准 SemVer 比较, 未自动覆盖。`,
    );
    io.out(
      `  若确认需要安装远端版本, 请加 --force 重试 (例如: ${options.binName} update --force)`,
    );
    return 0;
  }

  const hasUpdate = cmp === -1;
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
      `强制重装模式 (--force): 将重新安装 ${formatVersionLabel(remote.version)} (源: ${remote.registry})`,
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

  return performUpgrade({
    binName: options.binName,
    meta,
    origin,
    targetPm,
    targetSpec: remote.version,
    opts,
    io,
    deps,
  });
}
