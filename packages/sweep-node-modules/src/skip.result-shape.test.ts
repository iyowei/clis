/**
 * 跳过集册的结果形态契约: 编码判定 (skipReasonOf) / 候选构造 (toSkipCandidates) /
 * 码话合一集册 (SkipBook.entries)。依据 packages/sweep-node-modules/docs/designs/api-surface.md §2.5 与 §7.6。
 */
import { describe, expect, test } from 'bun:test';

import type { CrossDeviceKind } from './guard.ts';
import { collectSkips, skipReasonOf, toSkipCandidates } from './skip.ts';
import type {
  ScanHit,
  SizeResult,
  SkipCandidate,
  SweepPolicy,
} from './types.ts';

const policy = (releaseSuspects: boolean): SweepPolicy => ({ releaseSuspects });
const NO_DEVICE: ReadonlyMap<string, CrossDeviceKind> = new Map();

describe('跳过集册结果形态', () => {
  test('skipReasonOf: 四类原因编码与 null (进批)', async () => {
    const onPath = new Map<string, CrossDeviceKind>([
      ['/w/vol/node_modules', 'on-path'],
    ]);
    const targetItself = new Map<string, CrossDeviceKind>([
      ['/w/mnt/node_modules', 'target-itself'],
    ]);

    // 进批: 测得体积且非疑似
    expect(
      skipReasonOf(
        { target: '/w/a/node_modules', bytes: 1, suspect: false },
        NO_DEVICE,
        policy(false),
      ),
    ).toBeNull();
    // 跨设备两类 (policy 放行不了)
    expect(
      skipReasonOf(
        { target: '/w/vol/node_modules', bytes: 1, suspect: false },
        onPath,
        policy(true),
      ),
    ).toBe('cross-device:on-path');
    expect(
      skipReasonOf(
        { target: '/w/mnt/node_modules', bytes: 1, suspect: false },
        targetItself,
        policy(true),
      ),
    ).toBe('cross-device:target-itself');
    // 未测到 (bytes undefined)
    expect(
      skipReasonOf(
        { target: '/w/b/node_modules', bytes: undefined, suspect: false },
        NO_DEVICE,
        policy(false),
      ),
    ).toBe('unmeasured');
    // 疑似: 缺省跳过, releaseSuspects 放行
    expect(
      skipReasonOf(
        { target: '/w/lib/node_modules', bytes: 1, suspect: true },
        NO_DEVICE,
        policy(false),
      ),
    ).toBe('suspect-install-tree');
    expect(
      skipReasonOf(
        { target: '/w/lib/node_modules', bytes: 1, suspect: true },
        NO_DEVICE,
        policy(true),
      ),
    ).toBeNull();
  });

  test('优先级: 跨设备优先于未测到与疑似 (同时命中取更严的一侧)', async () => {
    const onPath = new Map<string, CrossDeviceKind>([
      ['/w/vol/node_modules', 'on-path'],
    ]);

    expect(
      skipReasonOf(
        { target: '/w/vol/node_modules', bytes: undefined, suspect: true },
        onPath,
        policy(true),
      ),
    ).toBe('cross-device:on-path');
  });

  test('toSkipCandidates: 由命中 + 体积结果组装 (gone 目标 bytes undefined, 天然被挡)', async () => {
    const hits: ScanHit[] = [
      { project: '/w/app', target: '/w/app/node_modules', root: '/w' },
      { project: '/w/lib', target: '/w/lib/node_modules', root: '/w' },
      { project: '/w/ghost', target: '/w/ghost/node_modules', root: '/w' },
    ];
    const size: SizeResult = {
      entries: [{ target: '/w/app/node_modules', bytes: 128 }],
      basis: 'logical-bytes',
      warnings: [],
      unmeasured: [
        {
          target: '/w/lib/node_modules',
          code: 'SIZE_UNMEASURED_PERMISSION',
          reason: '权限不足, 无法读取',
        },
      ],
      gone: ['/w/ghost/node_modules'],
    };

    const candidates = toSkipCandidates(hits, size, { home: null });

    expect(candidates.map((candidate) => candidate.target)).toEqual(
      hits.map((hit) => hit.target),
    );
    expect(candidates[0]).toMatchObject({
      target: '/w/app/node_modules',
      bytes: 128,
      suspect: false,
    });
    expect(candidates[1]?.unmeasuredReason).toBe('权限不足, 无法读取');
    expect(candidates[2]?.bytes).toBeUndefined(); // gone 目标天然被挡
  });

  test('collectSkips: entries 码话合一 (含未测到条目), trailer/hints 维持现状口径', async () => {
    const entries: SkipCandidate[] = [
      { target: '/w/lib/node_modules', bytes: 1024, suspect: true },
      {
        target: '/w/slow/node_modules',
        bytes: undefined,
        unmeasuredReason: '权限不足, 无法读取',
        suspect: false,
      },
      { target: '/w/app/node_modules', bytes: 128, suspect: false },
    ];

    const book = collectSkips(entries, NO_DEVICE, policy(false));

    // 集册: 含未测到条目 (同属批次外目标); 人话单源化
    expect(book.entries.map((entry) => [entry.target, entry.reason])).toEqual([
      ['/w/lib/node_modules', 'suspect-install-tree'],
      ['/w/slow/node_modules', 'unmeasured'],
    ]);
    expect(book.entries[0]?.note).toBe('已跳过 (加 --force 一并清理)');
    expect(book.entries[1]?.note).toBe('体积统计失败: 权限不足, 无法读取');
    // hints 只收测得体积的条目 (现状口径不变)
    expect([...book.hints.keys()]).toEqual(['/w/lib/node_modules']);
    // trailer 按类计数 (现状口径不变)
    expect(book.trailer).toEqual([
      '疑似安装树 1 处默认跳过 (加 --force 一并清理)',
    ]);
  });
});
