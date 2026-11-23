import { describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { DEFAULT_EXCLUDE } from './config.ts';
import { removeTargets } from './delete.ts';
import { SweepError } from './errors.ts';
import { POSIX_STYLE, type PathStyle, nativeStyle } from './guard.ts';
import { createScanner } from './scan.ts';
import { toSkipCandidates } from './skip.ts';
import { createSweeper } from './sweep.ts';
import { MACOS_TRASH_BIN, defaultExecFile } from './trash.ts';

const realpathNative = realpathSync.native ?? realpathSync;
const WORK_ROOT = process.platform === 'win32' ? 'C:\\work' : '/work';

function expectInvalidArg(fn: () => unknown, expectedField: string): void {
  try {
    fn();
    throw new Error('预期同步抛出 SweepError(INVALID_ARGUMENT), 实际未抛错');
  } catch (error) {
    expect(error).toBeInstanceOf(SweepError);
    const err = error as SweepError;
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect((err.details as { field?: string } | undefined)?.field).toBe(
      expectedField,
    );
  }
}

describe('createSweeper 构造期 presets / rules 同步校验与默认回收站红线', () => {
  test('非法 rules[].match (含 *.* / .. / a/b) 同步抛 INVALID_ARGUMENT', () => {
    for (const badMatch of ['', '.', '..', '.git', '*', '*.*', 'a/b']) {
      expectInvalidArg(
        () =>
          createSweeper({
            roots: [WORK_ROOT],
            rules: [
              {
                name: 'bad',
                kind: 'any',
                match: badMatch,
                action: 'delete',
              },
            ],
          }),
        'rules[0].match',
      );
    }
  });

  test('非法 presets (enabled 字段与未知预设名) 同步抛 INVALID_ARGUMENT', () => {
    expectInvalidArg(
      () =>
        createSweeper({
          roots: [WORK_ROOT],
          presets: {
            node: { enabled: false } as unknown as Record<string, never>,
          },
        }),
      'presets.node.enabled',
    );
    expectInvalidArg(
      () =>
        createSweeper({
          roots: [WORK_ROOT],
          presets: { golang: {} } as unknown as Record<string, never>,
        }),
      'presets.golang',
    );
  });

  test('JS 调用方省略 rules[].action 时强制归一化为 trash, 绝不翻转永久删除', () => {
    const sweeper = createSweeper({
      roots: [WORK_ROOT],
      rules: [
        {
          name: ' logs ',
          kind: 'file',
          match: '*.log',
        } as unknown as {
          name: string;
          kind: 'file';
          match: string;
          action: 'trash';
        },
      ],
    });
    expect(sweeper.options.rules).toEqual([
      {
        name: 'logs',
        kind: 'file',
        match: '*.log',
        action: 'trash',
      },
    ]);
  });
});

describe('多预设语义闸与回收站并发消失一致性', () => {
  test('toSkipCandidates 仅对 node 预设启用疑似安装树判定, 其余预设与规则不误判', () => {
    const size = {
      entries: [
        { target: '/work/lib/node_modules', bytes: 1024 },
        { target: '/work/lib/target', bytes: 2048 },
        { target: '/work/lib/.DS_Store', bytes: 64 },
      ],
      basis: 'logical-bytes' as const,
      warnings: [],
      unmeasured: [],
      gone: [],
    };
    const candidates = toSkipCandidates(
      [
        {
          project: 'lib',
          target: '/work/lib/node_modules',
          root: '/work',
          source: { kind: 'preset', name: 'node' },
        },
        {
          project: 'lib',
          target: '/work/lib/target',
          root: '/work',
          source: { kind: 'preset', name: 'rust' },
        },
        {
          project: 'lib',
          target: '/work/lib/.DS_Store',
          root: '/work',
          source: { kind: 'rule', name: 'junk' },
        },
      ],
      size,
      { style: POSIX_STYLE },
    );
    expect(candidates[0]!.suspect).toBe(true);
    expect(candidates[1]!.suspect).toBe(false);
    expect(candidates[2]!.suspect).toBe(false);
  });

  test('trash 通道遇到 ENOENT 且目标已消失归 missing (与 rm 通道一致), 目标仍在则维持 TRASH_FAILED', async () => {
    const base = join(
      realpathNative(tmpdir()),
      `sweep-trash-enoent-${Date.now()}`,
    );
    const root = join(base, 'work');
    const dirA = join(root, 'a');
    const targetA = join(dirA, 'foo.log');
    const dirB = join(root, 'b');
    const targetB = join(dirB, 'bar.log');
    mkdirSync(dirA, { recursive: true });
    mkdirSync(dirB, { recursive: true });
    writeFileSync(targetA, 'gone');
    writeFileSync(targetB, 'still-here');

    try {
      const style = nativeStyle();
      const result = await removeTargets([targetA, targetB], {
        roots: [{ configured: root, real: root }],
        style,
        allowGeneralTargets: true,
        actions: new Map([
          [targetA, 'trash'],
          [targetB, 'trash'],
        ]),
        trashDeps: {
          platform: 'linux',
          homedir: () => base,
          env: { XDG_DATA_HOME: join(base, 'xdg') },
          rename: async (src) => {
            if (String(src) === targetA) {
              rmSync(String(src), { force: true });
            }
            const err = new Error('ENOENT') as NodeJS.ErrnoException;
            err.code = 'ENOENT';
            throw err;
          },
        },
      });
      expect(result.missing).toEqual([targetA]);
      expect(result.failed).toHaveLength(1);
      expect(result.failed[0]!.target).toBe(targetB);
      expect(result.failed[0]!.code).toBe('TRASH_FAILED');
      expect(existsSync(targetB)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });

  test('createSweeper 传 exclude: [...DEFAULT_EXCLUDE] 未传 excludeExplicit 时缺省 false, 与 createScanner().scan 同参同构放行项目 .gradle', async () => {
    const base = join(
      realpathNative(tmpdir()),
      `sweep-gradle-parity-${Date.now()}`,
    );
    mkdirSync(join(base, '.gradle', 'caches'), { recursive: true });
    writeFileSync(join(base, 'build.gradle'), '// home bait\n');
    writeFileSync(join(base, '.gradle', 'caches', '.DS_Store'), 'junk');
    mkdirSync(join(base, 'dev', 'app', '.gradle'), { recursive: true });
    writeFileSync(join(base, 'dev', 'app', 'settings.gradle.kts'), '');
    mkdirSync(join(base, 'dev', 'bare', '.gradle'), { recursive: true });

    try {
      const sweeper = createSweeper({
        roots: [base],
        home: base,
        exclude: [...DEFAULT_EXCLUDE],
        include: [],
        presets: { java: {} },
      });
      expect(sweeper.options.excludeExplicit).toBe(false);

      const [plan, scanResult] = await Promise.all([
        sweeper.plan(),
        createScanner().scan({
          roots: [base],
          home: base,
          exclude: [...DEFAULT_EXCLUDE],
          include: [],
          presets: { java: {} },
        }),
      ]);
      const expected = [join(base, 'dev', 'app', '.gradle')];
      expect(plan.entries.map((e) => e.target)).toEqual(expected);
      expect(scanResult.hits.map((h) => h.target)).toEqual(expected);

      const explicitSweeper = createSweeper({
        roots: [base],
        home: base,
        exclude: [...DEFAULT_EXCLUDE],
        excludeExplicit: true,
        presets: { java: {} },
      });
      expect((await explicitSweeper.plan()).entries).toEqual([]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('macOS 回收站并发消失复核与非零退出码类型隔离', () => {
  test('[S-1] macOS / 子进程非零退出码: 并发消失统一复核归 missing, 未消失归 TRASH_FAILED 且 errno 绝不为 number', async () => {
    const base = join(
      realpathNative(tmpdir()),
      `sweep-macos-trash-race-${Date.now()}`,
    );
    const root = join(base, 'work');
    const vanishedBeforeLstat = join(root, 'a', 'pre.log');
    const vanishedDuringExec = join(root, 'b', 'race.log');
    const survivor = join(root, 'c', 'stay.log');
    mkdirSync(join(root, 'a'), { recursive: true });
    mkdirSync(join(root, 'b'), { recursive: true });
    mkdirSync(join(root, 'c'), { recursive: true });
    writeFileSync(vanishedBeforeLstat, 'v1');
    writeFileSync(vanishedDuringExec, 'v2');
    writeFileSync(survivor, 'v3');

    try {
      const style = nativeStyle();
      let preUnlinked = false;
      const result = await removeTargets(
        [vanishedBeforeLstat, vanishedDuringExec, survivor],
        {
          roots: [{ configured: root, real: root }],
          style,
          allowGeneralTargets: true,
          actions: new Map([
            [vanishedBeforeLstat, 'trash'],
            [vanishedDuringExec, 'trash'],
            [survivor, 'trash'],
          ]),
          trashDeps: {
            platform: 'darwin',
            existsSync: (p) => {
              // 模拟 reviewPathOnDisk 通过后、进入 trashMacos 前并发消失
              if (!preUnlinked && p === MACOS_TRASH_BIN) {
                preUnlinked = true;
              }
              return p === MACOS_TRASH_BIN;
            },
            lstat: (async (p: unknown) => {
              if (String(p) === vanishedBeforeLstat) {
                rmSync(vanishedBeforeLstat, { force: true });
                const err = new Error('ENOENT') as NodeJS.ErrnoException;
                err.code = 'ENOENT';
                throw err;
              }
              return {
                isDirectory: () => false,
                isFile: () => true,
                isSymbolicLink: () => false,
              };
            }) as NonNullable<
              NonNullable<
                Parameters<typeof removeTargets>[1]['trashDeps']
              >['lstat']
            >,
            execFile: async (_bin, args) => {
              const targetArg = args.at(-1);
              if (targetArg === vanishedDuringExec) {
                // 模拟子进程执行期间目标被并发移除, 子进程仅报非零退出码 (无 ENOENT errno)
                rmSync(vanishedDuringExec, { force: true });
              }
              // 走真实 defaultExecFile 触发 child_process 非零退出回调 (原始 error.code 为 number 1)
              return defaultExecFile(process.execPath, [
                '-e',
                'process.stderr.write("trash failed\\n"); process.exit(1);',
              ]);
            },
          },
        },
      );

      expect(result.missing).toEqual([vanishedBeforeLstat, vanishedDuringExec]);
      expect(result.trashed).toEqual([]);
      expect(result.failed).toHaveLength(1);
      const failure = result.failed[0]!;
      expect(failure.target).toBe(survivor);
      expect(failure.code).toBe('TRASH_FAILED');
      expect(typeof failure.errno).not.toBe('number');
      expect(failure.errno).toBeUndefined();
      expect(existsSync(survivor)).toBe(true);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});

describe('.gradle 白名单计数与编排器 style 透传', () => {
  test('[S-3 + S-4] include: [".gradle"] 被护栏剪枝时不虚增计数, 且 createSweeper 将 style 透传至扫描层', async () => {
    const base = join(
      realpathNative(tmpdir()),
      `sweep-include-style-${Date.now()}`,
    );
    mkdirSync(join(base, '.gradle', 'caches'), { recursive: true });
    writeFileSync(join(base, 'build.gradle'), '// home bait\n');
    mkdirSync(join(base, 'proj', '.gradle'), { recursive: true });
    writeFileSync(join(base, 'proj', 'build.gradle'), '');

    try {
      // [S-3] 仅启用 node 时 .gradle 不进 candidates 且被 shouldPruneUnmatchedDir 剪枝, includeMatches 不虚增
      const prunedInclude = await createScanner().scan({
        roots: [base],
        home: base,
        exclude: [],
        excludeExplicit: true,
        include: ['.gradle'],
        presets: { node: {} },
      });
      expect(prunedInclude.hits).toEqual([]);
      expect(prunedInclude.includeMatches).toEqual([
        { name: '.gradle', hits: 0 },
      ]);

      // 启用 java 使项目 .gradle 真正进入 candidates 时, includeMatches 准确计 1 (家目录 .gradle 仍为 0)
      const candidateInclude = await createScanner().scan({
        roots: [base],
        home: base,
        exclude: [],
        excludeExplicit: true,
        include: ['.gradle'],
        presets: { java: {} },
      });
      expect(candidateInclude.hits.map((h) => h.target)).toEqual([
        join(base, 'proj', '.gradle'),
      ]);
      expect(candidateInclude.includeMatches).toEqual([
        { name: '.gradle', hits: 1 },
      ]);

      // [S-4] 编排器 createSweeper 将自定义 style 透传至 scanner.scan (空命中下仅 scan 层 hasNestedRoots 触发 style.ops.relative)
      let scanRelativeCalls = 0;
      const baseStyle = nativeStyle();
      const trackedStyle: PathStyle = {
        ...baseStyle,
        caseInsensitive: true,
        ops: {
          ...baseStyle.ops,
          relative: (from, to) => {
            scanRelativeCalls += 1;
            return baseStyle.ops.relative(from, to);
          },
        },
      };
      const sweeper = createSweeper({
        roots: [base, join(base, 'proj')],
        home: base.toUpperCase(),
        style: trackedStyle,
        presets: { node: {} },
      });
      scanRelativeCalls = 0;
      const emptyNodePlan = await sweeper.plan();
      expect(emptyNodePlan.entries).toEqual([]);
      expect(scanRelativeCalls).toBeGreaterThan(0);

      // 同时验证含 java 命中时透传 caseInsensitive: true 跨全链拦截大写 home 下的 .gradle
      const javaSweeper = createSweeper({
        roots: [base],
        home: base.toUpperCase(),
        style: trackedStyle,
        presets: { java: {} },
      });
      const javaPlan = await javaSweeper.plan();
      expect(javaPlan.entries.map((e) => e.target)).toEqual([
        join(base, 'proj', '.gradle'),
      ]);
    } finally {
      rmSync(base, { recursive: true, force: true });
    }
  });
});
