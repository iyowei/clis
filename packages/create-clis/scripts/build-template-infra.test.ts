/**
 * 模板快照构建自检与 infra 作用域隔离单测:
 * 覆盖泛化零残留自检、清单完整性自检、禁词/排除包短名边界与 leakScope=infra 隔离 (分文件以守 max-lines 门禁)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
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

const FIXTURE_MANIFEST: readonly ManifestEntry[] = [
  { path: 'conf/a.conf', disposition: 'snapshot' },
  { path: 'demo-app.json', disposition: 'generalize' },
  { path: 'README.md', disposition: 'reset', note: '夹具: 换骨架' },
  { path: 'src/', disposition: 'exclude', note: '夹具: 不进模板' },
];

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

const setupFixture = (): {
  repoRoot: string;
  skeletonRoot: string;
  outDir: string;
} => {
  const root = makeTmpRoot('create-clis-guard-');
  createdRoots.push(root);
  const repoRoot = join(root, 'repo');
  const skeletonRoot = join(root, 'skeletons');
  const outDir = join(root, 'assets', 'template');
  mkdirSync(join(repoRoot, 'conf'), { recursive: true });
  mkdirSync(join(repoRoot, 'src'), { recursive: true });
  writeFileSync(join(repoRoot, 'conf/a.conf'), 'keep = byte-identical\n');
  writeFileSync(
    join(repoRoot, 'demo-app.json'),
    `${JSON.stringify({
      name: '@demo/demo-app',
      bin: 'da',
      author: 'DemoAuthor',
      url: 'https://github.com/demo/kit',
      slug: 'demo/kit',
    })}\n`,
  );
  writeFileSync(join(repoRoot, 'README.md'), '# 原 README (不复用)\n');
  writeFileSync(join(repoRoot, 'src/x.ts'), 'export const x = 1;\n');
  mkdirSync(dirname(join(skeletonRoot, 'README.md')), { recursive: true });
  writeFileSync(
    join(skeletonRoot, 'README.md'),
    '# {{NAME}}\n\n由 {{REPO_URL}} 生成。\n',
  );
  return { repoRoot, skeletonRoot, outDir };
};

const fixtureOpts = (
  base: ReturnType<typeof setupFixture>,
  manifest: readonly ManifestEntry[] = FIXTURE_MANIFEST,
) => ({
  repoRoot: base.repoRoot,
  outDir: base.outDir,
  original: FIXTURE_ORIGINAL,
  manifest,
  skeletonRoot: base.skeletonRoot,
});

describe('构建自检: 任一不过即抛错', () => {
  test('泛化零残留自检: snapshot 内容残留原词汇即抛错', () => {
    const base = setupFixture();
    writeFileSync(join(base.repoRoot, 'conf/a.conf'), 'name=demo-app\n');
    expect(() => buildTemplate(fixtureOpts(base))).toThrow(/残留/);
  });

  test('泛化零残留自检: 骨架内容残留原词汇即抛错', () => {
    const base = setupFixture();
    writeFileSync(join(base.skeletonRoot, 'README.md'), '# demo-app\n');
    expect(() => buildTemplate(fixtureOpts(base))).toThrow(/残留/);
  });

  test('泛化零残留自检先于写盘: 失败时不破坏既有旧产物', () => {
    const base = setupFixture();
    const options = fixtureOpts(base);
    buildTemplate(options);
    const sentinelPath = join(base.outDir, 'existing-good.txt');
    writeFileSync(sentinelPath, 'kept-intact\n');

    writeFileSync(join(base.repoRoot, 'conf/a.conf'), 'name=demo-app\n');
    expect(() => buildTemplate(options)).toThrow(/残留/);
    expect(existsSync(sentinelPath)).toBe(true);
    expect(readFileSync(sentinelPath, 'utf8')).toBe('kept-intact\n');
  });

  test('清单完整性自检: 源文件缺失即抛错', () => {
    const base = setupFixture();
    rmSync(join(base.repoRoot, 'demo-app.json'));
    expect(() => buildTemplate(fixtureOpts(base))).toThrow(/demo-app\.json/);
  });

  test('清单完整性自检: 骨架缺失即抛错', () => {
    const base = setupFixture();
    rmSync(join(base.skeletonRoot, 'README.md'));
    expect(() => buildTemplate(fixtureOpts(base))).toThrow(/骨架/);
  });

  test('清单完整性自检: 产出路径撞车即抛错', () => {
    const base = setupFixture();
    writeFileSync(join(base.repoRoot, '{{NAME}}.json'), '{}\n');
    const manifest: readonly ManifestEntry[] = [
      { path: 'demo-app.json', disposition: 'generalize' },
      { path: '{{NAME}}.json', disposition: 'generalize' },
    ];
    expect(() => buildTemplate(fixtureOpts(base, manifest))).toThrow(/重复/);
  });

  test('禁词与排除包短名边界自检: 拦截 sweep-lab / docs/sweep/ 与排除包短名, 不误伤超集词', () => {
    const manifestWithExcluded: readonly ManifestEntry[] = [
      ...FIXTURE_MANIFEST,
      { path: 'packages/secret/', disposition: 'exclude', note: '私有包' },
    ];
    for (const leaked of [
      'user=sweep-lab\n',
      'see docs/sweep/guide.md\n',
      'cli: secret --help\n',
    ]) {
      const base = setupFixture();
      writeFileSync(join(base.repoRoot, 'conf/a.conf'), leaked);
      expect(() =>
        buildTemplate({
          repoRoot: base.repoRoot,
          outDir: base.outDir,
          original: FIXTURE_ORIGINAL,
          manifest: manifestWithExcluded,
          skeletonRoot: base.skeletonRoot,
        }),
      ).toThrow(/泄漏本仓/);
    }
    const clean = setupFixture();
    writeFileSync(join(clean.repoRoot, 'conf/a.conf'), 'mode=secretive\n');
    expect(() =>
      buildTemplate({
        repoRoot: clean.repoRoot,
        outDir: clean.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: manifestWithExcluded,
        skeletonRoot: clean.skeletonRoot,
      }),
    ).not.toThrow();
  });
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
