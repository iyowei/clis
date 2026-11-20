/**
 * 编排层的结果形态契约: createSweeper 的 plan / run 产物 (SweepPlan / SweepReport)
 * 与结果缝合层 (isSuccessOutcome / summarizeReport)。
 * 依据 packages/sweep-node-modules/docs/designs/api-surface.md §2.7 / §7.7 / §7.8; 从公开面入口 (index.ts) 导入,
 * 按真实调用方的方式构造与消费。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  renameSync,
  rmSync,
  symlinkSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';
import {
  DEFAULT_EXCLUDE,
  type SweepError,
  WIN32_STYLE,
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
    expect(capture({ roots: ['.'] }).details).toEqual({ field: 'roots' });
    expect(capture({ roots: ['./app'] }).details).toEqual({ field: 'roots' });
    expect(capture({ roots: [42] }).details).toEqual({ field: 'roots' });
    const validRoot = process.platform === 'win32' ? 'C:\\w' : '/w';
    expect(capture({ roots: [validRoot], exclude: ['ok', 7] }).details).toEqual(
      {
        field: 'exclude',
      },
    );
    expect(capture({ roots: [validRoot], home: 3 }).details).toEqual({
      field: 'home',
    });
    expect(capture({ roots: [validRoot], home: '' }).details).toEqual({
      field: 'home',
    });
    expect(capture({ roots: [validRoot], policy: {} }).details).toEqual({
      field: 'policy',
    });
  });

  test('WIN32_STYLE 下拒绝盘根相对路径, 放行盘符与 UNC 绝对路径', () => {
    for (const badRoot of ['/Users/me/work', '/app', '\\app']) {
      let caught: unknown;
      try {
        createSweeper({ roots: [badRoot], style: WIN32_STYLE });
      } catch (error) {
        caught = error;
      }
      expect(isSweepError(caught)).toBe(true);
      if (isSweepError(caught)) {
        expect(caught.code).toBe('INVALID_ARGUMENT');
        expect(caught.details).toEqual({ field: 'roots' });
      }
    }

    const drive = createSweeper({ roots: ['C:\\work'], style: WIN32_STYLE });
    expect(drive.options.roots).toEqual(['C:\\work']);
    const unc = createSweeper({
      roots: ['\\\\srv\\share\\work'],
      style: WIN32_STYLE,
    });
    expect(unc.options.roots).toEqual(['\\\\srv\\share\\work']);
  });

  test('生效选项快照: 名单过收口 / 缺省合并 / 顶层冻结', async () => {
    const { root } = await make({ projects: [] });
    const sweeper = createSweeper({
      roots: [root],
      // 永不生效名 (node_modules / .git) 静默剔除, 重复名去重 (BC-34)
      exclude: ['node_modules', '.git', 'custom', 'custom'],
    });

    expect(Object.isFrozen(sweeper.options)).toBe(true);
    expect(Object.isFrozen(sweeper.options.roots)).toBe(true);
    expect(Object.isFrozen(sweeper.options.exclude)).toBe(true);
    expect(Object.isFrozen(sweeper.options.include)).toBe(true);
    expect(Object.isFrozen(sweeper.options.policy)).toBe(true);
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

const noPosixPerm =
  process.platform === 'win32' ||
  (typeof process.getuid === 'function' && process.getuid() === 0);

describe('只读面 (plan)', () => {
  test('全链产物: entries 形态 / 批次 / 跳过集册 / 名单 / 口径', async () => {
    const { root } = await make({
      projects: [
        { dir: 'zone/alpha' },
        // 父目录名为 lib → 命中安装树形态 (classify.ts 判定 2)
        { dir: 'zone/lib' },
      ],
    });
    const alphaTarget = join(root, 'zone', 'alpha', 'node_modules');
    const libTarget = join(root, 'zone', 'lib', 'node_modules');
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
    const alpha = plan.entries.find((entry) => entry.target === alphaTarget)!;
    expect(alpha.project).toBe(join(root, 'zone', 'alpha'));
    expect(alpha.root).toBe(root);
    expect(alpha.kind).toBe('project');
    expect(alpha.basis).toBe(plan.basis);
    expect(alpha.inBatch).toBe(true);
    expect(alpha.skipReason).toBeUndefined();
    expect(alpha.skipNote).toBeUndefined();

    // 疑似安装树: kind / 理由 / 不进批 / 跳过编码与说明
    const lib = plan.entries.find((entry) => entry.target === libTarget)!;
    expect(lib.kind).toBe('suspect-install-tree');
    expect(typeof lib.kindReason).toBe('string');
    expect(lib.inBatch).toBe(false);
    expect(lib.skipReason).toBe('suspect-install-tree');
    expect(lib.skipNote).toBe('已跳过 (加 --force 一并清理)');

    // 批次与跳过集册 (含 trailer 透出)
    expect(plan.batch).toEqual([alpha.target]);
    expect(plan.trailer).toEqual([
      '疑似安装树 1 处默认跳过 (加 --force 一并清理)',
    ]);
    expect(plan.skipped.map((item) => item.target)).toEqual([lib.target]);
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

  test.skipIf(noPosixPerm)(
    '未测到体积 (POSIX 权限注入): 占位形态齐全且不进批',
    async () => {
      const { root } = await make({
        projects: [{ dir: 'zone/alpha' }, { dir: 'zone/locked' }],
        unreadable: ['zone/locked/node_modules'],
      });
      const lockedTarget = join(root, 'zone', 'locked', 'node_modules');
      const sweeper = createSweeper({ roots: [root], exclude: [] });
      const plan = await sweeper.plan();

      const locked = plan.entries.find(
        (entry) => entry.target === lockedTarget,
      )!;
      expect(locked.bytes).toBeUndefined();
      expect(typeof locked.unmeasuredCode).toBe('string');
      expect(typeof locked.unmeasuredReason).toBe('string');
      expect(locked.inBatch).toBe(false);
      expect(locked.skipReason).toBe('unmeasured');
      expect(locked.skipNote?.startsWith('体积统计失败: ')).toBe(true);
      expect(plan.skipped.map((item) => item.target)).toEqual([locked.target]);
    },
  );

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

  test('rejected (多目标部分被拒): 拒收条为 rejected, 同批健康条为 not-attempted (BATCH_REJECTED) 且零删除', async () => {
    const { root } = await make({
      projects: [{ dir: 'alpha' }, { dir: 'beta' }],
    });
    const alpha = join(root, 'alpha/node_modules');
    const beta = join(root, 'beta/node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run({
      onProgress: (event) => {
        // 计划成型之后、安全闸之前仅删掉 alpha: alpha 被拒、beta 通过闸门但整批零删除
        if (
          event.kind === 'phase' &&
          event.phase === 'plan' &&
          event.status === 'done'
        )
          rmSync(alpha, { recursive: true, force: true });
      },
    });

    expect(report.status).toBe('rejected');
    expect(report.removal).toBeUndefined();
    expect(report.releasedBytes).toBe(0);
    expect(existsSync(beta)).toBe(true);

    const alphaEntry = report.entries.find((entry) => entry.target === alpha)!;
    expect(alphaEntry.outcome.kind).toBe('rejected');
    if (alphaEntry.outcome.kind === 'rejected') {
      expect(alphaEntry.outcome.rejection.code).toBe('GUARD_TARGET_MISSING');
    }

    const betaEntry = report.entries.find((entry) => entry.target === beta)!;
    expect(betaEntry.outcome).toEqual({
      kind: 'not-attempted',
      code: 'BATCH_REJECTED',
    });

    const summary = summarizeReport(report);
    expect(summary.counts.rejected).toBe(1);
    expect(summary.counts['not-attempted']).toBe(1);
    expect(summary.succeeded).toBe(0);
    expect(summary.unprocessed).toBe(2);
    expect(summary.aborted).toBe(false);
  });

  test('original !== real (根内符号链接目标): 经 validation.mappings 映射查桶, 不崩溃且正常归 removed', async () => {
    const { root } = await make({ projects: [{ dir: 'alpha' }] });
    const original = join(root, 'alpha/node_modules');
    const realParent = join(root, 'real-dir');
    const realTarget = join(realParent, 'node_modules');
    const sweeper = createSweeper({ roots: [root], exclude: [] });
    const report = await sweeper.run({
      onProgress: (event) => {
        // 计划成型之后、安全闸之前把原目录搬到根内另一处并在原位放符号链接 (使 original !== real 且均在 root 内)
        if (
          event.kind === 'phase' &&
          event.phase === 'plan' &&
          event.status === 'done'
        ) {
          mkdirSync(realParent, { recursive: true });
          renameSync(original, realTarget);
          symlinkSync(realTarget, original, 'dir');
        }
      },
    });

    expect(report.status).toBe('executed');
    expect(report.validation?.mappings).toEqual([
      { original, real: realTarget },
    ]);
    expect(report.removal?.removed).toEqual([realTarget]);
    expect(report.entries[0]?.outcome).toEqual({ kind: 'removed' });
    expect(report.releasedBytes).toBeGreaterThan(0);
    expect(existsSync(realTarget)).toBe(false);
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
    const betaTarget = join(root, 'beta', 'node_modules');
    const betaEntry = report.entries.find(
      (entry) => entry.target === betaTarget,
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
