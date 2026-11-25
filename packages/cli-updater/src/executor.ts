/**
 * 跨包管理器升级计划构造与隔离执行入口。
 */
import { spawnSync } from 'node:child_process';

import { type Locale, t } from '@iyowei/cli-i18n';

import { type PackageManager } from './detect.ts';
import {
  type PmInvocation,
  type SpawnLike,
  buildIsolatedEnv,
  defaultIsFile,
  isYarnBerryVersion,
  resolveExecutableInPath,
  resolvePmInvocation,
  withIsolatedCwd,
} from './exec-core.ts';
import {
  type ProbeGlobalRootsOptions,
  probeGlobalRoots,
  probeYarnVersion,
} from './probe.ts';
import { normalizeRegistryUrl } from './registry.ts';
import {
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
} from './semver.ts';

export {
  type PmInvocation,
  type ProbeGlobalRootsOptions,
  type SpawnLike,
  buildIsolatedEnv,
  isYarnBerryVersion,
  probeGlobalRoots,
  probeYarnVersion,
  resolveExecutableInPath,
  resolvePmInvocation,
};

/** 子进程调用描述符 */
export interface CommandSpec {
  /** 可执行文件绝对路径或系统命令 */
  command: string;
  /** 参数数组 (零 shell 拼接) */
  args: string[];
  /** 面向人类阅读与复制的命令文本 */
  displayCommand: string;
  /** 若需为本次调用注入额外环境变量 (如显式 --registry) */
  envOverlay?: Record<string, string>;
  /** Windows 经 ComSpec /d /s /c 调用 .cmd/.bat 时需置 true 避免二次加引号 */
  windowsVerbatimArguments?: boolean;
}

/** 构造升级计划的输入 */
export interface BuildUpgradePlanInput {
  pm: PackageManager;
  packageName: string;
  targetSpec?: string;
  explicitRegistry?: string;
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  isFile?: (path: string) => boolean;
  yarnVersion?: string | null;
  locale?: Locale;
}

/** 升级计划判定结果 */
export type UpgradePlanOutcome =
  | { ok: true; plan: CommandSpec }
  | { ok: false; reason: string; fallbackCommand?: string };

/** 生成面向人类展示与复制的升级命令串 */
export function formatUpgradeDisplayCommand(
  pm: PackageManager,
  packageName: string,
  targetSpec = 'latest',
  explicitRegistry?: string,
): string {
  const spec = `${packageName}@${targetSpec}`;
  const reg =
    explicitRegistry !== undefined
      ? normalizeRegistryUrl(explicitRegistry)
      : undefined;
  switch (pm) {
    case 'bun':
      return reg === undefined
        ? `bun add -g ${spec}`
        : `bun add -g ${spec} --registry=${reg}`;
    case 'npm':
      return reg === undefined
        ? `npm install -g ${spec}`
        : `npm install -g ${spec} --registry=${reg}`;
    case 'pnpm':
      return reg === undefined
        ? `pnpm add -g ${spec}`
        : `pnpm add -g ${spec} --registry=${reg}`;
    case 'yarn':
      return reg === undefined
        ? `yarn global add ${spec}`
        : `yarn global add ${spec} --registry ${reg}`;
    case 'volta':
      return reg === undefined
        ? `volta install ${spec}`
        : `NPM_CONFIG_REGISTRY=${reg} volta install ${spec}`;
  }
}

function buildPmUpgradeArgs(
  pm: PackageManager,
  spec: string,
  reg: string | undefined,
): string[] {
  if (pm === 'volta') return ['install', spec];
  if (pm === 'yarn') {
    return reg === undefined
      ? ['global', 'add', spec]
      : ['global', 'add', spec, '--registry', reg];
  }
  const base = pm === 'npm' ? ['install', '-g', spec] : ['add', '-g', spec];
  return reg === undefined ? base : [...base, `--registry=${reg}`];
}

/** 构造各包管理器升级子进程参数 (含 Yarn Berry 前置拦截与强输入校验) */
export function buildUpgradePlan(
  input: BuildUpgradePlanInput,
): UpgradePlanOutcome {
  const locale = input.locale ?? 'zh';
  const targetSpec = input.targetSpec ?? 'latest';
  if (!isValidPackageName(input.packageName)) {
    return {
      ok: false,
      reason: t(
        locale,
        `非法包名: ${input.packageName}`,
        `Invalid package name: ${input.packageName}`,
      ),
    };
  }
  if (!isValidTargetSpec(targetSpec)) {
    return {
      ok: false,
      reason: t(
        locale,
        `非法目标版本标签: ${targetSpec}`,
        `Invalid target version tag: ${targetSpec}`,
      ),
    };
  }
  if (
    input.explicitRegistry !== undefined &&
    !isValidRegistryUrl(input.explicitRegistry)
  ) {
    return {
      ok: false,
      reason: t(
        locale,
        `非法 registry 地址: ${input.explicitRegistry}`,
        `Invalid registry URL: ${input.explicitRegistry}`,
      ),
    };
  }

  const platform = input.platform ?? process.platform;
  const env = input.env ?? process.env;
  const isFile = input.isFile ?? defaultIsFile;
  const reg =
    input.explicitRegistry !== undefined
      ? normalizeRegistryUrl(input.explicitRegistry)
      : undefined;
  const displayCommand = formatUpgradeDisplayCommand(
    input.pm,
    input.packageName,
    targetSpec,
    reg,
  );

  if (input.pm === 'yarn' && isYarnBerryVersion(input.yarnVersion ?? null)) {
    return {
      ok: false,
      reason: t(
        locale,
        `当前环境的 Yarn (${input.yarnVersion?.trim()}) 为 v2+ (Berry), 官方已移除 yarn global add 命令, 请改用 --pm bun / --pm npm / --pm pnpm 执行全局更新`,
        `Yarn (${input.yarnVersion?.trim()}) is v2+ (Berry), which removed 'yarn global add'; rerun with --pm bun, --pm npm, or --pm pnpm`,
      ),
    };
  }

  const spec = `${input.packageName}@${targetSpec}`;
  const pmArgs = buildPmUpgradeArgs(input.pm, spec, reg);

  const invocation = resolvePmInvocation(
    input.pm,
    pmArgs,
    platform,
    env,
    isFile,
  );
  if (invocation === null) {
    return {
      ok: false,
      reason: t(
        locale,
        `当前 PATH 中未找到 ${input.pm} 可执行文件, 无法自动执行更新`,
        `${input.pm} executable was not found in PATH`,
      ),
      fallbackCommand: displayCommand,
    };
  }

  const envOverlay =
    reg === undefined
      ? undefined
      : { npm_config_registry: reg, NPM_CONFIG_REGISTRY: reg };

  const plan: CommandSpec = {
    command: invocation.command,
    args: invocation.args,
    displayCommand,
    envOverlay,
    ...(invocation.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  };

  return { ok: true, plan };
}

/** 在隔离空目录执行升级计划 (stdio 透传给用户实时可见进度, 保留 signal 与 windowsVerbatimArguments) */
export function executeUpgradePlan(
  plan: CommandSpec,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnLike = spawnSync as unknown as SpawnLike,
): { status: number | null; signal?: NodeJS.Signals | null; error?: Error } {
  return withIsolatedCwd((cwd) => {
    const res = spawnFn(plan.command, plan.args, {
      cwd,
      env: buildIsolatedEnv(env, plan.envOverlay),
      stdio: 'inherit',
      ...(plan.windowsVerbatimArguments === true
        ? { windowsVerbatimArguments: true }
        : {}),
    });
    return { status: res.status, signal: res.signal, error: res.error };
  });
}
