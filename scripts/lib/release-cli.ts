/**
 * CLI 包发布自证脚本的共享收口层 (供工作区内全部 CLI 包共用)。
 *
 * 动机: 三个 CLI 包此前各自复制了 write-dist-manifest.ts / verify-release.ts /
 * release-artifact.ts 的绝大多数逻辑 (~500 行), 已衍生出文案漂移、资产校验分叉与
 * `import.meta.dir` vs `fileURLToPath` 不一致。本模块将共享的 git 采集、清单构建、
 * 写盘、资产白名单展开与 CLI 入口收口在一处, 各包只保留纯声明配置。
 */
import { existsSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';

import {
  type DistState,
  type PackFacts,
  type ReleaseFacts,
  type ReleaseVerdict,
  type VerifyProfile,
  judgeRelease,
  normalizeCommit,
  readDistState,
  readGitText,
  readPackFiles,
  sha256File,
  shortHash,
} from './release-verify.ts';

/** 产物身份清单的通用形状 */
export interface CliDistManifest {
  schemaVersion: number;
  commit: string | null;
  dirty: boolean | null;
  cliSha256: string;
  builtAt: string;
}

/** 从 git 采集到的事实 (非 git 检出或 git 不可用时为 null) */
export interface GitFacts {
  commit: string | null;
  dirty: boolean | null;
}

/** 动态资产白名单的解析结果 */
export interface PackExpectation {
  files: readonly string[] | null;
  issue: string | null;
}

/** 资产清单白名单配置 (面向带 assets/template + assets/manifest.json 的包) */
export interface AssetPackConfig {
  /** 不含动态模板的固定白名单项 (结果数组将保持此前缀顺序) */
  baseFiles: readonly string[];
  /** assets 目录名 (默认 assets) */
  assetDir?: string;
  /** 模板目录名 (默认 template) */
  templateDir?: string;
  /** 清单文件名 (默认 manifest.json) */
  manifestFile?: string;
  /** 期望 schemaVersion (默认 1) */
  schemaVersion?: number;
  /** npm 会静默过滤、严禁以原名落入模板资产的文件名黑名单 */
  unshippableBasenames: readonly string[];
  /** 是否一并拒绝任何以 `.` 开头的隐藏文件名 (供严禁隐藏点文件随包的场景) */
  rejectDotfiles?: boolean;
}

/** 输出通道抽象 (与既有包内 ReleaseIo 接口兼容, 测试可注入内存缓冲) */
export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

const DEFAULT_IO: ReleaseIo = {
  out: (line) => process.stdout.write(`${line}\n`),
  err: (line) => process.stderr.write(`${line}\n`),
};

/** 采集 git 事实: HEAD 提交哈希与工作树干净态 */
export function collectGitFacts(root: string): GitFacts {
  const status = readGitText(root, ['status', '--porcelain']);
  return {
    commit: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dirty: status === null ? null : status.trim() !== '',
  };
}

/** 构造产物身份清单 (纯函数) */
export function buildCliManifest(fields: {
  cliSha256: string;
  git: GitFacts;
  builtAt: string;
  schemaVersion?: number;
}): CliDistManifest {
  return {
    schemaVersion: fields.schemaVersion ?? 1,
    commit: fields.git.commit,
    dirty: fields.git.dirty,
    cliSha256: fields.cliSha256,
    builtAt: fields.builtAt,
  };
}

/** 采集产物摘要并写出 dist/manifest.json; 产物缺失或零字节时返回 null 且不写盘 */
export function writeCliDistManifest(
  distDir: string,
  profile: Pick<VerifyProfile, 'entryFile' | 'manifestFile' | 'schemaVersion'>,
  git: GitFacts,
  builtAt: string,
): CliDistManifest | null {
  const entryPath = join(distDir, profile.entryFile);
  if (!existsSync(entryPath)) return null;
  const info = statSync(entryPath);
  if (!info.isFile() || info.size === 0) return null;
  const manifest = buildCliManifest({
    cliSha256: sha256File(entryPath),
    git,
    builtAt,
    schemaVersion: profile.schemaVersion,
  });
  writeFileSync(
    join(distDir, profile.manifestFile),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
}

/** 把 git 事实翻译成简短人读标签 */
export function formatGitSourceLabel(manifest: CliDistManifest): string {
  if (manifest.commit === null) return '非 git 检出 (未记录提交)';
  const dirty = manifest.dirty === true ? ' (脏工作树)' : '';
  return `提交 ${shortHash(manifest.commit)}${dirty}`;
}

/** 运行写清单 CLI 主流程 (返回退出码 0 / 1) */
export function runWriteDistManifestCli(
  packageRoot: string,
  profile: Pick<VerifyProfile, 'entryFile' | 'manifestFile' | 'schemaVersion'>,
  io: ReleaseIo = DEFAULT_IO,
): number {
  const manifest = writeCliDistManifest(
    join(packageRoot, 'dist'),
    profile,
    collectGitFacts(packageRoot),
    new Date().toISOString(),
  );
  if (manifest === null) {
    io.err(
      `产物清单未写入: dist/${profile.entryFile} 缺失或为空, 先跑 bun build 产出产物`,
    );
    return 1;
  }
  io.out(
    `产物清单已写入 dist/${profile.manifestFile}: ${formatGitSourceLabel(manifest)} · 摘要 ${shortHash(manifest.cliSha256)}`,
  );
  return 0;
}

/**
 * 读取带动态模板资产包的期望发行白名单: 固定基座 + assets/manifest.json + 展开的模板资产路径。
 * 任一校验不过 (缺失 / 非 JSON / schemaVersion 不符 / files 形状不符 / 含 npm 不可发名) 一律落 issue 不抛。
 */
export function readAssetPackExpectation(
  packageRoot: string,
  config: AssetPackConfig,
): PackExpectation {
  const assetDir = config.assetDir ?? 'assets';
  const templateDir = config.templateDir ?? 'template';
  const manifestFile = config.manifestFile ?? 'manifest.json';
  const expectedSchema = config.schemaVersion ?? 1;
  const label = `${assetDir}/${manifestFile}`;
  const manifestPath = join(packageRoot, assetDir, manifestFile);

  if (!existsSync(manifestPath)) {
    return {
      files: null,
      issue: `模板资产清单缺失 (${label} 不存在), 发行包白名单无从建立; 先跑构建 (bun run build)`,
    };
  }
  let raw: string;
  try {
    raw = readFileSync(manifestPath, 'utf8');
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
  if (fields.schemaVersion !== expectedSchema) {
    return {
      files: null,
      issue: `模板资产清单 schemaVersion 不受支持 (期望 ${expectedSchema})`,
    };
  }
  if (
    !Array.isArray(fields.files) ||
    fields.files.length === 0 ||
    fields.files.some(
      (file) =>
        typeof file !== 'string' ||
        file === '' ||
        file.includes('\\') ||
        file.startsWith('/') ||
        file.split('/').includes('..'),
    )
  ) {
    return {
      files: null,
      issue: '模板资产清单 files 字段形状不符 (应为非空 POSIX 相对路径数组)',
    };
  }
  const assets = fields.files as string[];
  const blocked = new Set(config.unshippableBasenames);
  const rejectDotfiles = config.rejectDotfiles === true;
  const unshippable = assets.filter((file) => {
    const base = basename(file);
    return blocked.has(base) || (rejectDotfiles && base.startsWith('.'));
  });
  if (unshippable.length > 0) {
    return {
      files: null,
      issue:
        `模板资产含 npm 打包机制硬性剔除或易忽略的隐藏文件名 (发不到包里): ${unshippable.join(', ')}; ` +
        '资产须以载体名随包并在生成期还原',
    };
  }
  return {
    files: [
      ...config.baseFiles,
      label,
      ...assets.map((file) => `${assetDir}/${templateDir}/${file}`),
    ],
    issue: null,
  };
}

/** 带可选动态资产白名单的 CLI 发布闸门判定 (纯函数) */
export function judgeCliRelease(
  facts: ReleaseFacts,
  profile: VerifyProfile,
  expectation?: PackExpectation,
  extraJudge?: () => string | null,
): ReleaseVerdict {
  if (expectation === undefined) {
    return judgeRelease(facts, profile, extraJudge);
  }
  const combinedExtra = (): string | null => {
    if (expectation.issue !== null) return expectation.issue;
    return extraJudge === undefined ? null : extraJudge();
  };
  return judgeRelease(
    facts,
    { ...profile, packExpected: expectation.files ?? [] },
    combinedExtra,
  );
}

/** 运行 CLI 发布自证闸门 (返回退出码 0 / 1) */
export function runVerifyReleaseCli(
  root: string,
  profile: VerifyProfile,
  io: ReleaseIo = DEFAULT_IO,
  packFacts: PackFacts = readPackFiles(root),
  expectation?: PackExpectation,
  extraJudge?: () => string | null,
): number {
  const facts: ReleaseFacts = {
    gitStatus: readGitText(root, ['status', '--porcelain']),
    gitHead: normalizeCommit(readGitText(root, ['rev-parse', 'HEAD'])),
    dist: readDistState(join(root, 'dist'), profile),
    pack: packFacts,
  };
  const verdict = judgeCliRelease(facts, profile, expectation, extraJudge);
  if (verdict.ok) {
    io.out(
      `发布前置校验通过: 提交 ${shortHash(verdict.commit)} · 产物摘要 ${shortHash(verdict.sha256)}`,
    );
    return 0;
  }
  io.err(`发布前置校验未通过: ${verdict.reason}`);
  io.err(
    '  处置: 工作树不干净就提交或 stash 后重新构建再发 (bun run build 会同时写产物与清单);' +
      ' 发行面包内文件与白名单不符就清掉包根的多余文件 (如备份移出仓库), 或同步白名单常量。',
  );
  return 1;
}

export type {
  DistState,
  PackFacts,
  ReleaseFacts,
  ReleaseVerdict,
  VerifyProfile,
};
