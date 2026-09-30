/**
 * 编排层的结果形态契约: createSweeper 的 plan / run 产物 (SweepPlan / SweepReport)
 * 与结果缝合层 (isSuccessOutcome / summarizeReport)。
 * 依据 packages/sweep-node-modules/docs/designs/api-surface.md §2.7 / §7.7 / §7.8; 从公开面入口 (index.ts) 导入,
 * 按真实调用方的方式构造与消费。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { rmSync } from 'node:fs';
import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import {
  DEFAULT_EXCLUDE,
  type SweepError,
  createSweeper,
  isSuccessOutcome,
  isSweepError,
  summarizeReport,
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

describe('构造期', () => {
  test('参数错误同步抛 INVALID_ARGUMENT (details.field 指首个不符字段)', () => {
    const capture = (input: unknown): SweepError => {
      try {
        createSweeper(input as never);
      } catch (error) {
        if (isSweepError(error)) return error;
        throw error;
      }
      throw new Error('应当同步抛错, 未抛出');
    };

    expect(capture({ roots: [] }).code).toBe('INVALID_ARGUMENT');
    expect(capture({ roots: [] }).details).toEqual({ field: 'roots' });
    expect(capture({ roots: [''] }).details).toEqual({ field: 'roots' });
    expect(capture({ roots: [42] }).details).toEqual({ field: 'roots' });
    expect(capture({ roots: ['/w'], exclude: ['ok', 7] }).details).toEqual({
      field: 'exclude',
    });
    expect(capture({ roots: ['/w'], home: 3 }).details).toEqual({
      field: 'home',
    });
    expect(capture({ roots: ['/w'], policy: {} }).details).toEqual({
      field: 'policy',
    });
  });

  test('生效选项快照: 名单过收口 / 缺省合并 / 顶层冻结', async () => {
    const { root } = await make({ projects: [] });
    const sweeper = createSweeper({
      roots: [root],
      // 永不生效名 (node_modules / .git) 静默剔除, 重复名去重 (BC-34)
      exclude: ['node_modules', '.git', 'custom', 'custom'],
    });

    expect(Object.isFrozen(sweeper.options)).toBe(true);
    expect(sweeper.options.roots).toEqual([root]);
    expect(sweeper.options.exclude).toEqual(['custom']);
    expect(sweeper.options.include).toEqual([]);
    expect(sweeper.options.policy).toEqual({ releaseSuspects: false });
  });

  test('exclude 缺省取内置默认名单 (与配置省略该字段同源, BC-20)', async () => {
    const { root } = await make({ projects: [] });
    const sweeper = createSweeper({ roots: [root] });
    expect(sweeper.options.exclude).toEqual([...DEFAULT_EXCLUDE]);
  });
});

describe('只读面 (plan)', () => {
  test('全链产物: entries 形态 / 批次 / 跳过集册 / 名单 / 口径', async () => {
    const { root } = await make({
      projects: [
        { dir: 'zone/alpha' },
        // 父目录名为 lib → 命中安装树形态 (classify.ts 判定 2)
        { dir: 'zone/lib' },
        // 权限不足 → unmeasured
        { dir: 'zone/locked' },
      ],
      unreadable: ['zone/locked/node_modules'],
    });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const plan = await sweeper.plan();

    // 生效面回显
    expect(plan.roots).toEqual([root]);
    expect(plan.exclude).toEqual([]);
    expect(plan.policy).toEqual({ releaseSuspects: false });
    // 有目标时体积口径必在 (契约: 无任何条目时缺省)
    if (plan.basis === undefined) throw new Error('有目标时体积口径必在');
    expect(['disk-usage', 'logical-bytes']).toContain(plan.basis);

    // 条目: 保扫描的 target 升序
    const targets = plan.entries.map((entry) => entry.target);
    expect(targets).toEqual([...targets].sort());
    const alpha = plan.entries.find((entry) =>
      entry.target.includes('/alpha/'),
    )!;
    expect(alpha.project).toBe(join(root, 'zone/alpha'));
    expect(alpha.root).toBe(root);
    expect(alpha.kind).toBe('project');
    expect(alpha.basis).toBe(plan.basis);
    expect(alpha.inBatch).toBe(true);
    expect(alpha.skipReason).toBeUndefined();
    expect(alpha.skipNote).toBeUndefined();

    // 疑似安装树: kind / 理由 / 不进批 / 跳过编码与说明
    const lib = plan.entries.find((entry) => entry.target.includes('/lib/'))!;
    expect(lib.kind).toBe('suspect-install-tree');
    expect(typeof lib.kindReason).toBe('string');
    expect(lib.inBatch).toBe(false);
    expect(lib.skipReason).toBe('suspect-install-tree');
    expect(lib.skipNote).toBe('已跳过 (加 --force 一并清理)');

    // 未测到体积: 占位形态 (bytes 缺省 + 原因齐全) 且不进批
    const locked = plan.entries.find((entry) =>
      entry.target.includes('/locked/'),
    )!;
    expect(locked.bytes).toBeUndefined();
    expect(typeof locked.unmeasuredCode).toBe('string');
    expect(typeof locked.unmeasuredReason).toBe('string');
    expect(locked.inBatch).toBe(false);
    expect(locked.skipReason).toBe('unmeasured');
    expect(locked.skipNote?.startsWith('体积统计失败: ')).toBe(true);

    // 批次与跳过集册
    expect(plan.batch).toEqual([alpha.target]);
    expect(plan.skipped.map((item) => item.target).sort()).toEqual(
      [lib.target, locked.target].sort(),
    );
    // 契约: entry 的 skipReason / skipNote 与 plan.skipped 同源同值
    for (const item of plan.skipped) {
      const entry = plan.entries.find(
        (candidate) => candidate.target === item.target,
      )!;
      expect(entry.skipReason).toBe(item.reason);
      expect(entry.skipNote).toBe(item.note);
    }

    // 名单命中统计恒在 (必填字段)
    expect(Array.isArray(plan.nameMatches.exclude)).toBe(true);
    expect(Array.isArray(plan.nameMatches.include)).toBe(true);
  });

  test('releaseSuspects 放行疑似安装树 (只影响批次构造)', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/lib' }] });
    const sweeper = createSweeper({
      roots: [root],
      exclude: [],
      policy: { releaseSuspects: true },
    });
    const plan = await sweeper.plan();
    expect(plan.entries[0]?.inBatch).toBe(true);
    expect(plan.skipped).toEqual([]);
    expect(plan.batch).toHaveLength(1);
  });

  test('空工作区: 零条目, 口径缺省', async () => {
    const { root } = await make({ projects: [] });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const plan = await sweeper.plan();
    expect(plan.entries).toEqual([]);
    expect(plan.batch).toEqual([]);
    expect(plan.skipped).toEqual([]);
    expect(plan.basis).toBeUndefined();
  });

  test('gone 目标 (BC-13): 测量时已不存在者不产生 entry, 计划照常成型', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const ghost = join(root, 'alpha/node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const plan = await sweeper.plan({
      onProgress: (event) => {
        // 扫描完成、体积统计开始前把目标删掉 (扫出竞态时序缝: BC-13 场景)
        if (
          event.kind === 'phase' &&
          event.phase === 'scan' &&
          event.status === 'done'
        )
          rmSync(ghost, { recursive: true, force: true });
      },
    });

    expect(plan.entries.map((entry) => entry.target)).not.toContain(ghost);
    expect(plan.entries).toHaveLength(1);
    expect(plan.batch).not.toContain(ghost);
    expect(plan.skipped.map((item) => item.target)).not.toContain(ghost);
  });
});

describe('执行面 (run)', () => {
  test('executed: 删除落地, 报告组装与释放量口径', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run();

    expect(report.status).toBe('executed');
    expect(report.removal?.removed).toHaveLength(1);
    expect(report.removal?.failed).toEqual([]);
    expect(report.entries[0]?.outcome).toEqual({ kind: 'removed' });
    expect(report.stale).toEqual([]);
    expect(report.drift).toBeUndefined();
    expect(report.validation?.rejected).toEqual([]);
    // 释放量: 成功侧体积累计 (本用例即该条目的测得体积)
    const bytes = report.entries[0]?.bytes;
    if (bytes === undefined) throw new Error('本用例目标必测得体积');
    expect(report.releasedBytes).toBe(bytes);
    expect(report.releasedBytes).toBeGreaterThan(0);
  });

  test('nothing-to-do: 批次全被跳过时零删除, validation / removal 缺省', async () => {
    const { root } = await make({ projects: [{ dir: 'zone/lib' }] });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run();

    expect(report.status).toBe('nothing-to-do');
    expect(report.removal).toBeUndefined();
    expect(report.validation).toBeUndefined();
    expect(report.releasedBytes).toBe(0);
    expect(report.entries[0]?.outcome.kind).toBe('skipped');
  });

  test('rejected: 安全闸前目标消失触发整批拒绝 (缺省 staleTargets)', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const target = join(root, 'alpha/node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run({
      onProgress: (event) => {
        // 计划成型之后、安全闸之前把目标删掉 (TOCTOU 缝)
        if (
          event.kind === 'phase' &&
          event.phase === 'plan' &&
          event.status === 'done'
        )
          rmSync(target, { recursive: true, force: true });
      },
    });

    expect(report.status).toBe('rejected');
    expect(report.removal).toBeUndefined();
    expect(report.releasedBytes).toBe(0);
    expect(report.validation?.rejected[0]?.code).toBe('GUARD_TARGET_MISSING');
    expect(report.entries[0]?.outcome.kind).toBe('rejected');
    expect(report.stale).toEqual([]);
  });

  test('staleTargets: missing: 已消失目标摘出, 健康目标照删', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const ghost = join(root, 'alpha/node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run({
      staleTargets: 'missing',
      onProgress: (event) => {
        if (
          event.kind === 'phase' &&
          event.phase === 'plan' &&
          event.status === 'done'
        )
          rmSync(ghost, { recursive: true, force: true });
      },
    });

    expect(report.status).toBe('executed');
    expect(report.stale).toEqual([ghost]);
    const ghostEntry = report.entries.find((entry) => entry.target === ghost)!;
    expect(ghostEntry.outcome).toEqual({ kind: 'stale' });
    // 健康目标照删
    const betaEntry = report.entries.find((entry) =>
      entry.target.includes('/beta/'),
    )!;
    expect(betaEntry.outcome).toEqual({ kind: 'removed' });
    // 释放量含 stale 条目 (成功侧口径: removed + missing + stale 的体积累计)
    expect(report.releasedBytes).toBe(
      (ghostEntry.bytes ?? 0) + (betaEntry.bytes ?? 0),
    );
  });

  test('expectedBatch 对账: 新增目标不删 (not-expected), 差集入 drift', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const alpha = join(root, 'alpha/node_modules');
    const beta = join(root, 'beta/node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    // 期望批次只含 alpha (beta 视为确认期间新冒出); ghost 视为期望里已消失的
    const ghost = join(root, 'ghost/node_modules');
    const report = await sweeper.run({ expectedBatch: [alpha, ghost] });

    expect(report.status).toBe('executed');
    expect(report.removal?.removed).toEqual([alpha]);
    const betaEntry = report.entries.find((entry) => entry.target === beta)!;
    expect(betaEntry.outcome).toEqual({ kind: 'not-expected' });
    expect(report.drift).toEqual({ added: [beta], removed: [ghost] });
  });
});

describe('结果缝合层', () => {
  test('isSuccessOutcome: 成功侧三类为真, 其余为假', () => {
    expect(isSuccessOutcome({ kind: 'removed' })).toBe(true);
    expect(isSuccessOutcome({ kind: 'missing' })).toBe(true);
    expect(isSuccessOutcome({ kind: 'stale' })).toBe(true);
    expect(isSuccessOutcome({ kind: 'skipped', reason: 'unmeasured' })).toBe(
      false,
    );
    expect(isSuccessOutcome({ kind: 'not-expected' })).toBe(false);
    expect(
      isSuccessOutcome({ kind: 'not-attempted', code: 'REVIEW_HEAD_SYMLINK' }),
    ).toBe(false);
  });

  test('summarizeReport: 四档计数与 entries 全划分', async () => {
    const { root } = await make({
      projects: [{ dir: 'zone/alpha' }, { dir: 'zone/lib' }],
    });
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run();
    const summary = summarizeReport(report);

    expect(summary.succeeded).toBe(1); // alpha removed
    expect(summary.unprocessed).toBe(1); // lib skipped
    expect(summary.failed).toBe(0);
    expect(summary.aborted).toBe(false);
    // 四档合计恰为 entries 全长 (计数表恒覆盖全部 kind)
    expect(summary.succeeded + summary.unprocessed + summary.failed).toBe(
      report.entries.length,
    );
    expect(summary.counts.removed).toBe(1);
    expect(summary.counts.skipped).toBe(1);
    expect(summary.counts['not-expected']).toBe(0);
  });

  test('summarizeReport: aborted 由 removal.aborted 判定', () => {
    const summary = summarizeReport({
      status: 'executed',
      plan: {
        roots: [],
        exclude: [],
        include: [],
        policy: { releaseSuspects: false },
        entries: [],
        batch: [],
        skipped: [],
        warnings: [],
        nameMatches: { exclude: [], include: [] },
      },
      removal: {
        removed: [],
        missing: [],
        failed: [],
        aborted: {
          target: '/w/zone/app/node_modules',
          code: 'REVIEW_HEAD_SYMLINK',
          message: '安全复核失败 (根被替换为符号链接): /w',
        },
      },
      entries: [],
      stale: [],
      releasedBytes: 0,
    } satisfies Parameters<typeof summarizeReport>[0]);
    expect(summary.aborted).toBe(true);
  });
});
