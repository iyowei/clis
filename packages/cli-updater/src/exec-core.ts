/**
 * 绝对 PATH 可执行文件解析、包管理器安全调用构造与隔离临时目录原语 (零循环底层原语)。
 */
import { type SpawnSyncReturns } from 'node:child_process';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, posix, win32 } from 'node:path';

import { type PackageManager } from './detect.ts';
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

const WIN32_NATIVE_EXTS = ['.exe', '.com'] as const;
const WIN32_BATCH_EXTS = ['.cmd', '.bat'] as const;

/** 默认常规文件探针 */
export function defaultIsFile(path: string): boolean {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
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

/** 判断 Yarn 版本号是否为 v2+ (Berry 已移除 yarn global add) */
export function isYarnBerryVersion(versionText: string | null): boolean {
  if (versionText === null) return false;
  const m = /^v?(\d+)\./.exec(versionText.trim());
  if (m === null) return false;
  return Number(m[1]) >= 2;
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
export function withIsolatedCwd<T>(fn: (cwd: string) => T): T {
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
