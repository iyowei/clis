/**
 * 发布自证闸门 (生成器包) 的适配层: 判定本体与事实读取在共享库 (scripts/lib/release-verify.ts,
 * 与 CLI / API 两包同源, 结构对称), 本文件只表达生成器侧的坐标与口径差异 (产物文件名
 * create-clis.js / 清单摘要字段名 / 动态面包白名单 / manifest 契约), 并向包内消费方
 * (verify-release / write-dist-manifest / 测试) 保持稳定的导出面。
 *
 * 与两包既有适配层的一处结构性差异: 生成器把模板资产 (assets/template/) 一并发售, 发行面包
 * 白名单 = 固定项 + 资产清单实时展开 (assets/manifest.json 列出的资产文件): 资产是构建产物,
 * 静态常量表达不了「发什么」; 资产清单缺失 / 损坏即白名单无从建立, 判定层直接拒绝 (缺一份资产
 * 等于发售一个生成不出完整项目的生成器)。
 *
 * 判定序 (共享库统一, 顺序即口径): 检出可信 (git 可读 / 有提交 / 工作树干净) → 产物就位
 * (存在 / 非空 / 可读) → 清单与提交、产物对账 → 资产清单 (专属判定) → 面包白名单。
 */
import { existsSync, readFileSync } from 'node:fs';
import { basename, join, resolve } from 'node:path';

import {
  type DistState,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgePackFiles as judgePackFilesCommon,
  judgeRelease as judgeReleaseCommon,
  normalizeCommit,
  readDistState as readDistStateCommon,
  readGitText,
} from '../../../scripts/lib/release-verify.ts';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/** 产物主文件 (dist/ 下) */
export const CLI_FILE = 'create-clis.js';

/** 产物清单文件名 (dist/ 下) */
export const MANIFEST_FILE = 'manifest.json';

/** 清单形状版本 */
export const MANIFEST_SCHEMA_VERSION = 1;

/** 资产目录名 (包根下; 模板资产与资产清单的所在) */
export const ASSET_DIR = 'assets';

/** 模板资产目录名 (ASSET_DIR 下; 生成期照此树复制, 见 src/generate.ts) */
export const ASSET_TEMPLATE_DIR = 'template';

/** 资产清单文件名 (ASSET_DIR 下; 由 scripts/build-template.ts 产出) */
export const ASSET_MANIFEST_FILE = 'manifest.json';

/** 资产清单形状版本 (与 build-template 的 AssetManifest.schemaVersion 同值) */
export const ASSET_MANIFEST_SCHEMA_VERSION = 1;

/**
 * npm 面包机制硬性剔除的文件名 (平台事实, 与包内容无关): npm-packlist 的固定规则按文件名在任何
 * 层级剔除 (npm 自带的 lib/index.js 里 defaults 表含 .gitignore 与 .npmrc, strict 表再含
 * .npmrc); 实测 `files` 字段也救不回, 显式列成文件条目同样被剔除。
 * 模板资产因而不得以这些真实名随包 (否则发售版生成器生成出的项目会缺它们, TD-05 的历史教训),
 * 一律以载体名随包并在生成期还原 (见 src/template-snapshot.ts 的 ASSET_CARRIERS)。
 * 本常量是那张表的**反面判据**: 资产清单里出现这些名字即白名单无从建立, 判定层直接拒绝
 * (这类文件必然缺席面包, 对账恒缺一项; 拒绝的处置指引指向载体约定)。
 */
export const NPM_UNSHIPPABLE_BASENAMES: readonly string[] = [
  '.gitignore',
  '.npmrc',
];

/**
 * 固定项白名单: 包自有文件 (bin 三件 + dist 两件) + npm 无条件收进包的文件 (README.md /
 * package.json; 官方没有任何排除通道: npm docs configuring-npm/package-json「files」节的
 * 排除语义 + 本机 npm-packlist 的 strict 规则, 见 ADR 0009 补记)。本常量把「包内应有什么」
 * 显式声明成契约, 发布前逐项对账。
 *
 * 改动义务: package.json 的 files / bin 变更, 或包根增删总是收录类文件 (README / LICENSE /
 * CHANGELOG) 时, 必须同步本清单, 否则闸门会拒绝发布 (这正是它存在的目的: 发行面变化必须是一次
 * 显式决定, 不能靠静默)。
 */
export const PACK_FILES_BASE: readonly string[] = [
  'README.md',
  'package.json',
  'bin/create-clis',
  'bin/create-clis.cmd',
  'bin/create-clis.mjs',
  `dist/${CLI_FILE}`,
  `dist/${MANIFEST_FILE}`,
];

/** 生成器侧闸门坐标 (差异面收口; packExpected 由 judgeRelease 按资产清单逐次注入) */
const PROFILE: VerifyProfile = {
  entryFile: CLI_FILE,
  manifestFile: MANIFEST_FILE,
  shaField: 'cliSha256',
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  packExpected: [],
};

/** dist/manifest.json 的字段契约 (构建写入、闸门与启动器读, 两侧同源) */
export interface DistManifest {
  /** 形状版本, 恒为 MANIFEST_SCHEMA_VERSION */
  schemaVersion: number;
  /** 构建时 HEAD 的完整哈希; 非 git 检出为 null */
  commit: string | null;
  /** 构建时工作树是否不干净; 读不到为 null */
  dirty: boolean | null;
  /** 产物 (dist/create-clis.js) 的 sha256 十六进制 */
  cliSha256: string;
  /** 构建时刻 (ISO 8601), 仅供人读诊断; 时间不是判据, 判定只看提交与摘要 */
  builtAt: string;
}

/** 构建侧 git 事实 (collectGitFacts 的产物, 写清单用) */
export interface GitFacts {
  /** HEAD 提交的完整哈希; 读不到为 null */
  commit: string | null;
  /** 工作树是否有未提交改动 (含未跟踪文件); 读不到为 null */
  dirty: boolean | null;
}

/** assets/manifest.json 的内容契约 (build-template 产出; 读取侧按形状校验, 不合即当不可用) */
export interface AssetManifest {
  /** 形状版本, 恒为 ASSET_MANIFEST_SCHEMA_VERSION */
  schemaVersion: number;
  /** 全部模板资产文件 (相对 assets/template/, 排序稳定) */
  files: string[];
}

/**
 * 发行面包的白名单期望: 资产清单可用时给出「固定项 + 资产清单展开」的完整文件集,
 * 不可用时 files 为 null 且 issue 给出人话原因 (判定层据此拒绝, 而不是拿半份白名单对账)。
 */
export interface PackExpectation {
  /** 期望的发行面包内文件集 (相对包根); null = 资产清单不可用 */
  files: readonly string[] | null;
  /** 资产清单不可用的原因 (人话); null = 可用 */
  issue: string | null;
}

/**
 * 读模板资产清单并展开成发行面包白名单期望: 固定项 + 资产清单自身 + 资产文件逐条加
 * `assets/template/` 前缀。
 * 缺失 / 读不到 / 非 JSON / 形状不符 / 含 npm 不可发名一律落 issue (不猜结构, 交判定层拒绝),
 * 不抛错。
 * 外部副作用：只读 (读 assets/manifest.json)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   root = /repo/packages/create-clis
 *   assets/manifest.json = { schemaVersion: 1, files: ['_gitignore', 'README.md', 'scripts/ci.ts'] }
 *
 * 步骤 1：读取与形状校验
 *   schemaVersion = 1 ✓; files 为非空字符串数组 ✓   *(缺失 / 损坏 / 异版本走 issue 分支)*
 *
 * 步骤 2：展开为面包内路径; 顺带拦住 npm 不可发名
 *   '_gitignore' (载体名) ✓ 放行; 若出现 '.gitignore' 则走 issue 分支 (白名单无从建立)
 *   'README.md' → 'assets/template/README.md'; 'scripts/ci.ts' → 'assets/template/scripts/ci.ts'
 *
 * Output（数据契约）
 *   return { files: [<PACK_FILES_BASE 七项>, 'assets/manifest.json',
 *                    'assets/template/_gitignore', 'assets/template/README.md',
 *                    'assets/template/scripts/ci.ts'], issue: null }
 * ```
 */
export const readPackExpectation = (root: string): PackExpectation => {
  const label = `${ASSET_DIR}/${ASSET_MANIFEST_FILE}`;
  const path = join(root, ASSET_DIR, ASSET_MANIFEST_FILE);
  if (!existsSync(path)) {
    return {
      files: null,
      issue: `模板资产清单缺失 (${label} 不存在), 发行面包白名单无从建立; 先跑构建 (bun run build)`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(path, 'utf8');
  } catch {
    return { files: null, issue: `模板资产清单 (${label}) 读取失败` };
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { files: null, issue: `模板资产清单 (${label}) 不是合法 JSON` };
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
    fields.files.some((file) => typeof file !== 'string' || file === '')
  ) {
    return {
      files: null,
      issue: '模板资产清单 files 字段形状不符 (应为非空字符串数组)',
    };
  }
  const assets = fields.files as string[];
  const unshippable = assets.filter((file) =>
    NPM_UNSHIPPABLE_BASENAMES.includes(basename(file)),
  );
  if (unshippable.length > 0) {
    return {
      files: null,
      issue:
        `模板资产含 npm 面包机制硬性剔除的文件名 (发不到面包里): ${unshippable.join(', ')}; ` +
        '资产须以载体名随包并在生成期还原 (见 src/template-snapshot.ts 的 ASSET_CARRIERS)',
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

// ---- 共享库直通导出 (包内消费方经本文件取用, 路径与命名保持稳定) ----

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

/** 读产物目录现状 (生成器侧口径) */
export const readDistState = (distDir: string): DistState =>
  readDistStateCommon(distDir, PROFILE);

/** 发行面包白名单判定 (生成器侧口径: 期望集由调用方按资产清单给足) */
export const judgePackFiles = (
  files: string[],
  expected: readonly string[],
): { ok: true } | { ok: false; reason: string } =>
  judgePackFilesCommon(files, expected);

/**
 * 发布闸门判定 (纯函数, 不碰文件系统): 委托共享库按统一判定序执行; 白名单期望注入 (动态合并
 * 的结果), 资产清单不可用时以专属判定在发行面检查段拒绝 (不拿半份白名单对账)。
 */
export const judgeRelease = (
  facts: ReleaseFacts,
  expectation: PackExpectation,
): ReleaseVerdict => {
  const issue = expectation.issue;
  return judgeReleaseCommon(
    facts,
    { ...PROFILE, packExpected: expectation.files ?? [] },
    issue === null ? undefined : () => issue,
  );
};

/** 采 git 事实 (构建侧写清单用): 在 root 内跑两条只读命令, 任一步读不到即落 null */
export const collectGitFacts = (root: string): GitFacts => {
  const status = readGitText(root, ['status', '--porcelain']);
  return {
    commit: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dirty: status === null ? null : status.trim() !== '',
  };
};

/** 组装清单 (构建侧写入的正是这份数据; 字段形状即契约) */
export const buildManifest = (fields: {
  cliSha256: string;
  git: GitFacts;
  builtAt: string;
}): DistManifest => ({
  schemaVersion: MANIFEST_SCHEMA_VERSION,
  commit: fields.git.commit,
  dirty: fields.git.dirty,
  cliSha256: fields.cliSha256,
  builtAt: fields.builtAt,
});
