/**
 * 扫描的取消与进度契约: signal 检查点抛 CANCELLED / onProgress 每命中一处一条 hit 事件。
 * 参数化跑全部候选 (parallel / native / prune); 依据 api-surface.md §2.2 与 §4。
 * 事件顺序不承诺 (并发完成序), 故断言按集合而非序列比对。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import { createNativeScanner } from './scan-native.ts';
import { createParallelScanner } from './scan-parallel.ts';
import { createPruningScanner } from './scan-prune.ts';
import type { ScanProgressEvent, Scanner } from './types.ts';

const scanners: Scanner[] = [
  createParallelScanner(),
  createNativeScanner(),
  createPruningScanner(),
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

for (const scanner of scanners) {
  describe(`scan 取消与进度 [${scanner.name}]`, () => {
    test('取消信号: 已 abort 的 signal 在检查点抛 CANCELLED', async () => {
      const { root } = await make({ projects: [{ dir: 'alpha' }] });
      const controller = new AbortController();
      controller.abort();

      await expect(
        scanner.scan({
          roots: [root],
          exclude: [],
          include: [],
          signal: controller.signal,
        }),
      ).rejects.toMatchObject({
        code: 'CANCELLED',
        details: { phase: 'scan' },
      });
    });

    test('进度事件: 每命中一处发一条 hit, 形状含 project / target / root', async () => {
      const { root } = await make({
        projects: [{ dir: 'alpha' }, { dir: 'beta' }],
      });
      const events: ScanProgressEvent[] = [];

      const result = await scanner.scan({
        roots: [root],
        exclude: [],
        include: [],
        onProgress: (event) => events.push(event),
      });

      expect(events.map((event) => event.kind)).toEqual(['hit', 'hit']);
      expect(events.map((event) => event.hit.target).sort()).toEqual(
        result.hits.map((hit) => hit.target).sort(),
      );
      for (const event of events) {
        expect(event.hit.root).toBe(root);
        expect(event.hit.target).toBe(join(event.hit.project, 'node_modules'));
      }
    });
  });
}

/** 构造深度为 depth 的串行链式目录列表 (d0, d0/d1, ...) */
function buildChainDirs(depth: number): string[] {
  const dirs: string[] = [];
  let current = '';
  for (let i = 0; i < depth; i += 1) {
    current = current ? `${current}/d${i}` : `d${i}`;
    dirs.push(current);
  }
  return dirs;
}

describe('scan 取消与进度 [parallel] 异常停泵与根预检取消', () => {
  test('onProgress 抛错: 并发池立刻停泵, 不继续遍历深层待派发目录', async () => {
    const { root } = await make({
      projects: buildChainDirs(12).map((dir) => ({ dir })),
    });
    let calls = 0;

    await expect(
      createParallelScanner().scan({
        roots: [root],
        exclude: [],
        include: [],
        onProgress: () => {
          calls += 1;
          throw new Error('stop-scan-now');
        },
      }),
    ).rejects.toThrow('stop-scan-now');

    expect(calls).toBe(1);
  });

  test('根预检前已取消: 立即抛 CANCELLED, 不进入任何根遍历', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      createParallelScanner().scan({
        roots: [root],
        exclude: [],
        include: [],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      details: { phase: 'scan' },
    });
  });
});
