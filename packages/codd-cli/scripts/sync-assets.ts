/**
 * CLI 包资产同步脚本: 从兄弟包 ../codd/assets 同步模板资产与 manifest.json 至 packages/codd-cli/assets/,
 * 使 @iyowei/codd-cli 在独立发布与离线安装时 100% 自包含、零外部运行时依赖。
 * 当 ../codd/scripts/build-assets.ts 存在时每次先同步重建 ../codd/assets 防打入过期模板,
 * 再严格按 parsed.files 白名单精准拷贝避免带入杂文件。
 */
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { buildCoddAssets } from '../../codd/scripts/build-assets.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

const assertSafeRelativeAsset = (rel: string): string[] => {
  if (rel === '' || isAbsolute(rel) || rel.includes('\\')) {
    throw new Error(`源资产清单包含非法相对路径: ${rel}`);
  }
  const parts = rel.split('/');
  if (parts.some((seg) => seg === '' || seg === '.' || seg === '..')) {
    throw new Error(`源资产清单包含越界或空路径段: ${rel}`);
  }
  return parts;
};

const refreshSourceAssets = (apiPkgRoot: string, srcManifest: string): void => {
  const buildScript = join(apiPkgRoot, 'scripts/build-assets.ts');
  if (existsSync(buildScript)) {
    if (resolve(apiPkgRoot) === resolve(PACKAGE_ROOT, '../codd')) {
      buildCoddAssets(apiPkgRoot);
      return;
    }
    const res = spawnSync(process.execPath, [buildScript], {
      cwd: apiPkgRoot,
      stdio: 'inherit',
    });
    if (res.error) {
      throw new Error(
        `自动构建 @iyowei/codd 模板资产失败: ${res.error.message}`,
      );
    }
    if (res.status !== 0) {
      throw new Error(
        `自动构建 @iyowei/codd 模板资产失败 (退出码 ${res.status ?? 1})`,
      );
    }
    return;
  }

  if (!existsSync(srcManifest)) {
    throw new Error(
      `找不到 @iyowei/codd 模板资产 (${srcManifest}), 请先构建 @iyowei/codd`,
    );
  }
};

export const syncCoddCliAssets = (
  cliPkgRoot: string = PACKAGE_ROOT,
  apiPkgRoot: string = resolve(cliPkgRoot, '../codd'),
): string[] => {
  const srcAssets = join(apiPkgRoot, 'assets');
  const srcManifest = join(srcAssets, 'manifest.json');

  refreshSourceAssets(apiPkgRoot, srcManifest);

  const parsed = JSON.parse(readFileSync(srcManifest, 'utf8')) as {
    schemaVersion?: number;
    files?: unknown;
  };
  if (
    parsed.schemaVersion !== 1 ||
    !Array.isArray(parsed.files) ||
    parsed.files.some((f) => typeof f !== 'string' || f === '')
  ) {
    throw new Error(`源资产清单形状不合法: ${srcManifest}`);
  }

  const files = parsed.files as string[];
  const dstAssets = join(cliPkgRoot, 'assets');
  const dstTemplateRoot = join(dstAssets, 'template');
  rmSync(dstAssets, { recursive: true, force: true });
  mkdirSync(dstTemplateRoot, { recursive: true });
  copyFileSync(srcManifest, join(dstAssets, 'manifest.json'));

  for (const rel of files) {
    const parts = assertSafeRelativeAsset(rel);
    const srcFile = join(srcAssets, 'template', ...parts);
    if (!existsSync(srcFile)) {
      throw new Error(`源资产清单声明的文件缺失: ${srcFile}`);
    }
    const dstFile = join(dstTemplateRoot, ...parts);
    mkdirSync(dirname(dstFile), { recursive: true });
    copyFileSync(srcFile, dstFile);
  }

  return files;
};

if (import.meta.main) {
  const files = syncCoddCliAssets();
  process.stdout.write(
    `codd-cli 已同步 ${files.length} 个模板资产至 assets/template/\n`,
  );
}
