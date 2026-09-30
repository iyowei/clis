/**
 * 体积结果形态契约: basis 口径 / gone 桶 / 划分完备性恒等式 / 取消 / 进度事件。
 * 与 size.contract.test.ts 的分工: 那边参数化全候选比对既有行为 (含 GNU du 注入变体的复跑),
 * 本文件只跑两个主候选, 专钉本轮新增的结果形态 (api-surface.md §2.2 / §3.2 / §7.3)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

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
  });
}
