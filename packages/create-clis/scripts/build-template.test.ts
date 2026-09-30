/**
 * 模板快照构建链单测: 四类处置的行为 / 三条构建自检 (任一不过抛错) / 真实清单全量对账。
 *
 * 处置与自检用「假仓库 + 小清单 + 小骨架」的临时根夹具钉住行为语义 (逐字节 / 替换 / 重置 /
 * 排除 / 路径泛化); 真实清单用例是骨架缺失、清单漂移与产物面回归的守门人 —— 夹具覆盖不到的
 * 那些条目 (含全部 reset 条目的骨架落位), 逐条对账全在其上跑 (条数以 template-manifest 为准,
 * 不在注释里写死)。
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
import {
  TEMPLATE_VOCABULARY,
  type Vocabulary,
  containsResidual,
  renderTemplate,
} from '../src/render.ts';
import { ORIGINAL, buildTemplate } from './build-template.ts';
import {
  type ManifestEntry,
  REPO_ROOT,
  TEMPLATE_MANIFEST,
} from './template-manifest.ts';

/** 夹具词汇 (自足小词表, 不依赖真实仓库值; 形态面与真实原始词汇同构: 含 author 与地址) */
const FIXTURE_ORIGINAL: Vocabulary = {
  name: 'demo-app',
  scope: '@demo',
  binName: 'da',
  owner: 'demo',
  repoUrl: 'https://github.com/demo/kit',
  author: 'DemoAuthor',
};

/** 夹具清单: 四类处置各一条, 且 generalize 与 reset 的路径都带项目名 (路径泛化面) */
const FIXTURE_MANIFEST: readonly ManifestEntry[] = [
  { path: 'conf/a.conf', disposition: 'snapshot' },
  { path: 'demo-app.json', disposition: 'generalize' },
  { path: 'README.md', disposition: 'reset', note: '夹具: 换骨架' },
  { path: 'src/', disposition: 'exclude', note: '夹具: 不进模板' },
];

/** 夹具骨架内容 (模板占位形态; 构建期原样搬运) */
const SKELETON_ROOT_README = '# {{NAME}}\n\n由 {{REPO_URL}} 生成。\n';
const SKELETON_API_INDEX = 'export const name = "{{SCOPE}}/{{NAME}}";\n';

/** 夹具骨架根 (镜像清单路径) */
const FIXTURE_SKELETON_FILES: Readonly<Record<string, string>> = {
  'README.md': SKELETON_ROOT_README,
  'packages/demo-app/src/index.ts': SKELETON_API_INDEX,
};

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** 搭一个夹具根: 写清单文件 + 骨架, 返回各坐标 */
const setupFixture = (): {
  repoRoot: string;
  skeletonRoot: string;
  outDir: string;
} => {
  const root = makeTmpRoot('create-clis-build-');
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
  for (const [rel, content] of Object.entries(FIXTURE_SKELETON_FILES)) {
    const target = join(skeletonRoot, rel);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, content);
  }
  return { repoRoot, skeletonRoot, outDir };
};

describe('buildTemplate 四类处置', () => {
  test('snapshot 原样 / generalize 替换 / reset 换骨架 / exclude 不出现', () => {
    const base = setupFixture();
    const { files } = buildTemplate({
      repoRoot: base.repoRoot,
      outDir: base.outDir,
      original: FIXTURE_ORIGINAL,
      manifest: FIXTURE_MANIFEST,
      skeletonRoot: base.skeletonRoot,
    });

    // snapshot: 逐字节相等 (不经任何文本处理)
    expect(readFileSync(join(base.outDir, 'conf/a.conf'), 'utf8')).toBe(
      'keep = byte-identical\n',
    );

    // generalize: 内容与路径都泛化 (文件名 demo-app.json → {{NAME}}.json)
    const rendered = readFileSync(join(base.outDir, '{{NAME}}.json'), 'utf8');
    expect(rendered).toContain('"{{SCOPE}}/{{NAME}}"');
    expect(rendered).toContain('"{{BIN_NAME}}"');
    expect(rendered).toContain('"{{OWNER}}"'); // author 形态回退 owner
    expect(rendered).toContain('"{{REPO_URL}}"');
    expect(rendered).toContain('"{{OWNER}}/{{NAME}}"'); // 裸 slug 形态
    expect(containsResidual(rendered, FIXTURE_ORIGINAL)).toBe(false);

    // reset: 骨架原样落位 (骨架自带占位词汇, 构建期不再加工)
    expect(readFileSync(join(base.outDir, 'README.md'), 'utf8')).toBe(
      SKELETON_ROOT_README,
    );

    // exclude: 源存在但不进模板
    expect(existsSync(join(base.repoRoot, 'src/x.ts'))).toBe(true);
    expect(existsSync(join(base.outDir, 'src'))).toBe(false);

    // 返回文件清单: 相对 outDir、排序稳定
    expect(files).toEqual(['README.md', 'conf/a.conf', '{{NAME}}.json']);
    expect([...files].sort()).toEqual(files);
  });

  test('资产清单落在 outDir 同级 manifest.json (T8 白名单输入)', () => {
    const base = setupFixture();
    const { files } = buildTemplate({
      repoRoot: base.repoRoot,
      outDir: base.outDir,
      original: FIXTURE_ORIGINAL,
      manifest: FIXTURE_MANIFEST,
      skeletonRoot: base.skeletonRoot,
    });

    const manifestPath = join(dirname(base.outDir), 'manifest.json');
    expect(existsSync(manifestPath)).toBe(true);
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as {
      schemaVersion: number;
      files: string[];
    };
    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.files).toEqual(files);
  });

  test('重复执行幂等: 旧产物被清掉, 结果与首次一致', () => {
    const base = setupFixture();
    const options = {
      repoRoot: base.repoRoot,
      outDir: base.outDir,
      original: FIXTURE_ORIGINAL,
      manifest: FIXTURE_MANIFEST,
      skeletonRoot: base.skeletonRoot,
    };
    const first = buildTemplate(options);
    writeFileSync(join(base.outDir, 'stale.txt'), '上一轮的残留\n');
    const second = buildTemplate(options);
    expect(second.files).toEqual(first.files);
    expect(existsSync(join(base.outDir, 'stale.txt'))).toBe(false);
  });

  test('目录条目 reset: 骨架目录整棵搬运, 路径随泛化落位', () => {
    const base = setupFixture();
    const manifest: readonly ManifestEntry[] = [
      {
        path: 'packages/demo-app/src/',
        disposition: 'reset',
        note: '夹具: 样例源码骨架',
      },
    ];
    const { files } = buildTemplate({
      repoRoot: base.repoRoot,
      outDir: base.outDir,
      original: FIXTURE_ORIGINAL,
      manifest,
      skeletonRoot: base.skeletonRoot,
    });
    expect(files).toEqual(['packages/{{NAME}}/src/index.ts']);
    expect(
      readFileSync(join(base.outDir, 'packages/{{NAME}}/src/index.ts'), 'utf8'),
    ).toBe(SKELETON_API_INDEX);
  });
});

describe('构建自检: 任一不过即抛错', () => {
  test('泛化零残留自检: snapshot 内容残留原词汇即抛错', () => {
    const base = setupFixture();
    writeFileSync(join(base.repoRoot, 'conf/a.conf'), 'name=demo-app\n');
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: FIXTURE_MANIFEST,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/残留/);
  });

  test('泛化零残留自检: 骨架内容残留原词汇即抛错', () => {
    const base = setupFixture();
    writeFileSync(join(base.skeletonRoot, 'README.md'), '# demo-app\n');
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: FIXTURE_MANIFEST,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/残留/);
  });

  test('清单完整性自检: 源文件缺失即抛错', () => {
    const base = setupFixture();
    rmSync(join(base.repoRoot, 'demo-app.json'));
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: FIXTURE_MANIFEST,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/demo-app\.json/);
  });

  test('清单完整性自检: 骨架缺失即抛错', () => {
    const base = setupFixture();
    rmSync(join(base.skeletonRoot, 'README.md'));
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest: FIXTURE_MANIFEST,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/骨架/);
  });

  test('清单完整性自检: 产出路径撞车即抛错', () => {
    const base = setupFixture();
    // 两条不同的源路径渲染到同一产出路径 (demo-app.json 与字面 {{NAME}}.json 都落 {{NAME}}.json)
    writeFileSync(join(base.repoRoot, '{{NAME}}.json'), '{}\n');
    const manifest: readonly ManifestEntry[] = [
      { path: 'demo-app.json', disposition: 'generalize' },
      { path: '{{NAME}}.json', disposition: 'generalize' },
    ];
    expect(() =>
      buildTemplate({
        repoRoot: base.repoRoot,
        outDir: base.outDir,
        original: FIXTURE_ORIGINAL,
        manifest,
        skeletonRoot: base.skeletonRoot,
      }),
    ).toThrow(/重复/);
  });
});

describe('真实清单集成: 全量产出', () => {
  /** 真实清单构建一次 (临时 outDir), 供多条断言复用 */
  const buildReal = (): { outDir: string; files: string[] } => {
    const outDir = join(
      makeTmpRoot('create-clis-template-'),
      'assets/template',
    );
    const { files } = buildTemplate({
      repoRoot: REPO_ROOT,
      outDir,
      original: ORIGINAL,
    });
    createdRoots.push(dirname(outDir));
    return { outDir, files };
  };

  test('关键路径落位: 示例包 / bin / docs 骨架按占位形态产出', () => {
    const { outDir, files } = buildReal();
    for (const rel of [
      'package.json',
      'tsconfig.json',
      'docs/README.md',
      'packages/{{NAME}}/package.json',
      'packages/{{NAME}}-cli/package.json',
      'packages/{{NAME}}-cli/bin/{{BIN_NAME}}',
      'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs',
      'packages/{{NAME}}/src/index.ts',
      'packages/{{NAME}}/scripts/verify-release.ts',
      'packages/{{NAME}}-cli/src/cli.ts',
    ]) {
      expect(files, `${rel} 未产出`).toContain(rel);
      expect(existsSync(join(outDir, rel)), `${rel} 不在磁盘上`).toBe(true);
    }
    // 路径泛化: 原包名不出现在任何产出路径里
    for (const file of files) {
      expect(containsResidual(file, ORIGINAL), `${file} 路径含原词汇`).toBe(
        false,
      );
    }
  });

  test('排除面不进模板: 产品区 / 锁文件 / 生成器自身', () => {
    const { files } = buildReal();
    const excluded = files.filter(
      (file) =>
        file.startsWith('docs/sweep/') ||
        file === 'bun.lock' ||
        file.startsWith('packages/create-clis/') ||
        file.startsWith('.mailmap'),
    );
    expect(excluded).toEqual([]);
  });

  test('清单完整性: 非 exclude 条目逐条落位 (真实清单全量对账)', () => {
    const { files } = buildReal();
    // 逐条按同一替换面推导期望产出路径: 文件条目须精确命中, 目录条目须有后代命中
    for (const entry of TEMPLATE_MANIFEST) {
      if (entry.disposition === 'exclude') continue;
      const expected = renderTemplate(
        entry.path,
        TEMPLATE_VOCABULARY,
        ORIGINAL,
      );
      const hit = entry.path.endsWith('/')
        ? files.some((file) => file.startsWith(expected))
        : files.includes(expected);
      expect(hit, `${entry.path} (${entry.disposition}) 未产出`).toBe(true);
    }
  });
});
