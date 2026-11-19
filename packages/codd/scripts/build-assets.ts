/**
 * 模板资产构建脚本: 将 packages/codd/template/ 下的模板复制到发布资产目录 assets/template/,
 * 并将以点号开头的隐藏文件 (.dockerignore / .env.tmpl / .helmignore) 转为无点载体名,
 * 避免 npm / yarn / pnpm / bun 打包或安装时剔除隐藏文件或误作忽略规则解析, 同时写出 assets/manifest.json。
 */
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ASSET_CARRIERS } from '../src/assets.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export { ASSET_CARRIERS };

const toCarrierName = (fileName: string): string =>
  ASSET_CARRIERS[fileName] ?? fileName;

const collectTemplateFiles = (
  dir: string,
  baseDir: string,
  out: string[] = [],
): string[] => {
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === '.DS_Store' ||
      entry.name.endsWith('.modified') ||
      entry.name.endsWith('.deleted')
    ) {
      continue;
    }
    const abs = join(dir, entry.name);
    if (entry.isDirectory()) {
      collectTemplateFiles(abs, baseDir, out);
    } else if (entry.isFile()) {
      out.push(relative(baseDir, abs));
    }
  }
  return out.sort();
};

export const buildCoddAssets = (pkgRoot: string = PACKAGE_ROOT): string[] => {
  const srcRoot = join(pkgRoot, 'template');
  if (!existsSync(srcRoot)) {
    throw new Error(`模板源目录不存在: ${srcRoot}`);
  }
  const assetsRoot = join(pkgRoot, 'assets');
  const dstRoot = join(assetsRoot, 'template');
  rmSync(assetsRoot, { recursive: true, force: true });
  mkdirSync(dstRoot, { recursive: true });

  const relFiles = collectTemplateFiles(srcRoot, srcRoot);
  const emitted: string[] = [];

  for (const rel of relFiles) {
    const parts = rel.split('/');
    const lastIdx = parts.length - 1;
    parts[lastIdx] = toCarrierName(parts[lastIdx]!);
    const carrierRel = parts.join('/');
    if (parts[lastIdx]!.startsWith('.')) {
      throw new Error(`模板资产存在未登记的隐藏点文件: ${rel}`);
    }
    const dstPath = join(dstRoot, carrierRel);
    mkdirSync(dirname(dstPath), { recursive: true });
    copyFileSync(join(srcRoot, rel), dstPath);
    emitted.push(carrierRel);
  }

  emitted.sort();
  writeFileSync(
    join(assetsRoot, 'manifest.json'),
    `${JSON.stringify({ schemaVersion: 1, files: emitted }, null, 2)}\n`,
    'utf8',
  );
  return emitted;
};

if (import.meta.main) {
  const emitted = buildCoddAssets();
  process.stdout.write(
    `codd 模板资产已构建至 assets/template/ (${emitted.length} 个文件)\n`,
  );
}
