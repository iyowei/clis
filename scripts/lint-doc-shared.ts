/**
 * 文档类静态闸门的共享底座: 仓库根定位与文件走查 (引用闸门 / 示例闸门 / 仓库卫生共用)。
 *
 * 走查跳过清单统一在此维护: 依赖目录与生成物 (node_modules / .git / .turbo / dist) 不含
 * 待查文档, mutants 为变异自证的一次性副本 (源码拷贝, 引用与示例均不适用于副本场景)。
 */
import { readdirSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 仓库根 (scripts/ 的上一级) */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

/** 走查跳过目录: 依赖 / 版本控制 / 构建缓存 / 生成物 / 变异副本 */
export const SKIP_DIRS: ReadonlySet<string> = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'mutants',
]);

/** 按扩展名走查文件, 返回仓库相对路径 (字典序, 稳定输出) */
export function walkFiles(
  root: string,
  extensions: readonly string[],
): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (SKIP_DIRS.has(entry.name)) continue;
      const abs = join(dir, entry.name);
      if (entry.isDirectory()) walk(abs);
      else if (extensions.some((ext) => entry.name.endsWith(ext))) {
        out.push(abs.slice(root.length + 1));
      }
    }
  };
  walk(root);
  return out.sort();
}
