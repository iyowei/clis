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

import {
  type Locale,
  resolveCliLocale,
  stripLangArgs,
  t,
} from '@iyowei/cli-i18n';

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
  type UpgradePlanExecutor,
} from './exec-async.ts';
import { type CommandSpec, type SpawnLike } from './executor.ts';
import { handleNonGlobalOrigin } from './non-global-flow.ts';
import {
  type FetchLike,
  type FetchVersionResult,
  fetchLatestVersion,
  resolveRegistry,
  resolveRegistryAuthToken,
} from './registry.ts';
import {
  dispatchRemoteVersion,
  handleFetchFailure,
} from './remote-dispatch.ts';
import { type UpdateSpinner, createUpdateSpinner } from './spinner.ts';
import {
  type ColorChannels,
  createUpdateUi,
  detectColorChannels,
  extractRegistryHost,
  stderrSupportsSpinner,
} from './ui.ts';
import {
  describeOrigin,
  resolveOrigin,
  sanitize,
  warnCrossPmOverride,
} from './update-helpers.ts';

export { type UpgradePlanExecutor } from './exec-async.ts';

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
  /** 工具配置名 (用于读取对应工具独立的 lang.json 偏好, 缺省取 binName) */
  toolName?: string;
  /** 显式指定本次自更新界面语言 (覆盖自动解析) */
  locale?: Locale;
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
    fetchFn?: FetchLike;
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
function resolveUpdateLocale(
  options: SelfUpdateRunOptions,
  flag?: 'system' | 'en' | 'zh',
): Locale {
  if (options.locale !== undefined) return options.locale;
  const deps = options.deps ?? {};
  return resolveCliLocale({
    toolName: options.toolName ?? options.binName,
    flag,
    platform: deps.platform,
    homedir: deps.homeDir,
    env: deps.env,
  }).locale;
}

function loadPackageMetaOrThrow(
  options: SelfUpdateRunOptions,
  locale: Locale,
): PackageMeta {
  if (options.meta !== undefined) return options.meta;
  if (options.entryMetaUrl !== undefined) {
    return readPackageMeta(options.entryMetaUrl);
  }
  throw new Error(
    t(
      locale,
      '缺少 entryMetaUrl 或 meta, 无法定位当前包信息',
      'Missing entryMetaUrl or meta for package resolution',
    ),
  );
}

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

  const baseLocale = resolveUpdateLocale(options);
  const peeked = stripLangArgs(options.argv, {
    fallbackLocale: baseLocale,
    valueFlags: new Set(['--pm', '--registry']),
  });
  const preLocale =
    peeked.lang !== undefined
      ? resolveUpdateLocale(options, peeked.lang)
      : baseLocale;

  const parsed = parseUpdateArgs(options.argv, preLocale);
  if (!parsed.ok) {
    const errUi = createUpdateUi(color, preLocale);
    io.err(
      errUi.error(
        t(
          preLocale,
          `参数错误: ${parsed.message}`,
          `Invalid argument: ${parsed.message}`,
        ),
      ),
    );
    return 1;
  }
  const opts = parsed.options;
  const locale = resolveUpdateLocale(options, opts.lang);
  const ui = createUpdateUi(color, locale);

  let meta: PackageMeta;
  try {
    meta = loadPackageMetaOrThrow(options, locale);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    io.err(
      ui.error(
        t(
          locale,
          `读取当前包信息失败: ${sanitize(msg)}`,
          `Failed to read package metadata: ${sanitize(msg)}`,
        ),
      ),
    );
    return 1;
  }

  if (opts.help) {
    for (const line of formatUpdateHelp(
      options.binName,
      meta.name,
      color.stdout,
      locale,
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
    toolName: options.toolName ?? options.binName,
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
      locale,
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
      locale,
    });
  }

  io.out(
    ui.kv(
      t(locale, '当前版本', 'Current'),
      `${meta.name}@${meta.version}`,
      'bold',
    ),
  );
  io.out(
    ui.kv(t(locale, '安装方式', 'Origin'), describeOrigin(origin, locale)),
  );
  if (opts.pm !== undefined && opts.pm !== detectedPm) {
    io.out(
      ui.kv(
        t(locale, '目标安装器', 'Target PM'),
        t(locale, `${opts.pm} (经 --pm 手动指定)`, `${opts.pm} (via --pm)`),
        'cyan',
      ),
    );
    warnCrossPmOverride(origin, opts.pm, io, ui, locale);
  }

  spinner.start(
    t(locale, '正在检查最新版本', 'Checking latest version'),
    extractRegistryHost(registry),
  );
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
      locale,
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
    locale,
  });
}
