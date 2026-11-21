import { afterAll, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkspace } from './analyzer.ts';
import { CLI_COMMAND_SPECS } from './cli-contract.ts';
import { evaluateEssenceProposal } from './essence-gate.ts';
import { evaluateRustReadiness } from './fingerprint.ts';
import {
  beginRoundCheckpoint,
  loadLedger,
  resolveHomeTmpBase,
  rollbackRoundCheckpoint,
  syncDegenerationWatches,
  upsertLedgerRecord,
} from './ledger.ts';
import { lintExtractedPackage } from './package-lint.ts';
import { buildExtractSummary } from './summary.ts';
import { analyzeSourceFile, tokenizeSource } from './tokenizer.ts';
import type { ExtractLedger, WorkspacePackageNode } from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const tmpRoots: string[] = [];
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

function makeSandboxRepo(files: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const dir = join(
    home,
    'tmp',
    `extract-contract-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
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

describe('P0 状态机自洽、防死锁与防退化误删回滚', () => {
  test('[P0-1] upsertLedgerRecord 提交或否决时严密保留 degenerationWatches 冷静期起点', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'p01',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/shared-old/package.json': JSON.stringify({
        name: '@demo/shared-old',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/shared-old/src/index.ts': 'export const v = 1;\n',
      'packages/cli-a/package.json': JSON.stringify({
        name: '@demo/cli-a',
        bin: { a: 'bin/a.js' },
        devDependencies: { '@demo/shared-old': '1.0.0' },
      }),
      'packages/cli-a/src/index.ts': 'export const a = 1;\n',
    });

    process.env.EXTRACT_LEDGER_PATH = join(repo, '.tmp-ledger.json');
    try {
      const day0 = new Date('2026-11-01T00:00:00.000Z');
      const s0 = scanWorkspace(repo, loadLedger(repo), 10, { now: day0 });
      syncDegenerationWatches(repo, s0.degeneratedLibs);
      expect(
        loadLedger(repo).degenerationWatches?.['@demo/shared-old']
          ?.firstObservedAt,
      ).toBe(day0.toISOString());

      // 在冷静期间穿插一次其他簇的 reject / commit-round, 不得清空退化计时
      upsertLedgerRecord(
        repo,
        {
          fingerprint: 'other-cluster-fp',
          status: 'rejected',
          reason: 'intentional divergence',
          memberDigests: {},
          distinctDomains: 2,
          recordedAt: '2026-11-05T00:00:00.000Z',
        },
        false,
      );
      expect(
        loadLedger(repo).degenerationWatches?.['@demo/shared-old']
          ?.firstObservedAt,
      ).toBe(day0.toISOString());

      // 到第 14 天准确升级为 reabsorb-candidate
      const day14 = new Date('2026-11-15T00:00:00.000Z');
      const s14 = scanWorkspace(repo, loadLedger(repo), 10, { now: day14 });
      expect(s14.degeneratedLibs[0]?.status).toBe('reabsorb-candidate');
      expect(s14.nextAction.kind).toBe('reabsorb');
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });

  test('[P0-2/P0-3] residue 模式回滚不删新库; reabsorb 回滚清新建子目录; 单活跃轮次锁拦截并发开启', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'p023',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/shared-b/package.json': JSON.stringify({
        name: '@demo/shared-b',
        private: true,
        clisRole: 'shared-lib',
      }),
      'packages/shared-b/src/index.ts': 'export const ok = 1;\n',
      'packages/one/package.json': JSON.stringify({
        name: '@demo/one',
        bin: { one: 'bin/one.js' },
        devDependencies: { '@demo/shared-b': '1.0.0' },
      }),
      'packages/one/src/work.ts': 'export const w = 1;\n',
    });

    process.env.EXTRACT_LEDGER_PATH = join(repo, '.tmp-ledger.json');
    try {
      // 1) residue 回滚绝不触碰 packages/shared-b
      const cpRes = beginRoundCheckpoint(
        repo,
        'residue-abc',
        'packages/shared-b',
        ['packages/one/src/work.ts'],
        'residue',
      );
      expect(() =>
        beginRoundCheckpoint(repo, 'another', 'packages/other', [], 'extract'),
      ).toThrow(/尚未提交或回滚的活跃轮次/);
      writeFileSync(join(repo, 'packages/one/src/work.ts'), 'BROKEN');
      rollbackRoundCheckpoint(repo, cpRes.roundId);
      expect(existsSync(join(repo, 'packages/shared-b/src/index.ts'))).toBe(
        true,
      );
      expect(readFileSync(join(repo, 'packages/one/src/work.ts'), 'utf8')).toBe(
        'export const w = 1;\n',
      );

      // 2) reabsorb 失败回滚会同时恢复旧包并删干净新建的 --into 子目录
      const cpRe = beginRoundCheckpoint(
        repo,
        '@demo/shared-b',
        'packages/shared-b',
        ['packages/one/package.json'],
        'reabsorb',
        'packages/one/src/shared-b',
      );
      rmSync(join(repo, 'packages/shared-b'), { recursive: true, force: true });
      mkdirSync(join(repo, 'packages/one/src/shared-b'), { recursive: true });
      writeFileSync(
        join(repo, 'packages/one/src/shared-b/index.ts'),
        'export const orphan = true;\n',
      );
      rollbackRoundCheckpoint(repo, cpRe.roundId);
      expect(existsSync(join(repo, 'packages/shared-b/src/index.ts'))).toBe(
        true,
      );
      expect(existsSync(join(repo, 'packages/one/src/shared-b'))).toBe(false);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });

  test('[P0-4] 已 accepted 新库即使彻底重构接口, 只要原消费方全接入则旧簇不无限重弹', () => {
    const dupFn = `
      export function computeDigest(raw: string): string {
        const trimmed = raw.trim().toLowerCase();
        if (trimmed.length === 0) return 'empty';
        const normalized = trimmed.replace(/\\s+/g, '-');
        const bounded = normalized.slice(0, 64);
        return bounded.replace(/-+$/g, '');
      }
    `;
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'p04',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/slug-core/package.json': JSON.stringify({
        name: '@demo/slug-core',
        private: true,
        clisRole: 'shared-lib',
      }),
      // 新库已大幅重写实现, 与 dupFn 不再聚在同一克隆簇
      'packages/slug-core/src/index.ts':
        'export const normalize = (s: string) => s.trim();\n',
      'packages/alpha/package.json': JSON.stringify({
        name: '@demo/alpha',
        bin: { a: 'bin/a.js' },
        devDependencies: { '@demo/slug-core': '1.0.0' },
      }),
      'packages/alpha/src/u.ts': dupFn,
      'packages/beta/package.json': JSON.stringify({
        name: '@demo/beta',
        bin: { b: 'bin/b.js' },
        devDependencies: { '@demo/slug-core': '1.0.0' },
      }),
      'packages/beta/src/u.ts': dupFn,
    });

    const initialScan = scanWorkspace(repo, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    const fp = initialScan.clusters[0]!.fingerprint;
    const digests: Record<string, string> = {};
    for (const m of initialScan.clusters[0]!.members) {
      digests[`${m.file}#${m.symbolName}`] = m.rawDigest;
    }

    const ledgerAfterAccept: ExtractLedger = {
      schemaVersion: 1,
      roundsExecuted: 1,
      records: [
        {
          fingerprint: fp,
          status: 'accepted',
          packageName: '@demo/slug-core',
          reason: 'extracted',
          memberDigests: digests,
          distinctDomains: 2,
          recordedAt: '2026-11-01T00:00:00.000Z',
        },
      ],
    };
    const scan2 = scanWorkspace(repo, ledgerAfterAccept);
    expect(scan2.clusters.some((c) => c.fingerprint === fp)).toBe(false);
    expect(scan2.suppressed.some((c) => c.fingerprint === fp)).toBe(true);
  });
});

describe('深层源码扫描、导出符号净名、去噪与词法细节修复', () => {
  test('package-lint 递归检测 src/ 深层目录业务词; essence-gate 拦截垃圾桶导出名; filename-aligned 去空同名噪声', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'deep-check',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/zephyr/package.json': JSON.stringify({
        name: '@demo/zephyr',
        version: '1.0.0',
        keywords: ['zephyr-engine'],
      }),
      'packages/zephyr/src/cli.ts': `
        export function runZephyrOne(input: string): string {
          const clean = input.trim();
          const lines = clean.split('\\n');
          return lines.join(';');
        }
      `,
      'packages/orchid/package.json': JSON.stringify({
        name: '@demo/orchid',
        bin: { o: 'bin/o.js' },
      }),
      'packages/orchid/src/cli.ts': `
        export function bootOrchidApp(flag: boolean): number {
          let code = 0;
          if (flag) code = 1;
          else code = 2;
          return code * 10;
        }
      `,
      'packages/new-lib/package.json': JSON.stringify({
        name: '@demo/new-lib',
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
      'packages/new-lib/tsconfig.build.json': JSON.stringify({
        compilerOptions: { paths: {}, noEmitOnError: true },
      }),
      'packages/new-lib/README.md': '# @demo/new-lib\nGeneric.\n',
      'packages/new-lib/src/index.ts': 'export * from "./nested/core.ts";\n',
      'packages/new-lib/src/nested/core.ts':
        'export const zephyrConfig = { mode: "fast" };\n',
      'packages/new-lib/src/nested/core.test.ts': 'export {};\n',
    });

    const graph = buildWorkspaceGraph(repo);
    const pkgLint = lintExtractedPackage(repo, graph, 'packages/new-lib');
    expect(pkgLint.passed).toBe(false);
    expect(pkgLint.violations.some((v) => v.includes('nested/core.ts'))).toBe(
      true,
    );

    const gate = evaluateEssenceProposal(graph, {
      packageName: '@demo/string-norm',
      description: 'Normalize unicode identifier strings cleanly',
      consumers: ['@demo/zephyr', '@demo/orchid'],
      exportedSymbols: ['stringUtils'],
    });
    expect(gate.passed).toBe(false);
    expect(gate.violations.some((v) => v.includes('垃圾桶'))).toBe(true);

    // 两个逻辑完全无关的 cli.ts 不再仅凭文件名相同上榜 filename-aligned
    const scan = scanWorkspace(repo, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    expect(scan.clusters.some((c) => c.kind === 'filename-aligned')).toBe(
      false,
    );

    // 验证 buildExtractSummary 输出完整汇总结构
    const sum = buildExtractSummary(scan, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    expect(sum.schemaVersion).toBe(1);
    expect(sum.nextAction.kind).toBeDefined();
  });

  test('detectMutClosureCapture 捕捉代码块嵌套 let 捕获与 export default async function 导出识别', () => {
    const src = `
      export default async function runNested(flag: boolean): Promise<number> {
        if (flag) {
          let acc = 0;
          const step = (): void => { acc += 1; };
          step();
          return acc;
        }
        return 0;
      }
    `;
    const dummyPkg: WorkspacePackageNode = {
      name: '@demo/a',
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
    const analyzed = analyzeSourceFile(dummyPkg, 'packages/a/src/r.ts', src);
    expect(analyzed.symbols[0]?.exported).toBe(true);
    const readiness = evaluateRustReadiness(
      tokenizeSource(src),
      ['pure'],
      true,
      true,
    );
    expect(readiness.hazards).toContain('mut-closure-capture');
  });
});

describe('文档 CLI 示例与代码注册表 + output-contract.schema.json 同源校验', () => {
  test('SKILL.md 与 references/*.md 内每条 extract-loop.ts 命令均满足 CLI_COMMAND_SPECS, 且 scan/summary 满足 output schema', () => {
    const docs = [
      readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8'),
      readFileSync(
        join(SKILL_ROOT, 'references/lifecycle-and-scaffold.md'),
        'utf8',
      ),
    ];

    const cmdRegex = /extract-loop\.ts\s+([a-z-]+)([^\n`]*)/g;
    let matchedCount = 0;
    for (const docText of docs) {
      for (const m of docText.matchAll(cmdRegex)) {
        const subcmd = m[1]!;
        const rest = m[2]!;
        if (subcmd === '<cmd>') continue;
        matchedCount += 1;
        const spec = CLI_COMMAND_SPECS[subcmd];
        expect(
          spec,
          `未在 CLI_COMMAND_SPECS 注册的子命令: ${subcmd}`,
        ).toBeDefined();

        for (const reqFlag of spec!.required) {
          expect(
            rest.includes(reqFlag),
            `文档中 "${subcmd}" 命令示例缺少必填参数 ${reqFlag}: ${m[0]}`,
          ).toBe(true);
        }

        const allowedFlags = new Set<string>([
          ...spec!.required,
          ...spec!.optional,
        ]);
        for (const flagMatch of rest.matchAll(/(--[a-z0-9-]+)/g)) {
          const flagName = flagMatch[1]!;
          expect(
            allowedFlags.has(flagName),
            `文档中 "${subcmd}" 出现未声明的幽灵参数 ${flagName}: ${m[0]}`,
          ).toBe(true);
        }
      }
    }
    expect(matchedCount).toBeGreaterThanOrEqual(8);

    const outSchema = JSON.parse(
      readFileSync(
        join(SKILL_ROOT, 'schemas/output-contract.schema.json'),
        'utf8',
      ),
    ) as {
      properties: {
        scanEnvelope: {
          properties: {
            stats: { required: string[] };
            nextAction: {
              required: string[];
              properties: { kind: { enum: string[] } };
            };
            convergence: { required: string[] };
          };
        };
        summaryOutput: { required: string[] };
      };
    };

    const repoRoot = resolve(SKILL_ROOT, '../../..');
    const scanReport = scanWorkspace(repoRoot, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });
    const summaryObj = buildExtractSummary(scanReport, {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    });

    for (const key of outSchema.properties.scanEnvelope.properties.stats
      .required) {
      expect(key in scanReport.stats, `scan.stats 缺少契约字段 ${key}`).toBe(
        true,
      );
    }
    expect(
      outSchema.properties.scanEnvelope.properties.nextAction.properties.kind
        .enum,
    ).toContain(scanReport.nextAction.kind);
    for (const key of outSchema.properties.summaryOutput.required) {
      expect(key in summaryObj, `summary 缺少契约字段 ${key}`).toBe(true);
    }
  });
});
