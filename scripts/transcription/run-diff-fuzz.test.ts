/**
 * 差分模糊测试引擎单测: PRNG 确定性、生成器覆盖、规范深比对、不变量拦截、批量/单步降级与诊断单落盘。
 * 全部使用临时目录自包含微型假 harness, 零业务包依赖, 随脚手架模板 snapshot 原样可用。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import {
  type GeneratorName,
  canonicalJson,
  checkInvariants,
  comparableOutcome,
  createPrng,
  generateFuzzArgs,
} from './fuzz-generators.ts';
import { parseArgs as parseConformanceArgs } from './run-conformance.ts';
import {
  parseFuzzArgs,
  resolveProductHarnessArgv,
  runDiffFuzzCli,
} from './run-diff-fuzz.ts';

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 构造微型参考/被测假 harness 脚本 (支持批量或仅单步, 并可注入差分偏差/脏字符故障) */
function writeMockHarness(
  dir: string,
  name: string,
  options: {
    supportBatch: boolean;
    buggyClean?: boolean;
    nonIdempotent?: boolean;
  },
): string {
  const path = join(dir, name);
  const code = `
import { readFileSync } from 'node:fs';
function cleanText(s) {
  let out = String(s)
    .replace(/[\\u0000-\\u0008\\u000b-\\u001f\\u007f-\\u009f\\u200b-\\u200f\\u202a-\\u202e\\u2066-\\u2069\\ufeff]/g, '')
    .replace(/\\s+/g, ' ')
    .trim();
  ${options.buggyClean ? 'if (out.includes("alpha")) out = out + "\\u001b[31m";' : ''}
  ${options.nonIdempotent ? 'out = "[" + out + "]";' : ''}
  return out;
}
function execOne(inst) {
  if (!inst || !Array.isArray(inst.steps)) {
    return { ok: false, error: { name: 'HarnessError', message: 'missing steps' } };
  }
  const step = inst.steps[0];
  if (step.call.export === 'clean') {
    return { ok: true, value: cleanText(step.call.args[0]) };
  }
  return { ok: false, error: { name: 'HarnessError', message: 'unknown export' } };
}
const parsed = JSON.parse(readFileSync(0, 'utf8'));
if (${String(options.supportBatch)} && Array.isArray(parsed.batch)) {
  process.stdout.write(JSON.stringify({ ok: true, results: parsed.batch.map(execOne) }) + '\\n');
} else {
  process.stdout.write(JSON.stringify(execOne(parsed)) + '\\n');
}
`;
  writeFileSync(path, code, 'utf8');
  return path;
}

describe('fuzz-generators 纯函数能力', () => {
  test('createPrng 同种子严格可复现, 异种子产生不同序列', () => {
    const a = createPrng(42);
    const b = createPrng(42);
    const c = createPrng(43);
    const seqA = Array.from({ length: 10 }, () => a());
    const seqB = Array.from({ length: 10 }, () => b());
    const seqC = Array.from({ length: 10 }, () => c());
    expect(seqA).toEqual(seqB);
    expect(seqA).not.toEqual(seqC);
  });

  test('全部 13 类生成器按同种子确定性产出非空参数数组', () => {
    const names: GeneratorName[] = [
      'dirty-line',
      'indented-dirty-line',
      'byte-size',
      'rule-match',
      'config-path-options',
      'name-lists',
      'v1-config-raw',
      'xdg-path',
      'classify-target',
      'rule-leaf-match',
      'older-than-days',
      'safe-target-leaf',
      'inside-any-root',
    ];
    for (const name of names) {
      const first = generateFuzzArgs(name, 2026, 20, { envVar: 'TEST_CFG' });
      const second = generateFuzzArgs(name, 2026, 20, { envVar: 'TEST_CFG' });
      expect(first.length).toBe(20);
      expect(first).toEqual(second);
    }
  });

  test('parseFuzzArgs 允许负整数 --seed 且支持 --all-products', () => {
    const neg = parseFuzzArgs(['--seed', '-42', '--all-products']);
    expect(neg.ok).toBe(true);
    if (neg.ok) {
      expect(neg.options.seed).toBe(-42);
      expect(neg.options.allProducts).toBe(true);
    }
  });

  test('运行器参数互斥校验: 拒绝 --all-products 与显式单产品参数混用, 保留 fuzz:diff 合法组合', () => {
    // 1. run-diff-fuzz: 拦截 --all-products + --targets, 放行 --all-products + --api-target
    const badFuzz = parseFuzzArgs(['--all-products', '--targets', 'x.json']);
    expect(badFuzz.ok).toBe(false);
    expect(runDiffFuzzCli(['--all-products', '--targets', 'x.json'])).toBe(2);

    const validDiff = parseFuzzArgs([
      '--all-products',
      '--api-target',
      'node scripts/transcription/api-harness.ts',
    ]);
    expect(validDiff.ok).toBe(true);

    // 2. run-conformance: 拦截 --all-products 与 --target / --api-target / --corpus 混用并退 2
    expect(
      parseConformanceArgs(['--all-products', '--target', 'bun x.ts']).ok,
    ).toBe(false);
    expect(
      parseConformanceArgs(['--all-products', '--api-target', 'bun h.ts']).ok,
    ).toBe(false);
    expect(
      parseConformanceArgs(['--all-products', '--corpus', 'some/dir']).ok,
    ).toBe(false);

    const conformanceEntry = join(
      dirname(fileURLToPath(import.meta.url)),
      'run-conformance.ts',
    );
    const proc = spawnSync(
      'bun',
      [conformanceEntry, '--all-products', '--target', 'bun x.ts'],
      { encoding: 'utf8' },
    );
    expect(proc.status).toBe(2);
  });

  test('resolveProductHarnessArgv 对仓内 api-harness.ts 自动补 --product 且不污染外部或显式 argv', () => {
    const fakeHarness = '/repo/scripts/transcription/api-harness.ts';
    expect(
      resolveProductHarnessArgv(
        ['node', fakeHarness],
        'packages/demo-api',
        fakeHarness,
      ),
    ).toEqual(['node', fakeHarness, '--product', 'packages/demo-api']);
    expect(
      resolveProductHarnessArgv(
        ['node', 'scripts/transcription/api-harness.ts'],
        'packages/demo-api',
        fakeHarness,
      ),
    ).toEqual([
      'node',
      'scripts/transcription/api-harness.ts',
      '--product',
      'packages/demo-api',
    ]);
    expect(
      resolveProductHarnessArgv(
        ['node', fakeHarness, '--product', 'packages/custom'],
        'packages/demo-api',
        fakeHarness,
      ),
    ).toEqual(['node', fakeHarness, '--product', 'packages/custom']);
    expect(
      resolveProductHarnessArgv(
        ['/tmp/rust-api-harness'],
        'packages/demo-api',
        fakeHarness,
      ),
    ).toEqual(['/tmp/rust-api-harness']);
    expect(resolveProductHarnessArgv(undefined, 'packages/demo-api')).toBe(
      undefined,
    );
  });

  test('canonicalJson 与 comparableOutcome 忽略对象键序差异', () => {
    expect(canonicalJson({ b: 1, a: { y: 2, x: 3 } })).toBe(
      canonicalJson({ a: { x: 3, y: 2 }, b: 1 }),
    );
    expect(comparableOutcome({ ok: true, value: { z: 1, a: 2 } })).toBe(
      comparableOutcome({ ok: true, value: { a: 2, z: 1 } }),
    );
    expect(
      comparableOutcome({
        ok: false,
        error: {
          name: 'CustomError',
          code: 'E_BAD',
          message: '中文差异不误伤',
        },
      }),
    ).toBe(
      comparableOutcome({
        ok: false,
        error: { name: 'CustomError', code: 'E_BAD', message: 'english msg' },
      }),
    );
  });

  test('checkInvariants 准确检出裸控制字符、bidi 与换行符', () => {
    expect(
      checkInvariants({ ok: true, value: 'ok text' }, [
        'ok-string',
        'non-empty-string',
        'no-control-chars',
        'no-newlines',
      ]),
    ).toEqual([]);
    const bad = checkInvariants({ ok: true, value: 'bad\u202e\nline' }, [
      'no-control-chars',
      'no-newlines',
    ]);
    expect(bad.length).toBe(2);
  });
});

describe('runDiffFuzzCli 端到端编排与降级', () => {
  test('双目标批量模式全绿 + 单步最小 harness 自动降级通过', () => {
    const root = makeTmpRoot('diff-fuzz-ok-');
    createdRoots.push(root);
    const refHarness = writeMockHarness(root, 'ref.mjs', {
      supportBatch: true,
    });
    const singleOnlyHarness = writeMockHarness(root, 'single.mjs', {
      supportBatch: false,
    });
    const configPath = join(root, 'fuzz-targets.json');
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            id: 'clean-text',
            export: 'clean',
            generator: 'dirty-line',
            invariants: [
              'ok-string',
              'no-control-chars',
              'no-newlines',
              'idempotent',
            ],
          },
        ],
      }),
      'utf8',
    );

    // 1. 批量参考 vs 批量被测
    const batchExit = runDiffFuzzCli([
      '--targets',
      configPath,
      '--reference-target',
      `bun ${refHarness}`,
      '--api-target',
      `bun ${refHarness}`,
      '--cases',
      '15',
      '--seed',
      '101',
    ]);
    expect(batchExit).toBe(0);

    // 2. 批量参考 vs 仅支持单步的外部最小 harness (auto 降级 single)
    const fallbackExit = runDiffFuzzCli([
      '--targets',
      configPath,
      '--reference-target',
      `bun ${refHarness}`,
      '--api-target',
      `bun ${singleOnlyHarness}`,
      '--cases',
      '8',
      '--seed',
      '101',
    ]);
    expect(fallbackExit).toBe(0);
  });

  test('检出差分偏差 / 不变量违例 / 破坏幂等时退 1 并落盘 FUZZ_FAILURES.md', () => {
    const root = makeTmpRoot('diff-fuzz-fail-');
    createdRoots.push(root);
    const refHarness = writeMockHarness(root, 'ref.mjs', {
      supportBatch: true,
    });
    const buggyHarness = writeMockHarness(root, 'buggy.mjs', {
      supportBatch: true,
      buggyClean: true,
      nonIdempotent: true,
    });
    const configPath = join(root, 'fuzz-targets.json');
    const emitDir = join(root, 'emitted');
    writeFileSync(
      configPath,
      JSON.stringify({
        schemaVersion: 1,
        targets: [
          {
            id: 'clean-text',
            export: 'clean',
            generator: 'dirty-line',
            invariants: ['no-control-chars', 'idempotent'],
          },
        ],
      }),
      'utf8',
    );

    const exit = runDiffFuzzCli([
      '--targets',
      configPath,
      '--reference-target',
      `bun ${refHarness}`,
      '--api-target',
      `bun ${buggyHarness}`,
      '--cases',
      '15',
      '--seed',
      '7',
      '--emit-failures',
      emitDir,
    ]);
    expect(exit).toBe(1);
    const diagPath = join(emitDir, 'FUZZ_FAILURES.md');
    expect(existsSync(diagPath)).toBe(true);
    const content = readFileSync(diagPath, 'utf8');
    expect(content).toContain('# 差分模糊测试失败诊断单');
    expect(content).toContain('参考实现与被测实现输出不一致');
    expect(content).toContain('违反 idempotent');
  });
});
