/**
 * 档位裁剪单测: 三档规则面 (standard 摘增强档 / core ⊇ standard 且加摘标准档)、裁剪行为
 * (删文件 + `scripts/ci.ts` 步骤声明手术)、裁剪自检 (规则与模板不同步即抛错), 以及一条真实
 * 模板端到端 —— 夹具直接取 buildTemplate 的真实产物 (免夹具与真实资产漂移)。
 *
 * 端到端同时钉住两件移交项: ① api-harness.ts 的三档处置 (T4: full 档该文件依赖示例包导出的
 * 领域常量); ② 裁剪后 `bun scripts/ci.ts --help` 仍可跑 (步骤表闭合 / 括号配平的实物验证)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { ORIGINAL, buildTemplate } from '../scripts/build-template.ts';
import { REPO_ROOT } from '../scripts/template-manifest.ts';
import { pruneTemplate, removeRulesFor } from './tier.ts';

/** 夹具 ci.ts: 形态对齐模板 `scripts/ci.ts` —— 单行条目 / 多行条目 (嵌套数组) / 模板字面量 /
 *  组数组 / 条目自带前置注释, 供步骤手术的精确断言 ("其它内容原样")。 */
const FIXTURE_CI_TS = `/**
 * 本地 CI 预演 (夹具, 形态对齐模板 scripts/ci.ts)
 */
import { spawnSync } from 'node:child_process';

process.chdir(join(import.meta.dir, '..'));

const { cli } = resolveCliAndApi(process.cwd());
const CLI_SRC = \`\${cli.dir}/src/cli.ts\`;

const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  'format-check': { command: 'bunx', args: ['prettier', '--check', '.'] },
  'lint:backups': { command: 'bun', args: ['scripts/lint-stray-backups.ts'] },
  // 台账对账闸门: 契约 / 语料 / 豁免三方对账 (增强档; 注释随条目一并摘除)
  'lint:coverage': {
    command: 'bun',
    args: ['scripts/transcription/validate-coverage.ts'],
  },
  'conformance:bun': {
    command: 'bun',
    args: [
      'scripts/transcription/run-conformance.ts',
      '--api-target',
      'bun scripts/transcription/api-harness.ts',
    ],
  },
};

const VERIFY_GROUP: readonly string[] = [
  'build',
  'format-check',
  'lint:coverage',
  'lint:backups',
];

const CONFORMANCE_GROUP: readonly string[] = [
  'build',
  'conformance:bun',
];

const HELP_TEXT = ['步骤名: ' + Object.keys(STEPS).join(' / ')].join('\\n');
`;

/** 夹具裁剪后的期望全文: 被摘条目 (含其前置注释) 与组数组引用行整体消失, 其余逐字节原样。
 *  注: 手术只做行级摘除, 不重排格式 —— 单元素组数组的折叠归生成期格式化收口 (T7)。 */
const FIXTURE_CI_TS_PRUNED = `/**
 * 本地 CI 预演 (夹具, 形态对齐模板 scripts/ci.ts)
 */
import { spawnSync } from 'node:child_process';

process.chdir(join(import.meta.dir, '..'));

const { cli } = resolveCliAndApi(process.cwd());
const CLI_SRC = \`\${cli.dir}/src/cli.ts\`;

const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  'format-check': { command: 'bunx', args: ['prettier', '--check', '.'] },
  'lint:backups': { command: 'bun', args: ['scripts/lint-stray-backups.ts'] },
};

const VERIFY_GROUP: readonly string[] = [
  'build',
  'format-check',
  'lint:backups',
];

const CONFORMANCE_GROUP: readonly string[] = [
  'build',
];

const HELP_TEXT = ['步骤名: ' + Object.keys(STEPS).join(' / ')].join('\\n');
`;

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** 建一个夹具模板根: `scripts/ci.ts` + 增强档机制件目录 (步骤引用的载体文件) */
const setupCiFixture = (): string => {
  const root = makeTmpRoot('create-clis-tier-');
  createdRoots.push(root);
  mkdirSync(join(root, 'scripts/transcription'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci.ts'), FIXTURE_CI_TS);
  for (const carrier of [
    'validate-coverage.ts',
    'run-conformance.ts',
    'api-harness.ts',
  ]) {
    writeFileSync(
      join(root, 'scripts/transcription', carrier),
      '// 夹具载体\n',
    );
  }
  return root;
};

/** 真实模板副本: buildTemplate 产物整棵拷一份 (每档一份, 互不干扰) */
const buildTemplateCopy = (root: string, label: string): string => {
  const source = join(root, 'template');
  if (!existsSync(join(source, 'scripts/ci.ts'))) {
    buildTemplate({ repoRoot: REPO_ROOT, outDir: source, original: ORIGINAL });
  }
  const copy = join(root, label);
  cpSync(source, copy, { recursive: true });
  return copy;
};

describe('removeRulesFor 三档规则面', () => {
  test('standard 相对 full 删除增强档, 保留核心档与标准档', () => {
    const full = removeRulesFor('full');
    expect(full.deletePaths).toEqual([]);
    expect(full.ciSteps).toEqual([]);

    const standard = removeRulesFor('standard');
    // 增强档机制件 (conformance 套件整目录) 与对应步骤
    expect(standard.deletePaths).toContain('scripts/transcription/');
    expect(standard.ciSteps).toContain('lint:coverage');
    expect(standard.ciSteps).toContain('conformance:bun');
    expect(standard.ciSteps).toContain('conformance:node');
    // 标准档装备 (技术债册子) 是 core 才摘, standard 保留
    expect(standard.deletePaths).not.toContain('docs/designs/tech-debt.md');
    // 核心档装备不得进删除面
    for (const kept of [
      'scripts/ci.ts',
      'scripts/lib/workspace.ts',
      'scripts/lint-stray-backups.ts',
      'docs/README.md',
    ]) {
      expect(standard.deletePaths).not.toContain(kept);
    }
  });

  test('core 连标准档一并删除', () => {
    const standard = removeRulesFor('standard');
    const core = removeRulesFor('core');
    for (const path of standard.deletePaths) {
      expect(core.deletePaths).toContain(path);
    }
    for (const step of standard.ciSteps) {
      expect(core.ciSteps).toContain(step);
    }
    // 标准档四条里唯一有独立文件载体的: 技术债登记册 (其余三条见 tier.ts 映射注)
    expect(standard.deletePaths).not.toContain('docs/designs/tech-debt.md');
    expect(core.deletePaths).toContain('docs/designs/tech-debt.md');
  });

  test('core 删除面不触及生成物骨架 (两包结构与 ci.ts 摘除即打断模板)', () => {
    const core = removeRulesFor('core');
    expect(core.deletePaths.some((path) => path.startsWith('packages/'))).toBe(
      false,
    );
    expect(core.deletePaths).not.toContain('scripts/ci.ts');
  });
});

describe('pruneTemplate 步骤声明手术', () => {
  test('指定步骤名从 STEPS 表与组数组一并消失, 其它内容原样', () => {
    const root = setupCiFixture();
    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
    });

    const pruned = readFileSync(join(root, 'scripts/ci.ts'), 'utf8');
    expect(pruned).toBe(FIXTURE_CI_TS_PRUNED);
    expect(pruned).not.toContain('lint:coverage');
    expect(pruned).not.toContain('conformance:bun');
  });

  test('裁剪自检: 路径缺失 / 步骤名缺失 / 步骤载体未进删除面 均抛错', () => {
    const missingPath = setupCiFixture();
    expect(() =>
      pruneTemplate(missingPath, {
        deletePaths: ['scripts/not-here/'],
        ciSteps: [],
      }),
    ).toThrow(/裁剪路径不存在/);

    const missingStep = setupCiFixture();
    expect(() =>
      pruneTemplate(missingStep, {
        deletePaths: [],
        ciSteps: ['lint:nonexistent'],
      }),
    ).toThrow(/步骤不存在/);

    // 载体未删: 摘 lint:backups 却不让它的脚本文件进删除面 —— 生成物会静默失去一道闸门
    const orphanStep = setupCiFixture();
    expect(() =>
      pruneTemplate(orphanStep, {
        deletePaths: ['scripts/transcription/'],
        ciSteps: ['lint:backups'],
      }),
    ).toThrow(/载体/);

    // 自检不过时不得留下半成品: ci.ts 逐字节原样, 删除面也未动
    expect(readFileSync(join(orphanStep, 'scripts/ci.ts'), 'utf8')).toBe(
      FIXTURE_CI_TS,
    );
    expect(
      existsSync(
        join(orphanStep, 'scripts/transcription/validate-coverage.ts'),
      ),
    ).toBe(true);
  });
});

describe('真实模板端到端', () => {
  test('三档裁剪后结构完整; core 档 bun scripts/ci.ts --help 仍可跑', () => {
    const root = makeTmpRoot('create-clis-tier-e2e-');
    createdRoots.push(root);

    // full: 全装备不动 (api-harness.ts 依赖示例包领域常量, 满档保留)
    const fullDir = buildTemplateCopy(root, 'full');
    pruneTemplate(fullDir, removeRulesFor('full'));
    expect(
      existsSync(join(fullDir, 'scripts/transcription/api-harness.ts')),
    ).toBe(true);
    expect(existsSync(join(fullDir, 'docs/designs/tech-debt.md'))).toBe(true);

    // standard: 增强档整目录摘除, 标准档 (技术债册子) 与两包骨架保留
    const standardDir = buildTemplateCopy(root, 'standard');
    pruneTemplate(standardDir, removeRulesFor('standard'));
    expect(existsSync(join(standardDir, 'scripts/transcription'))).toBe(false);
    expect(existsSync(join(standardDir, 'docs/designs/tech-debt.md'))).toBe(
      true,
    );
    expect(
      existsSync(join(standardDir, 'packages/{{NAME}}/src/index.ts')),
    ).toBe(true);
    expect(
      existsSync(join(standardDir, 'packages/{{NAME}}-cli/src/cli.ts')),
    ).toBe(true);

    // core: 连标准档一并摘除; api-harness.ts 在此随增强档消失 (T4 移交项的 core 侧)
    const coreDir = buildTemplateCopy(root, 'core');
    pruneTemplate(coreDir, removeRulesFor('core'));
    expect(existsSync(join(coreDir, 'scripts/transcription'))).toBe(false);
    expect(existsSync(join(coreDir, 'scripts/ci.ts'))).toBe(true);
    expect(existsSync(join(coreDir, 'docs/designs/tech-debt.md'))).toBe(false);

    // 步骤表闭合 / 括号配平的实物验证: ci.ts 真跑一次 --help
    const help = spawnSync('bun', ['scripts/ci.ts', '--help'], {
      cwd: coreDir,
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    const printed = help.stdout;
    expect(printed).toContain('lint:backups');
    expect(printed).toContain('typecheck');
    expect(printed).not.toContain('lint:coverage');
    expect(printed).not.toContain('conformance:bun');
    expect(printed).not.toContain('conformance:node');
  });
});
