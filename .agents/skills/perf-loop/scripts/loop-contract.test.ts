import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import { makeTmpRoot } from '../../../../scripts/lib/tmp-root.ts';

const HOST_REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');
const SKILL_ROOT = resolve(import.meta.dir, '..');
const LOOP_CLI = join(SKILL_ROOT, 'scripts', 'loop.ts');

interface SchemaNode {
  $ref?: string;
  oneOf?: SchemaNode[];
  type?: string | string[];
  const?: unknown;
  enum?: unknown[];
  minimum?: number;
  minLength?: number;
  items?: SchemaNode;
  required?: string[];
  properties?: Record<string, SchemaNode>;
  additionalProperties?: boolean | SchemaNode;
  $defs?: Record<string, SchemaNode>;
}

const CONTRACT_SCHEMA = JSON.parse(
  readFileSync(join(SKILL_ROOT, 'schemas/output-contract.schema.json'), 'utf8'),
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

const createdRoots: string[] = [];

afterAll(() => {
  for (const dir of createdRoots) rmSync(dir, { recursive: true, force: true });
});

function validateObj(
  obj: Record<string, unknown>,
  node: SchemaNode,
  root: SchemaNode,
  at: string,
): void {
  expect(
    node.properties !== undefined ||
      typeof node.additionalProperties === 'object',
    `${at} 空壳`,
  ).toBe(true);
  for (const req of node.required ?? [])
    expect(req in obj && obj[req] !== undefined, `${at}.${req}`).toBe(true);
  for (const [k, v] of Object.entries(obj)) {
    if (v === undefined) continue;
    const prop = node.properties?.[k];
    if (prop !== undefined) assertValidBySchema(v, prop, root, `${at}.${k}`);
    else if (node.additionalProperties === false)
      expect(false, `${at} 多余字段 ${k}`).toBe(true);
    else if (typeof node.additionalProperties === 'object')
      assertValidBySchema(v, node.additionalProperties, root, `${at}.${k}`);
  }
}

function assertValidBySchema(
  val: unknown,
  node: SchemaNode,
  root: SchemaNode = CONTRACT_SCHEMA,
  at = '$',
): void {
  if (node.$ref !== undefined) {
    const target = root.$defs?.[node.$ref.replace('#/$defs/', '')];
    expect(target, node.$ref).toBeDefined();
    assertValidBySchema(val, target!, root, at);
    return;
  }
  if (node.oneOf !== undefined) {
    let ok = 0;
    for (const b of node.oneOf) {
      try {
        assertValidBySchema(val, b, root, at);
        ok += 1;
      } catch {}
    }
    expect(ok, `${at} oneOf`).toBe(1);
    return;
  }
  if (node.const !== undefined) expect(val, at).toBe(node.const);
  if (node.enum !== undefined)
    expect(node.enum.includes(val), `${at} enum`).toBe(true);
  if (node.type !== undefined) {
    const ts = Array.isArray(node.type) ? node.type : [node.type];
    expect(
      ts.some((t) => TYPE_CHECKS[t]?.(val) === true),
      `${at} type`,
    ).toBe(true);
  }
  if (typeof val === 'string' && node.minLength !== undefined)
    expect(val.length >= node.minLength, at).toBe(true);
  if (typeof val === 'number' && node.minimum !== undefined)
    expect(val >= node.minimum, at).toBe(true);
  if (Array.isArray(val) && node.items !== undefined) {
    for (let i = 0; i < val.length; i += 1)
      assertValidBySchema(val[i], node.items, root, `${at}[${i}]`);
  }
  if (TYPE_CHECKS.object!(val))
    validateObj(val as Record<string, unknown>, node, root, at);
}

function createCliSandbox(): { root: string; tmpBase: string } {
  const root = makeTmpRoot('perf-loop-cli-contract-');
  createdRoots.push(root);
  const tmpBase = join(root, '.perf-tmp');
  for (const sub of [
    'packages/alpha/src',
    'packages/beta/src',
    'packages/beta/bench',
  ]) {
    mkdirSync(join(root, sub), { recursive: true });
  }
  symlinkSync(join(HOST_REPO_ROOT, 'node_modules'), join(root, 'node_modules'));

  writeFileSync(
    join(root, 'package.json'),
    '{"name":"cli-contract-mono","private":true,"workspaces":["packages/*"]}',
  );
  writeFileSync(
    join(root, 'packages/alpha/package.json'),
    '{"name":"@contract/alpha","version":"1.0.0","private":true,"type":"module","scripts":{"check":"bun --version","test":"bun test"}}',
  );
  writeFileSync(
    join(root, 'packages/alpha/tsconfig.json'),
    '{"include":["src"]}',
  );
  writeFileSync(
    join(root, 'packages/alpha/src/index.ts'),
    'export const alpha = 1;\n',
  );
  writeFileSync(
    join(root, 'packages/beta/package.json'),
    '{"name":"@contract/beta","version":"1.0.0","type":"module","scripts":{"bench":"bun bench/run.ts","check":"bun --version","test":"bun test"}}',
  );
  writeFileSync(
    join(root, 'packages/beta/src/algo.ts'),
    'export function countCommon(a: number[], b: number[]): number {\n  let count = 0;\n  for (let i = 0; i < a.length; i += 1) {\n    if (b.includes(a[i]!)) count += 1;\n  }\n  return count;\n}\n',
  );
  writeFileSync(
    join(root, 'packages/beta/src/algo.test.ts'),
    "import { expect, test } from 'bun:test';\nimport { countCommon } from './algo.ts';\ntest('ok', () => expect(countCommon([1, 2, 3], [2, 4])).toBe(1));\n",
  );
  writeFileSync(
    join(root, 'packages/beta/bench/run.ts'),
    `import { countCommon } from '../src/algo.ts';
const jsonMode = process.argv.includes('--json');
const arrA = Array.from({ length: 4200 }, (_, i) => i * 2);
const arrB = Array.from({ length: 4200 }, (_, i) => i * 3);
countCommon(arrA, arrB);
const samplesMs: number[] = [];
let hits = 0;
for (let i = 0; i < 6; i += 1) {
  const t0 = performance.now();
  hits = countCommon(arrA, arrB);
  samplesMs.push(performance.now() - t0);
}
const sorted = [...samplesMs].sort((a, b) => a - b);
const isBun = typeof Bun !== 'undefined';
if (jsonMode) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    package: '@contract/beta',
    runtime: isBun ? 'bun' : 'node',
    runtimeVersion: isBun ? Bun.version : process.version.replace(/^v/, ''),
    suite: 'quick',
    cases: [{
      name: 'common',
      role: 'primary',
      iterations: samplesMs.length,
      samplesMs,
      minMs: sorted[0] ?? 0,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p95Ms: sorted[sorted.length - 1] ?? 0,
      digest: String(hits),
    }],
  }) + '\\n');
}
`,
  );
  writeFileSync(
    join(root, '.gitignore'),
    'node_modules\n.perf-tmp\n**/bench/ledger\n',
  );
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return { root, tmpBase };
}

function runLoopCli(root: string, tmpBase: string, args: readonly string[]) {
  const res = spawnSync('bun', [LOOP_CLI, ...args], {
    cwd: root,
    encoding: 'utf8',
    env: {
      ...process.env,
      PERF_LOOP_REPO_ROOT: root,
      PERF_LOOP_TMP_BASE: tmpBase,
    },
  });
  return { status: res.status, stdout: res.stdout, stderr: res.stderr };
}

describe('loop.ts CLI 未知旗标防线、防吞旗标与合法枚举集合校验', () => {
  test('全部 6 子命令拒绝未知 --* 旗标、多余位置参数与非法枚举, 一律退 2 且绝不回滚删代码或污染 ledger', () => {
    const { root, tmpBase } = createCliSandbox();
    const prep = runLoopCli(root, tmpBase, [
      'prepare',
      '--pkg',
      '@contract/beta',
    ]);
    expect(prep.status).toBe(0);
    const activeRunId = (JSON.parse(prep.stdout) as { runId: string }).runId;

    const algoFile = join(root, 'packages/beta/src/algo.ts');
    const candidateCode =
      'export function countCommon(): number { return 1; }\n';
    writeFileSync(algoFile, candidateCode);

    const badCommandLines = [
      'status|--pkg',
      'status|--unknown-flag|x',
      'status|@contract/beta',
      'next|--pkg|@contract/beta',
      'next|extra-pos',
      'init-bench|--pkg|@contract/alpha|--force',
      'prepare|--pkg|--suite|quick',
      'prepare|--pkg|@contract/beta|--suite|turbo-invalid',
      'prepare|--pkg|@contract/beta|--case|--suite|quick',
      'prepare|--pkg|@contract/beta|--cases|10',
      `evaluate|--pkg|@contract/beta|--run|${activeRunId}|--proposal|typo|--dimension|arch|--expected-tier|P1|--allow-cross-package`,
      `evaluate|--pkg|@contract/beta|--run|${activeRunId}|--proposal|typo|--dimension|impl|--expected-tier|P2|--cases|10`,
      `evaluate|--pkg|@contract/beta|--run|${activeRunId}|--proposal|bad dim|--dimension|memory-bogus|--expected-tier|P1`,
      `evaluate|--pkg|@contract/beta|--run|${activeRunId}|--proposal|bad tier|--dimension|impl|--expected-tier|P9`,
      'recover|--run|--allow-cross-pkg',
      `recover|--run|${activeRunId}|--force`,
      'unknown-subcommand',
    ];
    for (const line of badCommandLines) {
      const out = runLoopCli(root, tmpBase, line.split('|'));
      expect(out.status, `${line} 应退 2`).toBe(2);
    }

    expect(readFileSync(algoFile, 'utf8')).toBe(candidateCode);
    expect(existsSync(join(tmpBase, activeRunId, 'state.json'))).toBe(true);
    expect(existsSync(join(root, 'packages/beta/bench/ledger'))).toBe(false);
  });

  test('已有非 --json 版 bench/run.ts 时路由到 COMPLETE_BENCH_STUB 而非必败 INIT_BENCH', () => {
    const { root, tmpBase } = createCliSandbox();
    mkdirSync(join(root, 'packages/beta/bench/ledger'), { recursive: true });
    const fakeLoss = JSON.stringify({
      id: 'x',
      ts: 1,
      package: '@contract/beta',
      proposal: 'p',
      rationale: '',
      dimension: 'impl',
      expectedTier: 'P2',
      verdict: 'REVERT',
      measuredTier: null,
      failureReason: 'NO_GAIN',
      touchedFiles: [],
      metrics: [],
      overallGainPct: 0,
      overallRssGainPct: null,
      nodeRegressionPct: null,
      fingerprint: {
        sourceHashes: {},
        benchHash: 'h',
        runtimeVersions: { bun: '1', node: '22' },
        acceptedCountAtAttempt: 0,
      },
      docActionRequired: false,
      docNotes: null,
    });
    writeFileSync(
      join(root, 'packages/beta/bench/ledger/rejected.jsonl'),
      `${Array.from({ length: 8 }, () => fakeLoss).join('\n')}\n`,
    );

    const nextMissing = JSON.parse(
      runLoopCli(root, tmpBase, ['next']).stdout,
    ) as {
      next: { action: string; target: string; reason: string };
    };
    expect(nextMissing.next.action).toBe('INIT_BENCH');
    expect(nextMissing.next.target).toBe('@contract/alpha');

    mkdirSync(join(root, 'packages/alpha/bench'), { recursive: true });
    writeFileSync(
      join(root, 'packages/alpha/bench/run.ts'),
      'console.log("legacy human-only bench");\n',
    );
    const nextLegacy = JSON.parse(
      runLoopCli(root, tmpBase, ['next']).stdout,
    ) as {
      next: { action: string; target: string; reason: string };
    };
    expect(nextLegacy.next.action).toBe('COMPLETE_BENCH_STUB');
    expect(nextLegacy.next.target).toBe('@contract/alpha');
    expect(nextLegacy.next.reason).toContain('--json');
  });
});

describe('loop.ts 全子命令输出契约与 output-contract.schema.json 递归对齐', () => {
  test('Schema 零空壳对象, 且 status/next/init-bench/prepare/recover/evaluate 全分支输出递归匹配 Schema', () => {
    expect(readFileSync(join(SKILL_ROOT, 'SKILL.md'), 'utf8')).toContain(
      'schemas/output-contract.schema.json',
    );
    expect(CONTRACT_SCHEMA.oneOf).toHaveLength(8);
    for (const [name, def] of Object.entries(CONTRACT_SCHEMA.$defs ?? {})) {
      if (def.type === 'object' && name !== 'sourceHashes') {
        expect(def.additionalProperties, `${name} 须锁紧`).toBe(false);
        expect(def.properties, `${name} 须声明 properties`).toBeDefined();
      }
    }

    const { root, tmpBase } = createCliSandbox();
    const execJson = (args: readonly string[], defName: string) => {
      const res = runLoopCli(root, tmpBase, args);
      expect(res.status, `${args.join(' ')} stderr: ${res.stderr}`).toBe(0);
      const parsed = JSON.parse(res.stdout) as Record<string, unknown>;
      assertValidBySchema(
        parsed,
        CONTRACT_SCHEMA.$defs![defName]!,
        CONTRACT_SCHEMA,
        defName,
      );
      assertValidBySchema(parsed, CONTRACT_SCHEMA);
      return parsed;
    };

    execJson(['status'], 'statusOutput');
    execJson(['next'], 'nextOutput');
    execJson(['init-bench', '--pkg', '@contract/alpha'], 'initBenchOutput');

    const prep1 = execJson(
      ['prepare', '--pkg', '@contract/beta', '--suite', 'quick'],
      'prepareActiveOutput',
    );
    const run1 = prep1.runId as string;
    expect(execJson(['recover', '--run', run1], 'recoverOutput').runId).toBe(
      run1,
    );

    const prep2 = execJson(
      ['prepare', '--pkg', '@contract/beta'],
      'prepareActiveOutput',
    );
    writeFileSync(
      join(root, 'packages/beta/src/algo.ts'),
      'export function countCommon(a: number[], b: number[]): number {\n  let total = 0;\n  for (let r = 0; r < 4; r += 1) {\n    total = 0;\n    for (let i = 0; i < a.length; i += 1) {\n      if (b.includes(a[i]!)) total += 1;\n    }\n  }\n  return total;\n}\n',
    );
    const revOut = execJson(
      `evaluate|--pkg|@contract/beta|--run|${String(prep2.runId)}|--proposal|4x slower loop|--dimension|impl|--expected-tier|P2|--cycles|1`.split(
        '|',
      ),
      'evaluateRevertOutput',
    );
    expect((revOut.record as { verdict: string }).verdict).toBe('REVERT');

    const prep3 = execJson(
      ['prepare', '--pkg', '@contract/beta'],
      'prepareActiveOutput',
    );
    writeFileSync(
      join(root, 'packages/beta/src/algo.ts'),
      'export function countCommon(a: number[], b: number[]): number {\n  const setB = new Set(b);\n  let count = 0;\n  for (let i = 0; i < a.length; i += 1) {\n    if (setB.has(a[i]!)) count += 1;\n  }\n  return count;\n}\n',
    );
    const keepOut = execJson(
      `evaluate|--pkg|@contract/beta|--run|${String(prep3.runId)}|--proposal|Use Set O(N)|--dimension|arch|--expected-tier|P0|--rationale|Linear lookup|--cycles|2`.split(
        '|',
      ),
      'evaluateKeepOutput',
    );
    expect((keepOut.record as { verdict: string }).verdict).toBe('KEEP');

    execJson(['prepare', '--pkg', '@contract/beta'], 'prepareActiveOutput');

    const baseRec = revOut.record as Record<string, unknown>;
    const eightLosses = Array.from({ length: 8 }, (_, idx) =>
      JSON.stringify({
        ...baseRec,
        id: `loss-${idx}`,
        ts: Date.now() + idx + 10,
      }),
    ).join('\n');
    writeFileSync(
      join(root, 'packages/beta/bench/ledger/rejected.jsonl'),
      `${eightLosses}\n`,
    );
    execJson(['prepare', '--pkg', '@contract/beta'], 'prepareStoppedOutput');
  });
});
