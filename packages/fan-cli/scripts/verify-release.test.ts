/**
 * `@iyowei/fan-cli` 发布前置闸门测试 (含工作树 dist 在场时与真实 npm pack 白名单对账)。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CLI_FILE,
  PACKAGE_ROOT,
  PACK_FILES_EXPECTED,
  type PackFacts,
  collectGitFacts,
  judgePackFiles,
  judgeRelease,
  readPackFiles,
  sha256File,
} from './release-artifact.ts';
import { makeTempRepo } from './release.fixtures.ts';
import { type ReleaseIo, verifyRelease } from './verify-release.ts';
import { writeDistManifest } from './write-dist-manifest.ts';

const PACK_OK: PackFacts = { files: [...PACK_FILES_EXPECTED], issue: null };

const capture = (): { io: ReleaseIo; out: string[]; err: string[] } => {
  const out: string[] = [];
  const err: string[] = [];
  return {
    io: {
      out: (line) => {
        out.push(line);
      },
      err: (line) => {
        err.push(line);
      },
    },
    out,
    err,
  };
};

describe('@iyowei/fan-cli verify-release', () => {
  test('干净临时检出 + 自洽产物通过, 脏工作树或白名单差异拒绝', async () => {
    const repo = await makeTempRepo('fan-release-ok-');
    try {
      await mkdir(join(repo.root, 'dist'), { recursive: true });
      const cliPath = join(repo.root, 'dist', CLI_FILE);
      await writeFile(cliPath, "console.log('fan');\n");
      const manifest = writeDistManifest(
        join(repo.root, 'dist'),
        collectGitFacts(repo.root),
        '2026-11-25T00:00:00.000Z',
      );
      expect(manifest?.cliSha256).toBe(sha256File(cliPath));

      const okCap = capture();
      expect(verifyRelease(repo.root, okCap.io, PACK_OK)).toBe(0);
      expect(okCap.err).toEqual([]);

      await writeFile(join(repo.root, 'dirty.txt'), 'x\n');
      const dirtyCap = capture();
      expect(verifyRelease(repo.root, dirtyCap.io, PACK_OK)).toBe(1);
      expect(dirtyCap.err.join('\n')).toContain('工作树不干净');
    } finally {
      await repo.cleanup();
    }

    const extra = judgePackFiles([...PACK_FILES_EXPECTED, 'extra.txt']);
    expect(extra.ok).toBe(false);
    const bad = judgeRelease({
      gitStatus: '',
      gitHead: 'a'.repeat(40),
      dist: {
        entryExists: false,
        entrySize: 0,
        entrySha256: null,
        manifestExists: false,
        manifest: null,
        manifestIssue: null,
      },
      pack: PACK_OK,
    });
    expect(bad.ok).toBe(false);
  });
});

const hasDist = existsSync(join(PACKAGE_ROOT, 'dist'));
const skipPackTest = process.env.CI_SKIP_PACK_TEST === '1';

describe('发行面白名单 · 真实 npm 对齐 (fan-cli)', () => {
  test.skipIf(!hasDist || skipPackTest)(
    'pack 清单与 PACK_FILES_EXPECTED 一致',
    () => {
      const facts = readPackFiles(PACKAGE_ROOT);
      expect(facts.issue).toBeNull();
      const verdict = judgePackFiles(facts.files ?? []);
      expect(verdict.ok ? '' : verdict.reason).toBe('');
    },
    30_000,
  );
});
