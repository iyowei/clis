/**
 * 模板快照构建链单测: 四类处置行为 / 真实清单全量对账 / Turbo 缓存输入与骨架共享配置物理同步守卫。
 * (假仓库构建自检见同目录 `build-template-infra.test.ts`, 分文件以守 max-lines 门禁。)
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
import { toCarrierPath } from '../src/template-snapshot.ts';
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
      'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.cmd',
      'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs',
      'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.d.mts',
      'packages/{{NAME}}/src/index.ts',
      'packages/{{NAME}}/docs/protocol/conformance/corpus.schema.json',
      'packages/{{NAME}}/scripts/verify-release.ts',
      'packages/{{NAME}}-cli/src/cli.ts',
      'packages/{{NAME}}-cli/src/launcher.runtime-resolution.test.ts',
    ]) {
      expect(files, `${rel} 未产出`).toContain(rel);
      expect(existsSync(join(outDir, rel)), `${rel} 不在磁盘上`).toBe(true);
    }
    const cmdTemplate = readFileSync(
      join(outDir, 'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.cmd'),
      'utf8',
    );
    expect(cmdTemplate).toContain('bin\\{{BIN_NAME}}.mjs');
    expect(cmdTemplate).not.toContain('sweep');
    // 路径泛化: 原包名不出现在任何产出路径里
    for (const file of files) {
      expect(containsResidual(file, ORIGINAL), `${file} 路径含原词汇`).toBe(
        false,
      );
    }

    // CREATE-P0-3: API 包构建脚本与 tsconfig.build.json 须为干净中性骨架 (不含 sweep 内部排除表)
    const apiBuild = readFileSync(
      join(outDir, 'packages/{{NAME}}/scripts/build.ts'),
      'utf8',
    );
    expect(apiBuild).toContain(
      'const INTERNAL_DTS_FILES: readonly string[] = [];',
    );
    expect(apiBuild).toContain("'x', '--no-install'");
    expect(apiBuild).not.toContain("'bunx'");
    for (const sweepInternal of ['runtime.d.ts', 'scan-native', 'size-du']) {
      expect(apiBuild).not.toContain(sweepInternal);
    }
    // 示例包不预置空壳 docs/README.md, 包根 README 不留未发包相对链接
    expect(files).not.toContain('packages/{{NAME}}/docs/README.md');
    expect(files).not.toContain('packages/{{NAME}}-cli/docs/README.md');
    for (const readme of [
      'packages/{{NAME}}/README.md',
      'packages/{{NAME}}/README.zh-CN.md',
      'packages/{{NAME}}-cli/README.md',
      'packages/{{NAME}}-cli/README.zh-CN.md',
    ]) {
      const content = readFileSync(join(outDir, readme), 'utf8');
      expect(content, `${readme} 不得含未发包相对链接`).not.toContain(
        '](docs/README.md)',
      );
      expect(content).toContain('{{REPO_URL}}/blob/main/docs/README.md');
    }
    const apiTsBuild = JSON.parse(
      readFileSync(
        join(outDir, 'packages/{{NAME}}/tsconfig.build.json'),
        'utf8',
      ),
    ) as Record<string, unknown>;
    expect(apiTsBuild).toMatchObject({
      compilerOptions: { noEmitOnError: true, paths: {} },
      exclude: ['src/**/*.test.ts', 'src/**/*smoke.ts'],
    });

    const rootTsConfig = JSON.parse(
      readFileSync(join(outDir, 'tsconfig.json'), 'utf8'),
    ) as { exclude: string[] };
    expect(rootTsConfig.exclude).toContain('**/dist');
    expect(rootTsConfig.exclude).toContain('scripts/transcription/mutants');
    const gitignoreCarrier = readFileSync(join(outDir, '_gitignore'), 'utf8');
    expect(gitignoreCarrier).toContain('scripts/transcription/mutants/gen-*/');
    expect(gitignoreCarrier).toContain('.vscode/*');
    expect(gitignoreCarrier).toContain('!.vscode/settings.json');
  });

  test('npm 面包机制剔除的真实名以载体名落位 (TD-05 的载体面)', () => {
    const { outDir, files } = buildReal();

    expect(files).toContain('_gitignore');
    expect(files).toContain('_npmrc');
    expect(existsSync(join(outDir, '.gitignore'))).toBe(false);
    expect(existsSync(join(outDir, '.npmrc'))).toBe(false);
    // 载体只改名不改内容 (.npmrc 是 snapshot 条目: 逐字节等于仓库根原件; 生成期还原的就是它)
    expect(readFileSync(join(outDir, '_npmrc'), 'utf8')).toBe(
      readFileSync(join(REPO_ROOT, '.npmrc'), 'utf8'),
    );
  });

  test('排除面不进模板且零私有包路径/镜像源泄漏', () => {
    const { outDir, files } = buildReal();
    const excluded = files.filter(
      (file) =>
        file.startsWith('docs/sweep/') ||
        file.startsWith('docs/codd/') ||
        file === 'bun.lock' ||
        file.startsWith('packages/create-clis/') ||
        file.startsWith('packages/codd/') ||
        file.startsWith('packages/codd-cli/') ||
        file.startsWith('.mailmap'),
    );
    expect(excluded).toEqual([]);
    for (const file of files) {
      const text = readFileSync(join(outDir, file), 'utf8');
      expect(text, `${file} 不得泄漏 packages/codd`).not.toContain(
        'packages/codd',
      );
      expect(text, `${file} 不得泄漏 packages/create-clis`).not.toContain(
        'packages/create-clis',
      );
      expect(text, `${file} 不得泄漏 npmmirror`).not.toContain(
        'registry.npmmirror.com',
      );
    }
  });

  test('清单完整性: 非 exclude 条目逐条落位 (真实清单全量对账)', () => {
    const { files } = buildReal();
    for (const entry of TEMPLATE_MANIFEST) {
      if (entry.disposition === 'exclude') continue;
      const expected = toCarrierPath(
        renderTemplate(entry.path, TEMPLATE_VOCABULARY, ORIGINAL),
      );
      const hit = entry.path.endsWith('/')
        ? files.some((file) => file.startsWith(expected))
        : files.includes(expected);
      expect(hit, `${entry.path} (${entry.disposition}) 未产出`).toBe(true);
    }
  });
});

/** 将 Turbo inputs 中的 POSIX glob 转为全路径正则 */
function turboGlobToRegExp(pattern: string): RegExp {
  const placeholder = pattern
    .replaceAll('/**/', '\0DIR\0')
    .replace(/\/\*\*$/, '\0TAIL\0')
    .replace(/^\*\*\//, '\0HEAD\0')
    .replaceAll('*', '\0STAR\0')
    .replaceAll('?', '\0QMARK\0');
  const escaped = placeholder
    .replace(/[.+^${}()|[\]\\]/g, '\\$&')
    .replaceAll('\0DIR\0', '(?:/.+/|/)')
    .replaceAll('\0TAIL\0', '/.+')
    .replaceAll('\0HEAD\0', '(?:.+/)?')
    .replaceAll('\0STAR\0', '[^/]*')
    .replaceAll('\0QMARK\0', '[^/]');
  return new RegExp(`^${escaped}$`);
}

describe('骨架与 Turbo 缓存物理对账守卫', () => {
  test('骨架同步守卫: template-skeletons/package.json 与根 package.json 工具链版本逐项一致', () => {
    const rootPkg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'package.json'), 'utf8'),
    ) as {
      packageManager: string;
      engines: Record<string, string>;
      devDependencies: Record<string, string>;
    };
    const skeletonPkg = JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          'packages/create-clis/scripts/template-skeletons/package.json',
        ),
        'utf8',
      ),
    ) as typeof rootPkg;
    const createClisPkg = JSON.parse(
      readFileSync(
        join(REPO_ROOT, 'packages/create-clis/package.json'),
        'utf8',
      ),
    ) as { dependencies: Record<string, string> };

    expect(skeletonPkg.packageManager).toBe(rootPkg.packageManager);
    expect(skeletonPkg.engines).toEqual(rootPkg.engines);
    expect(skeletonPkg.devDependencies).toEqual(rootPkg.devDependencies);
    expect(rootPkg.devDependencies.prettier).toBeUndefined();
    expect(
      rootPkg.devDependencies['@trivago/prettier-plugin-sort-imports'],
    ).toBeUndefined();
    expect(createClisPkg.dependencies.prettier).toMatch(/^\d+\.\d+\.\d+$/);
    expect(
      createClisPkg.dependencies['@trivago/prettier-plugin-sort-imports'],
    ).toMatch(/^\d+\.\d+\.\d+$/);
  });

  test('Turbo 缓存输入守卫: snapshot / generalize 跨目录源路径均纳入 create-clis turbo.json inputs', () => {
    const turboCfg = JSON.parse(
      readFileSync(join(REPO_ROOT, 'packages/create-clis/turbo.json'), 'utf8'),
    ) as { tasks: { build: { inputs: string[] } } };
    const inputs = turboCfg.tasks.build.inputs;
    expect(inputs).toContain('$TURBO_DEFAULT$');
    expect(inputs).toContain('$TURBO_ROOT$/tsconfig.json');

    const isCoveredByRootInputs = (relPath: string): boolean => {
      let matched = false;
      for (const rule of inputs) {
        if (rule.startsWith('$TURBO_ROOT$/')) {
          if (
            turboGlobToRegExp(rule.slice('$TURBO_ROOT$/'.length)).test(relPath)
          ) {
            matched = true;
          }
        } else if (rule.startsWith('!$TURBO_ROOT$/')) {
          if (
            turboGlobToRegExp(rule.slice('!$TURBO_ROOT$/'.length)).test(relPath)
          ) {
            matched = false;
          }
        }
      }
      return matched;
    };

    expect(isCoveredByRootInputs('scripts/transcription/mutants/m1/x.ts')).toBe(
      false,
    );
    expect(isCoveredByRootInputs('UNDECLARED_ROOT_FILE.txt')).toBe(false);

    const uncovered = TEMPLATE_MANIFEST.filter(
      (entry) =>
        (entry.disposition === 'snapshot' ||
          entry.disposition === 'generalize') &&
        !entry.path.startsWith('packages/create-clis/') &&
        !isCoveredByRootInputs(entry.path),
    ).map((entry) => `${entry.path} (${entry.disposition})`);
    expect(uncovered, '跨目录模板源文件漏配 $TURBO_ROOT$ inputs').toEqual([]);
  });

  test('骨架共享配置同步守卫: template-skeletons 的 .oxlintrc.json 与根 package.json 通用 scripts 完全对齐', () => {
    const rootOxlint = JSON.parse(
      readFileSync(join(REPO_ROOT, '.oxlintrc.json'), 'utf8'),
    ) as Record<string, unknown>;
    const skeletonOxlint = JSON.parse(
      readFileSync(
        join(
          REPO_ROOT,
          'packages/create-clis/scripts/template-skeletons/.oxlintrc.json',
        ),
        'utf8',
      ),
    ) as Record<string, unknown>;
    for (const key of ['plugins', 'categories', 'rules', 'env', 'globals']) {
      expect(skeletonOxlint[key], `.oxlintrc.json ${key} 漂移`).toEqual(
        rootOxlint[key],
      );
    }

    const rootScripts = (
      JSON.parse(readFileSync(join(REPO_ROOT, 'package.json'), 'utf8')) as {
        scripts: Record<string, string>;
      }
    ).scripts;
    const skeletonScripts = (
      JSON.parse(
        readFileSync(
          join(
            REPO_ROOT,
            'packages/create-clis/scripts/template-skeletons/package.json',
          ),
          'utf8',
        ),
      ) as { scripts: Record<string, string> }
    ).scripts;
    for (const key of [
      'safe-install',
      'prepare',
      'build',
      'lint',
      'lint:fix',
      'format',
      'format-check',
      'conformance',
      'fuzz',
      'fuzz:diff',
      'ci',
    ]) {
      expect(skeletonScripts[key], `package.json scripts.${key} 漂移`).toBe(
        rootScripts[key],
      );
    }
  });
});
