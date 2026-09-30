/**
 * 构建侧入口: 给产物 dist/create-clis.js 写自证清单 dist/manifest.json。
 *
 * package.json 的 build = `build-template && bun build ... && bun scripts/write-dist-manifest.ts`:
 * 产物与清单是同一次构建的两半, 分开跑会留下「有产物无清单」的中间态, 而那种产物会被启动器拒收。
 * 非 git 检出时不拒绝构建, 如实记 null (提交标识未知); 「发布必须来自干净检出」是
 * verify-release.ts 的职责, 构建侧不越权。
 *
 * 用法: bun scripts/write-dist-manifest.ts
 * 退出码: 0 清单已写入; 1 产物缺失或为空 (先跑构建)
 */
import { existsSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import {
  CLI_FILE,
  type DistManifest,
  type GitFacts,
  MANIFEST_FILE,
  PACKAGE_ROOT,
  buildManifest,
  collectGitFacts,
  sha256File,
  shortHash,
} from './release-artifact.ts';

/**
 * 写清单: 算产物摘要 → 采 git 事实 → 落盘, 返回写入的清单; 产物缺失 / 不是常规文件 /
 * 零字节时返回 null (缺失是要落退出码的拒绝路径, 不是异常, 故用返回值而非抛错)。
 * 外部副作用：写入 dist/manifest.json。
 */
export const writeDistManifest = (
  distDir: string,
  git: GitFacts,
  builtAt: string,
): DistManifest | null => {
  const cliPath = join(distDir, CLI_FILE);
  if (!existsSync(cliPath)) return null;
  // 存在但 stat 失败 / 摘要读不出属环境异常 (权限、坏盘), 让它抛: 失败要响亮, 不与「缺失」混同
  const info = statSync(cliPath);
  if (!info.isFile() || info.size === 0) return null;
  const manifest = buildManifest({
    cliSha256: sha256File(cliPath),
    git,
    builtAt,
  });
  writeFileSync(
    join(distDir, MANIFEST_FILE),
    `${JSON.stringify(manifest, null, 2)}\n`,
  );
  return manifest;
};

/** 人读的来源标签: 提交短哈希 + 脏净标注; 非 git 检出如实说明 (不假装有提交) */
const sourceLabel = (manifest: DistManifest): string => {
  if (manifest.commit === null) return '非 git 检出 (未记录提交)';
  const dirty = manifest.dirty === true ? ' (脏工作树)' : '';
  return `提交 ${shortHash(manifest.commit)}${dirty}`;
};

/** 入口: 写清单并落退出码 (0 已写入 / 1 产物缺失或为空) */
const main = (): number => {
  const manifest = writeDistManifest(
    join(PACKAGE_ROOT, 'dist'),
    collectGitFacts(PACKAGE_ROOT),
    new Date().toISOString(),
  );
  if (manifest === null) {
    process.stderr.write(
      `产物清单未写入: dist/${CLI_FILE} 缺失或为空, 先跑 bun build 产出产物\n`,
    );
    return 1;
  }
  process.stdout.write(
    `产物清单已写入 dist/${MANIFEST_FILE}: ${sourceLabel(manifest)} · 摘要 ${shortHash(manifest.cliSha256)}\n`,
  );
  return 0;
};

// 被测试 import 时不得跑入口 (只有直接运行才落退出码)
if (import.meta.main) process.exitCode = main();
