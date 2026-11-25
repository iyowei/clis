/**
 * `runSelfUpdate` 升级执行与远端结果分发流程 (中英双语)。
 */
import { type Locale, t } from '@iyowei/cli-i18n';

import { type UpdateOptions } from './args.ts';
import { type InstallOrigin, type PackageManager } from './detect.ts';
import {
  type ExecuteUpgradeAsyncOptions,
  type ExecuteUpgradeResult,
  type SpawnAsyncLike,
  type UpgradePlanExecutor,
  executeUpgradePlanAsync,
} from './exec-async.ts';
import {
  type CommandSpec,
  type SpawnLike,
  buildUpgradePlan,
  probeYarnVersion,
} from './executor.ts';
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
  locale: Locale;
}

function emitCapturedFailureTail(
  result: ExecuteUpgradeResult,
  verbose: boolean,
  io: UpdateIORef,
  ui: UpdateUi,
  locale: Locale,
): void {
  if (verbose || typeof result.capturedOutput !== 'string') return;
  const tail = sanitizeMultilineTail(result.capturedOutput);
  if (tail.lines.length === 0) return;
  const isClipped = result.truncated === true || tail.clipped;
  io.err(
    ui.errorHint(
      isClipped
        ? t(
            locale,
            '底层输出摘要 (仅显示末尾):',
            'Package manager output (tail):',
          )
        : t(locale, '底层输出摘要:', 'Package manager output:'),
    ),
  );
  for (const line of tail.lines) {
    io.err(ui.errorLogLine(line));
  }
}

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
    locale,
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
    locale,
  });

  const manualHint = (cmd: string): string =>
    t(locale, `手动更新命令: ${cmd}`, `Run manually: ${cmd}`);

  if (!built.ok) {
    io.err(
      ui.error(
        t(
          locale,
          `无法自动更新: ${built.reason}`,
          `Cannot upgrade automatically: ${built.reason}`,
        ),
      ),
    );
    if (built.fallbackCommand !== undefined) {
      io.err(ui.errorHint(manualHint(built.fallbackCommand)));
    }
    return 1;
  }

  const targetLabel = formatVersionLabel(sanitize(targetSpec));
  if (opts.verbose) {
    io.out(
      ui.kv(t(locale, '执行命令', 'Command'), built.plan.displayCommand, 'dim'),
    );
  } else {
    spinner.start(
      t(
        locale,
        `正在通过 ${targetPm} 升级至 ${targetLabel}`,
        `Upgrading to ${targetLabel} via ${targetPm}`,
      ),
    );
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
    io.err(
      ui.error(
        t(
          locale,
          `更新命令启动失败: ${sanitize(result.error.message)}`,
          `Failed to launch package manager: ${sanitize(result.error.message)}`,
        ),
      ),
    );
    emitCapturedFailureTail(result, opts.verbose, io, ui, locale);
    io.err(ui.errorHint(manualHint(built.plan.displayCommand)));
    return 1;
  }
  if (result.signal !== undefined && result.signal !== null) {
    io.err(
      ui.error(
        t(
          locale,
          `更新进程被信号中断 (${result.signal})`,
          `Upgrade interrupted by signal (${result.signal})`,
        ),
      ),
    );
    emitCapturedFailureTail(result, opts.verbose, io, ui, locale);
    io.err(ui.errorHint(manualHint(built.plan.displayCommand)));
    return 1;
  }
  if (result.status !== 0) {
    io.err(
      ui.error(
        t(
          locale,
          `更新失败 (${targetPm} 退出码 ${String(result.status ?? 1)})`,
          `Upgrade failed (${targetPm} exited with code ${String(result.status ?? 1)})`,
        ),
      ),
    );
    emitCapturedFailureTail(result, opts.verbose, io, ui, locale);
    if (platform === 'win32') {
      io.err(
        ui.errorHint(
          t(
            locale,
            `Windows 提示: 当前正在运行的 ${sanitize(binName)} 自身可执行/shim 文件可能被系统锁定 (EBUSY / EPERM), 请退出当前命令并关闭其他占用终端后直接执行下方命令:`,
            `Windows note: The running '${sanitize(binName)}' shim may be locked (EBUSY / EPERM); close active terminals and run manually:`,
          ),
        ),
      );
    }
    if (targetPm === 'pnpm') {
      io.err(
        ui.errorHint(
          t(
            locale,
            'pnpm 提示: 若提示未配置全局 bin 目录, 请检查 PNPM_HOME 环境变量或先运行 pnpm setup。',
            "pnpm note: If global bin directory is unconfigured, check PNPM_HOME or run 'pnpm setup'.",
          ),
        ),
      );
    }
    io.err(ui.errorHint(manualHint(built.plan.displayCommand)));
    return 1;
  }

  const elapsed = formatElapsedMs(result.durationMs);
  const pkgLabel = paint(sanitize(meta.name), '1', color.stdout);
  const verLabel = paint(targetLabel, '1;36', color.stdout);
  io.out(
    ui.success(
      t(
        locale,
        `已通过 ${targetPm} 更新 ${pkgLabel} 至 ${verLabel}`,
        `Updated ${pkgLabel} to ${verLabel} via ${targetPm}`,
      ),
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
    locale,
  });
  return 0;
}
