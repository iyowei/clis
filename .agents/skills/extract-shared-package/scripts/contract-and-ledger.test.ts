import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import * as fs from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { scanWorkspace } from './analyzer.ts';
import { CLI_COMMAND_SPECS } from './cli-contract.ts';
import { evaluateEssenceProposal } from './essence-gate.ts';
import { evaluateRustReadiness } from './fingerprint.ts';
import * as ledgerMod from './ledger.ts';
import * as pkgLint from './package-lint.ts';
import { buildExtractSummary } from './summary.ts';
import { analyzeSourceFile, tokenizeSource } from './tokenizer.ts';
import type { LedgerRecord, WorkspacePackageNode } from './types.ts';
import { buildWorkspaceGraph } from './workspace-graph.ts';

const tmpRoots: string[] = [];
const SKILL_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const LOOP_CLI = join(SKILL_ROOT, 'scripts/extract-loop.ts');

interface SchemaNode {
  $ref?: string;
  oneOf?: SchemaNode[];
  type?: string | string[];
  enum?: unknown[];
  minimum?: number;
  items?: SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  $defs?: Record<string, SchemaNode>;
}

const OUT_SCHEMA = JSON.parse(
  fs.readFileSync(
    join(SKILL_ROOT, 'schemas/output-contract.schema.json'),
    'utf8',
  ),
) as SchemaNode;
const TYPE_CHECKS: Record<string, (v: unknown) => boolean> = {
  null: (v) => v === null,
  boolean: (v) => typeof v === 'boolean',
  integer: (v) => typeof v === 'number' && Number.isInteger(v),
  number: (v) => typeof v === 'number' && Number.isFinite(v),
  string: (v) => typeof v === 'string',
  array: Array.isArray,
  object: (v) => v !== null && typeof v === 'object' && !Array.isArray(v),
};

function validateObj(
  obj: Record<string, unknown>,
  n: SchemaNode,
  at: string,
): void {
  expect(n.properties !== undefined, `${at} 空壳`).toBe(true);
  for (const r of n.required ?? [])
    expect(obj[r] !== undefined, `${at}.${r}`).toBe(true);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    if (n.properties?.[k])
      assertValidBySchema(v, n.properties[k], `${at}.${k}`);
    else if (n.additionalProperties === false)
      expect(false, `${at}+${k}`).toBe(true);
  }
}

function assertValidBySchema(val: unknown, n: SchemaNode, at = '$'): void {
  if (n.$ref !== undefined) {
    const refDef = OUT_SCHEMA.$defs?.[n.$ref.replace('#/$defs/', '')];
    expect(refDef, n.$ref).toBeDefined();
    assertValidBySchema(val, refDef!, at);
    return;
  }
  if (n.oneOf !== undefined) {
    let ok = 0;
    for (const b of n.oneOf) {
      try {
        assertValidBySchema(val, b, at);
        ok += 1;
      } catch {}
    }
    expect(ok, `${at} oneOf`).toBe(1);
    return;
  }
  if (n.enum !== undefined) expect(n.enum.includes(val), at).toBe(true);
  if (n.type !== undefined) {
    const ts = Array.isArray(n.type) ? n.type : [n.type];
    expect(
      ts.some((t) => TYPE_CHECKS[t]?.(val) === true),
      at,
    ).toBe(true);
  }
  if (typeof val === 'number' && n.minimum !== undefined) {
    expect(val >= n.minimum, at).toBe(true);
  }
  if (Array.isArray(val) && n.items !== undefined) {
    for (let i = 0; i < val.length; i += 1)
      assertValidBySchema(val[i], n.items, `${at}[${i}]`);
  }
  if (TYPE_CHECKS.object!(val))
    validateObj(val as Record<string, unknown>, n, at);
}

function makeSandboxRepo(files: Record<string, string>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const id = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
  const dir = join(home, 'tmp', `extract-contract-test-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    fs.mkdirSync(dirname(join(dir, rel)), { recursive: true });
    fs.writeFileSync(join(dir, rel), content, 'utf8');
  }
  return dir;
}

function runLoop(
  repo: string,
  cmd: string | string[],
  env?: Record<string, string>,
) {
  const args = typeof cmd === 'string' ? cmd.split('|') : cmd;
  const res = spawnSync('bun', [LOOP_CLI, ...args, '--repo', repo], {
    encoding: 'utf8',
    env: { ...process.env, ...env },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

const WS_PKG = '{"name":"ws","private":true,"workspaces":["packages/*"]}';
const cliJson = (n: string, deps = '') =>
  `{"name":"@demo/${n}","bin":{"${n}":"bin/x.mjs"}${deps ? `,"devDependencies":{${deps}}` : ''}}`;
const sharedJson = (n: string) =>
  `{"name":"@demo/${n}","private":true,"clisRole":"shared-lib"}`;

function mkRec(
  fingerprint: string,
  status: LedgerRecord['status'],
  packageName?: string,
  memberDigests: Record<string, string> = {},
  distinctDomains = 2,
): LedgerRecord {
  return {
    fingerprint,
    status,
    packageName,
    reason: 'r',
    memberDigests,
    distinctDomains,
    recordedAt: '2026-11-01T00:00:00.000Z',
  };
}

afterAll(() => {
  for (const dir of tmpRoots) {
    fs.rmSync(dir, { recursive: true, force: true });
    fs.rmSync(ledgerMod.resolveHomeTmpBase(dir), {
      recursive: true,
      force: true,
    });
  }
});

describe('P0 台账状态机与冷静期保护', () => {
  test('[P0-1/P0-4] upsertLedgerRecord 保留 degenerationWatches, 且已 accepted 消费方全接入时抑制旧簇', () => {
    const dupFn =
      'export function computeDigest(raw: string): string {\n  const trimmed = raw.trim().toLowerCase();\n  if (trimmed.length === 0) return "empty";\n  const normalized = trimmed.replace(/\\s+/g, "-");\n  return normalized.slice(0, 64).replace(/-+$/g, "");\n}';
    const repo = makeSandboxRepo({
      'package.json': WS_PKG,
      'packages/shared-old/package.json': sharedJson('shared-old'),
      'packages/shared-old/src/index.ts': 'export const v = 1;\n',
      'packages/alpha/package.json': cliJson(
        'alpha',
        '"@demo/shared-old":"1.0.0"',
      ),
      'packages/alpha/src/u.ts': dupFn,
      'packages/beta/package.json': cliJson('beta'),
      'packages/beta/src/u.ts': dupFn,
    });

    process.env.EXTRACT_LEDGER_PATH = join(repo, '.tmp-ledger.json');
    try {
      const day0 = new Date('2026-11-01T00:00:00.000Z');
      const s0 = scanWorkspace(repo, ledgerMod.loadLedger(repo), 10, {
        now: day0,
      });
      ledgerMod.syncDegenerationWatches(repo, s0.degeneratedLibs);
      const fp = s0.clusters[0]!.fingerprint;
      const digests = Object.fromEntries(
        s0.clusters[0]!.members.map((m) => [
          `${m.file}#${m.symbolName}`,
          m.rawDigest,
        ]),
      );
      ledgerMod.upsertLedgerRecord(repo, mkRec('other-fp', 'rejected'), false);
      const watches = ledgerMod.loadLedger(repo).degenerationWatches;
      expect(watches?.['@demo/shared-old']?.firstObservedAt).toBe(
        day0.toISOString(),
      );

      fs.writeFileSync(
        join(repo, 'packages/beta/package.json'),
        cliJson('beta', '"@demo/shared-old":"1.0.0"'),
      );
      const s2 = scanWorkspace(repo, {
        schemaVersion: 1,
        roundsExecuted: 1,
        records: [mkRec(fp, 'accepted', '@demo/shared-old', digests, 2)],
      });
      expect(s2.clusters.some((c) => c.fingerprint === fp)).toBe(false);
      expect(s2.suppressed.some((c) => c.fingerprint === fp)).toBe(true);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });
});

describe('轮次事务锁、回滚、backup-file 与 verify-reabsorb 检查点防线', () => {
  test('residue/reabsorb 回滚、backup-file 恢复, 且 verify-reabsorb 校验检查点 reabsorbInto 不一致报退 1', () => {
    const repo = makeSandboxRepo({
      'package.json': WS_PKG,
      'packages/shared-b/package.json': sharedJson('shared-b'),
      'packages/shared-b/src/index.ts': 'export const ok = 1;\n',
      'packages/one/package.json': cliJson('one', '"@demo/shared-b":"1.0.0"'),
      'packages/one/src/work.ts': 'export const w = 1;\n',
    });
    const env = { EXTRACT_LEDGER_PATH: join(repo, '.tmp-ledger.json') };
    process.env.EXTRACT_LEDGER_PATH = env.EXTRACT_LEDGER_PATH;
    const begin = ledgerMod.beginRoundCheckpoint;
    const exec = (c: string) => runLoop(repo, c, env);
    try {
      const wRel = 'packages/one/src/work.ts';
      const sbDir = 'packages/shared-b';
      const cpRes = begin(repo, 'res', sbDir, [wRel], 'residue');
      expect(() => begin(repo, 'x', 'packages/x', [], 'extract')).toThrow(
        /活跃轮次/,
      );
      fs.writeFileSync(join(repo, wRel), 'BROKEN');
      ledgerMod.rollbackRoundCheckpoint(repo, cpRes.roundId);
      expect(fs.readFileSync(join(repo, wRel), 'utf8')).toBe(
        'export const w = 1;\n',
      );

      const intoRel = 'packages/one/src/shared-b';
      const pJson = ['packages/one/package.json'];
      const cpRe = begin(
        repo,
        '@demo/shared-b',
        sbDir,
        pJson,
        'reabsorb',
        intoRel,
      );
      const vr = `verify-reabsorb|--name|@demo/shared-b|--dir|${sbDir}|--skip-ci`;
      const mis1 = exec(`${vr}|--into|packages/one/src/other`);
      expect(mis1.status).toBe(1);
      expect(mis1.stderr).toContain('reabsorbInto');
      expect(exec(`${vr}|--round|${cpRe.roundId}|--unused`).status).toBe(1);

      fs.rmSync(join(repo, sbDir), { recursive: true, force: true });
      fs.mkdirSync(join(repo, intoRel), { recursive: true });
      fs.writeFileSync(
        join(repo, `${intoRel}/index.ts`),
        'export const o = 1;\n',
      );
      ledgerMod.rollbackRoundCheckpoint(repo, cpRe.roundId);
      expect(fs.existsSync(join(repo, `${sbDir}/src/index.ts`))).toBe(true);
      expect(fs.existsSync(join(repo, intoRel))).toBe(false);

      const cpBk = begin(repo, '@demo/n', 'packages/n', [], 'extract');
      const addRel = 'packages/one/src/added.ts';
      expect(
        exec(`backup-file|--round|${cpBk.roundId}|--file|${wRel}`).status,
      ).toBe(0);
      expect(
        exec(`backup-file|--round|${cpBk.roundId}|--file|${addRel}`).status,
      ).toBe(0);
      fs.writeFileSync(join(repo, wRel), 'MUTATED\n');
      fs.writeFileSync(join(repo, addRel), 'ADDED\n');
      ledgerMod.rollbackRoundCheckpoint(repo, cpBk.roundId);
      expect(fs.readFileSync(join(repo, wRel), 'utf8')).toBe(
        'export const w = 1;\n',
      );
      expect(fs.existsSync(join(repo, addRel))).toBe(false);
    } finally {
      delete process.env.EXTRACT_LEDGER_PATH;
    }
  });
});

describe('深层源码扫描、链接识别升级、未知旗标防线与词法细节修复', () => {
  test('package-lint 孤儿 README 支持根相对 /packages/...、本仓 GitHub (blob|tree)/main/... 与 4 反引号围栏; 未知旗标退 2', () => {
    const sharedFields =
      '"clisRole":"shared-lib","type":"module","sideEffects":false,"files":["dist"],"main":"./dist/index.js","types":"./dist/index.d.ts","exports":{".":{"types":"./dist/index.d.ts","default":"./dist/index.js"}},"scripts":{"build":"x","typecheck":"y","test":"z"}';
    const repo = makeSandboxRepo({
      'package.json':
        '{"name":"orphan-guard","private":true,"repository":"https://github.com/acme/orphan-guard","workspaces":["packages/*"]}',
      'tsconfig.json':
        '{"compilerOptions":{"paths":{"@demo/u":["./packages/u/src/index.ts"]}}}',
      'node_modules/@demo/u/package.json': '{}',
      'README.md': '# Repo\n- `@demo/u`: internal\n',
      'docs/README.md':
        '# Docs\n````markdown\n```md\n[fake](../packages/u/README.md)\n```\n[still](/packages/u/README.md)\n````\n- `@demo/u`\n',
      'packages/zephyr/package.json':
        '{"name":"@demo/zephyr","version":"1.0.0"}',
      'packages/zephyr/src/cli.ts':
        'export function runZephyrOne(s: string): string { return s.trim(); }\n',
      'packages/orchid/package.json': cliJson('orchid'),
      'packages/orchid/src/cli.ts':
        'export function bootOrchid(f: boolean): number { return f ? 1 : 2; }\n',
      'packages/u/package.json': `{"name":"@demo/u","private":true,${sharedFields}}`,
      'packages/u/tsconfig.build.json':
        '{"compilerOptions":{"paths":{},"noEmitOnError":true}}',
      'packages/u/README.md': '# @demo/u\nHelper.\n',
      'packages/u/src/index.ts': 'export const u = 1;\n',
      'packages/u/src/index.test.ts': 'export {};\n',
    });

    expect(pkgLint.stripFencedCode('````md\n```\nkept\n```\n````\nout')).toBe(
      '\n\n\n\n\nout',
    );
    const graph = buildWorkspaceGraph(repo);
    expect(pkgLint.lintExtractedPackage(repo, graph, 'packages/u').passed).toBe(
      false,
    );
    const foreign =
      '[u](https://github.com/other/foreign/blob/main/packages/u/README.md)';
    expect(
      pkgLint.hasMarkdownLinkToPkgReadme(
        foreign,
        'docs/README.md',
        'packages/u',
        repo,
      ),
    ).toBe(false);

    for (const href of [
      '/packages/u/README.md',
      'https://github.com/acme/orphan-guard/blob/main/packages/u/README.md',
      'https://github.com/acme/orphan-guard/tree/main/packages/u',
    ]) {
      fs.writeFileSync(
        join(repo, 'docs/README.md'),
        `# Docs\n- \`@demo/u\`: [r](${href})\n`,
      );
      expect(
        pkgLint.lintExtractedPackage(repo, graph, 'packages/u').passed,
      ).toBe(true);
    }

    const gate = evaluateEssenceProposal(graph, {
      packageName: '@demo/string-norm',
      description: 'Normalize unicode identifier strings cleanly',
      consumers: ['@demo/zephyr', '@demo/orchid'],
      exportedSymbols: ['stringUtils'],
    });
    expect(gate.passed).toBe(false);

    for (const cmdLine of [
      'reject|--fingerprint|fp1|--reason|ok|--statu|deferred',
      'scan|--unknown-opt|1',
      'verify-reabsorb|--name|@demo/u|--dir|packages/u|--bogus',
      'summary|unexpected-positional',
      'check-proposal|--name|@demo/x|--description|desc',
      'check-proposal|--name|@demo/x|--description|desc|--consumers| , |--exports|fn1',
    ]) {
      const r = runLoop(repo, cmdLine);
      expect(r.status, cmdLine).toBe(2);
      expect(r.stderr).toContain(cmdLine.split('|')[0]!);
    }

    const src =
      'export default async function runNested(flag: boolean): Promise<number> {\n  if (flag) { let acc = 0; const step = (): void => { acc += 1; }; step(); return acc; }\n  return 0;\n}';
    const dummyPkg = { ...graph.packages[0]! } satisfies WorkspacePackageNode;
    expect(
      analyzeSourceFile(dummyPkg, 'packages/a/src/r.ts', src).symbols[0]
        ?.exported,
    ).toBe(true);
    const rr = evaluateRustReadiness(tokenizeSource(src), ['pure'], true, true);
    expect(rr.hazards).toContain('mut-closure-capture');
  });
});

describe('文档 CLI 示例与代码注册表 + output-contract.schema.json 递归同源校验', () => {
  test('SKILL.md 与 references/*.md 命令满足 CLI_COMMAND_SPECS, 且 scan / scan --full / summary 递归满足 Schema', () => {
    for (const [name, def] of Object.entries(OUT_SCHEMA.$defs ?? {})) {
      if (def.type === 'object') {
        expect(def.additionalProperties, `${name} 须锁紧`).toBe(false);
        expect(def.properties, `${name} 须声明 properties`).toBeDefined();
      }
    }
    let matchedCount = 0;
    for (const rel of ['SKILL.md', 'references/lifecycle-and-scaffold.md']) {
      const docText = fs.readFileSync(join(SKILL_ROOT, rel), 'utf8');
      for (const m of docText.matchAll(
        /extract-loop\.ts\s+([a-z-]+)([^\n`]*)/g,
      )) {
        const [, subcmd = '', rest = ''] = m;
        if (subcmd === '<cmd>') continue;
        matchedCount += 1;
        const spec = CLI_COMMAND_SPECS[subcmd]!;
        expect(spec, subcmd).toBeDefined();
        for (const reqFlag of spec.required)
          expect(rest.includes(reqFlag), reqFlag).toBe(true);
        const allowed = new Set([...spec.required, ...spec.optional]);
        for (const fm of rest.matchAll(/(--[a-z0-9-]+)/g))
          expect(allowed.has(fm[1]!), fm[1]!).toBe(true);
      }
    }
    expect(matchedCount).toBeGreaterThanOrEqual(8);

    const dupCode =
      'export function sharedFormat(raw: string): string {\n  const parts = raw.trim().split(",");\n  const out: string[] = [];\n  for (const p of parts) { if (p.length > 0) out.push(p.toUpperCase()); }\n  return out.join("|");\n}\n';
    const miniRepo = makeSandboxRepo({
      'package.json': WS_PKG,
      'packages/shared-cool/package.json': sharedJson('shared-cool'),
      'packages/shared-cool/src/index.ts': 'export const sc = 1;\n',
      'packages/pub-orphan/package.json':
        '{"name":"@demo/pub-orphan","version":"1.0.0"}',
      'packages/pub-orphan/src/index.ts': 'export const po = 1;\n',
      'packages/cli-a/package.json': cliJson(
        'cli-a',
        '"@demo/shared-cool":"1.0.0","@demo/pub-orphan":"1.0.0"',
      ),
      'packages/cli-a/src/index.ts': dupCode,
      'packages/cli-b/package.json': cliJson('cli-b'),
      'packages/cli-b/src/index.ts': `${dupCode}\nexport function dyn(x: any): any { return eval(String(x)); }\n`,
    });
    const seed = [
      mkRec('fp-acc', 'accepted', '@demo/ex', {}, 1),
      mkRec('fp-reab', 'reabsorbed', '@demo/old', {}, 1),
      mkRec('fp-rej', 'rejected', undefined, {}, 1),
    ];
    const ledgerPath = join(miniRepo, '.tmp-schema-ledger.json');
    fs.writeFileSync(
      ledgerPath,
      JSON.stringify({ schemaVersion: 1, roundsExecuted: 2, records: seed }),
    );
    const env = { EXTRACT_LEDGER_PATH: ledgerPath };
    const runJson = (args: string[], defKey: string) => {
      const r = runLoop(miniRepo, args, env);
      expect(r.status).toBe(0);
      const parsed = JSON.parse(r.stdout) as Record<string, unknown>;
      assertValidBySchema(parsed, OUT_SCHEMA.$defs![defKey]!, defKey);
      assertValidBySchema(parsed, OUT_SCHEMA);
      return parsed;
    };

    const scanOut = runJson(['scan'], 'scanEnvelope');
    expect((scanOut.topClusters as unknown[]).length).toBeGreaterThan(0);
    expect((scanOut.degeneratedLibs as unknown[]).length).toBeGreaterThan(0);
    runJson(['scan', '--full'], 'scanFullEnvelope');
    const sumOut = runJson(['summary'], 'summaryOutput');
    expect((sumOut.extractedPackages as unknown[]).length).toBe(1);
    expect((sumOut.reabsorbedPackages as unknown[]).length).toBe(1);
    expect((sumOut.rejectedOrDeferred as unknown[]).length).toBe(1);
    expect((sumOut.coolingDownLibs as unknown[]).length).toBe(1);
    const ldg = ledgerMod.loadLedger(miniRepo);
    expect(
      buildExtractSummary(scanWorkspace(miniRepo, ldg), ldg).schemaVersion,
    ).toBe(1);
  });
});
