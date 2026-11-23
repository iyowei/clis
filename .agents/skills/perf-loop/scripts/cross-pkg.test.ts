/**
 * --allow-cross-pkg 双包产品协同作用域端到端单元测试:
 * 覆盖双包基线/候选快照、A/B 交替切换与依赖重构建、双包联动门禁校验、REVERT/recover 全回滚及无关包越界拦截。
 */
import { describe, expect, test } from 'bun:test';

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
import { runEvaluateCommand, runRecoverCommand } from './evaluator.ts';
import { runPrepareCommand } from './planner.ts';

const HOST_REPO_ROOT = resolve(import.meta.dir, '..', '..', '..', '..');

const BASELINE_CORE_SRC = `export function computeScore(items: number[], probes: number[]): number {
  let hits = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (probes.includes(items[i]!)) hits += 1;
  }
  return hits;
}
`;

const BASELINE_CLI_SRC = `import { computeScore } from '../../core/dist/index.js';
export function runCliBatch(items: number[], probes: number[]): number {
  return computeScore(items, probes);
}
`;

function createCrossPkgRepo(): { root: string; tmpBase: string } {
  const root = makeTmpRoot('perf-loop-cross-');
  const tmpBase = join(root, '.perf-runs');
  for (const rel of [
    'packages/core/src',
    'packages/core-cli/src',
    'packages/core-cli/bench',
    'packages/unrelated/src',
  ]) {
    mkdirSync(join(root, rel), { recursive: true });
  }
  symlinkSync(join(HOST_REPO_ROOT, 'node_modules'), join(root, 'node_modules'));

  writeFileSync(
    join(root, 'package.json'),
    '{"name":"cross-mono","private":true,"workspaces":["packages/*"]}',
  );
  writeFileSync(
    join(root, 'packages/core/package.json'),
    JSON.stringify({
      name: '@cross/core',
      version: '1.0.0',
      private: true,
      type: 'module',
      main: './dist/index.js',
      exports: { '.': { default: './dist/index.js' } },
      scripts: {
        build: 'bun build src/index.ts --target=node --outfile=dist/index.js',
        check: 'bun --version',
        test: 'bun test',
      },
    }),
  );
  writeFileSync(join(root, 'packages/core/src/index.ts'), BASELINE_CORE_SRC);
  writeFileSync(
    join(root, 'packages/core/src/index.test.ts'),
    `import { expect, test } from 'bun:test';
import { computeScore } from './index.ts';
test('core', () => expect(computeScore([1, 2, 3], [2, 4])).toBe(1));
`,
  );

  writeFileSync(
    join(root, 'packages/core-cli/package.json'),
    JSON.stringify({
      name: '@cross/core-cli',
      version: '1.0.0',
      private: true,
      type: 'module',
      bin: { 'core-cli': 'bin/cli.mjs' },
      devDependencies: { '@cross/core': '1.0.0' },
      scripts: {
        bench: 'bun bench/run.ts',
        check: 'bun --version',
        test: 'bun test',
      },
    }),
  );
  writeFileSync(join(root, 'packages/core-cli/src/cli.ts'), BASELINE_CLI_SRC);
  writeFileSync(
    join(root, 'packages/core-cli/src/cli.test.ts'),
    `import { expect, test } from 'bun:test';
import { runCliBatch } from './cli.ts';
test('cli', () => expect(runCliBatch([10, 20], [20])).toBe(1));
`,
  );
  writeFileSync(
    join(root, 'packages/core-cli/bench/run.ts'),
    `import { runCliBatch } from '../src/cli.ts';
const jsonFlag = process.argv.includes('--json');
const arrA = Array.from({ length: 4200 }, (_, i) => i * 2);
const arrB = Array.from({ length: 4200 }, (_, i) => i * 3);
runCliBatch(arrA, arrB);
const samplesMs: number[] = [];
let digestVal = 0;
for (let i = 0; i < 5; i += 1) {
  const t0 = performance.now();
  digestVal = runCliBatch(arrA, arrB);
  samplesMs.push(performance.now() - t0);
}
const sorted = [...samplesMs].sort((a, b) => a - b);
const isBun = typeof Bun !== 'undefined';
if (jsonFlag) {
  process.stdout.write(JSON.stringify({
    schemaVersion: 1,
    package: '@cross/core-cli',
    runtime: isBun ? 'bun' : 'node',
    runtimeVersion: isBun ? Bun.version : process.version.replace(/^v/, ''),
    suite: 'quick',
    cases: [{
      name: 'cli-batch',
      role: 'primary',
      iterations: samplesMs.length,
      samplesMs,
      minMs: sorted[0] ?? 0,
      medianMs: sorted[Math.floor(sorted.length / 2)] ?? 0,
      p95Ms: sorted[sorted.length - 1] ?? 0,
      digest: String(digestVal),
    }],
  }) + '\\n');
}
`,
  );
  writeFileSync(
    join(root, 'packages/unrelated/package.json'),
    '{"name":"@cross/unrelated","version":"1.0.0"}',
  );
  writeFileSync(
    join(root, 'packages/unrelated/src/stay.ts'),
    'export const untouched = 1;\n',
  );
  writeFileSync(
    join(root, '.gitignore'),
    'node_modules\ndist\n.perf-runs\n**/bench/ledger\n',
  );

  const initBuild = spawnSync('bun', ['run', 'build'], {
    cwd: join(root, 'packages/core'),
    encoding: 'utf8',
  });
  expect(initBuild.status).toBe(0);
  spawnSync('git', ['init'], { cwd: root });
  spawnSync('git', ['add', '.'], { cwd: root });
  return { root, tmpBase };
}

describe('--allow-cross-pkg REVERT、recover 与无关包越界防护', () => {
  test('双包改动触发 REVERT 或 recover 时完整回滚双包源码、新增文件与 dist, 且拦截第 3 包越界修改', () => {
    const { root, tmpBase } = createCrossPkgRepo();
    try {
      const prep1 = runPrepareCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        suite: 'quick',
      });
      writeFileSync(
        join(root, 'packages/core/src/index.ts'),
        'export function computeScore(): number { return 999999; }\n',
      );
      writeFileSync(
        join(root, 'packages/core/src/temp-helper.ts'),
        'export const orphan = true;\n',
      );
      writeFileSync(
        join(root, 'packages/core-cli/src/cli.ts'),
        `${BASELINE_CLI_SRC}// mutated\n`,
      );

      const revOut = runEvaluateCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        runId: prep1.runId!,
        proposal: 'broken cross-pkg change',
        dimension: 'arch',
        expectedTier: 'P0',
        rationale: 'verify full dual-pkg rollback',
        allowCrossPkg: true,
        cycles: 1,
      });
      expect(revOut.record.verdict).toBe('REVERT');
      expect(revOut.record.failureReason).toBe('CORRECTNESS_FAIL');
      expect(
        readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8'),
      ).toBe(BASELINE_CORE_SRC);
      expect(existsSync(join(root, 'packages/core/src/temp-helper.ts'))).toBe(
        false,
      );
      expect(
        readFileSync(join(root, 'packages/core-cli/src/cli.ts'), 'utf8'),
      ).toBe(BASELINE_CLI_SRC);
      expect(
        readFileSync(join(root, 'packages/core/dist/index.js'), 'utf8'),
      ).not.toContain('999999');

      // 即使开启 --allow-cross-pkg, 触碰双包产品对之外的 packages/unrelated 仍触发 POLICY_VIOLATION
      const prep2 = runPrepareCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        suite: 'quick',
      });
      writeFileSync(
        join(root, 'packages/core/src/index.ts'),
        `// touched\n${BASELINE_CORE_SRC}`,
      );
      writeFileSync(
        join(root, 'packages/unrelated/src/stay.ts'),
        'export const untouched = 2;\n',
      );
      const policyOut = runEvaluateCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        runId: prep2.runId!,
        proposal: 'touch third package',
        dimension: 'arch',
        expectedTier: 'P1',
        rationale: 'test scope isolation',
        allowCrossPkg: true,
        cycles: 1,
      });
      expect(policyOut.record.verdict).toBe('REVERT');
      expect(policyOut.record.failureReason).toBe('POLICY_VIOLATION');
      expect(
        readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8'),
      ).toBe(BASELINE_CORE_SRC);

      // recover 同步恢复双包基线
      const prep3 = runPrepareCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        suite: 'quick',
      });
      writeFileSync(join(root, 'packages/core/src/index.ts'), '// dirty\n');
      writeFileSync(join(root, 'packages/core-cli/src/cli.ts'), '// dirty\n');
      const recoverMsg = runRecoverCommand(root, tmpBase, prep3.runId!);
      expect(recoverMsg).toContain('packages/core');
      expect(
        readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8'),
      ).toBe(BASELINE_CORE_SRC);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});

describe('--allow-cross-pkg 双包 A/B 交替切换与重跑构建 KEEP 留存', () => {
  test('同步切换 core + core-cli 快照并在每轮重跑依赖 build, 准确测得 P0 KEEP 并保留双包变更', () => {
    const { root, tmpBase } = createCrossPkgRepo();
    try {
      const prep = runPrepareCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        suite: 'quick',
      });
      const fastCoreSrc = `export function computeScoreSet(items: number[], probeSet: ReadonlySet<number>): number {
  let hits = 0;
  for (let i = 0; i < items.length; i += 1) {
    if (probeSet.has(items[i]!)) hits += 1;
  }
  return hits;
}
export function computeScore(items: number[], probes: number[]): number {
  return computeScoreSet(items, new Set(probes));
}
`;
      const fastCliSrc = `import { computeScoreSet } from '../../core/dist/index.js';
export function runCliBatch(items: number[], probes: number[]): number {
  return computeScoreSet(items, new Set(probes));
}
`;
      writeFileSync(join(root, 'packages/core/src/index.ts'), fastCoreSrc);
      writeFileSync(join(root, 'packages/core-cli/src/cli.ts'), fastCliSrc);

      const keepOut = runEvaluateCommand({
        repoRoot: root,
        tmpBase,
        pkgHint: '@cross/core-cli',
        runId: prep.runId!,
        proposal: 'Cross-pkg Set prebuild lookup between core and core-cli',
        dimension: 'arch',
        expectedTier: 'P0',
        rationale: 'Eliminate O(N*M) array scan across API/CLI boundary',
        allowCrossPkg: true,
        cycles: 2,
      });
      expect(keepOut.record.verdict).toBe('KEEP');
      expect(keepOut.record.measuredTier).toBe('P0');
      expect(keepOut.record.touchedFiles).toContain('src/cli.ts');
      expect(keepOut.record.touchedFiles).toContain(
        'packages/core/src/index.ts',
      );
      expect(
        readFileSync(join(root, 'packages/core/src/index.ts'), 'utf8'),
      ).toBe(fastCoreSrc);
      expect(
        readFileSync(join(root, 'packages/core-cli/src/cli.ts'), 'utf8'),
      ).toBe(fastCliSrc);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
