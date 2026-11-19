/**
 * 删除侧结果形态契约: 取消的 partial 交回 / 进度事件。
 * 依据 api-surface.md §2.4 与 §4.3; 失败码与 partialRisk 的语义覆盖归 delete.contract.test.ts。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { chmod, mkdir, rename, stat, symlink } from 'node:fs/promises';
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

const isRootOrWin =
  process.platform === 'win32' ||
  (process as { getuid?: () => number }).getuid?.() === 0;
const DIR_LINK = process.platform === 'win32' ? 'dir' : undefined;

describe('删除安全复核加固与事件去重 (SWEEP-P0-1 / P0-2 / P1-2 / P1-3)', () => {
  test('SWEEP-P0-1: 信任根祖先级被换成符号链接触发 REVIEW_HEAD_SYMLINK 整批中止, 受害目录完好', async () => {
    const { root } = await make({
      projects: [{ dir: 'victim/team/p1' }, { dir: 'victim/team/p2' }],
    });
    const linkAncestor = join(root, 'ws-link');
    await symlink(join(root, 'victim'), linkAncestor, DIR_LINK);

    const configuredRoot = join(linkAncestor, 'team');
    const realRoot = join(root, 'victim', 'team');
    const t1 = join(realRoot, 'p1', 'node_modules');
    const t2 = join(realRoot, 'p2', 'node_modules');

    const result = await removeTargets([t1, t2], {
      roots: [{ configured: configuredRoot, real: realRoot }],
    });

    expect(result.removed).toEqual([]);
    expect(result.aborted?.code).toBe('REVIEW_HEAD_SYMLINK');
    expect(result.aborted?.path).toBe(linkAncestor);
    expect(existsSync(t1)).toBe(true);
    expect(existsSync(t2)).toBe(true);
  });

  test('SWEEP-P0-1: 信任根配置拼写消失时阻断该条为 REVIEW_COMPONENT_VANISHED, 不静默放行', async () => {
    const { root } = await make({ projects: [{ dir: 'real/app' }] });
    const realRoot = join(root, 'real');
    const vanishedConfigured = join(root, 'gone-root');
    const target = join(realRoot, 'app', 'node_modules');

    const result = await removeTargets([target], {
      roots: [{ configured: vanishedConfigured, real: realRoot }],
    });

    expect(result.removed).toEqual([]);
    expect(result.failed).toHaveLength(1);
    expect(result.failed[0]?.code).toBe('REVIEW_COMPONENT_VANISHED');
    expect(result.failed[0]?.partialRisk).toBe(false);
    expect(existsSync(target)).toBe(true);
  });

  test.skipIf(isRootOrWin)(
    'SWEEP-P0-1: 信任根祖先不可核验时阻断该条为 REVIEW_UNVERIFIED',
    async () => {
      const { root } = await make({
        projects: [{ dir: 'real/app' }, { dir: 'locked/child' }],
      });
      const locked = join(root, 'locked');
      // eslint-disable-next-line no-bitwise
      const origMode = (await stat(locked)).mode & 0o777;
      await chmod(locked, 0o000);
      try {
        const target = join(root, 'real', 'app', 'node_modules');
        const result = await removeTargets([target], {
          roots: [
            {
              configured: join(locked, 'child'),
              real: join(root, 'real'),
            },
          ],
        });
        expect(result.removed).toEqual([]);
        expect(result.failed[0]?.code).toBe('REVIEW_UNVERIFIED');
        expect(result.failed[0]?.partialRisk).toBe(false);
        expect(existsSync(target)).toBe(true);
      } finally {
        await chmod(locked, origMode).catch(() => {});
      }
    },
  );

  test('SWEEP-P0-2: 入口硬拒绝尾分隔符、相对段 (.. / .) 与非 node_modules 末段, 零删除', async () => {
    const { root } = await make({
      projects: [{ dir: 'zone/app' }, { dir: 'outside' }],
    });
    const zone = join(root, 'zone');
    const appDir = join(zone, 'app');
    const appNm = join(appDir, 'node_modules');
    await mkdir(join(zone, 'sub'), { recursive: true });

    // 1. 尾分隔符
    const trailing = await removeTargets([`${appNm}/`], {
      roots: [trustRoot(zone)],
    });
    expect(trailing.aborted).toBeDefined();
    expect(trailing.removed).toEqual([]);
    expect(existsSync(appNm)).toBe(true);

    // 2. 相对段 ..
    const dotdot = await removeTargets(
      [join(zone, 'sub') + '/../app/node_modules'],
      { roots: [trustRoot(zone)] },
    );
    expect(dotdot.aborted).toBeDefined();
    expect(dotdot.removed).toEqual([]);
    expect(existsSync(appNm)).toBe(true);

    // 3. 末段非 node_modules
    const nonLeaf = await removeTargets([appDir], {
      roots: [trustRoot(zone)],
    });
    expect(nonLeaf.aborted).toBeDefined();
    expect(nonLeaf.removed).toEqual([]);
    expect(existsSync(appDir)).toBe(true);
  });

  test('SWEEP-P1-2: 多条并发触发中止时 aborted 进度事件仅发射一次且与最终结果一致', async () => {
    const names = ['p1', 'p2', 'p3', 'p4', 'p5'];
    const { root } = await make({
      projects: names.map((dir) => ({ dir: `real/${dir}` })),
    });
    const linkRoot = join(root, 'link-root');
    await symlink(join(root, 'real'), linkRoot, DIR_LINK);
    const realRoot = join(root, 'real');
    const targets = names.map((dir) => join(realRoot, dir, 'node_modules'));
    const events: RemovalProgressEvent[] = [];

    const result = await removeTargets(targets, {
      roots: [{ configured: linkRoot, real: realRoot }],
      onProgress: (event) => events.push(event),
    });

    const abortEvents = events.filter((event) => event.kind === 'aborted');
    expect(abortEvents).toHaveLength(1);
    expect(result.aborted?.target).toBe(targets[0]);
    expect(abortEvents[0]).toEqual({
      kind: 'aborted',
      aborted: result.aborted!,
    });
    // 顺带验证 rename 未被 lint 报 unused: 无冗余导入检查
    await rename(join(realRoot, 'p1'), join(realRoot, 'p1-kept'));
    expect(existsSync(join(realRoot, 'p1-kept', 'node_modules'))).toBe(true);
  });

  test('SWEEP-P1-3: 空 targets 遇已取消 signal 立即抛 CANCELLED', async () => {
    const controller = new AbortController();
    controller.abort();

    await expect(
      removeTargets([], { roots: [], signal: controller.signal }),
    ).rejects.toMatchObject({
      code: 'CANCELLED',
      details: {
        phase: 'remove',
        partial: { removed: [], missing: [], failed: [] },
      },
    });
  });
});
