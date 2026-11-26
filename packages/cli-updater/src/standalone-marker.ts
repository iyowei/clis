/**
 * 独立一键脚本安装标记 (`.clis-install.json`) 解析与安全校验。
 *
 * 安全不变量:
 * 1. `tool` 严格限制为小写字母、数字与连字符 (`^[a-z0-9][a-z0-9-]{0,31}$`), 阻断 staging/backup 目录名路径穿越;
 * 2. `packageName` 须通过合法 npm 包名校验;
 * 3. `dataDir` / `appDir` / `runtimeDir` / `binPath` 必须全部为绝对路径且不含控制字符, 杜绝相对工作目录 (CWD) 二进制劫持;
 * 4. `appDir` 与 `runtimeDir` 必须位于 `dataDir` 之内, 且 `resolveStandaloneOrigin` 强制核对标记内 `appDir` 与当前包根目录一致。
 */
import { readFileSync, renameSync, rmSync } from 'node:fs';
import { join, posix, win32 } from 'node:path';

import { isValidPackageName } from './semver.ts';

/** 独立脚本安装标记文件名 */
export const STANDALONE_MARKER_FILE = '.clis-install.json';

const SAFE_TOOL_NAME_RE = /^[a-z0-9][a-z0-9-]{0,31}$/;
const CONTROL_CHAR_RE = /[\0\r\n]/;

/** 独立脚本安装标记文件内容 */
export interface StandaloneInstallMarker {
  schemaVersion: 1;
  method: 'script';
  tool: string;
  packageName: string;
  dataDir: string;
  appDir: string;
  runtimeDir: string;
  binPath: string;
  version?: string;
  updatedAt?: string;
}

/** 独立脚本安装来源结构 */
export interface StandaloneOrigin {
  kind: 'standalone';
  tool: string;
  packageName: string;
  dataDir: string;
  appDir: string;
  runtimeDir: string;
  binPath: string;
  reason: string;
  packageRoot: string;
}

/** 安全读取 UTF-8 文本文件 (不存在或不可读时返回 null) */
export function readTextOrNull(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

function asSafeString(val: unknown): string | null {
  if (typeof val !== 'string') return null;
  const trimmed = val.trim();
  if (trimmed === '' || CONTROL_CHAR_RE.test(trimmed)) return null;
  return trimmed;
}

function isAbsoluteAnyFlavor(rawPath: string): boolean {
  if (CONTROL_CHAR_RE.test(rawPath)) return false;
  if (rawPath.startsWith('/')) return posix.isAbsolute(rawPath);
  if (/^(?:[A-Za-z]:[/\\]|\\\\[^\\/]+\\[^\\/]+)/.test(rawPath)) {
    return win32.isAbsolute(rawPath);
  }
  return false;
}

function normalizeCanonicalPath(rawPath: string): string {
  const isWin =
    /^(?:[A-Za-z]:[/\\]|\\\\)/.test(rawPath) || rawPath.includes('\\');
  const resolved = isWin ? win32.normalize(rawPath) : posix.normalize(rawPath);
  return resolved.replaceAll('\\', '/').replace(/\/+$/, '');
}

function isSubPathOrEqual(childPath: string, parentPath: string): boolean {
  const child = normalizeCanonicalPath(childPath).toLowerCase();
  const parent = normalizeCanonicalPath(parentPath).toLowerCase();
  if (child === '' || parent === '') return false;
  return child === parent || child.startsWith(`${parent}/`);
}

function hasTraversalSegment(rawPath: string): boolean {
  const segs = rawPath.replaceAll('\\', '/').split('/');
  return segs.includes('..');
}

/** 解析并严格校验独立脚本安装标记 (`.clis-install.json`) */
export function parseStandaloneInstallMarker(
  raw: string | null | undefined,
): StandaloneInstallMarker | null {
  if (typeof raw !== 'string' || raw.trim() === '') return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return null;
  }
  const obj = parsed as Record<string, unknown>;
  if (obj.schemaVersion !== 1 || obj.method !== 'script') return null;

  const tool = asSafeString(obj.tool);
  const packageName = asSafeString(obj.packageName);
  const dataDir = asSafeString(obj.dataDir);
  const appDir = asSafeString(obj.appDir);
  const runtimeDir = asSafeString(obj.runtimeDir);
  const binPath = asSafeString(obj.binPath);
  if (
    tool === null ||
    !SAFE_TOOL_NAME_RE.test(tool) ||
    packageName === null ||
    !isValidPackageName(packageName) ||
    dataDir === null ||
    appDir === null ||
    runtimeDir === null ||
    binPath === null
  ) {
    return null;
  }

  const paths = [dataDir, appDir, runtimeDir, binPath];
  if (
    paths.some((p) => !isAbsoluteAnyFlavor(p) || hasTraversalSegment(p)) ||
    !isSubPathOrEqual(appDir, dataDir) ||
    !isSubPathOrEqual(runtimeDir, dataDir)
  ) {
    return null;
  }

  return {
    schemaVersion: 1,
    method: 'script',
    tool,
    packageName,
    dataDir,
    appDir,
    runtimeDir,
    binPath,
    version: asSafeString(obj.version) ?? undefined,
    updatedAt: asSafeString(obj.updatedAt) ?? undefined,
  };
}

/** 根据独立安装标记构建 `standalone` 来源对象 (核验 `appDir` 与实际 `packageRoot` 同源) */
export function resolveStandaloneOrigin(
  rawPackageRoot: string,
  normalizedRoot: string,
  readText: (path: string) => string | null,
  joinPath: (base: string, ...segments: readonly string[]) => string,
): StandaloneOrigin | null {
  const marker = parseStandaloneInstallMarker(
    readText(joinPath(rawPackageRoot, STANDALONE_MARKER_FILE)),
  );
  if (marker === null) return null;

  const markerApp = normalizeCanonicalPath(marker.appDir).toLowerCase();
  const actualNorm = normalizeCanonicalPath(normalizedRoot).toLowerCase();
  const actualRaw = normalizeCanonicalPath(rawPackageRoot).toLowerCase();
  if (markerApp !== actualNorm && markerApp !== actualRaw) {
    return null;
  }

  return {
    kind: 'standalone',
    tool: marker.tool,
    packageName: marker.packageName,
    dataDir: marker.dataDir,
    appDir: marker.appDir,
    runtimeDir: marker.runtimeDir,
    binPath: marker.binPath,
    reason: '独立脚本安装 (.clis-install.json)',
    packageRoot: normalizedRoot,
  };
}

export interface ParsedExtractedPkg {
  name?: string;
  version?: string;
  bin?: unknown;
  dependencies?: Record<string, string>;
}

/** 读取解包后临时目录内的 package.json 关键字段 */
export function readExtractedPackageJson(
  stagingDir: string,
): ParsedExtractedPkg | null {
  try {
    const raw = readFileSync(join(stagingDir, 'package.json'), 'utf8');
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (typeof parsed !== 'object' || parsed === null) return null;
    const depsRaw = parsed.dependencies;
    let dependencies: Record<string, string> | undefined;
    if (
      typeof depsRaw === 'object' &&
      depsRaw !== null &&
      !Array.isArray(depsRaw)
    ) {
      const entries = Object.entries(depsRaw).filter(
        (pair): pair is [string, string] => typeof pair[1] === 'string',
      );
      if (entries.length > 0) {
        dependencies = Object.fromEntries(entries);
      }
    }
    return {
      name: typeof parsed.name === 'string' ? parsed.name : undefined,
      version: typeof parsed.version === 'string' ? parsed.version : undefined,
      bin: parsed.bin,
      dependencies,
    };
  } catch {
    return null;
  }
}

/** 尽力清理临时目录或旧备份目录 (失败不覆盖主流程结果) */
export function removeDirBestEffort(dir: string): void {
  try {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
  } catch {
    // 忽略清理异常
  }
}

function sleepSyncMs(ms: number): void {
  const buf = new SharedArrayBuffer(4);
  Atomics.wait(new Int32Array(buf), 0, 0, ms);
}

/** 带短暂指数退避的原子目录重命名 (缓解 Windows 瞬态句柄占用) */
export function renameWithRetry(src: string, dest: string): void {
  const maxAttempts = 4;
  let lastError: unknown;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      renameSync(src, dest);
      return;
    } catch (error) {
      lastError = error;
      const code =
        typeof error === 'object' && error !== null && 'code' in error
          ? String((error as { code?: unknown }).code)
          : '';
      if (
        (code === 'EBUSY' || code === 'EPERM' || code === 'EACCES') &&
        attempt + 1 < maxAttempts
      ) {
        sleepSyncMs(60 * (attempt + 1));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}
