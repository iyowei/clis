import { afterAll, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { scanWorkspace } from './analyzer.ts';
import { evaluateEssenceProposal } from './essence-gate.ts';
import {
  beginRoundCheckpoint,
  loadLedger,
  recordFileBackup,
  resolveHomeTmpBase,
  rollbackRoundCheckpoint,
  upsertLedgerRecord,
} from './ledger.ts';
import { lintExtractedPackage } from './package-lint.ts';
import { analyzeSourceFile, tokenizeSource } from './tokenizer.ts';
import type { ExtractLedger, WorkspacePackageNode } from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const tmpRoots: string[] = [];

function makeSandboxRepo(files: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const dir = join(
    home,
    'tmp',
    `extract-skill-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('tokenizer & fingerprint: 修复截断、跨范式提取与 Rust 陷阱识别', () => {
  const dummyPkg: WorkspacePackageNode = {
    name: '@test/a',
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

  test('返回类型含内联对象字面量时不再截断函数体, 且支持 class 方法与箭头函数等价匹配', () => {
    const srcClass = `
      export class Parser {
        public parseStats(line: string): { count: number; total: number } {
          const items = line.trim().split(',');
          let total = 0;
          for (const item of items) {
            if (item.length > 0) total += item.length;
          }
          return { count: items.length, total };
        }
      }
    `;
    const srcFn = `
      export function measureLine(raw: string): { count: number; total: number } {
        const parts = raw.trim().split(',');
        let sum = 0;
        for (const p of parts) {
          if (p.length > 0) sum += p.length;
        }
        return { count: parts.length, total: sum };
      }
    `;
    const a = analyzeSourceFile(dummyPkg, 'packages/a/src/p.ts', srcClass);
    const b = analyzeSourceFile(dummyPkg, 'packages/b/src/m.ts', srcFn);
    const methodUnit = a.symbols.find((s) => s.name === 'Parser.parseStats');
    const fnUnit = b.symbols.find((s) => s.name === 'measureLine');
    expect(methodUnit).toBeDefined();
    expect(fnUnit).toBeDefined();
    expect(methodUnit!.sloc).toBeGreaterThanOrEqual(6);
    // 计算 Shingle 交叠度验证跨范式结构高相似
    const inter = methodUnit!.shingles.filter((x) =>
      fnUnit!.shingles.includes(x),
    ).length;
    const union = new Set([...methodUnit!.shingles, ...fnUnit!.shingles]).size;
    expect(inter / union).toBeGreaterThan(0.65);
  });

  test('检测 Record<string, unknown>、未结构化 throw、可变闭包捕获与递归自引用结构', () => {
    const complex = `
      export interface TreeNode {
        id: string;
        children: TreeNode[];
      }
      export function walkMutable(raw: unknown): number {
        let count = 0;
        const bag: Record<string, unknown> = {};
        if (typeof raw !== 'string') throw new Error('bad');
        const bump = (x: string): void => {
          count += x.length;
        };
        bump(raw);
        return count + Object.keys(bag).length;
      }
    `;
    const res = analyzeSourceFile(dummyPkg, 'packages/a/src/rust.ts', complex);
    const typeUnit = res.symbols.find((s) => s.name === 'TreeNode');
    const fnUnit = res.symbols.find((s) => s.name === 'walkMutable');
    expect(typeUnit?.rustReadiness.hazards).toContain('recursive-self-ref');
    expect(fnUnit?.rustReadiness.hazards).toContain('unbounded-record');
    expect(fnUnit?.rustReadiness.hazards).toContain('untyped-throw');
    expect(fnUnit?.rustReadiness.hazards).toContain('mut-closure-capture');
    expect(fnUnit?.rustReadiness.hazards).toContain('dynamic-typeof-narrowing');
    expect(fnUnit?.rustReadiness.score).toBeLessThan(30);
    expect(
      tokenizeSource('const s = `hello ${a + 1}`;').length,
    ).toBeGreaterThan(5);
  });
});

describe('workspace-graph & essence-gate: 严格业务域计数、驼峰防泄漏与社区体检', () => {
  test('待首发 private API 与 CLI 共用同一产品域; shared-lib 不凑业务域数; D=3 须全覆盖; 拦驼峰泄漏', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/alpha/package.json': JSON.stringify({
        name: '@demo/alpha',
        version: '1.0.0',
        private: true,
      }),
      'packages/alpha-cli/package.json': JSON.stringify({
        name: '@demo/alpha-cli',
        version: '1.0.0',
        bin: { alpha: 'bin/alpha.js' },
        devDependencies: { '@demo/alpha': '1.0.0', '@demo/shared': '1.0.0' },
      }),
      'packages/beta-cli/package.json': JSON.stringify({
        name: '@demo/beta-cli',
        version: '1.0.0',
        bin: { beta: 'bin/beta.js' },
        devDependencies: { '@demo/shared': '1.0.0' },
      }),
      'packages/gamma-cli/package.json': JSON.stringify({
        name: '@demo/gamma-cli',
        version: '1.0.0',
        bin: { gamma: 'bin/gamma.js' },
        devDependencies: { '@demo/shared': '1.0.0' },
      }),
      'packages/shared/package.json': JSON.stringify({
        name: '@demo/shared',
        version: '1.0.0',
        private: true,
        clisRole: 'shared-lib',
      }),
    });

    const graph = buildWorkspaceGraph(repo);
    expect(graph.layerDomainCounts.cli).toBe(3);

    // private API + 其对称 CLI 共属同一域 -> 拒绝
    const sameProduct = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description: 'Deterministic terminal prompt primitive',
      consumers: ['@demo/alpha', '@demo/alpha-cli'],
      exportedSymbols: ['askConfirm'],
    });
    expect(sameProduct.passed).toBe(false);
    expect(sameProduct.metrics.businessConsumerDomains).toBe(1);

    // 1 shared-lib + 1 cli 凑数 -> 业务域仅为 1, 拒绝
    const crossLayerCheat = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description: 'Deterministic terminal prompt primitive',
      consumers: ['@demo/shared', '@demo/alpha-cli'],
      exportedSymbols: ['askConfirm'],
    });
    expect(crossLayerCheat.passed).toBe(false);
    expect(crossLayerCheat.metrics.businessConsumerDomains).toBe(1);

    // D=3 时仅 2/3 CLI -> 拒绝
    const partialSmall = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description: 'Deterministic terminal prompt primitive',
      consumers: ['@demo/alpha-cli', '@demo/beta-cli'],
      exportedSymbols: ['askConfirm'],
    });
    expect(partialSmall.passed).toBe(false);

    // 驼峰拼写夹带领域词 (alphaTarget) -> 拒绝
    const camelLeak = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description: 'Deterministic terminal prompt primitive',
      consumers: ['@demo/alpha-cli', '@demo/beta-cli', '@demo/gamma-cli'],
      exportedSymbols: ['askConfirm'],
      apiSignatures: ['alphaTargetPath'],
    });
    expect(camelLeak.passed).toBe(false);
    expect(camelLeak.violations.some((v) => v.includes('alpha'))).toBe(true);

    // 覆盖 3/3 CLI 域且纯洁命名 -> 放行
    const valid = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description: 'Deterministic terminal prompt primitive',
      consumers: ['@demo/alpha-cli', '@demo/beta-cli', '@demo/gamma-cli'],
      exportedSymbols: ['askConfirm'],
    });
    expect(valid.passed).toBe(true);
    expect(valid.metrics.layerCoverageLabel).toBe('3/3 (cli)');
  });

  test('落盘体检强检 files:[dist]、tsconfig.build.json (paths:{}, noEmitOnError) 与软链', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'tsconfig.json': JSON.stringify({
        compilerOptions: {
          paths: { '@demo/tty-prompt': ['./packages/tty-prompt/src/index.ts'] },
        },
      }),
      'packages/alpha/package.json': JSON.stringify({
        name: '@demo/alpha',
        version: '1.0.0',
      }),
      'packages/tty-prompt/package.json': JSON.stringify({
        name: '@demo/tty-prompt',
        private: true,
        clisRole: 'shared-lib',
        type: 'module',
        sideEffects: false,
        files: ['dist'],
        main: './dist/index.js',
        types: './dist/index.d.ts',
        exports: {
          '.': { types: './dist/index.d.ts', default: './dist/index.js' },
        },
        scripts: { build: 'x', typecheck: 'y', test: 'z' },
      }),
      'packages/tty-prompt/tsconfig.build.json': JSON.stringify({
        compilerOptions: { paths: {}, noEmitOnError: true },
      }),
      'packages/tty-prompt/README.md': '# @demo/tty-prompt\nPure prompt.',
      'packages/tty-prompt/src/index.ts': 'export const ok = true;\n',
      'packages/tty-prompt/src/index.test.ts':
        'import { test, expect } from "bun:test"; test("ok", () => expect(true).toBe(true));\n',
      'node_modules/@demo/tty-prompt/package.json': JSON.stringify({
        name: '@demo/tty-prompt',
      }),
    });

    const graph = buildWorkspaceGraph(repo);
    const res = lintExtractedPackage(repo, graph, 'packages/tty-prompt');
    expect(res.passed).toBe(true);

    // 缺少 files:[dist] 时必拦截
    writeFileSync(
      join(repo, 'packages/tty-prompt/package.json'),
      JSON.stringify({
        name: '@demo/tty-prompt',
        private: true,
        type: 'module',
        sideEffects: false,
        exports: { '.': './dist/index.js' },
        scripts: { build: 'x', typecheck: 'y', test: 'z' },
      }),
    );
    const missingFiles = lintExtractedPackage(
      repo,
      graph,
      'packages/tty-prompt',
    );
    expect(missingFiles.passed).toBe(false);
    expect(missingFiles.violations.some((v) => v.includes('"files"'))).toBe(
      true,
    );
  });
});

describe('analyzer & degeneration: 迁移残余识别、退化回收与跨粒度克隆', () => {
  test('检出退化私库 (仅剩 1 消费域) 并豁免公开库; 识别迁移回声与跨拆合粒度文件克隆', () => {
    const sharedCode = `
      export function formatSafeWidth(text: string, limit: number): string {
        const clean = text.trim();
        if (limit <= 0) return '';
        if (clean.length <= limit) return clean;
        const head = clean.slice(0, Math.max(0, limit - 1));
        return head + '…';
      }
    `;
    const splitHelperCode = `
      function clampLimit(limit: number): number {
        return Math.max(0, limit - 1);
      }
      function trimInput(text: string): string {
        return text.trim();
      }
      export function renderClamped(raw: string, maxLen: number): string {
        const clean = trimInput(raw);
        if (clean.length <= maxLen) return clean;
        return clean.slice(0, clampLimit(maxLen)) + '…';
      }
    `;
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/one/package.json': JSON.stringify({
        name: '@demo/one',
        bin: { one: 'bin/one.js' },
        devDependencies: {
          '@demo/reabsorb-me': '1.0.0',
          '@demo/public-orphan': '1.0.0',
          '@demo/fresh-lib': '1.0.0',
        },
      }),
      'packages/one/src/work.ts': `${sharedCode}\n${splitHelperCode}`,
      'packages/two/package.json': JSON.stringify({
        name: '@demo/two',
        bin: { two: 'bin/two.js' },
        devDependencies: { '@demo/fresh-lib': '1.0.0' },
      }),
      'packages/two/src/work.ts': sharedCode,
      // 刚抽出的 fresh-lib 与 two 中残余的 sharedCode 形成迁移残余
      'packages/fresh-lib/package.json': JSON.stringify({
        name: '@demo/fresh-lib',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/fresh-lib/src/index.ts': sharedCode,
      // 退化私库: 仅剩 @demo/one 1 个域在用
      'packages/reabsorb-me/package.json': JSON.stringify({
        name: '@demo/reabsorb-me',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/reabsorb-me/src/index.ts': 'export const legacy = 1;\n',
      // 孤立公开库: 同样只剩 @demo/one 1 个域, 但非 private 不得自动回收
      'packages/public-orphan/package.json': JSON.stringify({
        name: '@demo/public-orphan',
        clisRole: 'shared-lib',
      }),
      'packages/public-orphan/src/index.ts': 'export const pub = 1;\n',
    });

    const ledgerPath = join(repo, '.tmp-ledger.json');
    process.env.EXTRACT_LEDGER_PATH = ledgerPath;
    try {
      const ledger: ExtractLedger = {
        schemaVersion: 1,
        roundsExecuted: 1,
        records: [
          {
            fingerprint: 'seed-fp',
            status: 'accepted',
            packageName: '@demo/fresh-lib',
            reason: 'seed',
            memberDigests: {},
            distinctDomains: 2,
            recordedAt: new Date().toISOString(),
          },
        ],
      };

      const report = scanWorkspace(repo, ledger, 10, { cooldownDays: 0 });
      const reabsorbTarget = report.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/reabsorb-me',
      );
      const publicOrphan = report.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/public-orphan',
      );
      expect(reabsorbTarget?.status).toBe('reabsorb-candidate');
      expect(publicOrphan?.status).toBe('orphaned-public-lib');
      expect(report.migrationResidues.length).toBeGreaterThan(0);
      expect(report.stats.reabsorbableLibCount).toBe(1);

      // 测试 reabsorb 模式备份与回滚可无损恢复整个被删旧包目录
      const cp = beginRoundCheckpoint(
        repo,
        '@demo/reabsorb-me',
        'packages/reabsorb-me',
        ['packages/one/package.json'],
        'reabsorb',
      );
      rmSync(join(repo, 'packages/reabsorb-me'), {
        recursive: true,
        force: true,
      });
      writeFileSync(join(repo, 'packages/one/package.json'), '{"broken":true}');
      expect(existsSync(join(repo, 'packages/reabsorb-me'))).toBe(false);

      rollbackRoundCheckpoint(repo, cp.roundId);
      expect(existsSync(join(repo, 'packages/reabsorb-me/src/index.ts'))).toBe(
        true,
      );
      expect(
        readFileSync(join(repo, 'packages/one/package.json'), 'utf8'),
      ).toContain('@demo/reabsorb-me');

      // 台账写入应隔离在 ledgerPath, 不污染技能源码树
      upsertLedgerRecord(
        repo,
        {
          fingerprint: reabsorbTarget!.fingerprint,
          status: 'deferred',
          packageName: '@demo/reabsorb-me',
          reason: 'waiting for consumer B',
          memberDigests: { '@demo/reabsorb-me': '@demo/one' },
          distinctDomains: 1,
          recordedAt: new Date().toISOString(),
        },
        false,
      );
      const report2 = scanWorkspace(repo, loadLedger(repo));
      const suppressedDegen = report2.degeneratedLibs.find(
        (d) => d.pkgName === '@demo/reabsorb-me',
      );
      expect(suppressedDegen?.suppressed).toBe(true);
      expect(
        existsSync(
          join(repo, '.agents/skills/extract-shared-package/state/ledger.json'),
        ),
      ).toBe(false);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });

  test('extract 回滚保护未涉修改且不触碰无关文件', () => {
    const repo = makeSandboxRepo({
      'package.json':
        '{"name":"demo","private":true,"workspaces":["packages/*"]}',
      'packages/one/package.json': JSON.stringify({ name: '@demo/one' }),
      'packages/one/src/a.ts': 'export const a = 1;\n',
      'packages/one/src/user.ts': 'export const u = 1;\n',
    });
    const cp = beginRoundCheckpoint(
      repo,
      '@demo/tmp',
      'packages/tmp',
      ['packages/one/src/a.ts'],
      'extract',
    );
    recordFileBackup(cp, 'packages/one/src/added.ts');
    writeFileSync(join(repo, 'packages/one/src/a.ts'), 'BROKEN');
    writeFileSync(join(repo, 'packages/one/src/added.ts'), 'TMP');
    mkdirSync(join(repo, 'packages/tmp/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/tmp/src/index.ts'), 'export {};');
    writeFileSync(
      join(repo, 'packages/one/src/user.ts'),
      'export const u = 9;\n',
    );

    rollbackRoundCheckpoint(repo, cp.roundId);
    expect(readFileSync(join(repo, 'packages/one/src/a.ts'), 'utf8')).toBe(
      'export const a = 1;\n',
    );
    expect(existsSync(join(repo, 'packages/one/src/added.ts'))).toBe(false);
    expect(existsSync(join(repo, 'packages/tmp'))).toBe(false);
    expect(readFileSync(join(repo, 'packages/one/src/user.ts'), 'utf8')).toBe(
      'export const u = 9;\n',
    );
  });
});
