/**
 * 发布前置闸门 (verify-release.ts) 行为钉住:
 * 临时 git 检出端到端三态 + 注入事实的完整拒绝矩阵。
 */
import { describe, expect, test } from 'bun:test';

import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ASSET_DIR,
  ASSET_MANIFEST_FILE,
  CLI_FILE,
  type DistState,
  MANIFEST_FILE,
  type PackExpectation,
  type PackFacts,
  type ReleaseFacts,
  collectGitFacts,
  judgeRelease,
  sha256File,
} from './release-artifact.ts';
import {
  STAGED_EXPECTED_PACK,
  makeTempDir,
  makeTempRepo,
  stageTemplateAssets,
} from './release.fixtures.ts';
import { type ReleaseIo, verifyRelease } from './verify-release.ts';
import { writeDistManifest } from './write-dist-manifest.ts';

const PACK_OK: PackFacts = { files: [...STAGED_EXPECTED_PACK], issue: null };
const EXPECTATION_OK: PackExpectation = {
  files: STAGED_EXPECTED_PACK,
  issue: null,
};

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

const stageArtifact = async (root: string): Promise<void> => {
  await mkdir(join(root, 'dist'), { recursive: true });
  const cliPath = join(root, 'dist', CLI_FILE);
  await writeFile(cliPath, "console.log('hi');\n");
  const manifest = writeDistManifest(
    join(root, 'dist'),
    collectGitFacts(root),
    '2026-11-19T00:00:00.000Z',
  );
  expect(manifest).not.toBeNull();
  expect(manifest?.cliSha256).toBe(sha256File(cliPath));
};

const patchManifest = async (
  root: string,
  patch: Record<string, unknown>,
): Promise<void> => {
  const path = join(root, 'dist', MANIFEST_FILE);
  const current = JSON.parse(await readFile(path, 'utf8')) as Record<
    string,
    unknown
  >;
  await writeFile(path, JSON.stringify({ ...current, ...patch }));
};

const stageRelease = async (root: string): Promise<void> => {
  await stageTemplateAssets(root);
  await stageArtifact(root);
};

describe('发布前置闸门 · 临时检出端到端', () => {
  test('干净检出 + 本提交产物 + 清单自洽 + 白名单相符 → 通过 (退出码 0)', async () => {
    const repo = await makeTempRepo('codd-cli-release-ok-');
    try {
      await stageRelease(repo.root);
      const { io, out, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(0);
      expect(out.join('\n')).toContain('发布前置校验通过');
      expect(err).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('工作树脏 → 拒绝 (退出码 1)', async () => {
    const repo = await makeTempRepo('codd-cli-release-dirty-');
    try {
      await stageRelease(repo.root);
      await writeFile(join(repo.root, 'workspace.txt'), '半成品\n');
      const { io, out, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain(
        '工作树不干净 (未提交改动 1 项: workspace.txt)',
      );
      expect(out).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('产物缺失 / 摘要不符 / 脏构建 / 提交不一致 / 非 git / 资产缺失或损坏 分别拒绝', async () => {
    const repo = await makeTempRepo('codd-cli-release-cases-');
    try {
      await stageRelease(repo.root);
      await rm(join(repo.root, 'dist', CLI_FILE));
      const c1 = capture();
      expect(verifyRelease(repo.root, c1.io, PACK_OK)).toBe(1);
      expect(c1.err.join('\n')).toContain('产物缺失');

      await stageRelease(repo.root);
      await writeFile(join(repo.root, 'dist', CLI_FILE), "console.log('x');\n");
      const c2 = capture();
      expect(verifyRelease(repo.root, c2.io, PACK_OK)).toBe(1);
      expect(c2.err.join('\n')).toContain('产物摘要与清单记录不符');

      await stageRelease(repo.root);
      await patchManifest(repo.root, { dirty: true });
      const c3 = capture();
      expect(verifyRelease(repo.root, c3.io, PACK_OK)).toBe(1);
      expect(c3.err.join('\n')).toContain('脏工作树构建');

      await stageRelease(repo.root);
      await patchManifest(repo.root, { commit: 'f'.repeat(40) });
      const c4 = capture();
      expect(verifyRelease(repo.root, c4.io, PACK_OK)).toBe(1);
      expect(c4.err.join('\n')).toContain('不一致');

      await stageArtifact(repo.root);
      await rm(join(repo.root, ASSET_DIR), { recursive: true, force: true });
      const c5 = capture();
      expect(verifyRelease(repo.root, c5.io, PACK_OK)).toBe(1);
      expect(c5.err.join('\n')).toContain('模板资产清单缺失');

      await mkdir(join(repo.root, ASSET_DIR), { recursive: true });
      await writeFile(
        join(repo.root, ASSET_DIR, ASSET_MANIFEST_FILE),
        '{ broken',
      );
      const c6 = capture();
      expect(verifyRelease(repo.root, c6.io, PACK_OK)).toBe(1);
      expect(c6.err.join('\n')).toContain('不是合法 JSON');
    } finally {
      await repo.cleanup();
    }

    const noGit = await makeTempDir('codd-cli-release-nogit-');
    try {
      const c = capture();
      expect(verifyRelease(noGit.root, c.io, PACK_OK)).toBe(1);
      expect(c.err.join('\n')).toContain('读不到 git 状态');
    } finally {
      await noGit.cleanup();
    }
  });
});

interface FieldCase {
  name: string;
  facts: ReleaseFacts;
  expectation: PackExpectation;
  reason: string;
}

const fieldCases = (): { clean: ReleaseFacts; rejects: FieldCase[] } => {
  const cleanCommit = 'a2109d7f'.repeat(5);
  const cleanSha = '9f2c47ab'.repeat(8);
  const cleanManifest = {
    schemaVersion: 1,
    commit: cleanCommit,
    dirty: false,
    cliSha256: cleanSha,
    builtAt: '2026-11-19T00:00:00.000Z',
  };
  const cleanDist: DistState = {
    entryExists: true,
    entrySize: 17,
    entrySha256: cleanSha,
    manifestExists: true,
    manifest: cleanManifest,
    manifestIssue: null,
  };
  const clean: ReleaseFacts = {
    gitStatus: '',
    gitHead: cleanCommit,
    dist: cleanDist,
    pack: PACK_OK,
  };
  const reject = (
    name: string,
    patch: Partial<ReleaseFacts>,
    reason: string,
    expectation: PackExpectation = EXPECTATION_OK,
  ): FieldCase => ({
    name,
    facts: { ...clean, ...patch },
    expectation,
    reason,
  });
  const distPatch = (patch: Partial<DistState>): ReleaseFacts => ({
    ...clean,
    dist: { ...cleanDist, ...patch },
  });

  return {
    clean,
    rejects: [
      reject('git 状态读不到', { gitStatus: null }, '读不到 git 状态'),
      reject('HEAD 读不到', { gitHead: null }, '读不到 HEAD'),
      reject(
        '工作树脏 (多条预览截断)',
        { gitStatus: ' M a.txt\n?? b.txt\n M c.txt\n?? d.txt\n' },
        '未提交改动 4 项: a.txt, b.txt, c.txt …',
      ),
      {
        name: '产物缺失',
        facts: distPatch({
          entryExists: false,
          entrySize: 0,
          entrySha256: null,
        }),
        expectation: EXPECTATION_OK,
        reason: '产物缺失',
      },
      {
        name: '产物零字节',
        facts: distPatch({ entrySize: 0, entrySha256: null }),
        expectation: EXPECTATION_OK,
        reason: '产物为空',
      },
      {
        name: '产物不可读',
        facts: distPatch({ entrySha256: null }),
        expectation: EXPECTATION_OK,
        reason: '产物不可读',
      },
      {
        name: '清单缺失',
        facts: distPatch({ manifestExists: false, manifest: null }),
        expectation: EXPECTATION_OK,
        reason: '产物清单缺失',
      },
      {
        name: '清单 JSON 损坏',
        facts: distPatch({
          manifest: null,
          manifestIssue: '清单不是合法 JSON',
        }),
        expectation: EXPECTATION_OK,
        reason: '清单不可用: 清单不是合法 JSON',
      },
      {
        name: '清单记录脏构建',
        facts: distPatch({ manifest: { ...cleanManifest, dirty: true } }),
        expectation: EXPECTATION_OK,
        reason: '脏工作树构建',
      },
      {
        name: '清单提交与 HEAD 不一致',
        facts: distPatch({
          manifest: { ...cleanManifest, commit: 'b'.repeat(40) },
        }),
        expectation: EXPECTATION_OK,
        reason: '不一致',
      },
      {
        name: '摘要与清单不符',
        facts: distPatch({ entrySha256: 'c'.repeat(64) }),
        expectation: EXPECTATION_OK,
        reason: '摘要与清单记录不符',
      },
      {
        name: '资产清单不可用',
        facts: clean,
        expectation: { files: null, issue: '模板资产清单缺失' },
        reason: '模板资产清单缺失',
      },
      reject(
        '发行面清单采不到',
        { pack: { files: null, issue: 'npm pack 跑不起来 (需要 npm)' } },
        '该项检查需要 npm',
      ),
      reject(
        '发行面包内多出文件',
        {
          pack: {
            files: [...STAGED_EXPECTED_PACK, 'README.backup'],
            issue: null,
          },
        },
        '多出 README.backup',
      ),
      reject(
        '发行面包内缺少 dist/cli.js',
        {
          pack: {
            files: STAGED_EXPECTED_PACK.filter((p) => p !== `dist/${CLI_FILE}`),
            issue: null,
          },
        },
        `缺少 dist/${CLI_FILE}`,
      ),
      reject(
        '发行面包内缺少 bin/bunfig.toml',
        {
          pack: {
            files: STAGED_EXPECTED_PACK.filter((p) => p !== 'bin/bunfig.toml'),
            issue: null,
          },
        },
        '缺少 bin/bunfig.toml',
      ),
    ],
  };
};

describe('发布前置闸门 · 字段级判定 (注入事实)', () => {
  const { clean, rejects } = fieldCases();

  test('干净事实 → 通过并交出提交与摘要', () => {
    const verdict = judgeRelease(clean, EXPECTATION_OK);
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.commit).toBe('a2109d7f'.repeat(5));
      expect(verdict.sha256).toBe('9f2c47ab'.repeat(8));
    }
  });

  for (const item of rejects) {
    test(`拒绝: ${item.name}`, () => {
      const verdict = judgeRelease(item.facts, item.expectation);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(item.reason);
    });
  }
});
