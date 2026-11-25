/**
 * `write-dist-manifest.ts` 单元测试。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
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

const FIXED_TIME = '2026-11-25T00:00:00.000Z';
const COMMIT = 'a2109d7f'.repeat(5);

describe('fan-cli 产物清单写入', () => {
  test('写入清单与 sha256 精确对齐', async () => {
    const temp = await makeTempDir('fan-manifest-');
    try {
      const distDir = join(temp.root, 'dist');
      mkdirSync(distDir, { recursive: true });
      writeFileSync(join(distDir, CLI_FILE), "console.log('fan');\n");
      const manifest = writeDistManifest(
        distDir,
        { commit: COMMIT, dirty: false },
        FIXED_TIME,
      );
      expect(manifest).toEqual({
        schemaVersion: 1,
        commit: COMMIT,
        dirty: false,
        cliSha256: sha256File(join(distDir, CLI_FILE)),
        builtAt: FIXED_TIME,
      });
      const onDisk = JSON.parse(
        await readFile(join(distDir, MANIFEST_FILE), 'utf8'),
      ) as DistManifest;
      expect(onDisk).toEqual(manifest!);
    } finally {
      await temp.cleanup();
    }
  });

  test('产物缺失返回 null, 真实 git 检出采集正确', async () => {
    const repo = await makeTempRepo('fan-facts-');
    try {
      expect(
        writeDistManifest(
          join(repo.root, 'dist'),
          { commit: null, dirty: null },
          FIXED_TIME,
        ),
      ).toBeNull();
      expect(existsSync(join(repo.root, 'dist', MANIFEST_FILE))).toBe(false);
      expect(collectGitFacts(repo.root)).toEqual({
        commit: runGit(repo.root, ['rev-parse', 'HEAD']).trim(),
        dirty: false,
      });
    } finally {
      await repo.cleanup();
    }
  });
});
