/**
 * CLI 自更新主流程编排: 读包元数据 → 探测安装来源 → 查远端最新版 → 构造并隔离执行对应包管理器更新。
 *
 * 所有外部副作用 (fetch / spawn / fs / stdout / stderr / env / platform / spinner) 均可注入,
 * 默认采用异步静默捕获 (64 KiB 尾部上限防 OOM) + TTY 实时旋转进度接管等待期,
 * 成功收敛单行汇总、失败自动展开净化后的底层尾部日志, 传 `--verbose` 可切回实时透传。
 */
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { formatUpdateHelp, parseUpdateArgs } from './args.ts';
import {
  type GlobalRootMap,
  type PackageManager,
  safeRealpath,
} from './detect.ts';
import {
  type ExecuteUpgradeAsyncOptions,
  type ExecuteUpgradeResult,
  type SpawnAsyncLike,
} from './exec-async.ts';
import { type CommandSpec, type SpawnLike } from './executor.ts';
import {
  type FetchVersionResult,
  fetchLatestVersion,
  resolveRegistry,
  resolveRegistryAuthToken,
} from './registry.ts';
import { type UpdateSpinner, createUpdateSpinner } from './spinner.ts';
import {
  type ColorChannels,
  createUpdateUi,
  detectColorChannels,
  extractRegistryHost,
  stderrSupportsSpinner,
} from './ui.ts';
import {
  type UpgradePlanExecutor,
  dispatchRemoteVersion,
  handleFetchFailure,
} from './update-flow.ts';
import {
  describeOrigin,
  handleNonGlobalOrigin,
  resolveOrigin,
  sanitize,
  warnCrossPmOverride,
} from './update-helpers.ts';

export { type UpgradePlanExecutor } from './update-flow.ts';

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
  /** 命令展示名 (如 sweep / codd / create-clis) */
  binName: string;
  /** CLI 入口模块的 import.meta.url (用于定位相邻 package.json 与包目录) */
  entryMetaUrl?: string;
  /** 若调用方已读好包元数据可直接传入 (测试或自定义布局) */
  meta?: PackageMeta;
  /** `update` 子命令之后的参数数组 */
  argv: readonly string[];
  /** 可选覆盖输出流 (默认 stdout / stderr) */
  io?: UpdateIO;
  /** 可选覆盖双通道着色开关 (未传且使用默认 io 时自动按 TTY / NO_COLOR / TERM=dumb 判定) */
  color?: ColorChannels;
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
    execPlan?: UpgradePlanExecutor;
    execPlanAsync?: (
      plan: CommandSpec,
      options?: ExecuteUpgradeAsyncOptions,
    ) => Promise<ExecuteUpgradeResult>;
    spawnFn?: SpawnLike;
    spawnAsync?: SpawnAsyncLike;
    spinner?: UpdateSpinner;
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

/**
 * 统一 CLI 自更新入口 (返回进程退出码: 0 成功 / 已最新 / 仅检查; 1 失败 / 未发布 / 无法确定安装器)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  { binName: 'sweep', entryMetaUrl, argv: ['--check'] }
 * 步骤 1: parseUpdateArgs + readPackageMeta (--help 直接渲染并退 0)
 * 步骤 2: resolveOrigin (路径快路径 + 可选全局根实查) -> 确定 targetPm (opts.pm 优先)
 * 步骤 3: resolveRegistry (显式 > env > 按 pm 查家目录配置 > 官方源)
 * 步骤 4: 非全局受管且未指定 --pm -> handleNonGlobalOrigin 安全指引后退 0
 * 步骤 5: fetchLatestVersion (+可选同源 Bearer) -> 失败走 handleFetchFailure, 成功走 dispatchRemoteVersion
 * Output: 进程退出码 (0 / 1)
 * ```
 */
export async function runSelfUpdate(
  options: SelfUpdateRunOptions,
): Promise<number> {
  const usingDefaultIo = options.io === undefined;
  const io: UpdateIO = options.io ?? {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  };
  const deps = options.deps ?? {};
  const color: ColorChannels =
    options.color ??
    (usingDefaultIo
      ? detectColorChannels(deps.env)
      : { stdout: false, stderr: false });
  const ui = createUpdateUi(color);

  const parsed = parseUpdateArgs(options.argv);
  if (!parsed.ok) {
    io.err(ui.error(`参数错误: ${parsed.message}`));
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
    io.err(ui.error(`读取当前包信息失败: ${sanitize(msg)}`));
    return 1;
  }

  if (opts.help) {
    for (const line of formatUpdateHelp(
      options.binName,
      meta.name,
      color.stdout,
    ).split('\n')) {
      io.out(line);
    }
    return 0;
  }

  const spinner =
    deps.spinner ??
    createUpdateSpinner({
      enabled: usingDefaultIo && stderrSupportsSpinner(deps.env),
      color: color.stderr,
    });

  io.out(ui.header(options.binName));

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
      ui,
      spinner,
      fetchVersion,
      registry,
    });
  }

  io.out(ui.kv('当前版本', `${meta.name}@${meta.version}`, 'bold'));
  io.out(ui.kv('安装方式', describeOrigin(origin)));
  if (opts.pm !== undefined && opts.pm !== detectedPm) {
    io.out(ui.kv('目标安装器', `${opts.pm} (经 --pm 手动指定)`, 'cyan'));
    warnCrossPmOverride(origin, opts.pm, io, ui);
  }

  spinner.start('正在检查最新版本', extractRegistryHost(registry));
  let remote: FetchVersionResult;
  try {
    remote = await fetchVersion(registry);
  } finally {
    spinner.stop();
  }

  if (!remote.ok) {
    return await handleFetchFailure({
      binName: options.binName,
      meta,
      origin,
      targetPm,
      registry,
      remote,
      opts,
      io,
      color,
      ui,
      spinner,
      deps,
    });
  }

  return await dispatchRemoteVersion({
    binName: options.binName,
    meta,
    origin,
    targetPm,
    remote,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
  });
}
