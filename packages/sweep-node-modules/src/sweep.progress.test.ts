/**
 * 编排层的进度与取消契约: phase 事件推进 (SweepPhase 全序) / 原语事件透传 /
 * 终结事件收尾 / signal 在各阶段的表现。
 * 依据 docs/designs/api-surface.md §4; 从公开面入口 (index.ts) 导入。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import {
  type SweepProgressEvent,
  createSweeper,
  isSweepError,
} from './index.ts';

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

/** 提取事件流里的 phase 轨迹 (如 'scan:start' / 'scan:done') */
const phaseTrail = (events: readonly SweepProgressEvent[]): string[] =>
  events.flatMap((event) =>
    event.kind === 'phase' ? [`${event.phase}:${event.status}`] : [],
  );

describe('进度事件流', () => {
  test('plan: phase 成对推进 (scan → measure → classify → device → plan), plan-done 收尾', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const events: SweepProgressEvent[] = [];
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const plan = await sweeper.plan({
      onProgress: (event) => events.push(event),
    });

    expect(phaseTrail(events)).toEqual([
      'scan:start',
      'scan:done',
      'measure:start',
      'measure:done',
      'classify:start',
      'classify:done',
      'device:start',
      'device:done',
      'plan:start',
      'plan:done',
    ]);
    // done 事件携带阶段耗时
    for (const event of events) {
      if (event.kind === 'phase' && event.status === 'done')
        expect(typeof event.elapsedMs).toBe('number');
    }
    // 原语事件透传: 每命中一处一条 hit, 每测到一个目标一条 measured
    expect(events.filter((event) => event.kind === 'hit')).toHaveLength(1);
    expect(events.filter((event) => event.kind === 'measured')).toHaveLength(1);
    // 终结事件是最后一个, 携带完整计划; 之后不再有任何事件
    const last = events.at(-1);
    expect(last?.kind).toBe('plan-done');
    if (last?.kind === 'plan-done') {
      expect(last.plan).toEqual(plan);
      expect(typeof last.elapsedMs).toBe('number');
    }
  });

  test('plan: skipped 事件逐条播报批次外条目 (含原因编码)', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/lib' }] });
    const events: SweepProgressEvent[] = [];
    await createSweeper({ roots: [root], exclude: [] }).plan({
      onProgress: (event) => events.push(event),
    });
    const skipped = events.flatMap((event) =>
      event.kind === 'skipped' ? [event] : [],
    );
    expect(skipped).toHaveLength(1);
    expect(skipped[0]?.reason).toBe('suspect-install-tree');
    expect(skipped[0]?.target).toContain('/lib/');
  });

  test('plan: warning 事件透传扫描段告警 (不存在的根)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const events: SweepProgressEvent[] = [];
    await createSweeper({
      roots: [join(root, 'ghost-root'), root],
      exclude: [],
    }).plan({ onProgress: (event) => events.push(event) });

    const codes = events.flatMap((event) =>
      event.kind === 'warning' ? [event.warning.code] : [],
    );
    expect(codes).toContain('SCAN_ROOT_MISSING');
  });

  test('run: 续接 validate / remove 两阶段, removed 事件与 done 收尾', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const events: SweepProgressEvent[] = [];
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run({
      onProgress: (event) => events.push(event),
    });

    expect(phaseTrail(events)).toEqual([
      'scan:start',
      'scan:done',
      'measure:start',
      'measure:done',
      'classify:start',
      'classify:done',
      'device:start',
      'device:done',
      'plan:start',
      'plan:done',
      'validate:start',
      'validate:done',
      'remove:start',
      'remove:done',
    ]);
    const removed = events.flatMap((event) =>
      event.kind === 'removed' ? [event] : [],
    );
    expect(removed).toHaveLength(1);
    expect(removed[0]?.outcome).toBe('removed');
    const last = events.at(-1);
    expect(last?.kind).toBe('done');
    if (last?.kind === 'done') {
      expect(last.status).toBe(report.status);
      expect(typeof last.elapsedMs).toBe('number');
    }
  });

  test('run: 空批次 (nothing-to-do) 不进入 validate / remove, done 照常收尾', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/lib' }] });
    const events: SweepProgressEvent[] = [];
    await createSweeper({ roots: [root], exclude: [] }).run({
      onProgress: (event) => events.push(event),
    });
    expect(phaseTrail(events)).toEqual([
      'scan:start',
      'scan:done',
      'measure:start',
      'measure:done',
      'classify:start',
      'classify:done',
      'device:start',
      'device:done',
      'plan:start',
      'plan:done',
    ]);
    expect(events.at(-1)?.kind).toBe('done');
  });
});

describe('取消', () => {
  test('入口已取消: 阶段边界抛 CANCELLED, phase 为未完成的阶段', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const controller = new AbortController();
    controller.abort();
    const sweeper = createSweeper({ roots: [root], exclude: [] });

    let caught: unknown;
    try {
      await sweeper.plan({ signal: controller.signal });
    } catch (error) {
      caught = error;
    }
    expect(isSweepError(caught)).toBe(true);
    if (isSweepError(caught)) {
      expect(caught.code).toBe('CANCELLED');
      const details = caught.details;
      if (details !== undefined && 'phase' in details) {
        expect(details.phase).toBe('scan');
      } else {
        throw new Error('CANCELLED 应携带 phase 上下文');
      }
    }
  });

  test('删除阶段条目间取消: CANCELLED 携带已派发条目的 partial, 不打断单条 rm', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const controller = new AbortController();

    let caught: unknown;
    try {
      await sweeper.run({
        signal: controller.signal,
        onProgress: (event) => {
          // 第一条删除成功后立刻取消: 取消仍落在条目之间 (绝不打断单条 rm);
          // 并发删除下两目标均已派发, 检出后停派发、在飞条跑完, partial 收录其已出桶结果
          if (event.kind === 'removed') controller.abort();
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(isSweepError(caught)).toBe(true);
    if (isSweepError(caught)) {
      expect(caught.code).toBe('CANCELLED');
      const details = caught.details;
      if (details !== undefined && 'phase' in details) {
        expect(details.phase).toBe('remove');
      }
      if (details !== undefined && 'partial' in details) {
        // 两目标均在首批派发 (并发 4 未满), 取消检出后在飞条目跑完: partial 收录两条
        expect(details.partial?.removed).toHaveLength(2);
        expect(details.partial?.failed).toEqual([]);
      } else {
        throw new Error('删除阶段取消应携带 partial 部分结果');
      }
    }
  });

  test('计划完成后取消: 于 validate 阶段边界抛错 (run 续接段的入口检查)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const controller = new AbortController();
    const sweeper = createSweeper({ roots: [root], exclude: [] });

    let caught: unknown;
    try {
      await sweeper.run({
        signal: controller.signal,
        onProgress: (event) => {
          // 计划段收尾时下达取消: validate 尚未开始
          if (
            event.kind === 'phase' &&
            event.phase === 'plan' &&
            event.status === 'done'
          )
            controller.abort();
        },
      });
    } catch (error) {
      caught = error;
    }
    expect(isSweepError(caught)).toBe(true);
    if (isSweepError(caught)) {
      expect(caught.code).toBe('CANCELLED');
      const details = caught.details;
      if (details !== undefined && 'phase' in details) {
        expect(details.phase).toBe('validate');
      } else {
        throw new Error('CANCELLED 应携带 phase 上下文');
      }
    }
  });
});
