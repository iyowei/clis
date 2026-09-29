/**
 * 安全闸结果形态契约: 拒绝码 / errno 三分 / 路径映射表 / 取消信号。
 * 依据 api-surface.md §3.2 (安全闸拒绝表) 与 §7.2 (mappings);
 * 五不变量的行为契约归 guard.contract.test.ts, 本文件专钉本轮新增的机器可判别面。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import { validateTargets } from './guard.ts';

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

describe('安全闸结果形态', () => {
  test('末段不是 node_modules: 码为 GUARD_LEAF_NOT_NODE_MODULES', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });

    const result = await validateTargets([join(root, 'alpha')], {
      roots: [root],
    });

    expect(result.accepted).toEqual([]);
    expect(result.rejected[0]?.code).toBe('GUARD_LEAF_NOT_NODE_MODULES');
  });

  test('目标不存在: 码为 GUARD_TARGET_MISSING 且 details.errno 为 ENOENT', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const ghost = join(root, 'ghost', 'node_modules');

    const result = await validateTargets([ghost], { roots: [root] });

    expect(result.rejected[0]?.code).toBe('GUARD_TARGET_MISSING');
    expect(result.rejected[0]?.details).toEqual({ errno: 'ENOENT' });
  });

  test('realpath 成功但不在 roots 之下: 码为 GUARD_OUTSIDE_ROOTS', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const target = join(root, 'alpha', 'node_modules');

    const result = await validateTargets([target], { roots: ['/elsewhere'] });

    expect(result.rejected[0]?.code).toBe('GUARD_OUTSIDE_ROOTS');
  });

  test('重复目标: 首个进 accepted, 后来者码为 GUARD_DUPLICATE_TARGET', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const target = join(root, 'alpha', 'node_modules');

    const result = await validateTargets([target, target], {
      roots: [root],
    });

    expect(result.accepted).toHaveLength(1);
    expect(result.rejected[0]?.code).toBe('GUARD_DUPLICATE_TARGET');
  });

  test('路径映射表: mappings 与 accepted 逐位对应 (mappings[i].real === accepted[i])', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const alpha = join(root, 'alpha', 'node_modules');
    const beta = join(root, 'beta', 'node_modules');

    const result = await validateTargets([alpha, beta], { roots: [root] });

    expect(result.mappings).toHaveLength(result.accepted.length);
    for (const [index, mapping] of result.mappings.entries()) {
      expect(mapping.real).toBe(result.accepted[index]!);
    }
    // original 保调用方输入顺序; 无符号链接时原拼写与归一形态一致
    expect(result.mappings.map((mapping) => mapping.original)).toEqual([
      alpha,
      beta,
    ]);
  });

  test('取消信号: 已 abort 的 signal 在逐目标检查点抛 CANCELLED', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const controller = new AbortController();
    controller.abort();

    await expect(
      validateTargets([join(root, 'alpha', 'node_modules')], {
        roots: [root],
        signal: controller.signal,
      }),
    ).rejects.toThrow('安全闸校验在逐目标检查点被取消');
  });
});
