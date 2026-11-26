/**
 * `@iyowei/wake` 发布前置闸门单元测试。
 */
import { describe, expect, test } from 'bun:test';

import {
  PACK_FILES_EXPECTED,
  type VerifyFacts,
  judgeRelease,
  verifyRelease,
} from './verify-release.ts';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const cleanFacts = (): VerifyFacts => ({
  gitStatus: '',
  gitHead: HEAD,
  dist: {
    entryExists: true,
    entrySize: 64,
    entrySha256: SHA,
    manifestExists: true,
    manifest: {
      schemaVersion: 1,
      entry: 'index.js',
      entrySha256: SHA,
      commit: HEAD,
      dirty: false,
      builtAt: '2026-11-27T00:00:00.000Z',
    },
    manifestIssue: null,
  },
  dtsTsSpecifierHits: [],
  pack: { files: [...PACK_FILES_EXPECTED], issue: null },
});

describe('@iyowei/wake verify-release', () => {
  test('干净事实通过', () => {
    const out: string[] = [];
    const err: string[] = [];
    expect(
      verifyRelease(
        '/unused',
        { out: (l) => out.push(l), err: (l) => err.push(l) },
        cleanFacts(),
      ),
    ).toBe(0);
    expect(err).toEqual([]);
    expect(out[0]).toContain(HEAD.slice(0, 12));
  });

  test('d.ts 残留 .ts 或内部模块泄露白名单漂移拒绝', () => {
    const dts = judgeRelease({
      ...cleanFacts(),
      dtsTsSpecifierHits: ['index.d.ts'],
    });
    expect(dts.ok).toBe(false);

    const extra = judgeRelease({
      ...cleanFacts(),
      pack: {
        files: [...PACK_FILES_EXPECTED, 'dist/relay.d.ts'],
        issue: null,
      },
    });
    expect(extra.ok).toBe(false);
  });
});
