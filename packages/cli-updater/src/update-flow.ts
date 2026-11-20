/**
 * `runSelfUpdate` 升级执行与远端结果分发流程 (从 update.ts 拆分以保持单文件与单函数紧凑度)。
 */
import { type UpdateOptions } from './args.ts';
import { type InstallOrigin, type PackageManager } from './detect.ts';
import {
  type ExecuteUpgradeAsyncOptions,
  type ExecuteUpgradeResult,
  type SpawnAsyncLike,
  executeUpgradePlanAsync,
} from './exec-async.ts';
import {
  type CommandSpec,
  type SpawnLike,
  buildUpgradePlan,
  formatUpgradeDisplayCommand,
  probeYarnVersion,
} from './executor.ts';
import { type FetchVersionResult } from './registry.ts';
import { compareSemver } from './semver.ts';
import { type UpdateSpinner } from './spinner.ts';
import {
  type ColorChannels,
  type UpdateUi,
  formatElapsedMs,
  paint,
  sanitizeMultilineTail,
} from './ui.ts';
import {
  type PackageMetaRef,
  type UpdateIORef,
  formatVersionLabel,
  sanitize,
  verifyPostUpgrade,
} from './update-helpers.ts';

/** 兼容同步与异步的升级执行器签名 (保留向下兼容) */
export type UpgradePlanExecutor = (
  plan: CommandSpec,
  env?: NodeJS.ProcessEnv,
  spawnFn?: SpawnLike,
) => ExecuteUpgradeResult | Promise<ExecuteUpgradeResult>;

/** 执行层所需依赖切片 */
export interface UpgradeFlowDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
  readText?: (path: string) => string | null;
  probeYarn?: () => string | null;
  execPlan?: UpgradePlanExecutor;
  execPlanAsync?: (
    plan: CommandSpec,
    options?: ExecuteUpgradeAsyncOptions,
  ) => Promise<ExecuteUpgradeResult>;
  spawnFn?: SpawnLike;
  spawnAsync?: SpawnAsyncLike;
}

export interface PerformUpgradeContext {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager;
  targetSpec: string;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
}

/** 在静默捕获模式下失败时展开净化后的底层尾部错误摘要 */
function emitCapturedFailureTail(
  result: ExecuteUpgradeResult,
  verbose: boolean,
  io: UpdateIORef,
  ui: UpdateUi,
): void {
  if (verbose || typeof result.capturedOutput !== 'string') return;
  const tail = sanitizeMultilineTail(result.capturedOutput);
  if (tail.lines.length === 0) return;
  const isClipped = result.truncated === true || tail.clipped;
  io.err(
    ui.errorHint(isClipped ? '底层输出摘要 (仅显示末尾):' : '底层输出摘要:'),
  );
  for (const line of tail.lines) {
    io.err(ui.errorLogLine(line));
  }
}

/** 在确认存在目标包管理器且需更新后, 构造并异步隔离执行升级计划 */
export async function performUpgrade(
  ctx: PerformUpgradeContext,
): Promise<number> {
  const {
    binName,
    meta,
    origin,
    targetPm,
    targetSpec,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
  } = ctx;
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
    io.err(ui.error(`无法自动更新: ${built.reason}`));
    if (built.fallbackCommand !== undefined) {
      io.err(ui.errorHint(`手动更新命令: ${built.fallbackCommand}`));
    }
    return 1;
  }

  const targetLabel = formatVersionLabel(sanitize(targetSpec));
  if (opts.verbose) {
    io.out(ui.kv('执行命令', built.plan.displayCommand, 'dim'));
  } else {
    spinner.start(`正在通过 ${targetPm} 升级至 ${targetLabel}`);
  }

  let result: ExecuteUpgradeResult;
  try {
    if (deps.execPlanAsync !== undefined) {
      result = await deps.execPlanAsync(built.plan, {
        env,
        verbose: opts.verbose,
        spawnAsync: deps.spawnAsync,
      });
    } else if (deps.execPlan !== undefined) {
      result = await deps.execPlan(built.plan, env, deps.spawnFn);
    } else {
      result = await executeUpgradePlanAsync(built.plan, {
        env,
        verbose: opts.verbose,
        spawnAsync: deps.spawnAsync,
      });
    }
  } finally {
    spinner.stop();
  }

  if (result.error !== undefined) {
    io.err(ui.error(`更新命令启动失败: ${sanitize(result.error.message)}`));
    emitCapturedFailureTail(result, opts.verbose, io, ui);
    io.err(ui.errorHint(`手动更新命令: ${built.plan.displayCommand}`));
    return 1;
  }
  if (result.signal !== undefined && result.signal !== null) {
    io.err(ui.error(`更新进程被信号中断 (${result.signal})`));
    emitCapturedFailureTail(result, opts.verbose, io, ui);
    io.err(ui.errorHint(`手动更新命令: ${built.plan.displayCommand}`));
    return 1;
  }
  if (result.status !== 0) {
    io.err(
      ui.error(`更新失败 (${targetPm} 退出码 ${String(result.status ?? 1)})`),
    );
    emitCapturedFailureTail(result, opts.verbose, io, ui);
    if (platform === 'win32') {
      io.err(
        ui.errorHint(
          `Windows 提示: 当前正在运行的 ${sanitize(binName)} 自身可执行/shim 文件可能被系统锁定 (EBUSY / EPERM), 请退出当前命令并关闭其他占用终端后直接执行下方命令:`,
        ),
      );
    }
    if (targetPm === 'pnpm') {
      io.err(
        ui.errorHint(
          'pnpm 提示: 若提示未配置全局 bin 目录, 请检查 PNPM_HOME 环境变量或先运行 pnpm setup。',
        ),
      );
    }
    io.err(ui.errorHint(`手动更新命令: ${built.plan.displayCommand}`));
    return 1;
  }

  const elapsed = formatElapsedMs(result.durationMs);
  const pkgLabel = paint(sanitize(meta.name), '1', color.stdout);
  const verLabel = paint(targetLabel, '1;36', color.stdout);
  io.out(
    ui.success(
      `已通过 ${targetPm} 更新 ${pkgLabel} 至 ${verLabel}`,
      elapsed !== '' ? `(${elapsed})` : undefined,
    ),
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
    ui,
  });
  return 0;
}

/** 远端版本查询失败时的分类汇报与 --force 兜底直装 */
export async function handleFetchFailure(ctx: {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager | undefined;
  registry: string;
  remote: Extract<FetchVersionResult, { ok: false }>;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
}): Promise<number> {
  const {
    binName,
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
  } = ctx;

  if (opts.force && !opts.check && targetPm !== undefined) {
    io.err(ui.error(`警示: 远端版本查询失败 (${sanitize(remote.message)})`));
    io.out(
      ui.body(
        `强制重装模式 (--force): 跳过远端版本校验, 将直接通过 ${targetPm} 安装 ${sanitize(meta.name)}@latest`,
      ),
    );
    return await performUpgrade({
      binName,
      meta,
      origin,
      targetPm,
      targetSpec: 'latest',
      opts,
      io,
      color,
      ui,
      spinner,
      deps,
    });
  }

  if (remote.code === 'not-found') {
    io.err(
      ui.error(
        `${sanitize(meta.name)} 尚未在 ${sanitize(registry)} 发布 (HTTP 404), 无法在线更新` +
          (meta.isPrivate ? ' (当前包标记为 private)' : ''),
      ),
    );
    io.err(ui.errorHint('若已发布到私有源, 请加 --registry <url> 后重试'));
    return 1;
  }

  if (remote.code === 'auth') {
    io.err(ui.error(`检查最新版本失败: ${sanitize(remote.message)}`));
    io.err(
      ui.errorHint(
        '请先完成源登录或在 ~/.npmrc / ~/.bunfig.toml 配置同源访问 token, 或加 --force 直接委托包管理器安装',
      ),
    );
  } else {
    io.err(ui.error(`检查最新版本失败: ${sanitize(remote.message)}`));
  }

  if (targetPm !== undefined) {
    const cmd = formatUpgradeDisplayCommand(
      targetPm,
      meta.name,
      'latest',
      opts.registry,
    );
    io.err(ui.errorHint(`可稍后重试或手动执行: ${cmd}`));
  }
  return 1;
}

/** 比较远端版本与本地版本并分流到已最新 / --check / 执行升级 */
export async function dispatchRemoteVersion(ctx: {
  binName: string;
  meta: PackageMetaRef;
  origin: InstallOrigin;
  targetPm: PackageManager | undefined;
  remote: Extract<FetchVersionResult, { ok: true }>;
  opts: UpdateOptions;
  io: UpdateIORef;
  color: ColorChannels;
  ui: UpdateUi;
  spinner: UpdateSpinner;
  deps: UpgradeFlowDeps;
}): Promise<number> {
  const {
    binName,
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
  } = ctx;

  const cmp = compareSemver(meta.version, remote.version);
  if (cmp === null && !opts.force) {
    io.out(
      ui.body(
        `版本比较: 当前版本 (${sanitize(meta.version)}) 与远端版本 (${sanitize(remote.version)}, 源: ${sanitize(remote.registry)}) 无法按标准 SemVer 比较, 未自动覆盖。`,
      ),
    );
    io.out(
      ui.hint(
        `  若确认需要安装远端版本, 请加 --force 重试 (例如: ${sanitize(binName)} update --force)`,
      ),
    );
    return 0;
  }

  const hasUpdate = cmp === -1;
  if (!hasUpdate && !opts.force) {
    const safeVer = sanitize(meta.version);
    const safeRemote = sanitize(remote.version);
    const safeReg = sanitize(remote.registry);
    io.out(
      ui.success(
        `已是最新版本: ${paint(`v${safeVer}`, '1', color.stdout)}`,
        `(远端最新 v${safeRemote}, 源: ${safeReg})`,
      ),
    );
    return 0;
  }

  if (hasUpdate) {
    io.out(ui.foundUpdate(meta.version, remote.version, remote.registry));
  } else {
    io.out(
      ui.body(
        `强制重装模式 (--force): 将重新安装 ${paint(formatVersionLabel(sanitize(remote.version)), '1;36', color.stdout)} ${paint(`(源: ${sanitize(remote.registry)})`, '2', color.stdout)}`,
      ),
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
      io.out(
        ui.hint(
          `运行 ${sanitize(binName)} update 即可升级 (将执行: ${sanitize(cmd)})`,
        ),
      );
    } else {
      io.out(
        ui.hint(
          `未能自动识别安装器, 升级请运行: ${sanitize(binName)} update --pm <bun|npm|pnpm|yarn|volta>`,
        ),
      );
    }
    return 0;
  }

  if (targetPm === undefined) {
    io.err(
      ui.error(
        '未能自动确认安装本命令的包管理器, 为避免在 PATH 中装出重复版本已停止自动执行',
      ),
    );
    io.err(
      ui.errorHint(
        `请使用 --pm 显式指定你的包管理器后重试, 例如: ${sanitize(binName)} update --pm bun`,
      ),
    );
    return 1;
  }

  return await performUpgrade({
    binName,
    meta,
    origin,
    targetPm,
    targetSpec: remote.version,
    opts,
    io,
    color,
    ui,
    spinner,
    deps,
  });
}
