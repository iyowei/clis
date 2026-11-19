/**
 * 包内置模板资产定位与点号载体文件名还原。
 * 向上逐级查找同时存在 package.json 与模板目录 (assets/template 或 template) 的包根,
 * 确保在源码态 (packages/codd/src/assets.ts)、API 产物态 (packages/codd/dist/index.js)、
 * CLI 打包态 (packages/codd-cli/dist/cli.js) 与 npm 装包态下全部精准命中各自包根。
 */
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * 真实模板文件名 -> 发行资产载体文件名映射 (单源定义, 构建与生成两端共用):
 * 防止 npm / yarn / pnpm / bun 打包或解包时剔除 .dockerignore / .helmignore / .env.tmpl。
 */
export const ASSET_CARRIERS: Readonly<Record<string, string>> = {
  '.dockerignore': '_dockerignore',
  '.env.tmpl': 'env.tmpl',
  '.helmignore': '_helmignore',
};

const MAX_PACKAGE_ASCENT = 8;

const hasTemplateDir = (dir: string): boolean =>
  existsSync(join(dir, 'assets/template')) || existsSync(join(dir, 'template'));

export const resolvePackageRoot = (
  moduleUrl: string = import.meta.url,
): string => {
  const startDir = dirname(fileURLToPath(moduleUrl));
  let cur = startDir;
  let nearestPkgDir: string | null = null;

  for (let depth = 0; depth < MAX_PACKAGE_ASCENT; depth += 1) {
    if (existsSync(join(cur, 'package.json'))) {
      if (nearestPkgDir === null) nearestPkgDir = cur;
      if (hasTemplateDir(cur)) return cur;
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }

  return nearestPkgDir ?? resolve(startDir, '..');
};

export const resolveTemplateRoot = (
  overrideDir?: string,
  moduleUrl: string = import.meta.url,
): string => {
  if (overrideDir) return resolve(overrideDir);
  const envDir = process.env.CODD_TEMPLATE_DIR?.trim();
  if (envDir) return resolve(envDir);

  const pkgRoot = resolvePackageRoot(moduleUrl);
  const builtAssetsDir = join(pkgRoot, 'assets/template');
  if (existsSync(builtAssetsDir)) {
    return builtAssetsDir;
  }
  const sourceTemplateDir = join(pkgRoot, 'template');
  if (existsSync(sourceTemplateDir)) {
    return sourceTemplateDir;
  }
  throw new Error(
    `找不到 codd 模板资产目录 (已检查 ${builtAssetsDir}), 请重新安装 @iyowei/codd 或执行 bun run build`,
  );
};

/**
 * 解析模板目录中的物理文件路径: 优先匹配无点载体文件名 (assets/template/), 回退匹配原始文件名 (template/)。
 */
export const resolveTemplateFilePath = (
  subDir: string,
  realFileName: string,
): string => {
  const carrierName = ASSET_CARRIERS[realFileName];
  if (carrierName) {
    const carrierPath = join(subDir, carrierName);
    if (existsSync(carrierPath)) return carrierPath;
  }
  return join(subDir, realFileName);
};

export const readTemplateFile = (
  subDir: string,
  realFileName: string,
): string =>
  readFileSync(resolveTemplateFilePath(subDir, realFileName), 'utf8');

export const copyTemplateFile = (
  subDir: string,
  realFileName: string,
  targetPath: string,
): void => {
  copyFileSync(resolveTemplateFilePath(subDir, realFileName), targetPath);
};

export const readPackageVersion = (
  moduleUrl: string = import.meta.url,
): string => {
  const startDir = dirname(fileURLToPath(moduleUrl));
  let cur = startDir;
  for (let depth = 0; depth < MAX_PACKAGE_ASCENT; depth += 1) {
    const pkgPath = join(cur, 'package.json');
    if (existsSync(pkgPath)) {
      const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
        version?: string;
      };
      return parsed.version ?? '1.0.0';
    }
    const parent = dirname(cur);
    if (parent === cur) break;
    cur = parent;
  }
  return '1.0.0';
};
