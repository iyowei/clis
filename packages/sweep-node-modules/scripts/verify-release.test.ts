/**
 * 发布闸门的单元测试 (物理闸门自身的测试义务, 走标准断言):
 * judgeRelease 纯函数逐分支覆盖 + collectFacts 的临时仓库集成采集。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import {
  PACK_FILES_EXPECTED,
  type VerifyFacts,
  collectFacts,
  judgeRelease,
} from './verify-release.ts';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const cleanDist = () => ({
  entryExists: true,
  entrySize: 26,
  entrySha256: SHA,
  manifestExists: true,
  manifest: {
    schemaVersion: 1,
    entry: 'index.js',
    entrySha256: SHA,
    commit: HEAD,
    dirty: false,
    builtAt: '2026-09-29T00:00:00.000Z',
  } as Record<string, unknown> | null,
  manifestIssue: null as string | null,
});

const validFacts = (): VerifyFacts => ({
  gitStatus: '',
  gitHead: HEAD,
  dist: cleanDist(),
  dtsTsSpecifierHits: [],
  pack: { files: [...PACK_FILES_EXPECTED], issue: null },
});

describe('judgeRelease 判定链', () => {
  test('四要素齐备放行', () => {
    const verdict = judgeRelease(validFacts());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.commit).toBe(HEAD);
      expect(verdict.sha256).toBe(SHA);
    }
  });

  test('非 git 检出 / 脏工作树分别拒绝', () => {
    const notGit = judgeRelease({ ...validFacts(), gitStatus: null });
    expect(notGit.ok).toBe(false);
    if (!notGit.ok) expect(notGit.reason).toContain('读不到 git 状态');

    const dirty = judgeRelease({
      ...validFacts(),
      gitStatus: ' M packages/x/src/a.ts\n?? scratch.md',
    });
    expect(dirty.ok).toBe(false);
    if (!dirty.ok)
      expect(dirty.reason).toContain('工作树不干净 (未提交改动 2 项');
  });

  test('清单缺失 / 形状病灶 / 构建时脏 分别拒绝', () => {
    const missing = judgeRelease({
      ...validFacts(),
      dist: { ...cleanDist(), manifestExists: false, manifest: null },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('产物清单缺失');

    // 形状病灶在采集层落错 (readManifest), 判定层读 manifestIssue 报出
    const badSchema = judgeRelease({
      ...validFacts(),
      dist: {
        ...cleanDist(),
        manifest: null,
        manifestIssue: '清单 schemaVersion 不受支持 (期望 1)',
      },
    });
    expect(badSchema.ok).toBe(false);
    if (!badSchema.ok) expect(badSchema.reason).toContain('schemaVersion');

    // dirty 非 false (含未知 null) 一律拒: 产物无法自证出自干净构建
    const dirtyBuild = judgeRelease({
      ...validFacts(),
      dist: {
        ...cleanDist(),
        manifest: { ...cleanDist().manifest!, dirty: null },
      },
    });
    expect(dirtyBuild.ok).toBe(false);
    if (!dirtyBuild.ok) expect(dirtyBuild.reason).toContain('脏工作树构建');
  });

  test('产物非本提交构建 / 摘要不符 / index.js 缺失 分别拒绝', () => {
    const otherCommit = judgeRelease({
      ...validFacts(),
      dist: {
        ...cleanDist(),
        manifest: { ...cleanDist().manifest!, commit: 'f'.repeat(40) },
      },
    });
    expect(otherCommit.ok).toBe(false);
    if (!otherCommit.ok)
      expect(otherCommit.reason).toContain('不是本次提交构建');

    const swapped = judgeRelease({
      ...validFacts(),
      dist: { ...cleanDist(), entrySha256: 'f'.repeat(64) },
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.reason).toContain('产物摘要与清单记录不符');

    const noEntry = judgeRelease({
      ...validFacts(),
      dist: {
        ...cleanDist(),
        entryExists: false,
        entrySize: 0,
        entrySha256: null,
      },
    });
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) expect(noEntry.reason).toContain('产物缺失');
  });

  test('d.ts 残留 .ts specifier / pack 采集失败 / 白名单不符 分别拒绝', () => {
    const dts = judgeRelease({
      ...validFacts(),
      dtsTsSpecifierHits: ['index.d.ts', 'codes.d.ts'],
    });
    expect(dts.ok).toBe(false);
    if (!dts.ok) expect(dts.reason).toContain('index.d.ts, codes.d.ts');

    const noPack = judgeRelease({
      ...validFacts(),
      pack: { files: null, issue: 'npm pack 跑不起来' },
    });
    expect(noPack.ok).toBe(false);
    if (!noPack.ok) expect(noPack.reason).toContain('采不到');

    const extra = judgeRelease({
      ...validFacts(),
      pack: { files: [...PACK_FILES_EXPECTED, 'dist/secret.env'], issue: null },
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toContain('多出 dist/secret.env');

    const missing = judgeRelease({
      ...validFacts(),
      pack: {
        files: PACK_FILES_EXPECTED.filter((file) => file !== 'dist/index.js'),
        issue: null,
      },
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('缺少 dist/index.js');
  });
});

describe('collectFacts 集成采集', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const dir of dirs.splice(0))
      rmSync(dir, { recursive: true, force: true });
  });

  test('临时仓库: git 事实 / 清单 / 摘要 / d.ts 复查 / pack 清单逐项落地', () => {
    const root = mkdtempSync(join(tmpdir(), 'sweep-verify-'));
    dirs.push(root);
    const git = (args: string[]) =>
      spawnSync('git', args, { cwd: root, encoding: 'utf8' });
    git(['init', '-q']);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'probe-verify-pkg',
        version: '0.0.1',
        files: ['dist'],
      }),
    );
    mkdirSync(join(root, 'dist'));
    writeFileSync(join(root, 'dist/index.js'), 'export const x = 1;\n');
    writeFileSync(
      join(root, 'dist/index.d.ts'),
      "export { x } from './index.js';\n",
    );
    writeFileSync(join(root, 'dist/bad.d.ts'), "export { y } from './y.ts';\n");
    git(['add', '-A']);
    git(['-c', 'user.email=t@t', '-c', 'user.name=t', 'commit', '-qm', 'init']);

    const facts = collectFacts(root);
    expect(facts.gitStatus).toBe('');
    expect(facts.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.dist.manifest).toBeNull();
    expect(facts.dist.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.dtsTsSpecifierHits).toEqual(['bad.d.ts']);
    expect(facts.pack.files).toEqual(
      [
        'dist/bad.d.ts',
        'dist/index.d.ts',
        'dist/index.js',
        'package.json',
      ].sort(),
    );
  });
});
