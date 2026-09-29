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

const validFacts = (): VerifyFacts => ({
  gitStatus: '',
  gitHead: HEAD,
  manifest: {
    schemaVersion: 1,
    entry: 'index.js',
    entrySha256: SHA,
    commit: HEAD,
    dirty: false,
    builtAt: '2026-09-29T00:00:00.000Z',
  },
  entrySha256: SHA,
  dtsTsSpecifierHits: [],
  pack: [...PACK_FILES_EXPECTED],
});

describe('judgeRelease 判定链', () => {
  test('四要素齐备放行', () => {
    const verdict = judgeRelease(validFacts());
    expect(verdict.ok).toBe(true);
    if (verdict.ok) {
      expect(verdict.commit).toBe(HEAD);
      expect(verdict.entrySha256).toBe(SHA);
    }
  });

  test('非 git 检出 / 脏工作树分别拒绝', () => {
    const notGit = judgeRelease({ ...validFacts(), gitStatus: null });
    expect(notGit.ok).toBe(false);
    if (!notGit.ok) expect(notGit.reason).toContain('不是 git 检出');

    const dirty = judgeRelease({
      ...validFacts(),
      gitStatus: ' M packages/x/src/a.ts\n?? scratch.md',
    });
    expect(dirty.ok).toBe(false);
    if (!dirty.ok) expect(dirty.reason).toContain('工作树不干净 (2 处');
  });

  test('清单缺失 / 版本不支持 / 构建时脏 分别拒绝', () => {
    const missing = judgeRelease({ ...validFacts(), manifest: null });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('缺少产物清单');

    const badSchema = judgeRelease({
      ...validFacts(),
      manifest: { ...validFacts().manifest!, schemaVersion: 2 },
    });
    expect(badSchema.ok).toBe(false);
    if (!badSchema.ok) expect(badSchema.reason).toContain('schemaVersion');

    // dirty 非 false (含未知 null) 一律拒: 产物无法自证出自干净构建
    const dirtyBuild = judgeRelease({
      ...validFacts(),
      manifest: { ...validFacts().manifest!, dirty: null },
    });
    expect(dirtyBuild.ok).toBe(false);
    if (!dirtyBuild.ok)
      expect(dirtyBuild.reason).toContain('构建时工作树不干净');
  });

  test('产物非本提交构建 / 摘要不符 / index.js 缺失 分别拒绝', () => {
    const otherCommit = judgeRelease({
      ...validFacts(),
      manifest: { ...validFacts().manifest!, commit: 'f'.repeat(40) },
    });
    expect(otherCommit.ok).toBe(false);
    if (!otherCommit.ok) expect(otherCommit.reason).toContain('不是本提交构建');

    const swapped = judgeRelease({
      ...validFacts(),
      entrySha256: 'f'.repeat(64),
    });
    expect(swapped.ok).toBe(false);
    if (!swapped.ok) expect(swapped.reason).toContain('摘要与清单不符');

    const noEntry = judgeRelease({ ...validFacts(), entrySha256: null });
    expect(noEntry.ok).toBe(false);
    if (!noEntry.ok) expect(noEntry.reason).toContain('dist/index.js 缺失');
  });

  test('d.ts 残留 .ts specifier / pack 采集失败 / 白名单不符 分别拒绝', () => {
    const dts = judgeRelease({
      ...validFacts(),
      dtsTsSpecifierHits: ['index.d.ts', 'codes.d.ts'],
    });
    expect(dts.ok).toBe(false);
    if (!dts.ok) expect(dts.reason).toContain('index.d.ts, codes.d.ts');

    const noPack = judgeRelease({ ...validFacts(), pack: null });
    expect(noPack.ok).toBe(false);
    if (!noPack.ok) expect(noPack.reason).toContain('采集失败');

    const extra = judgeRelease({
      ...validFacts(),
      pack: [...PACK_FILES_EXPECTED, 'dist/secret.env'],
    });
    expect(extra.ok).toBe(false);
    if (!extra.ok) expect(extra.reason).toContain('多出: dist/secret.env');

    const missing = judgeRelease({
      ...validFacts(),
      pack: PACK_FILES_EXPECTED.filter((file) => file !== 'dist/index.js'),
    });
    expect(missing.ok).toBe(false);
    if (!missing.ok) expect(missing.reason).toContain('缺少: dist/index.js');
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
    expect(facts.manifest).toBeNull();
    expect(facts.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.dtsTsSpecifierHits).toEqual(['bad.d.ts']);
    expect(facts.pack).toEqual(
      [
        'dist/bad.d.ts',
        'dist/index.d.ts',
        'dist/index.js',
        'package.json',
      ].sort(),
    );
  });
});
