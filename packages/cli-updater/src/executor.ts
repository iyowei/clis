/**
 * 跨包管理器升级计划构造、自定义全局目录兜底探测与隔离执行器。
 *
 * 三重工程防线:
 * 1. 防 cwd 劫持: 沿 PATH 绝对目录解析包管理器二进制, 跳过空与相对目录;
 * 2. 防项目目录配置污染: 升级与探测子进程一律在独立临时空目录 (tmpdir) 作为 cwd 执行,
 *    完全隔绝当前工作目录的 .npmrc / .yarnrc.yml / bunfig.toml / package.json#packageManager;
 * 3. 防 Windows 批处理壳层故障与注入: npm / pnpm / yarn 优先直调 node.exe + JS 入口,
 *    批处理兜底采用 windowsVerbatimArguments 单串转义, 全部参数经白名单校验。
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
} from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { parseGlobalDirFromBunfig } from './config-parse.ts';
import {
  type GlobalRootMap,
  type PackageManager,
  safeRealpath,
} from './detect.ts';
import { normalizeRegistryUrl } from './registry.ts';
import {
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
} from './semver.ts';
import {
  isWin32AbsolutePath,
  resolveWindowsBatchInvocation,
} from './windows-exec.ts';

/** 单个可执行的底层调用结构 */
export interface PmInvocation {
  command: string;
  args: string[];
  /** Windows .cmd/.bat 经 ComSpec /d /s /c 调用时为 true */
  windowsVerbatimArguments?: boolean;
}

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
}

/** 升级计划判定结果 */
export type UpgradePlanOutcome =
  | { ok: true; plan: CommandSpec }
  | { ok: false; reason: string; fallbackCommand?: string };

/** 探测命令执行的返回值类型 */
export type SpawnLike = (
  command: string,
  args: readonly string[],
  options: {
    cwd?: string;
    env?: NodeJS.ProcessEnv;
    encoding?: 'utf8';
    stdio?:
      'inherit' | ['ignore', 'pipe', 'pipe'] | ['ignore', 'pipe', 'ignore'];
    timeout?: number;
    windowsVerbatimArguments?: boolean;
  },
) => SpawnSyncReturns<string>;

/** 动态探测全局目录的可选依赖注入 */
export interface ProbeGlobalRootsOptions {
  homeDir?: string;
  readText?: (path: string) => string | null;
  pathExists?: (path: string) => boolean;
  isFile?: (path: string) => boolean;
}

const WIN32_NATIVE_EXTS = ['.exe', '.com'] as const;
const WIN32_BATCH_EXTS = ['.cmd', '.bat'] as const;

/** 探针环境变量覆盖: 禁 Corepack 交互下载提示, 防阻塞挂起 */
const PROBE_ENV_OVERLAY: Record<string, string> = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};

/** 默认常规文件探针 */
function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
}

/** 安全读文本文件 (不存在或不可读返回 null) */
function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function firstNonEmptyEnv(
  ...values: ReadonlyArray<string | undefined>
): string {
  for (const val of values) {
    if (typeof val === 'string' && val.trim() !== '') return val;
  }
  return '';
}

/** 切分 PATH 并剔除空白、包裹引号与相对路径 (防当前目录与盘根相对路径劫持) */
function parseAbsolutePathDirs(
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform,
): string[] {
  const raw =
    platform === 'win32'
      ? firstNonEmptyEnv(env.PATH, env.Path)
      : firstNonEmptyEnv(env.PATH);
  const sep = platform === 'win32' ? ';' : ':';
  const out: string[] = [];
  for (const item of raw.split(sep)) {
    const trimmed = item.trim();
    const cleaned =
      trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1)
        : trimmed;
    if (cleaned === '') continue;
    const absolute =
      platform === 'win32'
        ? isWin32AbsolutePath(cleaned)
        : cleaned.startsWith('/');
    if (absolute) out.push(cleaned);
  }
  return out;
}

/** 在绝对 PATH 中查找可执行文件 (Windows 区分原生 PE 与 .cmd/.bat) */
export function resolveExecutableInPath(
  name: string,
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (path: string) => boolean = defaultIsFile,
): { path: string; isBatch: boolean } | null {
  const dirs = parseAbsolutePathDirs(env, platform);
  if (platform !== 'win32') {
    for (const dir of dirs) {
      const candidate = posix.join(dir, name);
      if (isFile(candidate)) return { path: candidate, isBatch: false };
    }
    return null;
  }
  for (const dir of dirs) {
    for (const ext of WIN32_NATIVE_EXTS) {
      const candidate = win32.join(dir, `${name}${ext}`);
      if (isFile(candidate)) return { path: candidate, isBatch: false };
    }
    for (const ext of WIN32_BATCH_EXTS) {
      const candidate = win32.join(dir, `${name}${ext}`);
      if (isFile(candidate)) return { path: candidate, isBatch: true };
    }
  }
  return null;
}

/** 构造安全调用包管理器的底层 command + args (零 shell: true) */
export function resolvePmInvocation(
  pm: PackageManager,
  pmArgs: readonly string[],
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  isFile: (path: string) => boolean = defaultIsFile,
): PmInvocation | null {
  const found = resolveExecutableInPath(pm, platform, env, isFile);
  if (found === null) return null;

  if (platform === 'win32' && found.isBatch) {
    const findNativeNode = (): string | null => {
      const nodeFound = resolveExecutableInPath('node', 'win32', env, isFile);
      return nodeFound !== null && !nodeFound.isBatch ? nodeFound.path : null;
    };
    return resolveWindowsBatchInvocation(
      pm,
      found.path,
      pmArgs,
      env,
      isFile,
      findNativeNode,
    );
  }
  return { command: found.path, args: [...pmArgs] };
}

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

/** 判断 Yarn 版本号是否为 v2+ (Berry 已移除 yarn global add) */
export function isYarnBerryVersion(versionText: string | null): boolean {
  if (versionText === null) return false;
  const m = /^v?(\d+)\./.exec(versionText.trim());
  if (m === null) return false;
  return Number(m[1]) >= 2;
}

/** 按包管理器构造全局安装参数数组 */
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

/**
 * 构造各包管理器升级子进程参数 (含 Yarn Berry 前置拦截与强输入校验)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  { pm: 'bun', packageName: '@iyowei/codd-cli', targetSpec: '1.3.0', explicitRegistry: 'https://r.example/' }
 * 步骤 1: 白名单校验 packageName / targetSpec / explicitRegistry, 归一 reg 并拼 displayCommand
 * 步骤 2: 若 pm === 'yarn' 且 yarnVersion >= 2 (Berry), 前置拦截拒绝 (无 yarn global add)
 * 步骤 3: buildPmUpgradeArgs + resolvePmInvocation (仅绝对 PATH 查找; Windows .cmd 走直调 JS 或 verbatim 单串)
 * Output: { ok: true, plan: { command, args, displayCommand, envOverlay, windowsVerbatimArguments? } }
 * ```
 */
export function buildUpgradePlan(
  input: BuildUpgradePlanInput,
): UpgradePlanOutcome {
  const targetSpec = input.targetSpec ?? 'latest';
  if (!isValidPackageName(input.packageName)) {
    return { ok: false, reason: `非法包名: ${input.packageName}` };
  }
  if (!isValidTargetSpec(targetSpec)) {
    return { ok: false, reason: `非法目标版本标签: ${targetSpec}` };
  }
  if (
    input.explicitRegistry !== undefined &&
    !isValidRegistryUrl(input.explicitRegistry)
  ) {
    return {
      ok: false,
      reason: `非法 registry 地址: ${input.explicitRegistry}`,
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
      reason:
        `当前环境的 Yarn (${input.yarnVersion?.trim()}) 为 v2+ (Berry), 官方已移除 yarn global add 命令, ` +
        '请改用 --pm bun / --pm npm / --pm pnpm 执行全局更新',
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
      reason: `当前 PATH 中未找到 ${input.pm} 可执行文件, 无法自动执行更新`,
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

/** 构造隔离后的子进程环境变量 (剥离可能干扰子管理器的 npm 生命周期残留变量) */
export function buildIsolatedEnv(
  baseEnv: NodeJS.ProcessEnv,
  overlay?: Record<string, string>,
): NodeJS.ProcessEnv {
  const next: NodeJS.ProcessEnv = { ...baseEnv };
  delete next.npm_execpath;
  delete next.npm_lifecycle_event;
  delete next.npm_lifecycle_script;
  delete next.npm_package_json;
  delete next.INIT_CWD;
  if (overlay !== undefined) Object.assign(next, overlay);
  return next;
}

/** 在隔离的临时空目录下执行回调 (隔绝当前目录的 .npmrc / bunfig.toml / package.json) */
function withIsolatedCwd<T>(fn: (cwd: string) => T): T {
  const dir = mkdtempSync(join(tmpdir(), 'cli-update-'));
  try {
    return fn(dir);
  } finally {
    try {
      rmSync(dir, {
        recursive: true,
        force: true,
        maxRetries: 3,
        retryDelay: 50,
      });
    } catch {
      // 清理失败不影响主流程结果
    }
  }
}

/** 在指定隔离目录内执行轻量只读探针 (注入防 Corepack 阻塞变量并透传 windowsVerbatimArguments) */
function runIsolatedProbe(
  cwd: string,
  invocation: PmInvocation,
  env: NodeJS.ProcessEnv,
  spawnFn: SpawnLike,
): string | null {
  const res = spawnFn(invocation.command, invocation.args, {
    cwd,
    env: buildIsolatedEnv(env, PROBE_ENV_OVERLAY),
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
    timeout: 3000,
    ...(invocation.windowsVerbatimArguments === true
      ? { windowsVerbatimArguments: true }
      : {}),
  });
  if (res.status !== 0 || typeof res.stdout !== 'string') return null;
  const text = res.stdout.trim();
  return text === '' ? null : text;
}

/** 探测本机 Yarn 版本号 (用于判断是否 Yarn Berry); 失败返回 null */
export function probeYarnVersion(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnLike = spawnSync as unknown as SpawnLike,
): string | null {
  const invocation = resolvePmInvocation('yarn', ['--version'], platform, env);
  if (invocation === null) return null;
  return withIsolatedCwd((cwd) =>
    runIsolatedProbe(cwd, invocation, env, spawnFn),
  );
}

/** 按目标平台分隔符拼接路径 */
const joinForPlatform = (p: NodeJS.Platform, ...parts: string[]): string =>
  p === 'win32' ? win32.join(...parts) : posix.join(...parts);

/** 展开 bunfig.toml 中可能以 `~` 开头的 globalDir 路径 */
function expandHomeDir(raw: string, home: string, p: NodeJS.Platform): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return joinForPlatform(p, home, raw.slice(2));
  }
  return raw;
}

/** 从 ~/.bunfig.toml 读取 [install] globalDir 填入自定义 Bun 全局根 */
function resolveBunGlobalDirFromConfig(
  home: string,
  platform: NodeJS.Platform,
  readText: (path: string) => string | null,
  pathExists: (path: string) => boolean,
): string | null {
  const bunfig = readText(joinForPlatform(platform, home, '.bunfig.toml'));
  if (bunfig === null) return null;
  const rawDir = parseGlobalDirFromBunfig(bunfig);
  if (rawDir === null) return null;
  const expanded = expandHomeDir(rawDir, home, platform);
  return pathExists(expanded) ? safeRealpath(expanded) : null;
}

/**
 * 动态实查兜底: 仅在纯路径特征未命中时, 轻探测本机包管理器自定义全局根目录。
 * 全探针复用单一临时空目录、注入 COREPACK_ENABLE_DOWNLOAD_PROMPT=0、带 3 秒超时, 失败静默跳过。
 *
 * ### 数据流转示例
 * ```text
 * Input:  (platform, env, spawnFn, options?)
 * 步骤 1: 读 ~/.bunfig.toml 的 [install] globalDir (展开 ~ 并校验存在) -> roots.bun
 * 步骤 2: 建单一临时空目录 cwd, 依次跑 `pnpm root -g` / `npm root -g` / (Yarn v1 才跑 `yarn global dir`)
 * 步骤 3: 每项输出取首行、验证存在并 safeRealpath 归一后落盘, finally 清理临时空目录
 * Output: GlobalRootMap ({ bun?, pnpm?, npm?, yarn? })
 * ```
 */
export function probeGlobalRoots(
  platform: NodeJS.Platform = process.platform,
  env: NodeJS.ProcessEnv = process.env,
  spawnFn: SpawnLike = spawnSync as unknown as SpawnLike,
  options?: ProbeGlobalRootsOptions,
): GlobalRootMap {
  const roots: GlobalRootMap = {};
  const home = options?.homeDir ?? homedir();
  const readText = options?.readText ?? defaultReadText;
  const pathExists = options?.pathExists ?? existsSync;
  const isFile = options?.isFile ?? defaultIsFile;

  const bunDir = resolveBunGlobalDirFromConfig(
    home,
    platform,
    readText,
    pathExists,
  );
  if (bunDir !== null) roots.bun = bunDir;

  withIsolatedCwd((cwd) => {
    const probeDir = (
      pm: PackageManager,
      args: readonly string[],
    ): string | null => {
      const invocation = resolvePmInvocation(pm, args, platform, env, isFile);
      if (invocation === null) return null;
      const stdout = runIsolatedProbe(cwd, invocation, env, spawnFn);
      if (stdout === null) return null;
      const line = stdout.split(/\r?\n/)[0]?.trim() ?? '';
      if (line === '' || !pathExists(line)) return null;
      return safeRealpath(line);
    };

    const pnpmRoot = probeDir('pnpm', ['root', '-g']);
    if (pnpmRoot !== null) roots.pnpm = pnpmRoot;

    const npmRoot = probeDir('npm', ['root', '-g']);
    if (npmRoot !== null) roots.npm = npmRoot;

    const yarnVerInv = resolvePmInvocation(
      'yarn',
      ['--version'],
      platform,
      env,
      isFile,
    );
    const yarnVer =
      yarnVerInv !== null
        ? runIsolatedProbe(cwd, yarnVerInv, env, spawnFn)
        : null;
    if (yarnVer !== null && !isYarnBerryVersion(yarnVer)) {
      const yarnDir = probeDir('yarn', ['global', 'dir']);
      if (yarnDir !== null) roots.yarn = yarnDir;
    }
  });

  return roots;
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
