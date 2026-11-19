/**
 * @iyowei/codd (纯编程 API + 模板资产包) 资产构建、.d.ts 后处理与发布自证闸门单测。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';
import { buildCoddAssets, toPosixPath } from './build-assets.ts';
import {
  INTERNAL_DTS_FILES,
  pruneInternalDts,
  rewriteDtsSpecifiers,
} from './build.ts';
import {
  ASSET_DIR,
  ASSET_MANIFEST_FILE,
  ENTRY_FILE,
  PACKAGE_ROOT,
  PACK_FILES_BASE,
  type PackExpectation,
  type VerifyFacts,
  findDtsTsSpecifiers,
  judgePackFiles,
  judgeRelease,
  readPackExpectation,
  readPackFiles,
} from './release-artifact.ts';
import { collectFacts } from './verify-release.ts';

const SHA = 'e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855';
const HEAD = '0123456789abcdef0123456789abcdef01234567';

const STAGED_PACK: readonly string[] = [
  ...PACK_FILES_BASE,
  'assets/manifest.json',
  'assets/template/helm/Chart.yaml',
];

const EXPECTATION_OK: PackExpectation = { files: STAGED_PACK, issue: null };

const cleanDist = () => ({
  entryExists: true,
  entrySize: 128,
  entrySha256: SHA,
  manifestExists: true,
  manifest: {
    schemaVersion: 1,
    entry: ENTRY_FILE,
    entrySha256: SHA,
    commit: HEAD,
    dirty: false,
    builtAt: '2026-11-19T00:00:00.000Z',
  } as Record<string, unknown> | null,
  manifestIssue: null as string | null,
});

const validFacts = (): VerifyFacts => ({
  gitStatus: '',
  gitHead: HEAD,
  dist: cleanDist(),
  dtsTsSpecifierHits: [],
  pack: { files: [...STAGED_PACK], issue: null },
});

describe('模板资产构建与 .d.ts 后处理', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  });

  test('toPosixPath 统一反斜杠为 POSIX 分隔符, buildCoddAssets 转换隐藏载体并产出清单', () => {
    expect(toPosixPath('podman\\.env.tmpl')).toBe('podman/.env.tmpl');
    expect(toPosixPath('helm\\templates\\secret.yaml')).toBe(
      'helm/templates/secret.yaml',
    );

    const tmpPkg = mkdtempSync(join(tmpdir(), 'codd-api-assets-'));
    dirs.push(tmpPkg);
    mkdirSync(join(tmpPkg, 'template/podman'), { recursive: true });
    mkdirSync(join(tmpPkg, 'template/helm'), { recursive: true });
    writeFileSync(
      join(tmpPkg, 'template/podman/.dockerignore'),
      'node_modules\n',
    );
    writeFileSync(join(tmpPkg, 'template/podman/.env.tmpl'), 'PORT={{PORT}}\n');
    writeFileSync(join(tmpPkg, 'template/helm/.helmignore'), '*.tgz\n');
    writeFileSync(join(tmpPkg, 'template/helm/Chart.yaml'), 'name: mongodb\n');

    const emitted = buildCoddAssets(tmpPkg);
    expect(emitted).toEqual([
      'helm/Chart.yaml',
      'helm/_helmignore',
      'podman/_dockerignore',
      'podman/env.tmpl',
    ]);
    const exp = readPackExpectation(tmpPkg);
    expect(exp.issue).toBeNull();
    expect(exp.files).toContain('assets/template/podman/env.tmpl');
  });

  test('rewriteDtsSpecifiers 递归改写 from / import / import() 三类 .ts 扩展名', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codd-dts-'));
    dirs.push(dir);
    mkdirSync(join(dir, 'nested'), { recursive: true });
    writeFileSync(
      join(dir, 'index.d.ts'),
      [
        "export { a } from './a.ts';",
        "import './side.ts';",
        "export type T = import('./nested/b.ts').B;",
      ].join('\n'),
      'utf8',
    );
    writeFileSync(
      join(dir, 'nested/b.d.ts'),
      "export type B = import('../a.ts').A;\n",
      'utf8',
    );

    expect(findDtsTsSpecifiers(dir)).toEqual(['index.d.ts', 'nested/b.d.ts']);
    expect(rewriteDtsSpecifiers(dir)).toBe(2);
    expect(findDtsTsSpecifiers(dir)).toEqual([]);
    expect(readFileSync(join(dir, 'index.d.ts'), 'utf8')).toContain(
      "export type T = import('./nested/b.js').B;",
    );
  });

  test('pruneInternalDts 清理 3 个内部 .d.ts 并在公开声明泄漏引用时告警', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codd-prune-dts-'));
    dirs.push(dir);
    for (const f of INTERNAL_DTS_FILES) {
      writeFileSync(join(dir, f), 'export const internal = 1;\n', 'utf8');
    }
    writeFileSync(
      join(dir, 'index.d.ts'),
      "export { generateBundle } from './generate.js';\n",
      'utf8',
    );
    expect(pruneInternalDts(dir)).toEqual([]);
    for (const f of INTERNAL_DTS_FILES) {
      expect(existsSync(join(dir, f))).toBe(false);
    }

    writeFileSync(
      join(dir, 'generate.d.ts'),
      "export type Bad = import('./emit-k8s.js').K8sEmitContext;\n",
      'utf8',
    );
    expect(pruneInternalDts(dir)).toEqual(['generate.d.ts -> emit-k8s']);
  });
});

describe('judgeRelease API 发布闸门拒绝矩阵', () => {
  test('全部要素齐备放行', () => {
    const verdict = judgeRelease(validFacts(), EXPECTATION_OK);
    expect(verdict).toEqual({ ok: true, commit: HEAD, sha256: SHA });
  });

  test('覆盖 git / dist / manifest / d.ts / 资产清单 / pack 全部拒绝分支', () => {
    const cases: Array<[VerifyFacts, PackExpectation, string]> = [
      [{ ...validFacts(), gitStatus: null }, EXPECTATION_OK, '读不到 git 状态'],
      [{ ...validFacts(), gitHead: null }, EXPECTATION_OK, '读不到 HEAD'],
      [
        { ...validFacts(), gitStatus: ' M src/index.ts\n' },
        EXPECTATION_OK,
        '工作树不干净',
      ],
      [
        {
          ...validFacts(),
          dist: {
            ...cleanDist(),
            entryExists: false,
            entrySize: 0,
            entrySha256: null,
          },
        },
        EXPECTATION_OK,
        '产物缺失',
      ],
      [
        {
          ...validFacts(),
          dist: { ...cleanDist(), manifestExists: false, manifest: null },
        },
        EXPECTATION_OK,
        '产物清单缺失',
      ],
      [
        {
          ...validFacts(),
          dist: {
            ...cleanDist(),
            manifest: { ...cleanDist().manifest!, dirty: true },
          },
        },
        EXPECTATION_OK,
        '脏工作树构建',
      ],
      [
        {
          ...validFacts(),
          dist: {
            ...cleanDist(),
            manifest: { ...cleanDist().manifest!, commit: 'f'.repeat(40) },
          },
        },
        EXPECTATION_OK,
        '不是本次提交构建',
      ],
      [
        {
          ...validFacts(),
          dist: { ...cleanDist(), entrySha256: 'f'.repeat(64) },
        },
        EXPECTATION_OK,
        '产物摘要与清单记录不符',
      ],
      [
        { ...validFacts(), dtsTsSpecifierHits: ['index.d.ts'] },
        EXPECTATION_OK,
        'index.d.ts',
      ],
      [
        validFacts(),
        { files: null, issue: '模板资产清单缺失' },
        '模板资产清单缺失',
      ],
      [
        { ...validFacts(), pack: { files: null, issue: 'npm pack 失败' } },
        EXPECTATION_OK,
        '采不到',
      ],
      [
        {
          ...validFacts(),
          pack: { files: [...STAGED_PACK, 'dist/leak.txt'], issue: null },
        },
        EXPECTATION_OK,
        '多出 dist/leak.txt',
      ],
      [
        {
          ...validFacts(),
          pack: {
            files: STAGED_PACK.filter((f) => f !== 'dist/index.js'),
            issue: null,
          },
        },
        EXPECTATION_OK,
        '缺少 dist/index.js',
      ],
    ];

    for (const [facts, exp, keyword] of cases) {
      const verdict = judgeRelease(facts, exp);
      expect(verdict.ok).toBe(false);
      if (!verdict.ok) expect(verdict.reason).toContain(keyword);
    }
  });

  test('readPackExpectation 拒绝损坏清单与含隐藏点名的资产', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codd-exp-'));
    try {
      expect(readPackExpectation(dir).issue).toContain('缺失');
      mkdirSync(join(dir, ASSET_DIR), { recursive: true });
      const mp = join(dir, ASSET_DIR, ASSET_MANIFEST_FILE);
      writeFileSync(mp, '{ bad');
      expect(readPackExpectation(dir).issue).toContain('不是合法 JSON');
      writeFileSync(
        mp,
        JSON.stringify({ schemaVersion: 1, files: ['podman/.env.tmpl'] }),
      );
      expect(readPackExpectation(dir).issue).toContain('隐藏文件');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  });
});

describe('collectFacts 临时仓库集成采集', () => {
  const dirs: string[] = [];
  afterEach(() => {
    for (const d of dirs.splice(0))
      rmSync(d, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
  });

  test('临时仓库能正确读取 git 事实、entry 摘要、递归 .d.ts 命中与 pack 清单', () => {
    const root = mkdtempSync(join(tmpdir(), 'codd-api-facts-'));
    dirs.push(root);
    const git = (args: string[]) =>
      spawnSync('git', args, {
        cwd: root,
        encoding: 'utf8',
        env: cleanGitEnv(),
      });
    git(['init', '-q']);
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'probe-codd-api',
        version: '0.0.1',
        files: ['dist'],
      }),
    );
    mkdirSync(join(root, 'dist/sub'), { recursive: true });
    writeFileSync(join(root, 'dist/index.js'), 'export const x = 1;\n');
    writeFileSync(
      join(root, 'dist/sub/bad.d.ts'),
      "export type X = import('../x.ts').X;\n",
    );
    git(['add', '-A']);
    git([
      '-c',
      'commit.gpgsign=false',
      '-c',
      'user.email=t@t',
      '-c',
      'user.name=t',
      'commit',
      '--no-verify',
      '-qm',
      'init',
    ]);

    const skipPack = process.env.CI_SKIP_PACK_TEST === '1';
    const facts = collectFacts(
      root,
      skipPack ? { files: [], issue: null } : undefined,
    );
    expect(facts.gitStatus).toBe('');
    expect(facts.gitHead).toMatch(/^[0-9a-f]{40}$/);
    expect(facts.dist.entrySha256).toMatch(/^[0-9a-f]{64}$/);
    expect(facts.dtsTsSpecifierHits).toEqual(['sub/bad.d.ts']);
    if (!skipPack) {
      expect(facts.pack.files).toContain('dist/index.js');
    }
  }, 30_000);
});

const hasDist = existsSync(join(PACKAGE_ROOT, 'dist', ENTRY_FILE));
const hasAssets = existsSync(
  join(PACKAGE_ROOT, ASSET_DIR, ASSET_MANIFEST_FILE),
);
const skipPackTest = process.env.CI_SKIP_PACK_TEST === '1';

describe('发行面白名单 · 真实 npm 对齐 (本包实测)', () => {
  test.skipIf(!hasDist || !hasAssets || skipPackTest)(
    '工作树 pack 清单与白名单逐项一致且包版本号非空',
    () => {
      const pkg = JSON.parse(
        readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8'),
      ) as { version?: string };
      expect(typeof pkg.version).toBe('string');
      expect(pkg.version!.length).toBeGreaterThan(0);

      const facts = readPackFiles(PACKAGE_ROOT);
      const expectation = readPackExpectation(PACKAGE_ROOT);
      expect(facts.issue).toBeNull();
      expect(expectation.issue).toBeNull();
      const verdict = judgePackFiles(
        facts.files ?? [],
        expectation.files ?? [],
      );
      expect(verdict.ok ? '' : verdict.reason).toBe('');
    },
    30_000,
  );
});
