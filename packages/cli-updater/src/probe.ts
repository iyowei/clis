/**
 * 自定义全局安装目录只读实查探针 (复用单一隔离临时空目录、带超时与防 Corepack 阻塞保护)。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { parseGlobalDirFromBunfig } from './config-parse.ts';
import {
  type GlobalRootMap,
  type PackageManager,
  safeRealpath,
} from './detect.ts';
import {
  type PmInvocation,
  type SpawnLike,
  buildIsolatedEnv,
  defaultIsFile,
  isYarnBerryVersion,
  resolvePmInvocation,
  withIsolatedCwd,
} from './exec-core.ts';

/** 动态探测全局目录的可选依赖注入 */
export interface ProbeGlobalRootsOptions {
  homeDir?: string;
  readText?: (path: string) => string | null;
  pathExists?: (path: string) => boolean;
  isFile?: (path: string) => boolean;
}

const PROBE_ENV_OVERLAY: Record<string, string> = {
  COREPACK_ENABLE_DOWNLOAD_PROMPT: '0',
};

function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

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

const joinForPlatform = (p: NodeJS.Platform, ...parts: string[]): string =>
  p === 'win32' ? win32.join(...parts) : posix.join(...parts);

function expandHomeDir(raw: string, home: string, p: NodeJS.Platform): string {
  if (raw === '~') return home;
  if (raw.startsWith('~/') || raw.startsWith('~\\')) {
    return joinForPlatform(p, home, raw.slice(2));
  }
  return raw;
}

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
