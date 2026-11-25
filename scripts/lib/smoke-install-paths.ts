/**
 * CLI 装包冒烟 · 纯路径派生、工作区发现与纯净 Node PATH 构造辅助。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  linkSync,
  mkdirSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type WorkspacePackage,
  listRuntimeDeps,
  listWorkspacePackages,
} from './workspace.ts';

export interface BinEntry {
  name: string;
  relPath: string;
}

export interface CliPackageTarget {
  pkg: WorkspacePackage;
  version: string;
  bins: BinEntry[];
  hasRuntimeDeps: boolean;
}

/** 从 `package.json` 的 `bin` 字段解析有序可执行入口表 */
export function resolveBinEntries(pkg: WorkspacePackage): BinEntry[] {
  const raw = pkg.manifest.bin;
  if (typeof raw === 'string') {
    const trimmed = raw.trim();
    if (trimmed === '') return [];
    const unscoped = pkg.name.includes('/')
      ? (pkg.name.split('/').pop() ?? pkg.name)
      : pkg.name;
    return [{ name: unscoped, relPath: trimmed }];
  }
  if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) {
    return [];
  }
  const entries: BinEntry[] = [];
  for (const name of Object.keys(raw as Record<string, unknown>).sort()) {
    const rel = (raw as Record<string, unknown>)[name];
    if (typeof rel === 'string' && rel.trim() !== '') {
      entries.push({ name, relPath: rel.trim() });
    }
  }
  return entries;
}

/** 枚举工作区中全部 CLI 包 */
export function resolveCliPackages(root: string): CliPackageTarget[] {
  const targets: CliPackageTarget[] = [];
  for (const pkg of listWorkspacePackages(root)) {
    const bins = resolveBinEntries(pkg);
    if (bins.length === 0) continue;
    const version =
      typeof pkg.manifest.version === 'string' ? pkg.manifest.version : '';
    if (version === '') {
      throw new Error(
        `CLI 包 ${pkg.name} (${pkg.dir}) 缺少有效的 version 字段`,
      );
    }
    targets.push({
      pkg,
      version,
      bins,
      hasRuntimeDeps: listRuntimeDeps(pkg).length > 0,
    });
  }
  return targets;
}

function unquotePathDir(segment: string): string {
  const trimmed = segment.trim();
  if (trimmed.length >= 2 && trimmed.startsWith('"') && trimmed.endsWith('"')) {
    return trimmed.slice(1, -1).trim();
  }
  return trimmed;
}

/** 按宿主机 `PATH` 分隔符拆分有效目录列表 */
export function splitPathList(
  pathValue: string,
  platform: NodeJS.Platform = process.platform,
): string[] {
  const sep = platform === 'win32' ? ';' : ':';
  return pathValue
    .split(sep)
    .map((item) => (platform === 'win32' ? unquotePathDir(item) : item.trim()))
    .filter((item) => item !== '');
}

function defaultHasBunInDir(
  platform: NodeJS.Platform,
): (dir: string) => boolean {
  const names =
    platform === 'win32' ? ['bun.exe', 'bun.com', 'bun.cmd'] : ['bun'];
  return (dir) => names.some((file) => existsSync(join(dir, file)));
}

/** 构造不含任何 `bun` 目录、仅保留指定 `node` 绝对路径目录的纯净 `PATH` */
export function buildNodeOnlyPath(
  pathValue: string,
  nodeBinDir: string,
  platform: NodeJS.Platform = process.platform,
  hasBunInDir: (dir: string) => boolean = defaultHasBunInDir(platform),
): string {
  const sep = platform === 'win32' ? ';' : ':';
  const kept = [nodeBinDir];
  const seen = new Set<string>([
    platform === 'win32' ? nodeBinDir.toLowerCase() : nodeBinDir,
  ]);
  for (const dir of splitPathList(pathValue, platform)) {
    if (hasBunInDir(dir)) continue;
    const key = platform === 'win32' ? dir.toLowerCase() : dir;
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(dir);
  }
  return kept.join(sep);
}

/** 计算 `npm install --global --prefix` 落盘的包目录路径 */
export function resolveNpmInstalledPackageDir(
  prefix: string,
  pkgName: string,
  platform: NodeJS.Platform = process.platform,
): string {
  const nameSegments = pkgName.split('/');
  return platform === 'win32'
    ? join(prefix, 'node_modules', ...nameSegments)
    : join(prefix, 'lib', 'node_modules', ...nameSegments);
}

/** 计算 `npm install --global --prefix` 生成的可执行 shim 与配套文件 */
export function resolveNpmGlobalShim(
  prefix: string,
  binName: string,
  platform: NodeJS.Platform = process.platform,
): { executable: string; companionFiles: string[] } {
  if (platform === 'win32') {
    return {
      executable: join(prefix, `${binName}.cmd`),
      companionFiles: [join(prefix, `${binName}.ps1`)],
    };
  }
  return { executable: join(prefix, 'bin', binName), companionFiles: [] };
}

/** 计算 `bun add --cwd` 落盘的 `node_modules/.bin` 可执行入口 */
export function resolveBunLocalShim(
  bunHostDir: string,
  binName: string,
  platform: NodeJS.Platform = process.platform,
  pathExists: (path: string) => boolean = existsSync,
): string {
  const binDir = join(bunHostDir, 'node_modules', '.bin');
  if (platform === 'win32') {
    for (const ext of ['.exe', '.cmd', '.bunx']) {
      const candidate = join(binDir, `${binName}${ext}`);
      if (pathExists(candidate)) return candidate;
    }
  }
  return join(binDir, binName);
}

const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

/** 清理易覆写 `--prefix` 参数的 npm 环境变量并禁用更新提示 */
export function buildNpmProcessEnv(base: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const clean: NodeJS.ProcessEnv = { ...base };
  for (const key of Object.keys(clean)) {
    if (key.toUpperCase() === 'NPM_CONFIG_PREFIX') delete clean[key];
  }
  return {
    ...clean,
    NO_UPDATE_NOTIFIER: '1',
    npm_config_update_notifier: 'false',
    npm_config_fund: 'false',
    npm_config_audit: 'false',
  };
}

function isSupportedNode(versionText: string): boolean {
  const match = /^v?(\d+)\.(\d+)/.exec(versionText.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  );
}

function resolveHostNodeExecutable(): string {
  const ver = spawnSync(
    'node',
    ['-e', 'process.stdout.write(process.version + "\\n" + process.execPath)'],
    { encoding: 'utf8', timeout: 10_000 },
  );
  if (ver.status !== 0) {
    throw new Error(
      `无法检测可用 node 可执行文件: ${ver.stderr || ver.error?.message || '未知错误'}`,
    );
  }
  const [rawVersion = '', rawExec = ''] = (ver.stdout ?? '').trim().split('\n');
  if (!isSupportedNode(rawVersion)) {
    throw new Error(
      `宿主机 node 版本不满足 >= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0 (当前: ${rawVersion})`,
    );
  }
  if (rawExec === '' || !existsSync(rawExec)) {
    throw new Error(`解析到的 node 路径无效: ${rawExec}`);
  }
  return rawExec;
}

/** 构造不含任何 bun 目录、仅保留独立 `node` 入口的纯净 Node 运行环境 */
export function preparePureNodeEnv(
  sandboxDir: string,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  const nodeExec = resolveHostNodeExecutable();
  const nodeOnlyDir = join(sandboxDir, 'node-only-bin');
  mkdirSync(nodeOnlyDir, { recursive: true });
  if (platform === 'win32') {
    const target = join(nodeOnlyDir, 'node.exe');
    try {
      linkSync(nodeExec, target);
    } catch {
      copyFileSync(nodeExec, target);
    }
  } else {
    symlinkSync(nodeExec, join(nodeOnlyDir, 'node'));
  }

  const rawPath = process.env.PATH ?? process.env.Path ?? '';
  const nextPath = buildNodeOnlyPath(rawPath, nodeOnlyDir, platform);
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of Object.keys(env)) {
    if (key.toUpperCase() === 'PATH') delete env[key];
  }
  env.PATH = nextPath;
  return env;
}

/** 创建包含损坏 `bunfig.toml` 与恶意 `preload` 的脏工作目录 */
export function preparePoisonedCwd(sandboxDir: string): string {
  const dirtyCwd = join(sandboxDir, 'poisoned-cwd');
  mkdirSync(dirtyCwd, { recursive: true });
  writeFileSync(
    join(dirtyCwd, 'bunfig.toml'),
    'preload = ["./evil.js"]\n[[broken toml\n',
    'utf8',
  );
  writeFileSync(
    join(dirtyCwd, 'evil.js'),
    "throw new Error('PRELOAD_HIJACKED');\n",
    'utf8',
  );
  return dirtyCwd;
}
