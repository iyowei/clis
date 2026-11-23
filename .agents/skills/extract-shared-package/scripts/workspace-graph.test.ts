import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { lintExtractedPackage } from './package-lint.ts';
import {
  buildWorkspaceGraph,
  simulateNewLibraryExtraction,
} from './workspace-graph.ts';

const tmpRoots: string[] = [];

function makeSandboxRepo(files: Record<string, unknown>): string {
  const home = process.env.HOME ?? process.env.USERPROFILE ?? '.';
  const dir = join(
    home,
    'tmp',
    `extract-graph-test-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpRoots.push(dir);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(dir, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(
      abs,
      typeof content === 'string' ? content : JSON.stringify(content, null, 2),
      'utf8',
    );
  }
  return dir;
}

afterAll(() => {
  for (const dir of tmpRoots) {
    rmSync(dir, { recursive: true, force: true });
  }
});

describe('workspace-graph 四类依赖扫描与运行期私库禁令', () => {
  test('扫描四类依赖并区分运行期与 devDependencies; 拦截公开库及待首发双包主包运行期依赖 private-lib', () => {
    const repo = makeSandboxRepo({
      'package.json': {
        name: 'dep-align',
        private: true,
        workspaces: ['packages/*'],
      },
      'packages/priv-shared/package.json': {
        name: '@demo/priv-shared',
        private: true,
        clisRole: 'shared-lib',
      },
      'packages/pub-bad-peer/package.json': {
        name: '@demo/pub-bad-peer',
        peerDependencies: { '@demo/priv-shared': '1.0.0' },
      },
      'packages/pub-bad-opt/package.json': {
        name: '@demo/pub-bad-opt',
        optionalDependencies: { '@demo/app-cli': '1.0.0' },
      },
      'packages/pub-ok-dev/package.json': {
        name: '@demo/pub-ok-dev',
        devDependencies: { '@demo/priv-shared': '1.0.0' },
      },
      'packages/prod-api/package.json': {
        name: '@demo/prod-api',
        private: true,
        dependencies: { '@demo/priv-shared': '1.0.0' },
      },
      'packages/prod-api-cli/package.json': {
        name: '@demo/prod-api-cli',
        private: true,
        bin: { prod: 'bin/prod.mjs' },
        devDependencies: {
          '@demo/prod-api': '1.0.0',
          '@demo/priv-shared': '1.0.0',
        },
      },
      'packages/app-cli/package.json': {
        name: '@demo/app-cli',
        bin: { app: 'bin/app.mjs' },
      },
    });

    const graph = buildWorkspaceGraph(repo);
    const prodApiNode = graph.packages.find(
      (p) => p.name === '@demo/prod-api',
    )!;
    const privNode = graph.packages.find(
      (p) => p.name === '@demo/priv-shared',
    )!;
    expect(prodApiNode.isPublicTierLib).toBe(true);
    expect(privNode.isPublicTierLib).toBe(false);
    expect(prodApiNode.runtimeInternalDeps).toEqual(['@demo/priv-shared']);

    expect(
      graph.existingViolations.some(
        (v) =>
          v.includes('@demo/pub-bad-peer') &&
          v.includes('运行期依赖仓内私有库'),
      ),
    ).toBe(true);
    expect(
      graph.existingViolations.some(
        (v) =>
          v.includes('@demo/prod-api') && v.includes('运行期依赖仓内私有库'),
      ),
    ).toBe(true);
    expect(
      graph.existingViolations.some(
        (v) => v.includes('@demo/pub-bad-opt') && v.includes('反向依赖 CLI'),
      ),
    ).toBe(true);
    expect(
      graph.existingViolations.some((v) => v.includes('@demo/pub-ok-dev')),
    ).toBe(false);
  });
});

describe('workspace-graph 公开库层级深度 2 检测与模拟预审', () => {
  test('暂标 private: true 的双包 API 主包计入公开库依赖链最大深度 2 检测, 而 shared-lib 不计入', () => {
    const repo = makeSandboxRepo({
      'package.json': {
        name: 'depth-align',
        private: true,
        workspaces: ['packages/*'],
      },
      'packages/l0/package.json': { name: '@demo/l0' },
      'packages/l1/package.json': {
        name: '@demo/l1',
        dependencies: { '@demo/l0': '1.0.0' },
      },
      'packages/l2/package.json': {
        name: '@demo/l2',
        dependencies: { '@demo/l1': '1.0.0' },
      },
      'packages/prod/package.json': {
        name: '@demo/prod',
        private: true,
        dependencies: { '@demo/l2': '1.0.0' },
      },
      'packages/prod-cli/package.json': {
        name: '@demo/prod-cli',
        private: true,
        bin: { prod: 'bin/prod.mjs' },
        devDependencies: { '@demo/prod': '1.0.0' },
      },
      'packages/internal-helper/package.json': {
        name: '@demo/internal-helper',
        private: true,
        clisRole: 'shared-lib',
        dependencies: { '@demo/l2': '1.0.0' },
      },
    });

    const graph = buildWorkspaceGraph(repo);
    expect(graph.existingViolations).toHaveLength(1);
    expect(graph.existingViolations[0]).toContain('公开库依赖链深度超过 2');
    expect(graph.existingViolations[0]).toContain(
      '@demo/prod → @demo/l2 → @demo/l1 → @demo/l0',
    );

    const cleanRepo = makeSandboxRepo({
      'package.json': {
        name: 'sim-align',
        private: true,
        workspaces: ['packages/*'],
      },
      'packages/prod/package.json': { name: '@demo/prod', private: true },
      'packages/prod-cli/package.json': {
        name: '@demo/prod-cli',
        private: true,
        bin: { prod: 'bin/prod.mjs' },
        devDependencies: { '@demo/prod': '1.0.0' },
      },
    });
    const cleanGraph = buildWorkspaceGraph(cleanRepo);
    expect(
      simulateNewLibraryExtraction(
        cleanGraph,
        '@demo/new-priv',
        'private-lib',
        ['@demo/prod'],
        [],
      ),
    ).toEqual([]);
    expect(
      simulateNewLibraryExtraction(
        cleanGraph,
        '@demo/new-priv',
        'private-lib',
        ['@demo/prod'],
        [],
        'runtime',
      ).some((v) => v.includes('运行期依赖仓内私有库')),
    ).toBe(true);
  });
});

describe('package-lint 消费方运行期私库拦截联动', () => {
  test('package-lint 同步拦截双包 API 主包在运行期 dependencies 引用新抽离私库, 改为 devDependencies 后放行', () => {
    const repo = makeSandboxRepo({
      'package.json': {
        name: 'pkg-lint-deps',
        private: true,
        workspaces: ['packages/*'],
      },
      'tsconfig.json': {
        compilerOptions: {
          paths: { '@demo/str-width': ['./packages/str-width/src/index.ts'] },
        },
      },
      'node_modules/@demo/str-width/package.json': { name: '@demo/str-width' },
      'packages/prod/package.json': {
        name: '@demo/prod',
        version: '1.0.0',
        private: true,
        dependencies: { '@demo/str-width': '1.0.0' },
      },
      'packages/prod-cli/package.json': {
        name: '@demo/prod-cli',
        version: '1.0.0',
        private: true,
        bin: { prod: 'bin/prod.mjs' },
        devDependencies: { '@demo/prod': '1.0.0' },
      },
      'packages/str-width/package.json': {
        name: '@demo/str-width',
        version: '1.0.0',
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
      },
      'packages/str-width/tsconfig.build.json': {
        compilerOptions: { paths: {}, noEmitOnError: true },
      },
      'packages/str-width/README.md': '# @demo/str-width\nWidth.\n',
      'packages/str-width/src/index.ts': 'export const w = 1;\n',
      'packages/str-width/src/index.test.ts': 'export {};\n',
    });

    const badLint = lintExtractedPackage(
      repo,
      buildWorkspaceGraph(repo),
      'packages/str-width',
    );
    expect(badLint.passed).toBe(false);
    expect(
      badLint.violations.some((v) => v.includes('运行期依赖仓内私有库')),
    ).toBe(true);

    writeFileSync(
      join(repo, 'packages/prod/package.json'),
      JSON.stringify({
        name: '@demo/prod',
        version: '1.0.0',
        private: true,
        devDependencies: { '@demo/str-width': '1.0.0' },
      }),
    );
    const okLint = lintExtractedPackage(
      repo,
      buildWorkspaceGraph(repo),
      'packages/str-width',
    );
    expect(okLint.passed).toBe(true);
  });

  test('本仓真实共享私库 packages/cli-updater 100% 通过 lintExtractedPackage 自证', () => {
    const realRepoRoot = join(import.meta.dir, '../../../..');
    const realGraph = buildWorkspaceGraph(realRepoRoot);
    const res = lintExtractedPackage(
      realRepoRoot,
      realGraph,
      'packages/cli-updater',
    );
    expect(res).toEqual({ passed: true, violations: [] });
  });
});
