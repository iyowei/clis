/**
 * 模板快照构建链: 读骨架清单 (template-manifest) → 按四类处置产出 assets/template/ → 两条
 * 构建自检 (清单完整性 / 泛化零残留, 任一不过即抛错非零退出) → 落资产清单 assets/manifest.json。
 *
 * 四类处置与产出:
 * - snapshot:   原样复制 (逐字节, 不做任何文本处理);
 * - generalize: 内容与**路径**都经 renderTemplate 泛化为模板占位词汇 (原包名 / bin 名在路径里
 *               的形态如 packages/sweep-node-modules/、bin/sweep-nm* 一并落位);
 * - reset:      从包内 scripts/template-skeletons/ 取模板化骨架 (骨架按清单路径镜像存放, 内容
 *               已是占位形态, 原样搬运); 目录条目整棵搬运;
 * - exclude:    跳过, 不进模板。
 *
 * 产出面: outDir 的目录结构即新项目根 (生成期由 Task 7 按档裁剪并代入用户词汇); 同级
 * manifest.json 列出全部产出文件 (相对 outDir, 排序稳定), 是 Task 8 发行面白名单的输入。
 *
 * 自检口径 (词面 = 6 个无歧义复合形态, 裸词 sweep / clis 原样保留属既定裁定):
 * - 清单完整性: 每条非 exclude 条目都要产出文件 (源文件 / 骨架缺失、产出路径撞车均即抛错);
 * - 泛化零残留: 产出文件的路径与内容都不得再含原项目词汇任一复合形态。
 *
 * 用法: bun packages/create-clis/scripts/build-template.ts (产出到包内 assets/, 该目录是构建
 * 产物不入库, 由 .gitignore / 各闸门忽略清单统一排除)。
 */
import {
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
import {
  type ManifestEntry,
  REPO_ROOT,
  TEMPLATE_MANIFEST,
} from './template-manifest.ts';

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

/** 资产清单文件名 (落 outDir 同级; 与 dist 侧清单同用 schemaVersion 记形状版本) */
export const ASSET_MANIFEST_FILE = 'manifest.json';

/** 本仓 (模板来源) 的原项目词汇: author 是 owner 的展示名形态 (LICENSE / package.json author), 缺它会漏替换与漏自检 */
export const ORIGINAL: Vocabulary = {
  name: 'sweep-node-modules',
  scope: '@iyowei',
  binName: 'sweep-nm',
  owner: 'iyowei',
  repoUrl: 'https://github.com/iyowei/clis',
  author: 'iTonyYo',
};

/** assets/manifest.json 的内容契约 (Task 8 动态白名单的输入) */
export interface AssetManifest {
  /** 形状版本 */
  schemaVersion: number;
  /** 全部产出文件, 相对 outDir, 排序稳定 */
  files: string[];
}

export interface BuildTemplateOptions {
  /** 源仓库根 (清单路径的解析基准) */
  repoRoot: string;
  /** 产出目录 (模板根); 同级写 manifest.json */
  outDir: string;
  /** 原项目词汇 (替换面与零残留自检的判据) */
  original: Vocabulary;
  /** 骨架清单 (默认 TEMPLATE_MANIFEST; 测试注入小清单) */
  manifest?: readonly ManifestEntry[];
  /** 骨架根 (默认包内 scripts/template-skeletons; 测试注入小骨架) */
  skeletonRoot?: string;
}

export interface BuildTemplateResult {
  /** 产出文件 (相对 outDir, 排序稳定) */
  files: string[];
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

/**
 * 产出模板资产。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   options = { repoRoot: '/repo', outDir: '/pkg/assets/template', original: ORIGINAL }
 *   清单条目 = { path: 'packages/sweep-node-modules-cli/bin/sweep-nm.mjs', disposition: 'generalize' }
 *
 * 步骤 1：逐条处置 (exclude 跳过)
 *   泛化路径 = 'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs'   *(路径同样过替换面)*
 *   泛化内容 = 启动器文本 (sweep-nm → {{BIN_NAME}}, @iyowei/... → {{SCOPE}}/...)
 *   清单完整性自检 = 源文件缺失 / 骨架缺失 / 产出路径撞车 → 抛错
 *
 * 步骤 2：写盘 (先清空 outDir)
 *   outDir 下按泛化路径落位; manifest.json 落 outDir 同级
 *
 * 步骤 3：泛化零残留自检 (回读磁盘)
 *   任一产出文件路径或内容含原词汇复合形态 → 抛错 (留下半成品, 下次构建整体重建)
 *
 * Output（数据契约）
 *   return { files: ['packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs', ...] }  // 相对 outDir, 排序稳定
 * ```
 */
export function buildTemplate(
  options: BuildTemplateOptions,
): BuildTemplateResult {
  const repoRoot = options.repoRoot;
  const outDir = options.outDir;
  const original = options.original;
  const placeholder = TEMPLATE_VOCABULARY;
  const manifest = options.manifest ?? TEMPLATE_MANIFEST;
  const skeletonRoot = options.skeletonRoot ?? DEFAULT_SKELETON_ROOT;

  // 1. 逐条处置: 计划产出 (输出相对路径 → 字节), 路径一并泛化; 撞车即抛
  const planned = new Map<string, Buffer>();
  const claim = (file: string, bytes: Buffer, source: string): void => {
    if (planned.has(file)) {
      throw new Error(
        `模板产出路径重复: ${file} (来源 ${source}); 两条清单条目映射到同一路径`,
      );
    }
    planned.set(file, bytes);
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
          claim(
            `${outPath}${rel}`,
            readFileSync(join(skeletonPath, rel)),
            entry.path,
          );
        }
      } else {
        claim(outPath, readFileSync(skeletonPath), entry.path);
      }
    } else {
      const sourcePath = join(repoRoot, entry.path);
      if (!existsSync(sourcePath) || !statSync(sourcePath).isFile()) {
        throw new Error(
          `清单完整性自检未过: 条目 ${entry.path} (${entry.disposition}) 在仓库根不存在或不是文件`,
        );
      }
      const bytes = readFileSync(sourcePath);
      claim(
        outPath,
        entry.disposition === 'snapshot'
          ? bytes
          : Buffer.from(
              renderTemplate(bytes.toString('utf8'), placeholder, original),
            ),
        entry.path,
      );
    }

    if (planned.size === before) {
      throw new Error(
        `清单完整性自检未过: 条目 ${entry.path} (${entry.disposition}) 没有产出任何文件`,
      );
    }
  }

  // 2. 写盘: 整目录重建 (清单可能收缩, 上一轮的残留文件不得混进新模板)
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  for (const [file, bytes] of planned) {
    const target = join(outDir, file);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, bytes);
  }

  // 3. 泛化零残留自检 (回读磁盘, 路径与内容都在判定面内)
  const leftovers: string[] = [];
  for (const file of planned.keys()) {
    if (containsResidual(file, original)) leftovers.push(`${file} (路径)`);
    const text = readFileSync(join(outDir, file), 'utf8');
    if (containsResidual(text, original)) leftovers.push(`${file} (内容)`);
  }
  if (leftovers.length > 0) {
    throw new Error(
      `泛化零残留自检未过, 模板内仍含原项目词汇:\n  ${leftovers.join('\n  ')}\n` +
        '  处置: 含该形态的源文件改标 generalize 走替换, 或改标 reset 换掉内容; 骨架内容必须写成模板占位形态。',
    );
  }

  // 4. 资产清单 (Task 8 动态白名单输入): 列出全部产出文件, 排序稳定
  const files = [...planned.keys()].sort();
  const assetManifest: AssetManifest = { schemaVersion: 1, files };
  writeFileSync(
    join(dirname(outDir), ASSET_MANIFEST_FILE),
    `${JSON.stringify(assetManifest, null, 2)}\n`,
  );

  return { files };
}

// 入口: 真实构建本仓模板资产 (产出到包内 assets/template/) 并落资产清单
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
