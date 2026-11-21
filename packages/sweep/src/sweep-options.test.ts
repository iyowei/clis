import { describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { removeTargets } from './delete.ts';
import { SweepError } from './errors.ts';
import { nativeStyle } from './guard.ts';
import { toSkipCandidates } from './skip.ts';
import { createSweeper } from './sweep.ts';

function expectInvalidArg(fn: () => unknown, expectedField: string): void {
  try {
    fn();
    throw new Error('预期同步抛出 SweepError(INVALID_ARGUMENT), 实际未抛错');
  } catch (error) {
    expect(error).toBeInstanceOf(SweepError);
    const err = error as SweepError;
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect((err.details as { field?: string } | undefined)?.field).toBe(
      expectedField,
    );
  }
}

describe('createSweeper 构造期 presets / rules 同步校验与默认回收站红线', () => {
  test('非法 rules[].match (含 *.* / .. / a/b) 同步抛 INVALID_ARGUMENT', () => {
    for (const badMatch of ['', '.', '..', '.git', '*', '*.*', 'a/b']) {
      expectInvalidArg(
        () =>
          createSweeper({
            roots: ['/work'],
            rules: [
              {
                name: 'bad',
                kind: 'any',
                match: badMatch,
                action: 'delete',
              },
            ],
          }),
        'rules[0].match',
      );
    }
  });

  test('非法 presets (enabled 字段与未知预设名) 同步抛 INVALID_ARGUMENT', () => {
    expectInvalidArg(
      () =>
        createSweeper({
          roots: ['/work'],
          presets: {
            node: { enabled: false } as unknown as Record<string, never>,
          },
        }),
      'presets.node.enabled',
    );
    expectInvalidArg(
      () =>
        createSweeper({
          roots: ['/work'],
          presets: { golang: {} } as unknown as Record<string, never>,
        }),
      'presets.golang',
    );
  });

  test('JS 调用方省略 rules[].action 时强制归一化为 trash, 绝不翻转永久删除', () => {
    const sweeper = createSweeper({
      roots: ['/work'],
      rules: [
        {
          name: ' logs ',
          kind: 'file',
          match: '*.log',
        } as unknown as {
          name: string;
          kind: 'file';
          match: string;
          action: 'trash';
        },
      ],
    });
    expect(sweeper.options.rules).toEqual([
      {
        name: 'logs',
        kind: 'file',
        match: '*.log',
        action: 'trash',
      },
    ]);
  });
});

describe('多预设语义闸与回收站并发消失一致性', () => {
  test('toSkipCandidates 仅对 node 预设启用疑似安装树判定, 其余预设与规则不误判', () => {
    const size = {
      entries: [
        { target: '/work/lib/node_modules', bytes: 1024 },
        { target: '/work/lib/target', bytes: 2048 },
        { target: '/work/lib/.DS_Store', bytes: 64 },
      ],
      basis: 'logical-bytes' as const,
      warnings: [],
      unmeasured: [],
      gone: [],
    };
    const candidates = toSkipCandidates(
      [
        {
          project: 'lib',
          target: '/work/lib/node_modules',
          root: '/work',
          source: { kind: 'preset', name: 'node' },
        },
        {
          project: 'lib',
          target: '/work/lib/target',
          root: '/work',
          source: { kind: 'preset', name: 'rust' },
        },
        {
          project: 'lib',
          target: '/work/lib/.DS_Store',
          root: '/work',
          source: { kind: 'rule', name: 'junk' },
        },
      ],
      size,
    );
    expect(candidates[0]!.suspect).toBe(true);
    expect(candidates[1]!.suspect).toBe(false);
    expect(candidates[2]!.suspect).toBe(false);
  });

  test('trash 通道遇到 ENOENT 且目标已消失归 missing (与 rm 通道一致), 目标仍在则维持 TRASH_FAILED', async () => {
    const base = join(
      realpathSync(tmpdir()),
      `sweep-trash-enoent-${Date.now()}`,
    );
    const root = join(base, 'work');
    const dirA = join(root, 'a');
    const targetA = join(dirA, 'foo.log');
    const dirB = join(root, 'b');
    const targetB = join(dirB, 'bar.log');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(targetA, 'gone');
    writeFileSync(targetB, 'still-here');

    try {
      const style = nativeStyle();
      const result = await removeTargets([targetA, targetB], {
        roots: [{ configured: root, real: root }],
        style,
        allowGeneralTargets: true,
        actions: new Map([
          [targetA, 'trash'],
          [targetB, 'trash'],
        ]),
        trashDeps: {
          platform: 'linux',
          homedir: () => base,
          env: { XDG_DATA_HOME: join(base, 'xdg') },
          rename: async (src) => {
            if (String(src) === targetA) {
              rmSync(String(src), { force: true });
            }
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
        },
      });
      expect(result.missing).toEqual([targetA]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.target).toBe(targetB);
      expect(result.failed[0]!.code).toBe('TRASH_FAILED');
      expect(existsSync(targetB)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
