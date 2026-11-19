/**
 * 发布自证闸门 (@iyowei/codd 纯编程 API + 模板资产包) 适配层:
 * 复用根共享库 scripts/lib/release-verify.ts, 校验 git 干净态、commit 对账、dist/index.js 摘要、
 * 递归 .d.ts specifier 零 .ts 残留、assets/manifest.json 完整性与不可发隐藏名拦截、以及 npm pack 白名单。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type DistState,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  judgeRelease as judgeReleaseCommon,
  readDistState as readDistStateCommon,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(
  dirname(fileURLToPath(import.meta.url)),
  '..',
);

export const ENTRY_FILE = 'index.js';
export const MANIFEST_FILE = 'manifest.json';
export const MANIFEST_SCHEMA_VERSION = 1;
export const ASSET_DIR = 'assets';
export const ASSET_TEMPLATE_DIR = 'template';
export const ASSET_MANIFEST_FILE = 'manifest.json';
export const ASSET_MANIFEST_SCHEMA_VERSION = 1;

export const NPM_UNSHIPPABLE_BASENAMES = new Set([
  '.gitignore',
  '.npmrc',
  '.dockerignore',
  '.helmignore',
  '.env.tmpl',
]);

/**
 * 发行面固定项白名单 (不含动态展开的 assets/ 模板资产):
 * 与 tsconfig.build.json 编译出的 11 个 API 模块 .d.ts 精确对应。
 */
export const PACK_FILES_BASE: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'dist/assets.d.ts',
  'dist/emit-k8s.d.ts',
  'dist/emit-podman-helpers.d.ts',
  'dist/emit-podman.d.ts',
  'dist/formulas.d.ts',
  'dist/generate.d.ts',
  'dist/index.d.ts',
  `dist/${ENTRY_FILE}`,
  `dist/${MANIFEST_FILE}`,
  'dist/render.d.ts',
  'dist/ssh.d.ts',
  'dist/state.d.ts',
  'dist/types.d.ts',
  'dist/validate.d.ts',
];

const PROFILE: VerifyProfile = {
  entryFile: ENTRY_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'entrySha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: [],
};

export interface DistManifest {
  schemaVersion: number;
  entry: string;
  entrySha256: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string;
}

export interface PackExpectation {
  files: readonly string[] | null;
  issue: string | null;
}

export type VerifyFacts = ReleaseFacts & {
  /** 含相对 '.ts' specifier 残留的 .d.ts 相对路径; 空数组即干净 */
  dtsTsSpecifierHits: string[];
};

const DTS_TS_FROM_RE = /from\s+['"]\.[^'"]+\.ts['"]/;
const DTS_TS_IMPORT_RE = /import\s+['"]\.[^'"]+\.ts['"]/;
const DTS_TS_DYNAMIC_RE = /import\(\s*['"]\.[^'"]+\.ts['"]\s*\)/;

/** 递归扫描 dist/ 下所有 .d.ts 是否残留相对 .ts specifier */
export const findDtsTsSpecifiers = (
  distDir: string,
  relPrefix = '',
): string[] => {
  const hits: string[] = [];
  try {
    for (const entry of readdirSync(distDir, { withFileTypes: true })) {
      const rel = relPrefix ? `${relPrefix}/${entry.name}` : entry.name;
      const abs = join(distDir, entry.name);
      if (entry.isDirectory()) {
        hits.push(...findDtsTsSpecifiers(abs, rel));
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith('.d.ts')) continue;
      const text = readFileSync(abs, 'utf8');
      if (
        DTS_TS_FROM_RE.test(text) ||
        DTS_TS_IMPORT_RE.test(text) ||
        DTS_TS_DYNAMIC_RE.test(text)
      ) {
        hits.push(rel);
      }
    }
  } catch {
    // dist 不在时由产物缺失分支统一报出
  }
  return hits.sort();
};

export const readPackExpectation = (root: string): PackExpectation => {
  const label = `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`;
  const path = join(root, ASSET_DIR, ASSET_MANIFEST_FILE);
  if (!existsSync(path)) {
    return {
      files: null,
      issue: `模板资产清单缺失 (${label} 不存在), 请先执行 bun run build`,
    };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, 'utf8'));
  } catch {
    return {
      files: null,
      issue: `模板资产清单 (${label}) 读取失败或不是合法 JSON`,
    };
  }
  if (typeof parsed !== 'object' || parsed === null || Array.isArray(parsed)) {
    return { files: null, issue: '模板资产清单应为 JSON 对象' };
  }
  const fields = parsed as Record<string, unknown>;
  if (fields.schemaVersion !== ASSET_MANIFEST_SCHEMA_VERSION) {
    return {
      files: null,
      issue: `模板资产清单 schemaVersion 不受支持 (期望 ${ASSET_MANIFEST_SCHEMA_VERSION})`,
    };
  }
  if (
    !Array.isArray(fields.files) ||
    fields.files.length === 0 ||
    fields.files.some((file) => typeof file !== 'string' || file === '')
  ) {
    return {
      files: null,
      issue: '模板资产清单 files 字段形状不符 (应为非空字符串数组)',
    };
  }
  const assets = fields.files as string[];
  const unshippable = assets.filter((file) => {
    const base = basename(file);
    return NPM_UNSHIPPABLE_BASENAMES.has(base) || base.startsWith('.');
  });
  if (unshippable.length > 0) {
    return {
      files: null,
      issue: `模板资产含易被包管理器忽略的隐藏文件 (请改用载体名): ${unshippable.join(', ')}`,
    };
  }
  return {
    files: [
      ...PACK_FILES_BASE,
      `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`,
      ...assets.map((file) => `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/${file}`),
    ],
    issue: null,
  };
};

export {
  countDirtyEntries,
  normalizeCommit,
  parsePackFiles,
  previewDirtyEntries,
  readGitText,
  readPackFiles,
  sha256File,
  shortHash,
} from '../../../scripts/lib/release-verify.ts';
export type {
  DistState,
  PackFacts,
  ReleaseFacts,
  ReleaseVerdict,
} from '../../../scripts/lib/release-verify.ts';

export const readDistState = (distDir: string): DistState =>
  readDistStateCommon(distDir, PROFILE);

export const judgePackFiles = (
  files: string[],
  expected: readonly string[],
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, expected);

export const judgeRelease = (
  facts: VerifyFacts,
  expectation: PackExpectation,
): ReleaseVerdict =>
  judgeReleaseCommon(
    facts,
    { ...PROFILE, packExpected: expectation.files ?? [] },
    () => {
      if (facts.dtsTsSpecifierHits.length > 0) {
        return `d.ts 残留 '.ts' specifier (消费方 TS 解析不了): ${facts.dtsTsSpecifierHits.join(', ')}; 检查 build.ts 的 d.ts 后处理`;
      }
      return expectation.issue;
    },
  );
