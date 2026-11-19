/**
 * 文档类静态闸门的共享底座: 仓库根定位与文件走查 (引用闸门 / 示例闸门 / 仓库卫生共用)。
 */
import { readdirSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根 (scripts/ 的上一级) */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 走查跳过目录: 依赖 / 版本控制 / 构建缓存 / 生成物 / 变异副本 / 宿主运行时状态 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'mutants',
  '.claude',
]);

/** 走查跳过路径 (仓库相对目录, POSIX 斜杠, 以 `/` 收尾) */
export const SKIP_PATHS: readonly string[] = [];

/** 走查选项 */
export interface WalkFilesOptions {
  skipPaths?: readonly string[];
}

const toPosixRelative = (root: string, abs: string): string =>
  relative(root, abs).replaceAll('\\', '/');

function isSkippedPath(
  relativePath: string,
  skipPaths: readonly string[],
): boolean {
  return skipPaths.some((prefix) => `${relativePath}/`.startsWith(prefix));
}

/** 按扩展名走查文件, 返回仓库相对路径 (POSIX 斜杠, 字典序, 稳定输出) */
export function walkFiles(
  root: string,
  extensions: readonly string[],
  options: WalkFilesOptions = {},
): string[] {
  const normalizedRoot = resolve(root);
  const skipPaths = options.skipPaths ?? SKIP_PATHS;
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      const rel = toPosixRelative(normalizedRoot, abs);
      if (entry.isDirectory()) {
        if (!isSkippedPath(rel, skipPaths)) walk(abs);
      } else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(rel);
      }
    }
  };
  walk(normalizedRoot);
  return out.sort();
}
