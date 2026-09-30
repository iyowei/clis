/**
 * 发布前置闸门 (verify-release.ts) 的行为钉住: 三态 (干净通过 / 脏拒绝 / 产物缺失拒绝) 全跑在
 * 临时 git 检出上, 判定所依据的 git 事实来自真命令, 而非「跑测试那一刻当前工作树恰好脏还是净」
 * (本仓库平时就是脏树, 正因如此不能拿它当夹具)。
 * 端到端不便造的畸形现场 (零字节产物 / 清单 JSON 损坏 / schemaVersion 不受支持等) 走注入事实的
 * 字段级用例: judgeRelease 是纯函数, 事实输入可完全摆布。
 * 生成器侧专有面 (白名单 = 固定项 + 资产清单动态合并) 的对账口径与真实 npm 对齐另见
 * release-artifact.test.ts; 本文件只管闸门端到端与字段级判定链。
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

/** 注入一个「与白名单相符」的发行面事实: 判定链要走完 pack 检查, 但单测不必真跑 npm */
const PACK_OK: PackFacts = { files: [...STAGED_EXPECTED_PACK], issue: null };

/** 注入一份「资产清单可用」的白名单期望 (端到端用例之外显式注入的那条路径) */
const EXPECTATION_OK: PackExpectation = {
  files: STAGED_EXPECTED_PACK,
  issue: null,
};

/** 捕获闸门输出 (既为断言文案, 也不让测试输出变成噪音) */
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

/** 在检出内造产物与清单: 走真实写入路径, git 事实取自该检出的真实 git */
const stageArtifact = async (root: string): Promise<void> => {
  await mkdir(join(root, 'dist'), { recursive: true });
  const cliPath = join(root, 'dist', CLI_FILE);
  await writeFile(cliPath, "console.log('hi');\n");
  const manifest = writeDistManifest(
    join(root, 'dist'),
    collectGitFacts(root),
    '2026-10-01T00:00:00.000Z',
  );
  expect(manifest).not.toBeNull();
  expect(manifest?.cliSha256).toBe(sha256File(cliPath));
};

/** 改写清单字段 (绕开写入路径, 造出「清单与事实不符」的现场) */
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

/** 端到端用例的公共铺场: 模板资产 + 产物与清单 (两者都是真实写入路径的产物) */
const stageRelease = async (root: string): Promise<void> => {
  await stageTemplateAssets(root);
  await stageArtifact(root);
};

describe('发布前置闸门 · 临时检出端到端', () => {
  test('干净检出 + 本提交产物 + 清单自洽 + 白名单相符 → 通过 (退出码 0)', async () => {
    const repo = await makeTempRepo('create-clis-release-ok-');
    try {
      await stageRelease(repo.root);
      const { io, out, err } = capture();

      // 注入的只有 pack 事实; 白名单期望走读资产清单的默认路径 (动态合并逻辑的真路径)
      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(0);
      expect(out.join('\n')).toContain('发布前置校验通过');
      expect(err).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('工作树脏 → 拒绝 (退出码 1, 拒绝原因带未提交改动条数)', async () => {
    const repo = await makeTempRepo('create-clis-release-dirty-');
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

  test('产物缺失 → 拒绝 (退出码 1)', async () => {
    const repo = await makeTempRepo('create-clis-release-noentry-');
    try {
      await stageRelease(repo.root);
      await rm(join(repo.root, 'dist', CLI_FILE));
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('产物缺失');
    } finally {
      await repo.cleanup();
    }
  });

  test('产物被替换 (摘要不符) → 拒绝', async () => {
    const repo = await makeTempRepo('create-clis-release-swapped-');
    try {
      await stageRelease(repo.root);
      await writeFile(
        join(repo.root, 'dist', CLI_FILE),
        "console.log('swapped');\n",
      );
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('产物摘要与清单记录不符');
    } finally {
      await repo.cleanup();
    }
  });

  test('清单记录的是脏构建 → 拒绝', async () => {
    const repo = await makeTempRepo('create-clis-release-dirtybuild-');
    try {
      await stageRelease(repo.root);
      await patchManifest(repo.root, { dirty: true });
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('脏工作树构建');
    } finally {
      await repo.cleanup();
    }
  });

  test('清单记录的提交与 HEAD 不一致 (构建后又有新提交) → 拒绝', async () => {
    const repo = await makeTempRepo('create-clis-release-stale-');
    try {
      await stageRelease(repo.root);
      await patchManifest(repo.root, { commit: 'f'.repeat(40) });
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('不一致');
    } finally {
      await repo.cleanup();
    }
  });

  test('非 git 目录 → 拒绝 (读不到 git 状态)', async () => {
    const temp = await makeTempDir('create-clis-release-nogit-');
    try {
      const { io, err } = capture();

      expect(verifyRelease(temp.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('读不到 git 状态');
    } finally {
      await temp.cleanup();
    }
  });

  test('资产清单缺失 → 拒绝 (白名单无从建立, 即使其余全干净)', async () => {
    const repo = await makeTempRepo('create-clis-release-noassets-');
    try {
      await stageArtifact(repo.root);
      const { io, out, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('模板资产清单缺失');
      expect(out).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('资产清单损坏 (JSON 不合法) → 拒绝', async () => {
    const repo = await makeTempRepo('create-clis-release-badassets-');
    try {
      await mkdir(join(repo.root, ASSET_DIR), { recursive: true });
      await writeFile(
        join(repo.root, ASSET_DIR, ASSET_MANIFEST_FILE),
        '{ 半截\n',
      );
      await stageArtifact(repo.root);
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('不是合法 JSON');
    } finally {
      await repo.cleanup();
    }
  });
});

/** 一条字段级拒绝用例: 以干净事实为基准注入一处病灶 */
interface FieldCase {
  name: string;
  facts: ReleaseFacts;
  expectation: PackExpectation;
  reason: string;
}

/**
 * 字段级用例集: 基准事实 + 逐项注入病灶的拒绝表。
 * 建在独立函数里 (而非 describe 回调内) 有两个理由: 表格与基准共用同一份常量, 且 describe
 * 回调因此保持短小 (仓库 lint 对单函数行数有上限)。
 */
const fieldCases = (): { clean: ReleaseFacts; rejects: FieldCase[] } => {
  const cleanCommit = 'a2109d7f'.repeat(5);
  const cleanSha = '9f2c47ab'.repeat(8);
  const cleanManifest = {
    schemaVersion: 1,
    commit: cleanCommit,
    dirty: false,
    cliSha256: cleanSha,
    builtAt: '2026-10-01T00:00:00.000Z',
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
        '工作树脏 (改动条数进拒绝原因)',
        { gitStatus: ' M workspace.txt\n?? draft.md\n' },
        '未提交改动 2 项',
      ),
      reject(
        '工作树脏 (路径预览逐条列出, 超三条以省略号收敛)',
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
        name: '产物读不出 (摘要算不出)',
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
        name: '清单不可用 (JSON 损坏, 病灶原样带上)',
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
        name: '摘要与清单记录不符',
        facts: distPatch({ entrySha256: 'c'.repeat(64) }),
        expectation: EXPECTATION_OK,
        reason: '摘要与清单记录不符',
      },
      {
        name: '资产清单不可用 (白名单无从建立, 在发行面检查段拒绝)',
        facts: clean,
        expectation: { files: null, issue: '模板资产清单缺失 (先跑构建)' },
        reason: '模板资产清单缺失',
      },
      reject(
        '发行面清单采不到 (该检查需要 npm)',
        { pack: { files: null, issue: 'npm pack 跑不起来 (需要 npm)' } },
        '该项检查需要 npm',
      ),
      reject(
        '发行面包内多出文件 (如包根备份被 npm 一并收进包)',
        {
          pack: {
            files: [
              ...STAGED_EXPECTED_PACK,
              'README.md.20261001_181433.modified',
            ],
            issue: null,
          },
        },
        '多出 README.md.20261001_181433.modified',
      ),
      reject(
        '发行面包内缺少文件',
        {
          pack: {
            files: STAGED_EXPECTED_PACK.filter(
              (path) => path !== `dist/${CLI_FILE}`,
            ),
            issue: null,
          },
        },
        `缺少 dist/${CLI_FILE}`,
      ),
      reject(
        '发行面包缺一份模板资产 (资产清单与面包对不上)',
        {
          pack: {
            files: STAGED_EXPECTED_PACK.filter(
              (path) => path !== `${ASSET_DIR}/template/README.md`,
            ),
            issue: null,
          },
        },
        `缺少 ${ASSET_DIR}/template/README.md`,
      ),
      reject(
        '发行面包内一多一少 (两向差异并列列出)',
        {
          pack: {
            files: [
              ...STAGED_EXPECTED_PACK.filter((path) => path !== 'package.json'),
              'extra.txt',
            ],
            issue: null,
          },
        },
        '多出 extra.txt; 缺少 package.json',
      ),
    ],
  };
};

describe('发布前置闸门 · 字段级判定 (注入事实)', () => {
  const { clean, rejects } = fieldCases();

  test('干净事实 → 通过并交出被判定的提交与摘要', () => {
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
