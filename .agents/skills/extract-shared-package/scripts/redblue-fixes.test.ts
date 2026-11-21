import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { scanWorkspace } from './analyzer.ts';
import { collectSignatureArgs, getFlag } from './cli-helpers.ts';
import { deriveDomainLeakTerms } from './domain-terms.ts';
import { evaluateRustReadiness } from './fingerprint.ts';
import { assertInsideRepo } from './fs-utils.ts';
import { extractImports, extractModuleSpecifiers } from './import-parser.ts';
import {
  beginRoundCheckpoint,
  loadLedger,
  resolveHomeTmpBase,
  rollbackRoundCheckpoint,
  upsertLedgerRecord,
} from './ledger.ts';
import { tokenizeSource } from './lexer.ts';
import { lintExtractedPackage } from './package-lint.ts';
import { lintReabsorbedTarget } from './reabsorb-lint.ts';
import { analyzeSourceFile } from './tokenizer.ts';
import type { WorkspacePackageNode } from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const tmpRoots: string[] = [];

function makeSandboxRepo(files: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const dir = join(
    home,
    'tmp',
    `extract-rb-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('红军实测 S 级漏洞回归测试', () => {
  const dummyPkg: WorkspacePackageNode = {
    name: '@rb/a',
    dir: 'packages/a',
    language: 'ts-bun',
    kind: 'cli',
    layer: 'cli',
    domainId: 'domain:packages/a',
    isPrivate: true,
    hasBin: true,
    internalDeps: [],
    externalDeps: [],
  };

  test('[S-1] 无分号 ESM (semi: false) + 正则字面量含引号不再吞掉文件后续函数与导出', () => {
    const src = `
import { a } from '../mod.js'
import { type Foo, type Bar } from './types-only'
export * from '../reexported'
export type User = { id: string; tag: string }
const sanitizePattern = /[:*?"'\`<>|]/g
export function extractAfterRegexAndNoSemi(input: string, limit: number): string {
  const clean = input.replace(sanitizePattern, '').trim()
  if (clean.length <= limit) return clean
  return clean.slice(0, limit)
}
    `;
    const res = analyzeSourceFile(dummyPkg, 'packages/a/src/no-semi.ts', src);
    expect(
      res.symbols.some((s) => s.name === 'extractAfterRegexAndNoSemi'),
    ).toBe(true);
    expect(res.fileShingles.length).toBeGreaterThan(5);
    expect(res.relativeImports).toContain('../reexported');
    expect(res.internalTypeImports).toContain('./types-only');
  });

  test('[S-2] domain-terms 不因 keywords (clean/prune/rust) 误杀通用工具词汇', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'my-suite',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/sweeper/package.json': JSON.stringify({
        name: '@rb/sweeper',
        bin: { sweeper: 'bin/s.js' },
        keywords: ['clean', 'prune', 'trash', 'rust', 'python'],
      }),
      'packages/sweeper/src/index.ts': 'export const s = 1;\n',
    });
    const terms = deriveDomainLeakTerms(buildWorkspaceGraph(repo));
    expect(terms).toContain('sweeper');
    expect(terms).not.toContain('clean');
    expect(terms).not.toContain('prune');
    expect(terms).not.toContain('rust');
    expect(terms).not.toContain('python');
  });

  test('[S-3] 拦截 package-lint 源码直出 (./src/...)、非精确版本号及 reabsorb-lint 动态 await import 逃逸', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'gate-bypass',
        private: true,
        workspaces: ['packages/*'],
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: { '@rb/shared': ['./packages/shared/src/index.ts'] },
        },
      }),
      'node_modules/@rb/shared/package.json': '{}',
      'README.md': '# suite\nUses @rb/shared-cli only.\n',
      'packages/shared/package.json': JSON.stringify({
        name: '@rb/shared',
        private: true,
        clisRole: 'shared-lib',
        type: 'module',
        sideEffects: false,
        files: ['dist'],
        main: './src/index.ts',
        types: './src/index.ts',
        exports: { '.': { import: './src/index.ts' } },
        scripts: { build: 'x', typecheck: 'y', test: 'z' },
      }),
      'packages/shared/tsconfig.build.json': JSON.stringify({
        compilerOptions: { paths: {}, noEmitOnError: true },
      }),
      'packages/shared/README.md': '# @rb/shared\nPure.\n',
      'packages/shared/src/index.ts': 'export const x = 1;\n',
      'packages/shared/src/index.test.ts': 'export {};\n',
      'packages/app-cli/package.json': JSON.stringify({
        name: '@rb/app-cli',
        bin: { app: 'bin/a.js' },
        devDependencies: { '@rb/shared': '^1.0.0' },
      }),
      'packages/app-cli/src/secret.ts': 'export const secret = 42;\n',
      'packages/app-cli/src/cli.ts':
        'import { run } from "./sub/index.ts"; export const o = run();\n',
      'packages/app-cli/src/sub/index.ts': `
        export async function run(): Promise<number> {
          const s = await import('../secret.ts');
          return s.secret + 1;
        }
      `,
      'packages/app-cli/src/sub/index.test.ts': 'export {};\n',
    });

    const graph = buildWorkspaceGraph(repo);
    const pkgLint = lintExtractedPackage(repo, graph, 'packages/shared');
    expect(pkgLint.passed).toBe(false);
    expect(pkgLint.violations.some((v) => v.includes('dist/'))).toBe(true);
    expect(pkgLint.violations.some((v) => v.includes('精确 semver'))).toBe(
      true,
    );

    const reabsorbLint = lintReabsorbedTarget(
      repo,
      graph,
      '@rb/shared',
      'packages/shared',
      { intoPath: 'packages/app-cli/src/sub' },
    );
    expect(reabsorbLint.passed).toBe(false);
    expect(
      reabsorbLint.violations.some((v) => v.includes('反向耦合逃逸')),
    ).toBe(true);
    // 边界正则不得把 README 里的 @rb/shared-cli 误判为 @rb/shared 残留
    expect(reabsorbLint.violations.some((v) => v.includes('README.md'))).toBe(
      false,
    );
  });
});

describe('[S-4] 路径安全围栏、参数校验与台账状态机回归测试', () => {
  test('[S-4] 路径穿越越界硬拒、参数错位拒绝、损坏台账报错与 rejected 抑制退化库', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'sec-repo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/old-lib/package.json': JSON.stringify({
        name: '@rb/old-lib',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/old-lib/src/index.ts': 'export const oldVal = 1;\n',
      'packages/cli-a/package.json': JSON.stringify({
        name: '@rb/cli-a',
        bin: { a: 'bin/a.js' },
        devDependencies: { '@rb/old-lib': '1.0.0' },
      }),
      'packages/cli-a/src/index.ts': 'export const a = 1;\n',
    });

    expect(() => assertInsideRepo(repo, '../victim', '--dir')).toThrow(/越界/);
    expect(() =>
      beginRoundCheckpoint(repo, '@rb/evil', '../victim', [], 'extract'),
    ).toThrow(/越界/);

    expect(getFlag(['--dir', '--mode', 'residue'], '--dir')).toBeUndefined();
    expect(
      collectSignatureArgs([
        '--signatures',
        'fnA(a: string, b: number); fieldB: boolean',
      ]),
    ).toEqual(['fnA(a: string, b: number)', 'fieldB: boolean']);

    process.env.EXTRACT_LEDGER_PATH = join(repo, '.tmp-ledger.json');
    try {
      const scan0 = scanWorkspace(repo, loadLedger(repo), 10, {
        cooldownDays: 0,
      });
      const fp = scan0.degeneratedLibs[0]!.fingerprint;
      upsertLedgerRecord(
        repo,
        {
          fingerprint: fp,
          status: 'rejected',
          packageName: '@rb/old-lib',
          reason: 'intentionally kept standalone',
          memberDigests: { '@rb/old-lib': '@rb/cli-a' },
          distinctDomains: 1,
          recordedAt: new Date().toISOString(),
        },
        false,
      );
      const scan1 = scanWorkspace(repo, loadLedger(repo), 10, {
        cooldownDays: 0,
      });
      expect(scan1.degeneratedLibs[0]?.suppressed).toBe(true);
      expect(scan1.nextAction.kind).toBe('stop');

      // 回滚后严禁再提交已回滚轮次
      const cp = beginRoundCheckpoint(
        repo,
        '@rb/x',
        'packages/x',
        [],
        'extract',
      );
      rollbackRoundCheckpoint(repo, cp.roundId);
      expect(() =>
        upsertLedgerRecord(
          repo,
          {
            fingerprint: 'abc',
            status: 'accepted',
            packageName: '@rb/x',
            reason: 'late',
            memberDigests: {},
            distinctDomains: 2,
            recordedAt: new Date().toISOString(),
          },
          true,
          cp.roundId,
        ),
      ).toThrow(/已回滚作废/);

      // 损坏 JSON 明确抛出中文结构提示而非裸崩溃
      writeFileSync(process.env.EXTRACT_LEDGER_PATH, '{"broken":true}');
      expect(() => loadLedger(repo)).toThrow(/台账格式异常/);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });
});

describe('M 级 AST 准确率与聚类去噪回归测试', () => {
  test('[M-1] 单表达式闭包、逗号声明、x++ 捕获准确; if(arr.some(n=>n>0)) 不再误报; 泛型参数与 extends 返回类型准确', () => {
    const okNoCapture = `
      export function checkArr(arr: number[]): number {
        let acc = 0;
        if (arr.some((n) => n > 0)) {
          acc = 1;
        }
        return acc;
      }
    `;
    expect(
      evaluateRustReadiness(tokenizeSource(okNoCapture), ['pure'], true, true)
        .hazards,
    ).not.toContain('mut-closure-capture');

    const realCapture = `
      export function countWithExprArrow(arr: number[]): number {
        let flag = false, acc = 0;
        arr.forEach(() => (acc++));
        return flag ? acc : acc + 1;
      }
    `;
    expect(
      evaluateRustReadiness(tokenizeSource(realCapture), ['pure'], true, true)
        .hazards,
    ).toContain('mut-closure-capture');

    const dummyPkg: WorkspacePackageNode = {
      name: '@rb/m',
      dir: 'packages/m',
      language: 'ts-bun',
      kind: 'cli',
      layer: 'cli',
      domainId: 'domain:packages/m',
      isPrivate: true,
      hasBin: true,
      internalDeps: [],
      externalDeps: [],
    };
    const tsCode = `
      export function complexFn<T extends { ok: boolean }>(
        m: Map<string, Record<string, Set<number>>>,
        cb: (a: number, b: string) => void,
        { x = 1, y = 2 }: { x?: number; y?: number } = {},
      ): T extends { a: number } ? string : number {
        let out = 0;
        if (m.size > 0) out = x + y;
        cb(out, 'ok');
        return out as never;
      }
    `;
    const analyzed = analyzeSourceFile(dummyPkg, 'packages/m/src/c.ts', tsCode);
    const fn = analyzed.symbols.find((s) => s.name === 'complexFn')!;
    expect(fn.paramCount).toBe(3);
    expect(fn.sloc).toBeGreaterThanOrEqual(8);

    // 验证成对孤立花括号字符串 ('{' 无对应 '}') + export function* 生成器不吞掉后续符号
    const stringBraceAndGenerator = `
      const BRACE_SET = new Set(['(', '[', '{']);
      export function* emitItems(items: string[]): Generator<string> {
        for (const item of items) {
          const clean = item.trim();
          if (clean.length > 0 && !BRACE_SET.has(clean)) {
            yield clean;
          }
        }
      }
      export function afterGenerator(a: number, b: number): number {
        const total = a + b;
        if (total > 10) return total * 2;
        if (total > 0) return total + 1;
        return 0;
      }
    `;
    const genRes = analyzeSourceFile(
      dummyPkg,
      'packages/m/src/gen.ts',
      stringBraceAndGenerator,
    );
    expect(genRes.symbols.some((s) => s.name === 'emitItems')).toBe(true);
    expect(genRes.symbols.some((s) => s.name === 'afterGenerator')).toBe(true);
    expect(
      extractImports(tokenizeSource("import { type A, type B } from './t';"))[0]
        ?.isTypeOnly,
    ).toBe(true);
    expect(
      extractModuleSpecifiers(
        tokenizeSource("const x = await import('../z');"),
      ),
    ).toContain('../z');
  });

  test('[M-2] 紧密团拆分消除 A~B~C 传递误聚, 且混入 bin/*.mjs 时正确降权为 isInfraOnly', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'clique-demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/a/package.json': JSON.stringify({
        name: '@rb/a',
        bin: { a: 'bin/a.js' },
      }),
      'packages/a/src/work.ts': `
        export function processAlphaOnly(raw: string): string[] {
          const items = raw.trim().split(',');
          const out: string[] = [];
          for (const item of items) {
            if (item.length > 0) out.push(item.toLowerCase());
          }
          return out;
        }
      `,
      'packages/b/package.json': JSON.stringify({
        name: '@rb/b',
        bin: { b: 'bin/b.js' },
      }),
      'packages/b/src/work.ts': `
        export function processBridgeMixed(raw: string, nums: number[]): number {
          const items = raw.trim().split(',');
          const out: string[] = [];
          for (const item of items) {
            if (item.length > 0) out.push(item.toLowerCase());
          }
          let total = out.length;
          for (const n of nums) {
            if (n > 10 && n % 2 === 0) total += n * 3;
          }
          return total;
        }
      `,
      'packages/c/package.json': JSON.stringify({
        name: '@rb/c',
        bin: { c: 'bin/c.js' },
      }),
      'packages/c/src/work.ts': `
        export function computeGammaOnly(nums: number[]): number {
          let total = 0;
          for (const n of nums) {
            if (n > 10 && n % 2 === 0) total += n * 3;
          }
          return total + 100;
        }
      `,
    });

    const scan = scanWorkspace(repo, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    let overMerged = false;
    for (const c of scan.clusters) {
      const hasAlpha = c.members.some(
        (m) => m.symbolName === 'processAlphaOnly',
      );
      const hasGamma = c.members.some(
        (m) => m.symbolName === 'computeGammaOnly',
      );
      if (hasAlpha && hasGamma) {
        overMerged = true;
        break;
      }
    }
    expect(overMerged).toBe(false);

    // 验证 bin/*.mjs 与单业务 file 混聚时触发 infra 降权
    const fakeFn = `
      export function findExecutables(dir: string, exts: string[]): string[] {
        const res: string[] = [];
        for (const ext of exts) {
          if (dir.length > 0 && ext.startsWith('.')) {
            res.push(dir + '/' + ext);
          }
        }
        return res;
      }
    `;
    const infraMixRepo = makeSandboxRepo({
      'package.json':
        '{"name":"infra-mix","private":true,"workspaces":["packages/*"]}',
      'packages/lib-a/package.json': '{"name":"@rb/lib-a","private":true}',
      'packages/lib-a/src/exec.ts': fakeFn,
      'packages/cli-b/package.json':
        '{"name":"@rb/cli-b","bin":{"b":"bin/b.mjs"}}',
      'packages/cli-b/bin/b.mjs': fakeFn,
    });
    const infraRes = scanWorkspace(infraMixRepo, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    expect(infraRes.clusters[0]?.isInfraOnly).toBe(true);
  });
});
