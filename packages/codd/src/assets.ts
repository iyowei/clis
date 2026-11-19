/**
 * 包内置模板资产定位与点号载体文件名还原。
 * 源码态 (src/assets.ts) 与打包态 (dist/cli.js) 均位于包根一级子目录下,
 * 故 new URL('..', import.meta.url) 恒定解析到 packages/codd 包根目录。
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

export const resolvePackageRoot = (
  moduleUrl: string = import.meta.url,
): string => resolve(dirname(fileURLToPath(moduleUrl)), '..');

export const resolveTemplateRoot = (overrideDir?: string): string => {
  if (overrideDir) return resolve(overrideDir);
  const envDir = process.env.CODD_TEMPLATE_DIR?.trim();
  if (envDir) return resolve(envDir);

  const pkgRoot = resolvePackageRoot();
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

export const readPackageVersion = (): string => {
  const pkgPath = join(resolvePackageRoot(), 'package.json');
  const parsed = JSON.parse(readFileSync(pkgPath, 'utf8')) as {
    version?: string;
  };
  return parsed.version ?? '1.0.0';
};
