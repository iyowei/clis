/**
 * 文档类静态闸门的共享底座: 仓库根定位与文件走查。
 * 调用方: 引用闸门 / 示例闸门 / 仓库卫生 / 依赖方向 / 发布凭据 / 语料覆盖闸门。
 *
 * 走查跳过清单统一在此维护: 依赖目录与生成物 (node_modules / .git / .turbo / dist / .claude)
 * 不含待查文档, mutants 为变异自证的一次性副本 (引用与示例均不适用于副本场景);
 * 生成器与部署工具包的模板空间 (assets / template / template-skeletons) 的链接与示例只在
 * 目标项目语境成立, 文档类闸门默认跳过; 仓库卫生闸门可通过 skipPaths: [] 扫描模板源码目录。
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

/**
 * 走查跳过路径 (仓库相对目录, POSIX 斜杠, 以 `/` 收尾):
 * 模板空间与派生资产目录内的链接/示例面向生成后的目标环境, 不属于本仓文档面。
 * 同款排除见 .gitignore / .prettierignore / .oxlintrc.json / tsconfig.json / bunfig.toml。
 */
export const SKIP_PATHS: readonly string[] = [
  'packages/create-clis/assets/',
  'packages/create-clis/scripts/template-skeletons/',
  'packages/codd/assets/',
  'packages/codd/template/',
  'packages/codd-cli/assets/',
];

/** 走查选项 */
export interface WalkFilesOptions {
  /** 覆写跳过路径列表 (默认 SKIP_PATHS; 传 [] 表示不跳任何业务目录, 仅跳 SKIP_DIRS) */
  skipPaths?: readonly string[];
}

/** 相对路径转 POSIX 分隔符 */
const toPosixRelative = (root: string, abs: string): string =>
  relative(root, abs).replaceAll('\\', '/');

/** 相对路径是否落在跳过面内 (目录前缀匹配) */
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
