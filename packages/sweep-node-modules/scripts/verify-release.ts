/**
 * 发布侧闸门 (API 包): 干净检出 + 产物自证 (自证清单与 dist/index.js 相符且出自本提交)
 * + 类型声明无 .ts specifier 残留 + 发行面包内文件与白名单相符, 四项齐备才放行。
 *
 * 由 package.json 的 prepublishOnly (`npm run build && npm run verify:release`) 在构建后调用,
 * 手动复核即 `bun run verify:release`。结构对等 CLI 包的同名闸门 (ADR 0010「闸门结构与判定
 * 不变, 落位点与配置变」); API 特有项为 d.ts specifier 复查 (消费方 TS 解析的硬前提)。
 * 分工: 事实采集与判定都在本文件 (判定是纯函数, 事实可注入), 入口只负责坐标与输出面。
 *
 * 用法: bun scripts/verify-release.ts
 * 退出码: 0 通过; 1 拒绝 (原因与处置见 stderr)
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';

export const PACKAGE_ROOT = resolve(import.meta.dir, '..');

/**
 * 发行面包的期望文件集: files 白名单 (dist) 的物化 + npm 强制包含项 (README / LICENSE /
 * package.json)。增删产物文件 (如新增源模块的 .d.ts) 须同步本表, 闸门拒绝时会指出差集。
 */
export const PACK_FILES_EXPECTED: readonly string[] = [
  'LICENSE',
  'README.md',
  'README.zh-CN.md',
  'package.json',
  'dist/classify.d.ts',
  'dist/codes.d.ts',
  'dist/config.d.ts',
  'dist/delete.d.ts',
  'dist/display.d.ts',
  'dist/errors.d.ts',
  'dist/guard.d.ts',
  'dist/index.d.ts',
  'dist/index.js',
  'dist/manifest.json',
  'dist/runtime.d.ts',
  'dist/scan-native.d.ts',
  'dist/scan-parallel.d.ts',
  'dist/scan-prune.d.ts',
  'dist/scan.d.ts',
  'dist/size-du.d.ts',
  'dist/size-js.d.ts',
  'dist/size.d.ts',
  'dist/skip.d.ts',
  'dist/summary.d.ts',
  'dist/sweep.d.ts',
  'dist/types.d.ts',
];

/** 构建侧写下的自证清单 (scripts/build.ts 第 5 步; 字段契约见该处) */
export interface DistManifest {
  schemaVersion: number;
  entry: string;
  entrySha256: string;
  commit: string | null;
  dirty: boolean | null;
  builtAt: string;
}

/** 判定所需的全部事实 (采集纯读取; 测试可注入构造的现场) */
export interface VerifyFacts {
  /** `git status --porcelain` 原文; 非 git 检出为 null */
  gitStatus: string | null;
  /** HEAD 提交; 非 git 检出为 null */
  gitHead: string | null;
  /** dist/manifest.json 解析结果; 缺失或不合法为 null */
  manifest: DistManifest | null;
  /** dist/index.js 实测摘要; 缺失为 null */
  entrySha256: string | null;
  /** 含 '.ts' specifier 残留的 d.ts 文件名; 空数组即干净 */
  dtsTsSpecifierHits: string[];
  /** `npm pack --dry-run` 的包内文件清单; 采集失败为 null */
  pack: string[] | null;
}

export type VerifyVerdict =
  | { ok: true; commit: string; entrySha256: string }
  | { ok: false; reason: string };

const sha256 = (path: string): string =>
  createHash('sha256').update(readFileSync(path)).digest('hex');

/** d.ts specifier 残留检查: 后处理 (build.ts 第 4 步) 失效或手工产物混入的确定性信号 */
const dtsHits = (distDir: string): string[] => {
  const hits: string[] = [];
  for (const file of readdirSync(distDir)) {
    if (!file.endsWith('.d.ts')) continue;
    const text = readFileSync(join(distDir, file), 'utf8');
    if (
      /from\s+['"]\.[^'"]+\.ts['"]/.test(text) ||
      /import\s+['"]\.[^'"]+\.ts['"]/.test(text)
    )
      hits.push(file);
  }
  return hits;
};

/**
 * 采事实: 两条只读 git 命令 + 读 dist 产物与清单 + d.ts 复查 + 一次只读的 npm pack。
 * 外部副作用：无 (全部只读)。
 */
export const collectFacts = (root: string): VerifyFacts => {
  const gitText = (args: string[]): string | null => {
    const result = spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    return result.status === 0 ? result.stdout.trim() : null;
  };

  const distDir = join(root, 'dist');
  let manifest: DistManifest | null = null;
  try {
    manifest = JSON.parse(
      readFileSync(join(distDir, 'manifest.json'), 'utf8'),
    ) as DistManifest;
  } catch {
    manifest = null;
  }

  let entrySha256: string | null = null;
  try {
    entrySha256 = sha256(join(distDir, 'index.js'));
  } catch {
    entrySha256 = null;
  }

  let hits: string[] = [];
  try {
    if (statSync(distDir).isDirectory()) hits = dtsHits(distDir);
  } catch {
    hits = [];
  }

  const packed = spawnSync('npm', ['pack', '--dry-run', '--json'], {
    cwd: root,
    encoding: 'utf8',
  });
  let pack: string[] | null = null;
  if (packed.status === 0) {
    try {
      const parsed = JSON.parse(packed.stdout) as {
        files?: { path: string }[];
      }[];
      pack = (parsed[0]?.files ?? []).map((item) => item.path).sort();
    } catch {
      pack = null;
    }
  }

  return {
    gitStatus: gitText(['status', '--porcelain']),
    gitHead: gitText(['rev-parse', 'HEAD']),
    manifest,
    entrySha256,
    dtsTsSpecifierHits: hits,
    pack,
  };
};

/** 判定 (纯函数): 按序短路, 首个不符即拒, reason 给可核对的差集与处置线索 */
export const judgeRelease = (facts: VerifyFacts): VerifyVerdict => {
  if (facts.gitStatus === null)
    return { ok: false, reason: '不是 git 检出, 无法核对发布来源' };
  if (facts.gitStatus !== '')
    return {
      ok: false,
      reason: `工作树不干净 (${facts.gitStatus.split('\n').length} 处; 前几项: ${facts.gitStatus
        .split('\n')
        .slice(0, 3)
        .join(' / ')})`,
    };
  if (facts.gitHead === null) return { ok: false, reason: '读不到 HEAD 提交' };
  if (facts.manifest === null)
    return {
      ok: false,
      reason: '缺少产物清单 (dist/manifest.json), 先跑 bun run build',
    };
  if (facts.manifest.schemaVersion !== 1)
    return {
      ok: false,
      reason: `产物清单的 schemaVersion 不是受支持的版本 (期望 1, 实为 ${facts.manifest.schemaVersion})`,
    };
  if (facts.manifest.dirty !== false)
    return {
      ok: false,
      reason:
        '清单记录构建时工作树不干净 (或未知), 产物无法自证出自本提交; 清干净后重新 build',
    };
  if (facts.manifest.commit !== facts.gitHead)
    return {
      ok: false,
      reason: `产物不是本提交构建的 (清单 ${facts.manifest.commit ?? 'null'} ≠ HEAD ${facts.gitHead})`,
    };
  if (facts.entrySha256 === null)
    return { ok: false, reason: 'dist/index.js 缺失或读不出' };
  if (facts.manifest.entrySha256 !== facts.entrySha256)
    return {
      ok: false,
      reason: '产物摘要与清单不符 (dist/index.js 在构建后被改动?)',
    };
  if (facts.dtsTsSpecifierHits.length > 0)
    return {
      ok: false,
      reason: `d.ts 残留 '.ts' specifier (消费方 TS 解析不了): ${facts.dtsTsSpecifierHits.join(', ')}; 检查 build 的 d.ts 后处理`,
    };
  if (facts.pack === null)
    return {
      ok: false,
      reason: '发行面清单采集失败 (npm pack --dry-run 不可用?)',
    };
  const expected = [...PACK_FILES_EXPECTED].sort();
  const extra = facts.pack.filter((file) => !expected.includes(file));
  const missing = expected.filter((file) => !facts.pack?.includes(file));
  if (extra.length > 0 || missing.length > 0)
    return {
      ok: false,
      reason: `发行面包内文件与白名单不符${extra.length > 0 ? `; 多出: ${extra.join(', ')}` : ''}${missing.length > 0 ? `; 缺少: ${missing.join(', ')}` : ''}`,
    };
  return { ok: true, commit: facts.gitHead, entrySha256: facts.entrySha256 };
};

/** 输出面 (注入以便测试捕获; CLI 直写 process) */
export interface ReleaseIo {
  out: (line: string) => void;
  err: (line: string) => void;
}

/** 跑一次发布前置校验: 采事实 → judgeRelease → 输出结论与退出码 */
export const verifyRelease = (
  root: string,
  io: ReleaseIo,
  facts: VerifyFacts = collectFacts(root),
): number => {
  const verdict = judgeRelease(facts);
  if (verdict.ok) {
    io.out(
      `发布前置校验通过: 提交 ${verdict.commit.slice(0, 7)} · 产物摘要 ${verdict.entrySha256.slice(0, 7)}`,
    );
    return 0;
  }
  io.err(`发布前置校验未通过: ${verdict.reason}`);
  io.err(
    '  处置: 工作树不干净就提交或 stash 后重新构建再发 (bun run build 会同时写产物与清单);' +
      ' 发行面包内文件与白名单不符就清掉多余文件或同步 PACK_FILES_EXPECTED。',
  );
  return 1;
};

// 被测试 import 时不得跑入口 (只有直接运行才落退出码)
if (import.meta.main) {
  process.exitCode = verifyRelease(PACKAGE_ROOT, {
    out: (line) => process.stdout.write(`${line}\n`),
    err: (line) => process.stderr.write(`${line}\n`),
  });
}
