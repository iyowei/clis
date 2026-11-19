/**
 * 构建侧入口: 给产物 dist/cli.js 写入自证清单 dist/manifest.json。
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

export const writeDistManifest = (
  distDir: string,
  git: GitFacts,
  builtAt: string,
): DistManifest | null => {
  const cliPath = join(distDir, CLI_FILE);
  if (!existsSync(cliPath)) return null;
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

const sourceLabel = (manifest: DistManifest): string => {
  if (manifest.commit === null) return '非 git 检出 (未记录提交)';
  const dirty = manifest.dirty === true ? ' (脏工作树)' : '';
  return `提交 ${shortHash(manifest.commit)}${dirty}`;
};

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

if (import.meta.main) process.exitCode = main();
