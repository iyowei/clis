/**
 * 体积结果形态契约: basis 口径 / gone 桶 / 划分完备性恒等式 / 取消 / 进度事件。
 * 与 size.contract.test.ts 的分工: 那边参数化全候选比对既有行为 (含 GNU du 注入变体的复跑),
 * 本文件只跑两个主候选, 专钉本轮新增的结果形态 (api-surface.md §2.2 / §3.2 / §7.3)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { chmod, mkdir, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import { createDuSizer, findDu } from './size-du.ts';
import { createJsSizer } from './size-js.ts';
import type { MeasureProgressEvent, Sizer } from './types.ts';

const duAvailable = findDu() !== null;

const candidates: { sizer: Sizer; needsDu: boolean }[] = [
  { sizer: createJsSizer(), needsDu: false },
  { sizer: createDuSizer(), needsDu: true },
];

const workspaces: Workspace[] = [];
async function make(spec: WorkspaceSpec): Promise<Workspace> {
  const workspace = await makeWorkspace(spec);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
  workspaces.length = 0;
});

for (const candidate of candidates) {
  const it = (name: string, fn: () => Promise<void>) =>
    test.skipIf(candidate.needsDu && !duAvailable)(name, fn);

  describe(`size 结果形态 [${candidate.sizer.name}]`, () => {
    it('体积口径: basis 与候选自报一致', async () => {
      expect(candidate.sizer.basis).toBe(
        candidate.sizer.name.startsWith('du') ? 'disk-usage' : 'logical-bytes',
      );
    });

    it('不存在的目标: 单列 gone 桶 + SIZE_TARGET_VANISHED 事件, 不进 unmeasured', async () => {
      const { root } = await make({ projects: [] });
      const ghost = join(root, 'ghost', 'node_modules');

      const result = await candidate.sizer.measure([ghost]);

      expect(result.entries).toEqual([]);
      expect(result.unmeasured).toEqual([]);
      expect(result.gone).toEqual([ghost]);
      expect(
        result.warnings.some(
          (warning) =>
            warning.code === 'SIZE_TARGET_VANISHED' && warning.path === ghost,
        ),
      ).toBe(true);
    });

    it('划分完备性恒等式: entries ∪ unmeasured ∪ gone 恰好构成输入全集且两两不相交', async () => {
      const { root } = await make({
        projects: [{ dir: 'alpha', files: 1, bytesPerFile: 128 }],
      });
      const present = join(root, 'alpha', 'node_modules');
      const ghost = join(root, 'ghost', 'node_modules');
      const inputs = [present, ghost].sort();

      const result = await candidate.sizer.measure([present, ghost]);

      const buckets = [
        result.entries.map((entry) => entry.target),
        result.unmeasured.map((item) => item.target),
        result.gone,
      ];
      expect(buckets.flat().sort()).toEqual(inputs);
      // 两两不相交: 三桶长度和恒等于全集长度
      expect(buckets.reduce((sum, bucket) => sum + bucket.length, 0)).toBe(
        inputs.length,
      );
    });

    it('取消信号: 已 abort 的 signal 在检查点抛 CANCELLED', async () => {
      const { root } = await make({
        projects: [{ dir: 'alpha', files: 1, bytesPerFile: 64 }],
      });
      const controller = new AbortController();
      controller.abort();

      await expect(
        candidate.sizer.measure([join(root, 'alpha', 'node_modules')], {
          signal: controller.signal,
        }),
      ).rejects.toThrow(/体积统计在.+被取消/);
    });

    it('进度事件: 每目标恰发一条 (measured / gone 按结果归类)', async () => {
      const { root } = await make({
        projects: [{ dir: 'alpha', files: 1, bytesPerFile: 64 }],
      });
      const present = join(root, 'alpha', 'node_modules');
      const ghost = join(root, 'ghost', 'node_modules');
      const events: MeasureProgressEvent[] = [];

      await candidate.sizer.measure([present, ghost], {
        onProgress: (event) => events.push(event),
      });

      expect(events.map((event) => event.kind)).toEqual(['measured', 'gone']);
      expect(events.map((event) => event.target)).toEqual([present, ghost]);
    });

    it('重复路径输入: 去重后测, 无重复条目且不误降级', async () => {
      const { root } = await make({
        projects: [{ dir: 'alpha', files: 1, bytesPerFile: 64 }],
      });
      const present = join(root, 'alpha', 'node_modules');

      const result = await candidate.sizer.measure([present, present]);

      expect(result.entries.map((entry) => entry.target)).toEqual([present]);
      expect(result.unmeasured).toEqual([]);
      expect(result.gone).toEqual([]);
      expect(result.warnings).toEqual([]);
    });

    it('空 targets 遇已取消 signal 立即抛 CANCELLED (SWEEP-P1-3)', async () => {
      const controller = new AbortController();
      controller.abort();

      await expect(
        candidate.sizer.measure([], { signal: controller.signal }),
      ).rejects.toMatchObject({
        code: 'CANCELLED',
        details: { phase: 'measure' },
      });
    });
  });
}

const isRootOrWin =
  process.platform === 'win32' ||
  (process as { getuid?: () => number }).getuid?.() === 0;

describe('size-js 并发池、内部取消与 errno 告警 (SWEEP-P1-1)', () => {
  test('多子目录并发求和与精确字节口径一致', async () => {
    const { root } = await make({ projects: [{ dir: 'big', files: 0 }] });
    const target = join(root, 'big', 'node_modules');
    let expectedBytes = 0;
    for (let i = 0; i < 40; i += 1) {
      const sub = join(target, `pkg-${i}`);
      await mkdir(sub, { recursive: true });
      const content = 'a'.repeat(100 + i);
      await writeFile(join(sub, 'index.js'), content);
      expectedBytes += content.length;
    }

    const result = await createJsSizer().measure([target]);
    expect(result.entries).toEqual([{ target, bytes: expectedBytes }]);
    expect(result.warnings).toEqual([]);
  });

  test.skipIf(isRootOrWin)(
    '不可读子目录: SIZE_SUBPATH_FAILED 告警填充 errno',
    async () => {
      const { root } = await make({
        projects: [{ dir: 'partial', files: 1, bytesPerFile: 64 }],
      });
      const target = join(root, 'partial', 'node_modules');
      const lockedSub = join(target, 'locked-sub');
      await mkdir(lockedSub, { recursive: true });
      // eslint-disable-next-line no-bitwise
      const origMode = (await stat(lockedSub)).mode & 0o777;
      await chmod(lockedSub, 0o000);
      try {
        const result = await createJsSizer().measure([target]);
        expect(result.entries).toEqual([{ target, bytes: 64 }]);
        const subWarn = result.warnings.find(
          (w) => w.code === 'SIZE_SUBPATH_FAILED',
        );
        expect(subWarn?.path).toBe(lockedSub);
        expect(subWarn?.errno).toBe('EACCES');
      } finally {
        await chmod(lockedSub, origMode).catch(() => {});
      }
    },
  );
});
