/**
 * CLI 包资产同步脚本: 从兄弟包 ../codd/assets 同步模板资产与 manifest.json 至 packages/codd-cli/assets/,
 * 使 @iyowei/codd-cli 在独立发布与离线安装时 100% 自包含、零外部运行时依赖。
 * 若 ../codd/assets/manifest.json 尚未构建, 自动在 ../codd 执行 bun scripts/build-assets.ts 生成。
 */
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const syncCoddCliAssets = (
  cliPkgRoot: string = PACKAGE_ROOT,
  apiPkgRoot: string = resolve(cliPkgRoot, '../codd'),
): string[] => {
  const srcAssets = join(apiPkgRoot, 'assets');
  const srcManifest = join(srcAssets, 'manifest.json');

  if (!existsSync(srcManifest)) {
    const buildScript = join(apiPkgRoot, 'scripts/build-assets.ts');
    if (!existsSync(buildScript)) {
      throw new Error(
        `找不到 @iyowei/codd 模板资产 (${srcManifest}), 请先构建 @iyowei/codd`,
      );
    }
    const res = spawnSync('bun', ['scripts/build-assets.ts'], {
      cwd: apiPkgRoot,
      stdio: 'inherit',
    });
    if (res.status !== 0) {
      throw new Error(
        `自动构建 @iyowei/codd 模板资产失败 (退出码 ${res.status ?? 1})`,
      );
    }
  }

  const parsed = JSON.parse(readFileSync(srcManifest, 'utf8')) as {
    schemaVersion?: number;
    files?: string[];
  };
  if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.files)) {
    throw new Error(`源资产清单形状不合法: ${srcManifest}`);
  }

  const dstAssets = join(cliPkgRoot, 'assets');
  rmSync(dstAssets, { recursive: true, force: true });
  cpSync(srcAssets, dstAssets, { recursive: true });
  return parsed.files;
};

if (import.meta.main) {
  const files = syncCoddCliAssets();
  process.stdout.write(
    `codd-cli 已同步 ${files.length} 个模板资产至 assets/template/\n`,
  );
}
