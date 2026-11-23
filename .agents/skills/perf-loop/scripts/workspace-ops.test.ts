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
import { initBenchForPackage } from './init-bench.ts';
import {
  buildIsolatedHomeEnv,
  buildPackageSourceMap,
  checkPolicyViolations,
  computeBenchDirHashes,
  computeOutsideScopeDigest,
  diffSnapshotFiles,
  discoverTargetPackages,
  prepareIsolatedHome,
  restorePackageSnapshot,
  runPackageValidationGates,
  savePackageSnapshot,
  shouldRebuildPackageDist,
} from './workspace-ops.ts';

function makeTempRepo(): string {
  const root = makeTmpRoot('perf-loop-test-');
  mkdirSync(join(root, 'packages', 'demo', 'src'), { recursive: true });
  mkdirSync(join(root, 'packages', 'other', 'src'), { recursive: true });
  writeFileSync(
    join(root, 'package.json'),
    JSON.stringify({ name: 'test-mono', workspaces: ['packages/*'] }),
  );
  writeFileSync(
    join(root, 'packages', 'demo', 'package.json'),
    JSON.stringify({ name: '@test/demo', scripts: { test: 'bun test' } }),
  );
  writeFileSync(
    join(root, 'packages', 'other', 'package.json'),
    JSON.stringify({ name: '@test/other', scripts: { test: 'bun test' } }),
  );
  writeFileSync(
    join(root, 'packages', 'demo', 'tsconfig.json'),
    JSON.stringify({ include: ['src'] }),
  );
  writeFileSync(
    join(root, 'packages', 'demo', 'src', 'index.ts'),
    'export function runFast(n: number): number { return n; }\n',
  );
  writeFileSync(
    join(root, 'packages', 'other', 'src', 'keep.ts'),
    'export const dirty = "untouched";\n',
  );
  return root;
}

describe('workspace-ops 快照隔离、stub 拦截与源码地图', () => {
  test('snapshot / restore 精确回退目标包且不碰其它包', () => {
    const root = makeTempRepo();
    const snapBase = join(root, '.tmp-snap-base');
    const snapCand = join(root, '.tmp-snap-cand');
    try {
      savePackageSnapshot(root, 'packages/demo', snapBase);
      writeFileSync(
        join(root, 'packages', 'demo', 'src', 'index.ts'),
        'export const val = 2;\n',
      );
      writeFileSync(
        join(root, 'packages', 'demo', 'src', 'extra.ts'),
        'export const added = true;\n',
      );
      savePackageSnapshot(root, 'packages/demo', snapCand);

      const diffs = diffSnapshotFiles(snapBase, snapCand);
      expect(diffs).toEqual(['src/extra.ts', 'src/index.ts']);

      restorePackageSnapshot(root, 'packages/demo', snapBase);
      expect(
        readFileSync(join(root, 'packages', 'demo', 'src', 'index.ts'), 'utf8'),
      ).toContain('runFast');
      expect(
        existsSync(join(root, 'packages', 'demo', 'src', 'extra.ts')),
      ).toBe(false);
      expect(
        readFileSync(join(root, 'packages', 'other', 'src', 'keep.ts'), 'utf8'),
      ).toBe('export const dirty = "untouched";\n');

      const map = buildPackageSourceMap(root, 'packages/demo');
      expect(map).toEqual([
        { file: 'src/index.ts', lines: 2, exports: ['runFast'] },
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('initBenchForPackage 生成的 stub 被探测拦截直到去掉 @perf-loop:stub 才就绪', () => {
    const root = makeTempRepo();
    try {
      const res = initBenchForPackage(root, 'packages/demo', '@test/demo');
      expect(res.createdFiles).toEqual(['packages/demo/bench/run.ts']);

      const [before] = discoverTargetPackages(root, '@test/demo');
      expect(before?.isStubBench).toBe(true);
      expect(before?.supportsJsonBench).toBe(false);

      const runFile = join(root, 'packages', 'demo', 'bench', 'run.ts');
      const cleaned = readFileSync(runFile, 'utf8').replace(
        /^\/\/.*@perf-loop:stub.*\n/m,
        '',
      );
      writeFileSync(runFile, cleaned, 'utf8');

      const [after] = discoverTargetPackages(root, '@test/demo');
      expect(after?.isStubBench).toBe(false);
      expect(after?.supportsJsonBench).toBe(true);

      const bunOut = spawnSync('bun', [runFile, '--json', '--quick'], {
        encoding: 'utf8',
      });
      expect(bunOut.status).toBe(0);
      const nodeOut = spawnSync('node', [runFile, '--json', '--quick'], {
        encoding: 'utf8',
      });
      expect(nodeOut.status).toBe(0);

      const baseHashes = computeBenchDirHashes(root, 'packages/demo');
      const outsideDigest = computeOutsideScopeDigest(root, 'packages/demo');
      expect(
        checkPolicyViolations({
          repoRoot: root,
          pkgDir: 'packages/demo',
          baselineBenchHashes: baseHashes,
          baselineOutsideDigest: outsideDigest,
          allowCrossPkg: false,
        }),
      ).toBeNull();
      expect(
        checkPolicyViolations({
          repoRoot: root,
          pkgDir: 'packages/demo',
          baselineBenchHashes: baseHashes,
          baselineOutsideDigest: 'changed-other-pkg',
          allowCrossPkg: false,
        }),
      ).toContain('未授权改动');
      expect(
        checkPolicyViolations({
          repoRoot: root,
          pkgDir: 'packages/demo',
          baselineBenchHashes: baseHashes,
          baselineOutsideDigest: 'changed-other-pkg',
          allowCrossPkg: true,
        }),
      ).toBeNull();
      writeFileSync(runFile, '// tampered\n', 'utf8');
      expect(
        checkPolicyViolations({
          repoRoot: root,
          pkgDir: 'packages/demo',
          baselineBenchHashes: baseHashes,
          baselineOutsideDigest: outsideDigest,
          allowCrossPkg: false,
        }),
      ).not.toBeNull();
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });

  test('prepareIsolatedHome / buildIsolatedHomeEnv 对齐 CI 隔离目录, 且单包已存在 dist/ 时验证前自动重跑 build', () => {
    const root = makeTempRepo();
    const fakeHome = join(root, '.isolated-home');
    try {
      prepareIsolatedHome(fakeHome);
      expect(existsSync(join(fakeHome, '.config', 'turborepo'))).toBe(true);
      expect(existsSync(join(fakeHome, '.config', 'vercel'))).toBe(true);
      expect(existsSync(join(fakeHome, 'AppData', 'Roaming'))).toBe(true);
      expect(existsSync(join(fakeHome, 'AppData', 'Local'))).toBe(true);

      const env = buildIsolatedHomeEnv(fakeHome, {});
      expect(env.HOME).toBe(fakeHome);
      expect(env.USERPROFILE).toBe(fakeHome);
      expect(env.XDG_CONFIG_HOME).toBe(join(fakeHome, '.config'));
      expect(env.APPDATA).toBe(join(fakeHome, 'AppData', 'Roaming'));
      expect(env.LOCALAPPDATA).toBe(join(fakeHome, 'AppData', 'Local'));
      expect(env.TURBO_CONFIG_DIR_PATH).toBe(
        join(fakeHome, '.config', 'turborepo'),
      );
      expect(env.VERCEL_CONFIG_DIR_PATH).toBe(
        join(fakeHome, '.config', 'vercel'),
      );

      const hostRepo = resolve(import.meta.dir, '..', '..', '..', '..');
      symlinkSync(join(hostRepo, 'node_modules'), join(root, 'node_modules'));
      const demoDir = join(root, 'packages', 'demo');
      writeFileSync(
        join(demoDir, 'package.json'),
        JSON.stringify({
          name: '@test/demo',
          type: 'module',
          scripts: {
            build:
              'bun build src/index.ts --target=node --outfile=dist/index.js',
            check: 'bun --version',
            test: 'bun test',
          },
        }),
      );
      writeFileSync(
        join(demoDir, 'src', 'index.ts'),
        'export function runFast(n: number): number { return n * 10; }\n',
      );
      writeFileSync(
        join(demoDir, 'src', 'smoke.test.ts'),
        `import { expect, test } from 'bun:test';
import { runFast } from '../dist/index.js';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
test('fresh dist + isolated home', () => {
  expect(runFast(3)).toBe(30);
  expect(existsSync(join(process.env.APPDATA!, '..'))).toBe(true);
  expect(process.env.TURBO_CONFIG_DIR_PATH).toContain('turborepo');
});
`,
      );

      // 未建 dist/ 前 shouldRebuildPackageDist 为 false
      expect(shouldRebuildPackageDist(root, 'packages/demo')).toBe(false);

      // 预置陈旧 dist/ 产物 (返回旧值 n * 1), 验证 runPackageValidationGates 会先 build 刷新 dist/
      mkdirSync(join(demoDir, 'dist'), { recursive: true });
      writeFileSync(
        join(demoDir, 'dist', 'index.js'),
        'export function runFast(n) { return n; }\n',
      );
      expect(shouldRebuildPackageDist(root, 'packages/demo')).toBe(true);

      const gateRes = runPackageValidationGates(root, 'packages/demo', [
        'src/index.ts',
      ]);
      expect(gateRes.ok, gateRes.output).toBe(true);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
