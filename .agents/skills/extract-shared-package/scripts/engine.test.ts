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
import {
  evaluateEssenceProposal,
  lintExtractedPackage,
} from './essence-gate.ts';
import {
  beginRoundCheckpoint,
  loadLedger,
  recordFileBackup,
  rollbackRoundCheckpoint,
  upsertLedgerRecord,
} from './ledger.ts';
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
  }
});

describe('tokenizer: α-归一化克隆检测与 Rust 可转写评分', () => {
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

  test('局部变量完全重命名与注释变更时, Shingle 相似度仍接近 1', () => {
    const srcA = `
      import { readFileSync, existsSync } from 'node:fs';
      // read config A
      export function loadConfigA(filePath: string): string | null {
        if (!existsSync(filePath)) return null;
        const rawText = readFileSync(filePath, 'utf8');
        const trimmed = rawText.trim();
        return trimmed.length > 0 ? trimmed : null;
      }
    `;
    const srcB = `
      import { readFileSync, existsSync } from 'node:fs';
      export function readJsonText(target: string): string | null {
        if (!existsSync(target)) return null;
        const buf = readFileSync(target, 'utf8');
        const clean = buf.trim();
        return clean.length > 0 ? clean : null;
      }
    `;
    const a = analyzeSourceFile(dummyPkg, 'packages/a/src/x.ts', srcA);
    const b = analyzeSourceFile(dummyPkg, 'packages/b/src/y.ts', srcB);
    expect(a.symbols.length).toBe(1);
    expect(b.symbols.length).toBe(1);
    expect(a.symbols[0]!.normalizedDigest).toBe(b.symbols[0]!.normalizedDigest);
  });

  test('顶层箭头函数同样被提取且能识别跨包等价结构', () => {
    const arrowA = `
      export const parseLineA = (line: string): string[] => {
        const trimmed = line.trim();
        if (trimmed === '') return [];
        return trimmed.split(',').map((item) => item.trim());
      };
    `;
    const arrowB = `
      export const splitItemB = (raw: string): string[] => {
        const clean = raw.trim();
        if (clean === '') return [];
        return clean.split(',').map((part) => part.trim());
      };
    `;
    const a = analyzeSourceFile(dummyPkg, 'packages/a/src/arrow.ts', arrowA);
    const b = analyzeSourceFile(dummyPkg, 'packages/b/src/arrow.ts', arrowB);
    expect(a.symbols.length).toBe(1);
    expect(a.symbols[0]!.name).toBe('parseLineA');
    expect(a.symbols[0]!.normalizedDigest).toBe(b.symbols[0]!.normalizedDigest);
  });

  test('含 any 或混杂多层宿主 I/O 的函数会降低 Rust 可转写评分', () => {
    const messy = `
      import { readFileSync } from 'node:fs';
      import { spawnSync } from 'node:child_process';
      export function runDirty(input: any) {
        const txt = readFileSync(String(input), 'utf8');
        spawnSync('echo', [txt]);
        return txt;
      }
    `;
    const res = analyzeSourceFile(dummyPkg, 'packages/a/src/dirty.ts', messy);
    const sym = res.symbols[0]!;
    expect(sym.rustReadiness.hazards).toContain('any-type');
    expect(sym.rustReadiness.ioBoundaryMixed).toBe(true);
    expect(sym.rustReadiness.score).toBeLessThan(60);
    expect(
      tokenizeSource('const s = `hello ${a + 1}`;').length,
    ).toBeGreaterThan(5);
  });
});

describe('workspace-graph & essence-gate: 双包去重与本质闸门', () => {
  test('同一双包产品内部共享不计为跨独立域复用; 跨两产品域且纯洁命名才放行', () => {
    const repo = makeSandboxRepo({
      'package.json': JSON.stringify({
        name: 'demo',
        private: true,
        workspaces: ['packages/*'],
      }),
      'packages/alpha/package.json': JSON.stringify({
        name: '@demo/alpha',
        version: '1.0.0',
      }),
      'packages/alpha-cli/package.json': JSON.stringify({
        name: '@demo/alpha-cli',
        version: '1.0.0',
        bin: { alpha: 'bin/alpha.js' },
        devDependencies: { '@demo/alpha': '1.0.0' },
      }),
      'packages/beta/package.json': JSON.stringify({
        name: '@demo/beta',
        version: '1.0.0',
      }),
      'packages/beta-cli/package.json': JSON.stringify({
        name: '@demo/beta-cli',
        version: '1.0.0',
        bin: { beta: 'bin/beta.js' },
        devDependencies: { '@demo/beta': '1.0.0' },
      }),
    });

    const graph = buildWorkspaceGraph(repo);
    expect(graph.layerDomainCounts.cli).toBe(2);

    // 同一产品双包内自用 -> 必须拦截
    const sameProduct = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description:
        'Deterministic terminal prompt primitive with non-TTY fallback',
      consumers: ['@demo/alpha', '@demo/alpha-cli'],
      exportedSymbols: ['askConfirm'],
    });
    expect(sameProduct.passed).toBe(false);
    expect(sameProduct.metrics.distinctDomains).toBe(1);

    // 垃圾桶命名 + 原业务词泄漏 -> 必须拦截
    const badName = evaluateEssenceProposal(graph, {
      packageName: '@demo/alpha-utils',
      description: 'Helper tools for alpha and beta',
      consumers: ['@demo/alpha-cli', '@demo/beta-cli'],
      exportedSymbols: ['alphaAsk'],
    });
    expect(badName.passed).toBe(false);
    expect(badName.violations.some((v) => v.includes('utils'))).toBe(true);
    expect(badName.violations.some((v) => v.includes('alpha'))).toBe(true);

    // 跨两个独立 CLI 域 (2/2 覆盖) + 本质命名 -> 放行
    const valid = evaluateEssenceProposal(graph, {
      packageName: '@demo/tty-prompt',
      description:
        'Deterministic terminal prompt primitive with non-TTY fallback',
      consumers: ['@demo/alpha-cli', '@demo/beta-cli'],
      exportedSymbols: ['askText', 'askConfirm'],
    });
    expect(valid.passed).toBe(true);
    expect(valid.metrics.distinctDomains).toBe(2);
  });

  test('落盘实包体检强制要求 private:true、sideEffects:false 与零领域词', () => {
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
        type: 'module',
        sideEffects: false,
        exports: { '.': './dist/index.js' },
        scripts: { build: 'x', typecheck: 'y', test: 'z' },
      }),
      'packages/tty-prompt/README.md': '# @demo/tty-prompt\nPure prompt.',
      'packages/tty-prompt/src/index.ts': 'export const ok = true;\n',
      'packages/tty-prompt/src/index.test.ts':
        'import { test, expect } from "bun:test"; test("ok", () => expect(true).toBe(true));\n',
    });

    const graph = buildWorkspaceGraph(repo);
    const res = lintExtractedPackage(repo, graph, 'packages/tty-prompt');
    expect(res.passed).toBe(true);
  });
});

describe('analyzer & ledger: 台账抑制自愈与原子回滚安全', () => {
  test('被否决候选在代码未变时被抑制, 代码改变后自动解锁; 回滚不破坏未参与文件', () => {
    const sharedBody = `
      import { existsSync, readFileSync } from 'node:fs';
      import { join } from 'node:path';
      export function readTrimmed(root: string, name: string): string {
        const p = join(root, name);
        if (!existsSync(p)) return '';
        return readFileSync(p, 'utf8').trim();
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
      }),
      'packages/one/src/config.ts': sharedBody,
      'packages/two/package.json': JSON.stringify({
        name: '@demo/two',
        bin: { two: 'bin/two.js' },
      }),
      'packages/two/src/config.ts': sharedBody.replace(
        'readTrimmed',
        'loadTrimmed',
      ),
      'packages/one/src/unrelated-dirty.ts': 'export const userWork = 1;\n',
    });

    const emptyLedger: ExtractLedger = {
      schemaVersion: 1,
      roundsExecuted: 0,
      records: [],
    };
    const scan1 = scanWorkspace(repo, emptyLedger);
    expect(scan1.clusters.length).toBeGreaterThan(0);
    const targetCluster = scan1.clusters[0]!;
    const memberDigests: Record<string, string> = {};
    for (const m of targetCluster.members) {
      memberDigests[`${m.file}#${m.symbolName}`] = m.rawDigest;
    }

    // 登记否决后重扫 -> 自动抑制
    upsertLedgerRecord(
      repo,
      {
        fingerprint: targetCluster.fingerprint,
        status: 'rejected',
        reason: 'too small',
        memberDigests,
        distinctDomains: targetCluster.distinctDomainCount,
        recordedAt: new Date().toISOString(),
      },
      false,
    );
    const scan2 = scanWorkspace(repo, loadLedger(repo));
    expect(
      scan2.suppressed.some((c) => c.fingerprint === targetCluster.fingerprint),
    ).toBe(true);

    // 验证单轮回滚机制保护 unrelated-dirty.ts
    const cp = beginRoundCheckpoint(repo, '@demo/tmp-pkg', 'packages/tmp-pkg', [
      'packages/one/src/config.ts',
    ]);
    recordFileBackup(cp, 'packages/one/src/added-by-round.ts');
    writeFileSync(join(repo, 'packages/one/src/config.ts'), 'BROKEN');
    writeFileSync(join(repo, 'packages/one/src/added-by-round.ts'), 'TMP');
    mkdirSync(join(repo, 'packages/tmp-pkg/src'), { recursive: true });
    writeFileSync(join(repo, 'packages/tmp-pkg/src/index.ts'), 'export {};');
    // 模拟用户自己在该文件有未登记的新改动
    writeFileSync(
      join(repo, 'packages/one/src/unrelated-dirty.ts'),
      'export const userWork = 999;\n',
    );

    rollbackRoundCheckpoint(repo, cp.roundId);
    expect(readFileSync(join(repo, 'packages/one/src/config.ts'), 'utf8')).toBe(
      sharedBody,
    );
    expect(existsSync(join(repo, 'packages/one/src/added-by-round.ts'))).toBe(
      false,
    );
    expect(existsSync(join(repo, 'packages/tmp-pkg'))).toBe(false);
    expect(
      readFileSync(join(repo, 'packages/one/src/unrelated-dirty.ts'), 'utf8'),
    ).toBe('export const userWork = 999;\n');
  });
});
