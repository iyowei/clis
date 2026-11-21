import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scanWorkspace } from './analyzer.ts';
import { partitionMigrationResidues } from './degeneration.ts';
import {
  loadLedger,
  resolveHomeTmpBase,
  syncDegenerationWatches,
} from './ledger.ts';
import { lintReabsorbedTarget } from './reabsorb-lint.ts';
import type { ExtractLedger, SimilarityCluster } from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const tmpRoots: string[] = [];

function makeSandboxRepo(files: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const dir = join(
    home,
    'tmp',
    `extract-degen-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content, 'utf8');
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
    rmSync(resolveHomeTmpBase(dir), { recursive: true, force: true });
  }
});

describe('退化冷静观察期与恢复自动清零机制', () => {
  test('从 3 域跌回 1 域时进入 14 天冷却观察 (不阻断收敛), 第 14 天到期转回收; 期间接回第 2 域自动清零计时', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'cool-demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/shared-b/package.json': JSON.stringify({
        name: '@demo/shared-b',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/shared-b/src/index.ts':
        'export function pad(s: string): string { return s.trim(); }\n',
      'packages/cli-a/package.json': JSON.stringify({
        name: '@demo/cli-a',
        bin: { a: 'bin/a.js' },
        devDependencies: { '@demo/shared-b': '1.0.0' },
      }),
      'packages/cli-a/src/index.ts': 'export const a = 1;\n',
      'packages/cli-c/package.json': JSON.stringify({
        name: '@demo/cli-c',
        bin: { c: 'bin/c.js' },
      }),
      'packages/cli-c/src/index.ts': 'export const c = 2;\n',
    });

    const ledgerPath = join(repo, '.tmp-ledger.json');
    process.env.EXTRACT_LEDGER_PATH = ledgerPath;
    try {
      const day0 = new Date('2026-11-01T00:00:00.000Z');
      const day10 = new Date('2026-11-11T00:00:00.000Z');
      const day14 = new Date('2026-11-15T00:00:00.000Z');

      // 第 0 天首次发现仅剩 @demo/cli-a: 记账起算, 状态 cooling-down
      const scan0 = scanWorkspace(repo, loadLedger(repo), 10, { now: day0 });
      syncDegenerationWatches(repo, scan0.degeneratedLibs);
      const d0 = scan0.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/shared-b',
      );
      expect(d0?.status).toBe('cooling-down');
      expect(d0?.remainingDays).toBe(14);
      expect(scan0.stats.coolingDownLibCount).toBe(1);
      expect(scan0.stats.reabsorbableLibCount).toBe(0);
      expect(scan0.convergence.shouldStop).toBe(true);

      // 第 10 天仍在冷却期: 已观察 10 天, 剩余 4 天
      const scan10 = scanWorkspace(repo, loadLedger(repo), 10, { now: day10 });
      const d10 = scan10.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/shared-b',
      );
      expect(d10?.status).toBe('cooling-down');
      expect(d10?.elapsedDays).toBe(10);
      expect(d10?.remainingDays).toBe(4);
      expect(scan10.stats.reabsorbableLibCount).toBe(0);

      // 第 14 天冷却期满: 自动转为 reabsorb-candidate
      const scan14 = scanWorkspace(repo, loadLedger(repo), 10, { now: day14 });
      const d14 = scan14.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/shared-b',
      );
      expect(d14?.status).toBe('reabsorb-candidate');
      expect(scan14.stats.reabsorbableLibCount).toBe(1);
      expect(scan14.convergence.shouldStop).toBe(false);

      // 假设未到期前新产品 cli-c 重新接入 @demo/shared-b: 自动清除观察计时器
      writeFileSync(
        join(repo, 'packages/cli-c/package.json'),
        JSON.stringify({
          name: '@demo/cli-c',
          bin: { c: 'bin/c.js' },
          devDependencies: { '@demo/shared-b': '1.0.0' },
        }),
      );
      const scanRecovered = scanWorkspace(repo, loadLedger(repo), 10, {
        now: day10,
      });
      const syncRes = syncDegenerationWatches(
        repo,
        scanRecovered.degeneratedLibs,
      );
      expect(syncRes.cleared).toBe(1);
      expect(loadLedger(repo).degenerationWatches?.['@demo/shared-b']).toBe(
        undefined,
      );
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });

  test('零消费者私库默认 7 天冷却期满转为 dead-unused', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'dead-demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/zombie/package.json': JSON.stringify({
        name: '@demo/zombie',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/zombie/src/index.ts': 'export const dead = 1;\n',
    });

    const ledgerPath = join(repo, '.tmp-ledger.json');
    process.env.EXTRACT_LEDGER_PATH = ledgerPath;
    try {
      const day0 = new Date('2026-11-01T00:00:00.000Z');
      const day7 = new Date('2026-11-08T00:00:00.000Z');

      const s0 = scanWorkspace(repo, loadLedger(repo), 10, { now: day0 });
      syncDegenerationWatches(repo, s0.degeneratedLibs);
      expect(s0.degeneratedLibs[0]?.status).toBe('cooling-down');
      expect(s0.degeneratedLibs[0]?.cooldownDays).toBe(7);

      const s7 = scanWorkspace(repo, loadLedger(repo), 10, { now: day7 });
      expect(s7.degeneratedLibs[0]?.status).toBe('dead-unused');
      expect(s7.stats.reabsorbableLibCount).toBe(1);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });

  test('partitionMigrationResidues 自动排除纯脚手架脚本簇 (如 build.ts)', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'infra-filter',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/app-a/package.json': JSON.stringify({
        name: '@demo/app-a',
        bin: { a: 'bin/a.js' },
        devDependencies: { '@demo/shared-x': '1.0.0' },
      }),
      'packages/shared-x/package.json': JSON.stringify({
        name: '@demo/shared-x',
        private: true,
        clisRole: 'shared-lib',
      }),
    });
    const graph = buildWorkspaceGraph(repo);
    const ledger: ExtractLedger = {
      schemaVersion: 1,
      roundsExecuted: 1,
      records: [
        {
          fingerprint: 'fp1',
          status: 'accepted',
          packageName: '@demo/shared-x',
          reason: 'ok',
          memberDigests: {},
          distinctDomains: 1,
          recordedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    };
    const infraCluster: SimilarityCluster = {
      fingerprint: 'infra-build-fp',
      kind: 'exact-clone',
      similarity: 1,
      priorityScore: 100,
      isInfraOnly: true,
      distinctPackageCount: 2,
      distinctDomainCount: 2,
      sharedLayers: ['cli', 'shared-lib'],
      commonBuiltins: [],
      suppressed: false,
      members: [
        {
          pkgName: '@demo/shared-x',
          pkgDir: 'packages/shared-x',
          domainId: 'domain:packages/shared-x',
          layer: 'shared-lib',
          file: 'packages/shared-x/scripts/build.ts',
          isInfra: true,
          symbolName: 'collectDtsFiles',
          startLine: 1,
          endLine: 10,
          sloc: 10,
          rawDigest: 'abc',
          cutCost: 0,
          rustReadinessScore: 100,
          sideEffects: ['fs'],
          builtins: ['node:fs'],
        },
        {
          pkgName: '@demo/app-a',
          pkgDir: 'packages/app-a',
          domainId: 'domain:packages/app-a',
          layer: 'cli',
          file: 'packages/app-a/scripts/build.ts',
          isInfra: true,
          symbolName: 'collectDtsFiles',
          startLine: 1,
          endLine: 10,
          sloc: 10,
          rawDigest: 'abc',
          cutCost: 0,
          rustReadinessScore: 100,
          sideEffects: ['fs'],
          builtins: ['node:fs'],
        },
      ],
    };
    const res = partitionMigrationResidues([infraCluster], graph, ledger);
    expect(res.migrationResidues.length).toBe(0);
    expect(res.extractionCandidates.length).toBe(1);
  });
});

describe('reabsorb 独立子模块与单向边界门禁 (lintReabsorbedTarget)', () => {
  test('独立子目录模块 + 配套单测 + 单向门面导入校验通过', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'clean-reabsorb',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/alpha-cli/package.json': JSON.stringify({
        name: '@demo/alpha-cli',
        bin: { alpha: 'bin/alpha.js' },
      }),
      'packages/alpha-cli/src/cli.ts': `
        import { measureColumns } from './tty-width/index.ts';
        export function run(input: string): number {
          return measureColumns(input);
        }
      `,
      'packages/alpha-cli/src/tty-width/core.ts': `
        export function charColumns(code: number): number {
          return code > 0xff ? 2 : 1;
        }
      `,
      'packages/alpha-cli/src/tty-width/index.ts': `
        import { charColumns } from './core.ts';
        export function measureColumns(text: string): number {
          let sum = 0;
          for (const ch of text) sum += charColumns(ch.codePointAt(0) ?? 0);
          return sum;
        }
      `,
      'packages/alpha-cli/src/tty-width/index.test.ts': `
        import { expect, test } from 'bun:test';
        import { measureColumns } from './index.ts';
        test('ok', () => expect(measureColumns('a')).toBe(1));
      `,
    });
    const res = lintReabsorbedTarget(
      repo,
      buildWorkspaceGraph(repo),
      '@demo/tty-width',
      'packages/tty-width',
      { intoPath: 'packages/alpha-cli/src/tty-width' },
    );
    expect(res.passed).toBe(true);
    expect(res.violations).toEqual([]);
  });

  test('硬拦截: 混入 utils.ts、子模块反向引用消费包源码、夹带业务词、绕过门面与缺单测', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'dirty-reabsorb',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/mango-cli/package.json': JSON.stringify({
        name: '@demo/mango-cli',
        bin: { mango: 'bin/mango.js' },
      }),
      'packages/mango-cli/src/shared-state.ts': 'export const state = 1;\n',
      'packages/mango-cli/src/cli.ts': `
        import { helper } from './tty-width/helper.ts';
        export const out = helper();
      `,
      'packages/mango-cli/src/tty-width/index.ts':
        'export * from "./helper.ts";\n',
      'packages/mango-cli/src/tty-width/helper.ts': `
        import { state } from '../shared-state.ts';
        export function helper(): number {
          const mangoMode = state + 1;
          if (mangoMode > 0) return mangoMode;
          return 0;
        }
      `,
      'packages/mango-cli/src/utils.ts': `
        export function mixedFn(x: number): number {
          const y = x + 1;
          const z = y * 2;
          return z + 3;
        }
      `,
    });

    const graph = buildWorkspaceGraph(repo);
    // 1. 子目录存在反向逃逸 + 业务词 + 绕过门面 + 缺单测 + 缺少通过 index 合法消费
    const subRes = lintReabsorbedTarget(
      repo,
      graph,
      '@demo/tty-width',
      'packages/tty-width',
      { intoPath: 'packages/mango-cli/src/tty-width' },
    );
    expect(subRes.passed).toBe(false);
    expect(subRes.violations.some((v) => v.includes('反向耦合逃逸'))).toBe(
      true,
    );
    expect(subRes.violations.some((v) => v.includes('业务领域词'))).toBe(true);
    expect(subRes.violations.some((v) => v.includes('绕过门面'))).toBe(true);
    expect(subRes.violations.some((v) => v.includes('单元测试'))).toBe(true);

    // 2. 禁止将回收代码混入 utils.ts 杂烩文件
    const mixRes = lintReabsorbedTarget(
      repo,
      graph,
      '@demo/tty-width',
      'packages/tty-width',
      { intoPath: 'packages/mango-cli/src/utils.ts' },
    );
    expect(mixRes.passed).toBe(false);
    expect(
      mixRes.violations.some((v) => v.includes('禁止将回收代码混入')),
    ).toBe(true);
  });

  test('单文件独立模块自包含通过校验; 带相对依赖与 --unused 残留引用均拦截', () => {
    const cleanSingleRepo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'single-file-reabsorb',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/app/package.json': JSON.stringify({
        name: '@demo/app',
        bin: { app: 'bin/app.js' },
      }),
      'packages/app/src/cli.ts':
        'import { trimSlug } from "./slug-norm.ts"; export const s = trimSlug(" a ");\n',
      'packages/app/src/slug-norm.ts': [
        'export function trimSlug(raw: string): string {',
        '  const clean = raw.trim().toLowerCase();',
        '  if (clean.length === 0) return "untitled";',
        '  return clean.replace(/\\s+/g, "-");',
        '}',
      ].join('\n'),
      'packages/app/src/slug-norm.test.ts':
        'import { expect, test } from "bun:test"; test("t", () => expect(1).toBe(1));\n',
    });
    const ok = lintReabsorbedTarget(
      cleanSingleRepo,
      buildWorkspaceGraph(cleanSingleRepo),
      '@demo/slug-norm',
      'packages/slug-norm',
      { intoPath: 'packages/app/src/slug-norm.ts' },
    );
    expect(ok.passed).toBe(true);

    // 传入相对依赖会报错提示使用独立子目录; 且 --unused 对零消费清理也会拦截残留导入
    const coupledSingleRepo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'coupled-single',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/app/package.json': JSON.stringify({
        name: '@demo/app',
        bin: { app: 'bin/app.js' },
      }),
      'packages/app/src/dep.ts': 'export const d = 1;\n',
      'packages/app/src/cli.ts':
        'import { f } from "./slug-norm.ts"; import { old } from "@demo/slug-norm"; export const out = f() + old;\n',
      'packages/app/src/slug-norm.ts': [
        'import { d } from "./dep.ts";',
        'export function f(): number {',
        '  const n = d + 1;',
        '  if (n > 0) return n;',
        '  return 0;',
        '}',
      ].join('\n'),
      'packages/app/src/slug-norm.test.ts':
        'import { expect, test } from "bun:test"; test("t", () => expect(1).toBe(1));\n',
    });
    const coupledRes = lintReabsorbedTarget(
      coupledSingleRepo,
      buildWorkspaceGraph(coupledSingleRepo),
      '@demo/slug-norm',
      'packages/slug-norm',
      { intoPath: 'packages/app/src/slug-norm.ts' },
    );
    expect(coupledRes.passed).toBe(false);
    expect(coupledRes.violations.some((v) => v.includes('独立子目录'))).toBe(
      true,
    );

    const unusedLeak = lintReabsorbedTarget(
      coupledSingleRepo,
      buildWorkspaceGraph(coupledSingleRepo),
      '@demo/slug-norm',
      'packages/slug-norm',
      { unused: true },
    );
    expect(unusedLeak.passed).toBe(false);
    expect(unusedLeak.violations.some((v) => v.includes('残留旧包导入'))).toBe(
      true,
    );
  });
});
