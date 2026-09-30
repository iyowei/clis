/**
 * 仓库卫生闸门单测: 临时根上验证「散落备份抓得住、正常文件不误伤」。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import { findStrayBackups } from './lint-stray-backups.ts';

const roots: string[] = [];
function makeRoot(files: string[]): string {
  const root = makeTmpRoot('stray-');
  roots.push(root);
  for (const rel of files) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, 'x');
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('findStrayBackups', () => {
  test('抓到 .modified / .deleted 收尾的文件, 正常文件不误伤', () => {
    const root = makeRoot([
      'docs/note.md',
      'docs/note.md.20260930_120000.modified',
      'packages/a/src/x.ts.20260929_090000.deleted',
      'scripts/plain.ts',
    ]);
    expect(findStrayBackups(root)).toEqual([
      'docs/note.md.20260930_120000.modified',
      'packages/a/src/x.ts.20260929_090000.deleted',
    ]);
  });

  test('空树与仅正常文件时零输出', () => {
    expect(findStrayBackups(makeRoot(['README.md', 'a/b/c.json']))).toEqual([]);
  });

  test('嵌套深处的备份同样被抓', () => {
    const root = makeRoot([
      'docs/nested/deep/note.md.20260101_000000.modified',
    ]);
    expect(findStrayBackups(root)).toEqual([
      'docs/nested/deep/note.md.20260101_000000.modified',
    ]);
  });
});
