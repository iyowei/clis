/**
 * 模板快照构建链: 读骨架清单 (template-manifest) → 按四类处置产出 assets/template/ →
 * 三条构建自检 (清单完整性 / 泛化零残留 / 排除包路径零泄漏) → 落资产清单 assets/manifest.json。
 *
 * 权限透传: 落盘时保留源文件/骨架文件原有 mode (+x 可执行位不丢失)。
 */
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  TEMPLATE_VOCABULARY,
  type Vocabulary,
  containsResidual,
  renderTemplate,
} from '../src/render.ts';
import { ORIGINAL, toCarrierPath } from '../src/template-snapshot.ts';
import {
  type ManifestEntry,
  REPO_ROOT,
  TEMPLATE_MANIFEST,
} from './template-manifest.ts';

export { ORIGINAL };

/** 生成器包根 (scripts/ 的上一级) */
export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

/** 默认骨架根: 模板化骨架按清单路径镜像存放 */
export const DEFAULT_SKELETON_ROOT = join(
  PACKAGE_ROOT,
  'scripts',
  'template-skeletons',
);

/** 默认产出目录 (构建产物, 不入库; 包内 assets/ 下) */
export const DEFAULT_TEMPLATE_DIR = join(PACKAGE_ROOT, 'assets', 'template');

/** 资产清单文件名 (落 outDir 同级) */
export const ASSET_MANIFEST_FILE = 'manifest.json';

/** assets/manifest.json 的内容契约 */
export interface AssetManifest {
  schemaVersion: number;
  files: string[];
}

export interface BuildTemplateOptions {
  repoRoot: string;
  outDir: string;
  original: Vocabulary;
  manifest?: readonly ManifestEntry[];
  skeletonRoot?: string;
  /** 额外禁止在生成模板内容里出现的私密/私有包词面 (缺省按 manifest 中 exclude 的 packages/* 自动派生) */
  forbiddenLiterals?: readonly string[];
}

export interface BuildTemplateResult {
  files: string[];
}

interface PlannedFile {
  bytes: Buffer;
  mode: number;
}

const escapeRegExp = (value: string): string =>
  value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** 从清单中自动派生「被排除的非模板包」路径禁词 (如 packages/codd、packages/create-clis) */
export function deriveExcludedPackageTerms(
  manifest: readonly ManifestEntry[],
): string[] {
  const terms = new Set<string>();
  for (const entry of manifest) {
    if (entry.disposition !== 'exclude') continue;
    const match = entry.path.match(/^(packages\/[^/]+)\/?$/);
    if (match) terms.add(match[1]!);
  }
  return [...terms].sort();
}

/** 从清单中自动派生「被排除的非模板包」短名边界正则 (如 packages/codd → /\bcodd\b/) */
export function deriveExcludedShortNamePatterns(
  manifest: readonly ManifestEntry[],
): { term: string; pattern: RegExp }[] {
  const shortNames = new Set<string>();
  for (const entry of manifest) {
    if (entry.disposition !== 'exclude') continue;
    const match = entry.path.match(/^packages\/([^/]+)\/?$/);
    if (match) shortNames.add(match[1]!);
  }
  return [...shortNames].sort().map((term) => ({
    term,
    pattern: new RegExp(`\\b${escapeRegExp(term)}\\b`),
  }));
}

/** 目录走查 (相对路径用 `/` 连接, 排序稳定; 只收文件) */
function walkSkeletonDir(root: string, prefix: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkSkeletonDir(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 产出模板资产 */
export function buildTemplate(
  options: BuildTemplateOptions,
): BuildTemplateResult {
  const repoRoot = options.repoRoot;
  const outDir = options.outDir;
  const original = options.original;
  const placeholder = TEMPLATE_VOCABULARY;
  const manifest = options.manifest ?? TEMPLATE_MANIFEST;
  const skeletonRoot = options.skeletonRoot ?? DEFAULT_SKELETON_ROOT;
  const forbiddenTerms = options.forbiddenLiterals ?? [
    ...deriveExcludedPackageTerms(manifest),
    'registry.npmmirror.com',
    'sweep-lab',
    'docs/sweep/',
  ];
  const forbiddenPatterns =
    options.forbiddenLiterals !== undefined
      ? []
      : deriveExcludedShortNamePatterns(manifest);

  // 1. 逐条处置: 计划产出 (输出相对路径 → 字节 + 权限 mode), 路径一并泛化; 撞车即抛
  const planned = new Map<string, PlannedFile>();
  const claim = (
    file: string,
    bytes: Buffer,
    mode: number,
    source: string,
  ): void => {
    const shipped = toCarrierPath(file);
    if (planned.has(shipped)) {
      throw new Error(
        `模板产出路径重复: ${shipped} (来源 ${source}); 两条清单条目映射到同一路径`,
      );
    }
    planned.set(shipped, { bytes, mode });
  };

  for (const entry of manifest) {
    if (entry.disposition === 'exclude') continue;
    const outPath = renderTemplate(entry.path, placeholder, original);
    const before = planned.size;

    if (entry.disposition === 'reset') {
      const skeletonPath = join(skeletonRoot, entry.path);
      if (
        !existsSync(skeletonPath) ||
        statSync(skeletonPath).isDirectory() !== entry.path.endsWith('/')
      ) {
        throw new Error(
          `骨架缺失: ${entry.path} 在 ${skeletonRoot} 下找不到对应${entry.path.endsWith('/') ? '目录' : '文件'} ` +
            '(reset 条目的骨架须按清单路径镜像存放)',
        );
      }
      if (entry.path.endsWith('/')) {
        for (const rel of walkSkeletonDir(skeletonPath, '')) {
          const full = join(skeletonPath, rel);
          claim(
            `${outPath}${rel}`,
            readFileSync(full),
            statSync(full).mode,
            entry.path,
          );
        }
      } else {
        claim(
          outPath,
          readFileSync(skeletonPath),
          statSync(skeletonPath).mode,
          entry.path,
        );
      }
    } else {
      const sourcePath = join(repoRoot, entry.path);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(
          `清单完整性自检未过: 条目 ${entry.path} (${entry.disposition}) 在仓库根不存在或不是文件`,
        );
      }
      const bytes = readFileSync(sourcePath);
      const { mode } = statSync(sourcePath);
      claim(
        outPath,
        entry.disposition === 'snapshot'
          ? bytes
          : Buffer.from(
              renderTemplate(bytes.toString('utf8'), placeholder, original),
            ),
        mode,
        entry.path,
      );
    }

    if (planned.size === before) {
      throw new Error(
        `清单完整性自检未过: 条目 ${entry.path} (${entry.disposition}) 没有产出任何文件`,
      );
    }
  }

  // 2. 内存自检: 泛化零残留 + 排除包零泄漏 (全检通过前不删旧写盘, 防失败留下脏产物)
  const leftovers: string[] = [];
  for (const [file, { bytes }] of planned) {
    if (containsResidual(file, original)) leftovers.push(`${file} (路径)`);
    const text = bytes.toString('utf8');
    if (containsResidual(text, original)) leftovers.push(`${file} (内容)`);
    for (const term of forbiddenTerms) {
      if (file.includes(term) || text.includes(term)) {
        leftovers.push(`${file} (泄漏本仓禁词: ${term})`);
      }
    }
    for (const { term, pattern } of forbiddenPatterns) {
      if (pattern.test(file) || pattern.test(text)) {
        leftovers.push(`${file} (泄漏本仓排除包短名: ${term})`);
      }
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `泛化零残留自检未过, 模板内仍含原项目词汇或私密配置:\n  ${leftovers.join('\n  ')}\n` +
        '  处置: 含该形态的源文件改标 generalize 走替换, 或改标 reset 换用干净骨架。',
    );
  }

  // 3. 写盘: 全部自检通过后再整目录重建并保留可执行权限位
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [file, { bytes, mode }] of planned) {
    const target = join(outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes, { mode });
    if (process.platform !== 'win32') chmodSync(target, mode);
  }

  // 4. 资产清单
  const files = [...planned.keys()].sort();
  const assetManifest: AssetManifest = { schemaVersion: 1, files };
  writeFileSync(
    join(dirname(outDir), ASSET_MANIFEST_FILE),
    `${JSON.stringify(assetManifest, null, 2)}\n`,
  );

  return { files };
}

if (import.meta.main) {
  try {
    const { files } = buildTemplate({
      repoRoot: REPO_ROOT,
      outDir: DEFAULT_TEMPLATE_DIR,
      original: ORIGINAL,
    });
    process.stdout.write(
      `模板资产已产出: ${files.length} 个文件 → ${DEFAULT_TEMPLATE_DIR} (资产清单: ${ASSET_MANIFEST_FILE})\n`,
    );
  } catch (error) {
    process.stderr.write(
      `模板资产构建失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  }
}
