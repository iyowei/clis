/**
 * 删除侧结果形态契约: 取消的 partial 交回 / 进度事件。
 * 依据 api-surface.md §2.4 与 §4.3; 失败码与 partialRisk 的语义覆盖归 delete.contract.test.ts。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { join } from 'node:path';

import {
  type RemovalProgressEvent,
  type TrustRoot,
  removeBatch,
  removeTargets,
} from './delete.ts';
import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';

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

const trustRoot = (path: string): TrustRoot => ({
  configured: path,
  real: path,
});

describe('删除结果形态', () => {
  test('取消信号: 已 abort 的 signal 抛 CANCELLED 并交回已完成分桶 (details.partial)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const target = join(root, 'alpha', 'node_modules');
    const controller = new AbortController();
    controller.abort();

    await expect(
      removeTargets([target], {
        roots: [trustRoot(root)],
        signal: controller.signal,
      }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      details: {
        phase: 'remove',
        partial: { removed: [], missing: [], failed: [] },
      },
    });
  });

  test('进度事件: 每条目标出桶即发一条 (removed 按结果归类)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const target = join(root, 'alpha', 'node_modules');
    const events: RemovalProgressEvent[] = [];

    const result = await removeTargets([target], {
      roots: [trustRoot(root)],
      onProgress: (event) => events.push(event),
    });

    expect(result.removed).toEqual([target]);
    expect(events).toEqual([{ kind: 'removed', target }]);
  });
});

describe('removeBatch 编排入口', () => {
  test('安全闸整批拒绝: status 为 rejected 且零删除', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const bad = join(root, 'alpha'); // 末段不是 node_modules

    const outcome = await removeBatch([bad], { roots: [root] });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.rejected[0]?.code).toBe('GUARD_LEAF_NOT_NODE_MODULES');
    }
  });

  test('缺省 staleTargets=reject: 已消失目标照旧触发整批拒绝 (零删除)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const present = join(root, 'alpha', 'node_modules');
    const ghost = join(root, 'ghost', 'node_modules');

    const outcome = await removeBatch([ghost, present], { roots: [root] });

    expect(outcome.status).toBe('rejected');
    if (outcome.status === 'rejected') {
      expect(outcome.rejected[0]?.code).toBe('GUARD_TARGET_MISSING');
    }
    expect(existsSync(present)).toBe(true); // 健康目标未被删
  });

  test('staleTargets: missing 摘出已消失目标 (不触发整批拒绝), 健康目标照删', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const present = join(root, 'alpha', 'node_modules');
    const ghost = join(root, 'ghost', 'node_modules');

    const outcome = await removeBatch([ghost, present], {
      roots: [root],
      staleTargets: 'missing',
    });

    expect(outcome.status).toBe('executed');
    if (outcome.status === 'executed') {
      expect(outcome.stale).toEqual([ghost]);
      expect(outcome.removal.removed).toEqual([present]);
      expect(outcome.mappings).toHaveLength(outcome.accepted.length);
    }
  });
});
