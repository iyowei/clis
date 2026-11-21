/**
 * infra 作用域排除包构建自检单测: 防止共享库社区短名误杀普通英文词, 同时严防完整 packages/<name> 路径泄漏。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import type { Vocabulary } from '../src/render.ts';
import { buildTemplate } from './build-template.ts';
import type { ManifestEntry } from './template-manifest.ts';

const FIXTURE_ORIGINAL: Vocabulary = {
  name: 'demo-app',
  scope: '@demo',
  binName: 'da',
  owner: 'demo',
  repoUrl: 'https://github.com/demo/kit',
  author: 'DemoAuthor',
};

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function setupInfraFixture(): {
  repoRoot: string;
  skeletonRoot: string;
  outDir: string;
  manifest: ManifestEntry[];
} {
  const root = makeTmpRoot('create-clis-infra-');
  createdRoots.push(root);
  const repoRoot = join(root, 'repo');
  const skeletonRoot = join(root, 'skeletons');
  const outDir = join(root, 'assets', 'template');
  mkdirSync(join(repoRoot, 'conf'), { recursive: true });
  mkdirSync(join(repoRoot, 'packages/spinner'), { recursive: true });
  writeFileSync(join(repoRoot, 'packages/spinner/index.ts'), 'export {};\n');
  mkdirSync(dirname(join(skeletonRoot, 'README.md')), { recursive: true });
  writeFileSync(join(skeletonRoot, 'README.md'), '# {{NAME}}\n');
  return {
    repoRoot,
    skeletonRoot,
    outDir,
    manifest: [
      { path: 'conf/a.conf', disposition: 'snapshot' },
      { path: 'README.md', disposition: 'reset', note: '骨架' },
      {
        path: 'packages/spinner/',
        disposition: 'exclude',
        note: '通用共享库',
        leakScope: 'infra',
      },
    ],
  };
}

describe('buildTemplate leakScope=infra 隔离自检', () => {
  test('不派生裸短名黑名单误杀英文注释词 spinner', () => {
    const base = setupInfraFixture();
    writeFileSync(
      join(base.repoRoot, 'conf/a.conf'),
      '// render terminal spinner while waiting\n',
    );
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: base.manifest,
        skeletonRoot: base.skeletonRoot,
      }),
    ).not.toThrow();
  });

  test('依然硬拦截 packages/spinner 完整路径泄漏', () => {
    const base = setupInfraFixture();
    writeFileSync(
      join(base.repoRoot, 'conf/a.conf'),
      'import from "packages/spinner/src/index.ts"\n',
    );
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: base.manifest,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/泄漏本仓/);
  });
});
