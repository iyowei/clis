/**
 * 发布前置闸门 (verify-release.ts) 的行为钉住: 三态 (干净通过 / 脏拒绝 / 产物缺失拒绝) 全跑在
 * 临时 git 检出上, 判定所依据的 git 事实来自真命令, 而非「跑测试那一刻当前工作树恰好脏还是净」
 * (本仓库平时就是脏树, 正因如此不能拿它当夹具)。
 * 端到端不便造的畸形现场 (零字节产物 / 清单 JSON 损坏 / schemaVersion 不受支持等) 走注入事实的
 * 字段级用例: judgeRelease 是纯函数, 事实输入可完全摆布。
 * 发行面清单 (npm pack 输出) 同理注入, 端到端用例因而一次 npm 都不跑; 白名单与真实 npm 行为的
 * 对齐由文末「真实 npm 对齐」组在本仓库上实跑一次钉住 (防仓库根杂质复发); 该组在无 dist/ 的
 * 未构建态注册期 skip 并播报 (bun:test 无运行时 skip), 免得「还没构建」被误报成发行面回归。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CLI_FILE,
  type DistState,
  MANIFEST_FILE,
  PACKAGE_ROOT,
  PACK_FILES_EXPECTED,
  type PackFacts,
  type ReleaseFacts,
  collectGitFacts,
  judgePackFiles,
  judgeRelease,
  parsePackFiles,
  readPackFiles,
  sha256File,
} from './release-artifact.ts';
import { makeTempDir, makeTempRepo } from './release.fixtures.ts';
import { type ReleaseIo, verifyRelease } from './verify-release.ts';
import { writeDistManifest } from './write-dist-manifest.ts';

/** 注入一个「与白名单相符」的发行面事实: 判定链要走完 pack 检查, 但单测不必真跑 npm */
const PACK_OK: PackFacts = { files: [...PACK_FILES_EXPECTED], issue: null };

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
    '2026-09-26T00:00:00.000Z',
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

describe('发布前置闸门 · 临时检出端到端', () => {
  test('干净检出 + 本提交产物 + 清单自洽 → 通过 (退出码 0)', async () => {
    const repo = await makeTempRepo('sweep-lab-release-ok-');
    try {
      await stageArtifact(repo.root);
      const { io, out, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(0);
      expect(out.join('\n')).toContain('发布前置校验通过');
      expect(err).toEqual([]);
    } finally {
      await repo.cleanup();
    }
  });

  test('工作树脏 → 拒绝 (退出码 1, 拒绝原因带未提交改动条数)', async () => {
    const repo = await makeTempRepo('sweep-lab-release-dirty-');
    try {
      await stageArtifact(repo.root);
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
    const repo = await makeTempRepo('sweep-lab-release-nocli-');
    try {
      await stageArtifact(repo.root);
      await rm(join(repo.root, 'dist', CLI_FILE));
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('产物缺失');
    } finally {
      await repo.cleanup();
    }
  });

  test('产物被替换 (摘要不符) → 拒绝', async () => {
    const repo = await makeTempRepo('sweep-lab-release-swapped-');
    try {
      await stageArtifact(repo.root);
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
    const repo = await makeTempRepo('sweep-lab-release-dirtybuild-');
    try {
      await stageArtifact(repo.root);
      await patchManifest(repo.root, { dirty: true });
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('脏工作树构建');
    } finally {
      await repo.cleanup();
    }
  });

  test('清单记录的提交与 HEAD 不一致 (构建后又有新提交) → 拒绝', async () => {
    const repo = await makeTempRepo('sweep-lab-release-stale-');
    try {
      await stageArtifact(repo.root);
      await patchManifest(repo.root, { commit: 'f'.repeat(40) });
      const { io, err } = capture();

      expect(verifyRelease(repo.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('不一致');
    } finally {
      await repo.cleanup();
    }
  });

  test('非 git 目录 → 拒绝 (读不到 git 状态)', async () => {
    const temp = await makeTempDir('sweep-lab-release-nogit-');
    try {
      const { io, err } = capture();

      expect(verifyRelease(temp.root, io, PACK_OK)).toBe(1);
      expect(err.join('\n')).toContain('读不到 git 状态');
    } finally {
      await temp.cleanup();
    }
  });
});

describe('发布前置闸门 · 字段级判定 (注入事实)', () => {
  const CLEAN_COMMIT = 'a2109d7f'.repeat(5);
  const CLEAN_SHA = '9f2c47ab'.repeat(8);
  const cleanManifest = {
    schemaVersion: 1,
    commit: CLEAN_COMMIT,
    dirty: false,
    cliSha256: CLEAN_SHA,
    builtAt: '2026-09-26T00:00:00.000Z',
  };
  const cleanDist: DistState = {
    entryExists: true,
    entrySize: 17,
    entrySha256: CLEAN_SHA,
    manifestExists: true,
    manifest: cleanManifest,
    manifestIssue: null,
  };
  const cleanFacts: ReleaseFacts = {
    gitStatus: '',
    gitHead: CLEAN_COMMIT,
    dist: cleanDist,
    pack: PACK_OK,
  };

  test('干净事实 → 通过并交出被判定的提交与摘要', () => {
    const verdict = judgeRelease(cleanFacts);

    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.commit).toBe(CLEAN_COMMIT);
      expect(verdict.sha256).toBe(CLEAN_SHA);
    }
  });

  const rejectCases: Array<{
    name: string;
    facts: ReleaseFacts;
    reason: string;
  }> = [
    {
      name: 'git 状态读不到',
      facts: { ...cleanFacts, gitStatus: null },
      reason: '读不到 git 状态',
    },
    {
      name: 'HEAD 读不到',
      facts: { ...cleanFacts, gitHead: null },
      reason: '读不到 HEAD',
    },
    {
      name: '工作树脏 (改动条数进拒绝原因)',
      facts: { ...cleanFacts, gitStatus: ' M workspace.txt\n?? draft.md\n' },
      reason: '未提交改动 2 项',
    },
    {
      name: '工作树脏 (路径预览逐条列出, 超三条以省略号收敛)',
      facts: {
        ...cleanFacts,
        gitStatus: ' M a.txt\n?? b.txt\n M c.txt\n?? d.txt\n',
      },
      reason: '未提交改动 4 项: a.txt, b.txt, c.txt …',
    },
    {
      name: '产物缺失',
      facts: {
        ...cleanFacts,
        dist: {
          ...cleanDist,
          entryExists: false,
          entrySize: 0,
          entrySha256: null,
        },
      },
      reason: '产物缺失',
    },
    {
      name: '产物零字节',
      facts: {
        ...cleanFacts,
        dist: { ...cleanDist, entrySize: 0, entrySha256: null },
      },
      reason: '产物为空',
    },
    {
      name: '产物读不出 (摘要算不出)',
      facts: { ...cleanFacts, dist: { ...cleanDist, entrySha256: null } },
      reason: '产物不可读',
    },
    {
      name: '清单缺失',
      facts: {
        ...cleanFacts,
        dist: { ...cleanDist, manifestExists: false, manifest: null },
      },
      reason: '产物清单缺失',
    },
    {
      name: '清单不可用 (JSON 损坏, 病灶原样带上)',
      facts: {
        ...cleanFacts,
        dist: {
          ...cleanDist,
          manifest: null,
          manifestIssue: '清单不是合法 JSON',
        },
      },
      reason: '清单不可用: 清单不是合法 JSON',
    },
    {
      name: '清单记录脏构建',
      facts: {
        ...cleanFacts,
        dist: { ...cleanDist, manifest: { ...cleanManifest, dirty: true } },
      },
      reason: '脏工作树构建',
    },
    {
      name: '清单提交与 HEAD 不一致',
      facts: {
        ...cleanFacts,
        dist: {
          ...cleanDist,
          manifest: { ...cleanManifest, commit: 'b'.repeat(40) },
        },
      },
      reason: '不一致',
    },
    {
      name: '摘要与清单记录不符',
      facts: {
        ...cleanFacts,
        dist: { ...cleanDist, entrySha256: 'c'.repeat(64) },
      },
      reason: '摘要与清单记录不符',
    },
    {
      name: '发行面清单采不到 (该检查需要 npm)',
      facts: {
        ...cleanFacts,
        pack: { files: null, issue: 'npm pack 跑不起来 (需要 npm)' },
      },
      reason: '该项检查需要 npm',
    },
    {
      name: '发行面包内多出文件 (如仓库根备份被 npm 一并收进包)',
      facts: {
        ...cleanFacts,
        pack: {
          files: [...PACK_FILES_EXPECTED, 'README.md.20260924_181433.modified'],
          issue: null,
        },
      },
      reason: '多出 README.md.20260924_181433.modified',
    },
    {
      name: '发行面包内缺少文件',
      facts: {
        ...cleanFacts,
        pack: {
          files: PACK_FILES_EXPECTED.filter((path) => path !== 'dist/cli.js'),
          issue: null,
        },
      },
      reason: '缺少 dist/cli.js',
    },
    {
      name: '发行面包内一多一少 (两向差异并列列出)',
      facts: {
        ...cleanFacts,
        pack: {
          files: [
            ...PACK_FILES_EXPECTED.filter((path) => path !== 'LICENSE'),
            'extra.txt',
          ],
          issue: null,
        },
      },
      reason: '多出 extra.txt; 缺少 LICENSE',
    },
  ];

  for (const item of rejectCases) {
    test(`拒绝: ${item.name}`, () => {
      const verdict = judgeRelease(item.facts);

      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(item.reason);
    });
  }
});

describe('发行面白名单 · 注入式 (喂假 pack 输出, 一次 npm 都不跑)', () => {
  test('解析 npm pack --json 的输出: 取首个元素的 files[].path', () => {
    const raw = JSON.stringify([
      {
        filename: 'iyowei-sweep-node-modules-0.3.0.tgz',
        files: [
          { path: 'LICENSE', size: 1063 },
          { path: 'dist/cli.js', size: 51965 },
        ],
      },
    ]);

    expect(parsePackFiles(raw)).toEqual(['LICENSE', 'dist/cli.js']);
  });

  test('输出非 JSON / 结构不符 → null (不猜结构, 交由采集层落 issue)', () => {
    expect(parsePackFiles('not json at all')).toBeNull();
    expect(parsePackFiles('{"files":[]}')).toBeNull();
    expect(parsePackFiles('[]')).toBeNull();
    expect(parsePackFiles('[{"files":[{"nopath":1}]}]')).toBeNull();
    expect(parsePackFiles('[{"files":[{"path":""}]}]')).toBeNull();
  });

  test('集合相等 → 通过 (与顺序无关)', () => {
    expect(judgePackFiles([...PACK_FILES_EXPECTED].reverse()).ok).toBe(true);
  });

  test('差异路径剔控制字符 (路径来自 npm 输出, 属低信任输入)', () => {
    const verdict = judgePackFiles([
      ...PACK_FILES_EXPECTED,
      'bad\u001b[31m.txt',
    ]);

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('bad?[31m.txt');
  });
});

/**
 * 真实 npm 对齐的注册门控: 工作树无 dist/ = 未构建的合法态 (safe-install 清产物后尚未重构建即如此),
 * 此时 pack 清单必然缺 dist/cli.js 与 dist/manifest.json, 属「还没构建」而非「发行面杂质回归」。
 * 注册期判定 skip 并播报原因; dist 在场则全程维持原有全清单断言, 不削弱真问题抓取力。
 */
const hasDist = existsSync(join(PACKAGE_ROOT, 'dist'));

if (!hasDist) {
  console.warn(
    '[Skip] 工作树无构建产物 (先 bun run build); 本用例守护发行面杂质回归',
  );
}

describe('发行面白名单 · 真实 npm 对齐 (本仓库实测)', () => {
  test.skipIf(!hasDist)(
    '本仓库工作树的 pack 清单与白名单逐项一致 (包根杂质复发的常驻回归)',
    () => {
      const facts = readPackFiles(PACKAGE_ROOT);

      // 采不到即失败并显示 issue (如「需要 npm」), 不静默跳过: 该项是发行面唯一的真实对齐证据
      expect(facts.issue).toBeNull();
      const verdict = judgePackFiles(facts.files ?? []);
      // 断言携带 reason 而非裸 false: 失败时测试输出直接给出差异清单, 一眼看清是多出还是缺少
      expect(verdict.ok ? '' : verdict.reason).toBe('');
    },
  );
});
