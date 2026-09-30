/**
 * 构建侧清单写入 (write-dist-manifest.ts) 与 git 事实采集 (collectGitFacts) 的行为钉住。
 * 清单字段是三方契约 (构建侧写 / 发布闸门读 / npm 启动器读), 故连字段值一并钉死: 启动器
 * 随包分发, 无法 import 本模块, 两边口径只靠各自测试与注释对齐;
 * 采集口径用真 git 检出验 (打桩验不出「porcelain 空输出 = 干净」这条口径)。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CLI_FILE,
  type DistManifest,
  MANIFEST_FILE,
  collectGitFacts,
  sha256File,
} from './release-artifact.ts';
import { makeTempDir, makeTempRepo, runGit } from './release.fixtures.ts';
import { writeDistManifest } from './write-dist-manifest.ts';

const FIXED_TIME = '2026-10-01T00:00:00.000Z';
const COMMIT = 'a2109d7f'.repeat(5);

/** 临时产物目录 (同步建目录便于用例内直接写文件) */
const makeDistDir = async (): Promise<{
  distDir: string;
  cleanup: () => Promise<void>;
}> => {
  const temp = await makeTempDir('create-clis-manifest-');
  const distDir = join(temp.root, 'dist');
  mkdirSync(distDir, { recursive: true });
  return { distDir, cleanup: temp.cleanup };
};

describe('产物清单写入', () => {
  test('写入清单: 形状与摘要钉住 (摘要取产物实测值)', async () => {
    const dist = await makeDistDir();
    try {
      writeFileSync(join(dist.distDir, CLI_FILE), "console.log('hi');\n");

      const manifest = writeDistManifest(
        dist.distDir,
        { commit: COMMIT, dirty: false },
        FIXED_TIME,
      );
      if (manifest === null) throw new Error('清单应已写入, 实际返回 null');

      expect(manifest).toEqual({
        schemaVersion: 1,
        commit: COMMIT,
        dirty: false,
        cliSha256: sha256File(join(dist.distDir, CLI_FILE)),
        builtAt: FIXED_TIME,
      });
      const onDisk = JSON.parse(
        await readFile(join(dist.distDir, MANIFEST_FILE), 'utf8'),
      ) as DistManifest;
      expect(onDisk).toEqual(manifest);
    } finally {
      await dist.cleanup();
    }
  });

  test('产物缺失 → 返回 null, 不落清单', async () => {
    const dist = await makeDistDir();
    try {
      expect(
        writeDistManifest(
          dist.distDir,
          { commit: null, dirty: null },
          FIXED_TIME,
        ),
      ).toBeNull();
      expect(existsSync(join(dist.distDir, MANIFEST_FILE))).toBe(false);
    } finally {
      await dist.cleanup();
    }
  });

  test('产物零字节 → 返回 null (空产物不算产物)', async () => {
    const dist = await makeDistDir();
    try {
      writeFileSync(join(dist.distDir, CLI_FILE), '');

      expect(
        writeDistManifest(
          dist.distDir,
          { commit: null, dirty: null },
          FIXED_TIME,
        ),
      ).toBeNull();
      expect(existsSync(join(dist.distDir, MANIFEST_FILE))).toBe(false);
    } finally {
      await dist.cleanup();
    }
  });

  test('非 git 检出: 事实如实落 null (不假装有提交)', async () => {
    const temp = await makeTempDir('create-clis-nogit-');
    try {
      expect(collectGitFacts(temp.root)).toEqual({ commit: null, dirty: null });
    } finally {
      await temp.cleanup();
    }
  });

  test('真实检出: 干净时采到提交与净状态, 改动后转脏', async () => {
    const repo = await makeTempRepo('create-clis-facts-');
    try {
      expect(collectGitFacts(repo.root)).toEqual({
        commit: runGit(repo.root, ['rev-parse', 'HEAD']).trim(),
        dirty: false,
      });

      await writeFile(join(repo.root, 'workspace.txt'), '改过\n');

      expect(collectGitFacts(repo.root)).toEqual({
        commit: runGit(repo.root, ['rev-parse', 'HEAD']).trim(),
        dirty: true,
      });
    } finally {
      await repo.cleanup();
    }
  });
});
