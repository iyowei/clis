/**
 * create-clis 端到端契约 (TDD 驱动件: 本文件先行, 驱动 src/generate.ts 与 src/cli.ts 接线)。
 *
 * 夹具取真实模板资产: 模块加载时经 buildTemplate 现场产出到独占临时目录, 经环境变量
 * (CREATE_CLIS_TEMPLATE_DIR) 注入给 CLI 子进程 —— 不造小夹具, 免与真实资产漂移, 也不写
 * 工作区 (每次运行都是新鲜产物)。断言面覆盖生成全链 (收集 → 复制 → 裁剪 → 替换 → 格式化
 * 收口 → 自检 → 收尾) 与失败路径 (非空拒绝 / 取消 / 旗标非法); 同一批用例参数化跑 bun 与
 * node 两个载体。交互以管道 stdin 覆盖 (createPromptIO 的缓冲 / EOF 行为), 一律不真跑依赖
 * 安装 (--no-install), git init 仅专门用例执行。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { buildTemplate } from '../scripts/build-template.ts';
import { REPO_ROOT } from '../scripts/template-manifest.ts';
import { type GenerateHooks, generateProject } from './generate.ts';
import { TEMPLATE_VOCABULARY, type Vocabulary } from './render.ts';
import { ORIGINAL, defaultTemplateDir } from './template-snapshot.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const RUNNERS = ['bun', 'node'];

/** 非交互生成的标准变量 (五变量全给, 免进交互); 各用例按需拼接档位与收尾旗标 */
const VARIABLES = [
  '--name',
  'demo-tool',
  '--scope',
  '@demo',
  '--bin',
  'dt',
  '--owner',
  'demouser',
  '--repo',
  'https://github.com/demouser/demo-tool',
];

/** 跳过全部收尾动作 (e2e 不真跑依赖安装; git init 仅专门用例执行) */
const NO_HOOKS = ['--no-git', '--no-install'];

/** 模块面直调 generateProject 的固定词汇 */
const HOOK_VOCABULARY: Vocabulary = {
  name: 'hook-tool',
  scope: '',
  binName: 'hook-tool',
  owner: 'demouser',
  repoUrl: 'https://github.com/demouser/hook-tool',
};

/** 子进程时限: 生成含全树 prettier 收口, 阈值给足防慢机误判; 交互死锁由它兜底 */
const TIMEOUT_MS = 120_000;

/** 真实模板夹具: 现场经 buildTemplate 产出 (CLI 输入即构建链的真实产物形态) */
const TEMPLATE_ROOT = makeTmpRoot('create-clis-e2e-tpl-');
const TEMPLATE_DIR = join(TEMPLATE_ROOT, 'template');
buildTemplate({
  repoRoot: REPO_ROOT,
  outDir: TEMPLATE_DIR,
  original: ORIGINAL,
});

afterAll(() => {
  rmSync(TEMPLATE_ROOT, { recursive: true, force: true });
});

/** 变量零残留判据 (与引擎同源): 五个占位形态 + 裸 slug 组合形态 */
const PLACEHOLDER_FORMS = [
  ...Object.values(TEMPLATE_VOCABULARY),
  '{{OWNER}}/{{NAME}}',
].filter((form): form is string => typeof form === 'string');

/** 原项目词汇判据: 生成物不得再出现本仓任一形态 */
const ORIGINAL_FORMS = [
  ORIGINAL.name,
  ORIGINAL.scope,
  ORIGINAL.binName,
  ORIGINAL.owner,
  ORIGINAL.repoUrl,
  ORIGINAL.author ?? '',
].filter((form) => form.length > 0);

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

/** 建一个用例工作区: home 作为隔离 HOME, target 作为生成目标 (basename 即项目名) */
function makeCase(label: string): {
  home: string;
  target: string;
} {
  const root = makeTmpRoot(`create-clis-e2e-${label}-`);
  createdRoots.push(root);
  const home = join(root, 'home');
  mkdirSync(home, { recursive: true });
  return { home, target: join(root, 'proj') };
}

/** 在隔离 HOME 里写一份 git 全局配置 (owner 默认值的环境来源) */
function writeGitConfig(home: string, userName: string): void {
  writeFileSync(join(home, '.gitconfig'), `[user]\n\tname = ${userName}\n`);
}

/** 跑一次接线后的 CLI (真实模板经环境变量注入; 隔离 HOME 防宿主 git 配置泄漏) */
function runCli(
  runner: string,
  args: string[],
  options: { home: string; input?: string },
): { status: number | null; stdout: string; stderr: string } {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    HOME: options.home,
    CREATE_CLIS_TEMPLATE_DIR: TEMPLATE_DIR,
  };
  const result = spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    env,
    input: options.input,
    timeout: TIMEOUT_MS,
  });
  return {
    status: result.status,
    stdout: result.stdout ?? '',
    stderr: result.stderr ?? '',
  };
}

/** 以 --yes 零交互跑一次生成 (owner 取隔离 HOME 里预写的 git user.name) */
function runYes(
  runner: string,
  target: string,
  home: string,
  extra: string[],
): ReturnType<typeof runCli> {
  writeGitConfig(home, 'demo-user');
  return runCli(runner, [target, '--yes', ...extra], { home });
}

/** 递归列出目录下全部文件 (相对路径, 排序稳定) */
function walkFiles(root: string, prefix = ''): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(join(root, prefix), {
    withFileTypes: true,
  })) {
    const rel = prefix === '' ? entry.name : `${prefix}/${entry.name}`;
    if (entry.isDirectory()) out.push(...walkFiles(root, rel));
    else if (entry.isFile()) out.push(rel);
  }
  return out.sort();
}

/** 全树零残留断言: 路径与内容都不得含给定形态, 命中即携文件与形态名失败 */
function expectNoForm(target: string, forms: readonly string[]): void {
  for (const rel of walkFiles(target)) {
    const pathHits = forms.filter((form) => rel.includes(form));
    expect(pathHits, `${rel} 路径残留形态`).toEqual([]);
    const text = readFileSync(join(target, rel), 'utf8');
    const textHits = forms.filter((form) => text.includes(form));
    expect(textHits, `${rel} 内容残留形态`).toEqual([]);
  }
}

/** core 档生成物的结构断言: 骨架与两包槽位落位 (bin 名与包目录名均已代入), 增强档 / 标准档装备已摘除 */
function expectCoreStructure(target: string): void {
  for (const file of [
    '.gitignore',
    '.prettierrc',
    'package.json',
    'scripts/ci.ts',
    'packages/demo-tool/package.json',
    'packages/demo-tool/src/index.ts',
    'packages/demo-tool-cli/package.json',
    'packages/demo-tool-cli/bin/dt.mjs',
    'packages/demo-tool-cli/bin/dt',
    'packages/demo-tool-cli/src/cli.ts',
  ]) {
    expect(existsSync(join(target, file)), `${file} 应存在`).toBe(true);
  }
  expect(existsSync(join(target, 'scripts/transcription'))).toBe(false);
  expect(existsSync(join(target, 'docs/designs/tech-debt.md'))).toBe(false);
}

/** 替换面抽样: 根包与 API 包的词汇落位 (全树零残留由 expectNoForm 背书) */
function expectVocabularyApplied(target: string): void {
  const rootPkg = readFileSync(join(target, 'package.json'), 'utf8');
  expect(rootPkg).toContain('"name": "demo-tool-monorepo"');
  expect(rootPkg).toContain('"author": "demouser');
  const apiPkg = readFileSync(
    join(target, 'packages/demo-tool/package.json'),
    'utf8',
  );
  expect(apiPkg).toContain('"name": "@demo/demo-tool"');
}

/** next steps 三步断言: 进入目录 / ci 验证 / 定位文档 */
function expectNextSteps(stdout: string, target: string): void {
  expect(stdout).toContain('已生成');
  expect(stdout).toContain(target);
  expect(stdout).toContain('bun run ci');
  expect(stdout).toContain('docs/designs/collection-positioning.md');
}

for (const runner of RUNNERS) {
  const available = spawnSync(runner, ['--version']).status === 0;
  defineScaffoldCases(runner, available);
  defineWiringCases(runner, available);
  defineFlagCases(runner, available);
}

/** 生成与交付面: 结构 / 裁剪 / 替换 / 零残留 / next steps (逐 runner 注册) */
function defineScaffoldCases(runner: string, available: boolean): void {
  describe(`create-clis e2e [${runner}] 生成面`, () => {
    test.skipIf(!available)(
      'core 档非交互生成: 结构完整 + 裁剪生效 + 零残留 + next steps',
      () => {
        const { home, target } = makeCase('core');
        const result = runCli(
          runner,
          [target, ...VARIABLES, '--tier', 'core', ...NO_HOOKS],
          { home },
        );
        expect(
          result.status,
          `应退 0; stdout=${result.stdout} stderr=${result.stderr}`,
        ).toBe(0);

        expectCoreStructure(target);
        expectVocabularyApplied(target);
        // 零残留: 全树无占位形态、无原项目词汇
        expectNoForm(target, PLACEHOLDER_FORMS);
        expectNoForm(target, ORIGINAL_FORMS);
        // 收尾旗标: 不建仓库、不装依赖
        expect(existsSync(join(target, '.git'))).toBe(false);
        expect(existsSync(join(target, 'node_modules'))).toBe(false);
        expectNextSteps(result.stdout, target);
      },
      TIMEOUT_MS,
    );
  });
}

/** 交互与收尾面: 收集 / 取消 / git init / 非空拒绝 (逐 runner 注册) */
function defineWiringCases(runner: string, available: boolean): void {
  describe(`create-clis e2e [${runner}] 交互与收尾面`, () => {
    test.skipIf(!available)(
      '目标目录: 空目录放行 / 非空拒绝且不覆盖',
      () => {
        // 空目录: 属可用目标, 内容落进既有目录 (不是嵌套成 target/<name>/...)
        const empty = makeCase('empty-dir');
        mkdirSync(empty.target, { recursive: true });
        const ok = runCli(
          runner,
          [empty.target, ...VARIABLES, '--tier', 'core', ...NO_HOOKS],
          { home: empty.home },
        );
        expect(ok.status, `空目录应放行: ${ok.stderr}`).toBe(0);
        expect(existsSync(join(empty.target, 'package.json'))).toBe(true);

        // 非空: 拒绝且不覆盖 (原文件原样在, 也没有任何生成物混入)
        const { home, target } = makeCase('occupied');
        mkdirSync(target, { recursive: true });
        writeFileSync(join(target, 'keep.txt'), 'keep-me\n');
        const result = runCli(
          runner,
          [target, ...VARIABLES, '--tier', 'core', ...NO_HOOKS],
          { home },
        );
        expect(result.status, `应退非零: ${result.stderr}`).not.toBe(0);
        expect(result.stderr).toContain('非空');
        expect(readFileSync(join(target, 'keep.txt'), 'utf8')).toBe(
          'keep-me\n',
        );
        expect(walkFiles(target)).toEqual(['keep.txt']);
      },
      TIMEOUT_MS,
    );

    test.skipIf(!available)(
      '--yes 零交互: 全默认派生 (owner 取隔离 HOME 的 git user.name)',
      () => {
        const { home, target } = makeCase('yes');
        const result = runYes(runner, target, home, [
          '--tier',
          'core',
          ...NO_HOOKS,
        ]);

        expect(result.status, `应退 0: ${result.stderr}`).toBe(0);
        // 项目名取目标目录 basename; 单段名不缩写; owner / repo 由默认链派生
        const rootPkg = readFileSync(join(target, 'package.json'), 'utf8');
        expect(rootPkg).toContain('"name": "proj-monorepo"');
        expect(rootPkg).toContain('"author": "demo-user');
        const apiPkg = readFileSync(
          join(target, 'packages/proj/package.json'),
          'utf8',
        );
        expect(apiPkg).toContain(
          '"homepage": "https://github.com/demo-user/proj#readme"',
        );
      },
      TIMEOUT_MS,
    );

    test.skipIf(!available)(
      '默认收尾: git init 执行, 产物是可独立建仓的目录',
      () => {
        const { home, target } = makeCase('git-init');
        const result = runYes(runner, target, home, [
          '--tier',
          'core',
          '--no-install',
        ]);

        expect(result.status, `应退 0: ${result.stderr}`).toBe(0);
        expect(existsSync(join(target, '.git'))).toBe(true);
      },
      TIMEOUT_MS,
    );

    test.skipIf(!available)(
      '管道 stdin: 逐问收集 (缓冲 / 默认值) 后生成',
      () => {
        const { home, target } = makeCase('piped');
        // 位置参数已回填项目名, 四问依次为 scope / bin / owner / repo
        const result = runCli(
          runner,
          [target, '--tier', 'core', '--no-git', '--no-install'],
          { home, input: '@piped\n\npipedowner\n\n' },
        );

        expect(result.status, `应退 0: ${result.stderr}`).toBe(0);
        const apiPkg = readFileSync(
          join(target, 'packages/proj/package.json'),
          'utf8',
        );
        expect(apiPkg).toContain('"name": "@piped/proj"');
        expect(existsSync(join(target, 'packages/proj-cli/bin/proj.mjs'))).toBe(
          true,
        );
      },
    );

    test.skipIf(!available)(
      '管道 stdin 立即 EOF: 折算取消, 提示后非零退出且无产物',
      () => {
        const { home, target } = makeCase('cancelled');
        const result = runCli(
          runner,
          [target, '--tier', 'core', '--no-git', '--no-install'],
          { home, input: '' },
        );

        expect(result.status).not.toBe(0);
        expect(`${result.stdout}${result.stderr}`).toContain('已取消');
        expect(existsSync(target)).toBe(false);
      },
    );
  });
}

/** 旗标与档位面: 参数错误 / help / -- 行为 / 档位裁剪 (逐 runner 注册) */
function defineFlagCases(runner: string, available: boolean): void {
  describe(`create-clis e2e [${runner}] 旗标与档位面`, () => {
    test.skipIf(!available)('旗标非法: 报因退非零且未生成', () => {
      const { home, target } = makeCase('bad-flag');
      // 注: `--` 到不了 argv 还是被结构化剥离随载体而异 (bun 直跑剥离 `--`, node 会原样传入),
      // 不在此断言; npm create 场景则统一由 npm 剥离
      const cases: { args: string[]; reason: string }[] = [
        { args: ['--bogus'], reason: '未知旗标' },
        { args: ['--tier', 'ultimate'], reason: '--tier' },
        {
          args: [target, '--name', 'BadName', '--no-git', '--no-install'],
          reason: 'kebab-case',
        },
      ];
      for (const { args, reason } of cases) {
        const result = runCli(runner, [...args, '--yes'], { home });
        expect(result.status, `应退非零: ${args.join(' ')}`).not.toBe(0);
        expect(result.stderr).toContain(reason);
      }
      expect(existsSync(target)).toBe(false);
    });

    test.skipIf(!available)('--help: 先行拦截, 退 0 且给出用法', () => {
      const { home } = makeCase('help');
      const result = runCli(runner, ['--help'], { home });

      expect(result.status).toBe(0);
      for (const text of ['create-clis', '--tier', '--no-install']) {
        expect(result.stdout).toContain(text);
      }
    });

    test.skipIf(!available)('full 档: 增强档装备保留', () => {
      const { home, target } = makeCase('full');
      const result = runCli(
        runner,
        [target, ...VARIABLES, '--tier', 'full', ...NO_HOOKS],
        { home },
      );

      expect(result.status, `应退 0: ${result.stderr}`).toBe(0);
      expect(
        existsSync(join(target, 'scripts/transcription/run-conformance.ts')),
      ).toBe(true);
      expect(existsSync(join(target, 'docs/designs/tech-debt.md'))).toBe(true);
    });

    test.skipIf(!available)(
      '缺省档位 standard: 增强档摘除, 标准档册子保留',
      () => {
        const { home, target } = makeCase('standard');
        const result = runYes(runner, target, home, NO_HOOKS);

        expect(result.status, `应退 0: ${result.stderr}`).toBe(0);
        expect(existsSync(join(target, 'scripts/transcription'))).toBe(false);
        expect(existsSync(join(target, 'docs/designs/tech-debt.md'))).toBe(
          true,
        );
      },
      TIMEOUT_MS,
    );
  });
}

/** 直调 generateProject (模块面用例共用): 真实模板夹具 + 固定词汇, hooks 由用例给定 */
function runGenerate(
  targetDir: string,
  hooks?: GenerateHooks,
): Promise<{ executed: string[] }> {
  return generateProject({
    templateDir: TEMPLATE_DIR,
    targetDir,
    vocabulary: HOOK_VOCABULARY,
    tier: 'core',
    original: ORIGINAL,
    hooks,
  });
}

/** hooks 调度契约 (模块面): 执行序 / 如实记录 / 失败中止, 直调 generateProject 不经 CLI 进程 */
describe('generateProject hooks 调度', () => {
  test('hooks 按执行序执行并如实记录; 未提供的 hook 跳过', async () => {
    const { target } = makeCase('hooks');
    const calls: string[] = [];
    const result = await runGenerate(target, {
      gitInit: () => {
        calls.push('git');
      },
      install: async () => {
        calls.push('install');
      },
    });

    expect(calls).toEqual(['git', 'install']);
    expect(result.executed).toEqual(['git init', '依赖安装']);

    // 未提供的动作不执行 (--no-git / --no-install 的折算语义)
    const second = makeCase('hooks-skip');
    const skipped = await runGenerate(second.target, {
      install: () => {
        calls.push('install-only');
      },
    });
    expect(calls).toEqual(['git', 'install', 'install-only']);
    expect(skipped.executed).toEqual(['依赖安装']);

    // 抛错即中止: 后续 hook 不执行, 半成品保留 (产物已完整生成, 失败发生在收尾面)
    const third = makeCase('hooks-fail');
    const failing = runGenerate(third.target, {
      gitInit: () => {
        throw new Error('boom');
      },
      install: () => {
        calls.push('must-not-run');
      },
    });
    await expect(failing).rejects.toThrow('boom');
    expect(calls).toEqual(['git', 'install', 'install-only']);
    expect(existsSync(join(third.target, 'package.json'))).toBe(true);
  });
});

/** 模块与产物面: 模板定位 + 格式化收口验收 (与生成物 ci 的 format-check 步骤同口径) */
describe('模块与产物面', () => {
  test('默认模板目录指向包内 assets/template', () => {
    const dir = defaultTemplateDir();
    expect(dir.endsWith(join('assets', 'template'))).toBe(true);
  });

  test('core 档产物过 prettier --check (产物内真实 CLI)', () => {
    const { home, target } = makeCase('format');
    const generated = runCli(
      'bun',
      [target, ...VARIABLES, '--tier', 'core', ...NO_HOOKS],
      { home },
    );
    expect(generated.status, `应退 0: ${generated.stderr}`).toBe(0);

    // 产物尚未装依赖: 把仓内同版本 prettier 与插件链进 node_modules, 让产物自身的
    // prettier --check 口径可用 (链接随用例清理, 不落工作区)
    for (const name of ['prettier', '@trivago/prettier-plugin-sort-imports']) {
      const link = join(target, 'node_modules', name);
      mkdirSync(dirname(link), { recursive: true });
      symlinkSync(join(REPO_ROOT, 'node_modules', name), link, 'dir');
    }

    const check = spawnSync(
      'node',
      [
        join(REPO_ROOT, 'node_modules', 'prettier', 'bin', 'prettier.cjs'),
        '--check',
        '.',
      ],
      { cwd: target, encoding: 'utf8', timeout: TIMEOUT_MS },
    );
    expect(
      check.status,
      `format-check 应通过: ${check.stdout}${check.stderr}`,
    ).toBe(0);
  });
});
