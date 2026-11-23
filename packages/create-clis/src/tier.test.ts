/**
 * 档位裁剪单测: 三档规则面 (standard 摘增强档 / core ⊇ standard 且加摘标准档)、裁剪行为
 * (删文件 + `scripts/ci.ts` 步骤声明手术 + 根 `package.json` 脚本摘除) 与裁剪自检。
 * 真实模板三档端到端见 `tier.e2e.test.ts`。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { pruneTemplate, removeRulesFor } from './tier.ts';

/** 夹具 ci.ts: 形态对齐模板 `scripts/ci.ts` —— 单行条目 / 多行条目 (嵌套数组) / 模板字面量 /
 *  组数组 / 条目自带前置注释, 供步骤手术的精确断言 ("其它内容原样")。 */
const FIXTURE_CI_TS = `/**
 * 本地 CI 预演 (夹具, 形态对齐模板 scripts/ci.ts): 消费方含 CI 三路 job (Linux / Windows / macOS)。
 *
 * 分组:
 * - \`--verify\`         验证组;
 * - \`--conformance\`    验收组 (macOS 口径);
 * - (无旗标)           全链 = 验证组 + 验收组 (重复步骤去重);
 *
 * 用法: bun scripts/ci.ts [--verify | --conformance | --only <step> | --help]
 */
import { spawnSync } from 'node:child_process';

import { makeTmpRoot } from './lib/tmp-root.ts';
import { resolveCliAndApi } from './lib/workspace.ts';

process.chdir(join(import.meta.dir, '..'));

/** CLI 入口坐标: 由 workspaces 派生 (chdir 之后相对仓库根; 夹具里只服务 conformance 步骤) */
const { cli } = resolveCliAndApi(process.cwd());
const CLI_SRC = \`\${cli.dir}/src/cli.ts\`;

const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  'format-check': { command: 'bun', args: ['fmt', '--check'] },
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
      '--target',
      \`bun \${CLI_SRC}\`,
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

const HELP_TEXT = [
  '  --verify           验证组: ' + VERIFY_GROUP.join(' → '),
  '  --conformance      验收组: ' + CONFORMANCE_GROUP.join(' → '),
  '  (无旗标)           全链 = 验证组 + 验收组 (去重)',
  '步骤名: ' + Object.keys(STEPS).join(' / '),
].join('\\n');

function resolveSteps(argv: string[]): string[] {
  const modes: string[] = [];
  for (const arg of argv) {
    if (arg === '--verify' || arg === '--conformance') modes.push(arg);
  }
  if (modes[0] === '--verify') return [...VERIFY_GROUP];
  if (modes[0] === '--conformance') return [...CONFORMANCE_GROUP];
  // 全链: 验证组 + 验收组中未出现过的步骤 (build 去重)
  return [
    ...VERIFY_GROUP,
    ...CONFORMANCE_GROUP.filter((name) => !VERIFY_GROUP.includes(name)),
  ];
}
`;

/** 夹具裁剪后的期望全文: 被摘条目 (含其前置注释) 与组数组引用行整体消失, CONFORMANCE_GROUP 及
 *  --conformance 分支随真实验收步骤同步摘净, 只服务被摘步骤的载体声明与导入一并摘净, 其余逐字节原样。 */
const FIXTURE_CI_TS_PRUNED = `/**
 * 本地 CI 预演 (夹具, 形态对齐模板 scripts/ci.ts): 消费方含 CI 双路 job (Linux / Windows)。
 *
 * 分组:
 * - \`--verify\`         验证组;
 * - (无旗标)           全链 = 验证组;
 *
 * 用法: bun scripts/ci.ts [--verify | --only <step> | --help]
 */
import { spawnSync } from 'node:child_process';

import { makeTmpRoot } from './lib/tmp-root.ts';

process.chdir(join(import.meta.dir, '..'));

const STEPS: Readonly<Record<string, Step>> = {
  build: { command: 'bun', args: ['run', 'build'] },
  'format-check': { command: 'bun', args: ['fmt', '--check'] },
  'lint:backups': { command: 'bun', args: ['scripts/lint-stray-backups.ts'] },
};

const VERIFY_GROUP: readonly string[] = [
  'build',
  'format-check',
  'lint:backups',
];

const HELP_TEXT = [
  '  --verify           验证组: ' + VERIFY_GROUP.join(' → '),
  '  (无旗标)           全链 = 验证组',
  '步骤名: ' + Object.keys(STEPS).join(' / '),
].join('\\n');

function resolveSteps(argv: string[]): string[] {
  const modes: string[] = [];
  for (const arg of argv) {
    if (arg === '--verify') modes.push(arg);
  }
  if (modes[0] === '--verify') return [...VERIFY_GROUP];
  return [...VERIFY_GROUP];
}
`;

/** 夹具根 package.json: 形态对齐模板 (含 conformance 脚本; 缩进 2 空格 + 末尾换行, 与模板同形) */
const FIXTURE_PACKAGE_JSON = `{
  "name": "demo-monorepo",
  "scripts": {
    "build": "turbo run build",
    "conformance": "bun scripts/transcription/run-conformance.ts",
    "ci": "bun scripts/ci.ts"
  }
}
`;

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0))
    rmSync(root, { recursive: true, force: true });
});

/** 建一个夹具模板根: `scripts/ci.ts` + 根 package.json + 增强档机制件目录 (步骤引用的载体文件) */
const setupCiFixture = (): string => {
  const root = makeTmpRoot('create-clis-tier-');
  createdRoots.push(root);
  mkdirSync(join(root, 'scripts/transcription'), { recursive: true });
  writeFileSync(join(root, 'scripts/ci.ts'), FIXTURE_CI_TS);
  writeFileSync(join(root, 'package.json'), FIXTURE_PACKAGE_JSON);
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

describe('removeRulesFor 三档规则面', () => {
  test('standard 相对 full 删除增强档, 保留核心档与标准档', () => {
    const full = removeRulesFor('full');
    expect(full.deletePaths).toEqual([]);
    expect(full.ciSteps).toEqual([]);
    expect(full.packageScripts).toEqual([]);
    expect(full.workflowJobs).toEqual([]);

    const standard = removeRulesFor('standard');
    // 增强档机制件 (conformance 套件、仓级转写文档与示例包协议目录) 与对应步骤 / workflow job
    expect(standard.deletePaths).toContain('scripts/transcription/');
    expect(standard.deletePaths).toContain('docs/transcription/');
    expect(standard.deletePaths).toContain('packages/{{NAME}}/docs/');
    expect(standard.ciSteps).toContain('lint:coverage');
    expect(standard.ciSteps).toContain('lint:mutants');
    expect(standard.ciSteps).toContain('fuzz');
    expect(standard.ciSteps).toContain('conformance:portable');
    expect(standard.ciSteps).toContain('conformance:bun');
    expect(standard.ciSteps).toContain('conformance:node');
    expect(standard.workflowJobs).toContain('conformance');
    // 增强档在根包上的脚本挂载 (载体随机制件摘除, 脚本不摘即悬空)
    expect(standard.packageScripts).toContain('conformance');
    expect(standard.packageScripts).toContain('fuzz');
    expect(standard.packageScripts).toContain('fuzz:diff');
    // 标准档装备 (技术债册子 + 依赖方向闸门) 是 core 才摘, standard 保留
    expect(standard.deletePaths).not.toContain('docs/designs/tech-debt.md');
    expect(standard.ciSteps).not.toContain('lint:deps');
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
    for (const script of standard.packageScripts) {
      expect(core.packageScripts).toContain(script);
    }
    expect(core.deletePaths).toContain('docs/designs/tech-debt.md');
    expect(core.deletePaths).toContain('scripts/lint-dependency-direction.ts');
    expect(core.ciSteps).toContain('lint:deps');
  });

  test('core 删除面不触及生成物骨架 (两包源码/清单与 ci.ts 摘除即打断模板)', () => {
    const core = removeRulesFor('core');
    const pkgDeletes = core.deletePaths.filter((path) =>
      path.startsWith('packages/'),
    );
    expect(pkgDeletes).toEqual(['packages/{{NAME}}/docs/']);
    expect(core.deletePaths).not.toContain('scripts/ci.ts');
  });
});

describe('pruneTemplate 步骤声明手术', () => {
  test('指定步骤名从 STEPS 表与组数组一并消失, 其它内容原样', () => {
    const root = setupCiFixture();
    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
      packageScripts: [],
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
        packageScripts: [],
      }),
    ).toThrow(/裁剪路径不存在/);

    const missingStep = setupCiFixture();
    expect(() =>
      pruneTemplate(missingStep, {
        deletePaths: [],
        ciSteps: ['lint:nonexistent'],
        packageScripts: [],
      }),
    ).toThrow(/步骤不存在/);

    // 载体未删: 摘 lint:backups 却不让它的脚本文件进删除面 —— 生成物会静默失去一道闸门
    const orphanStep = setupCiFixture();
    expect(() =>
      pruneTemplate(orphanStep, {
        deletePaths: ['scripts/transcription/'],
        ciSteps: ['lint:backups'],
        packageScripts: [],
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

  test('载体声明仍有其它消费者时保留 (判据是「摘后无引用」, 不是「见块就摘」)', () => {
    const root = makeTmpRoot('create-clis-tier-shared-');
    createdRoots.push(root);
    mkdirSync(join(root, 'scripts/transcription'), { recursive: true });
    // 把 CLI 坐标的消费点搬到保留步骤上: 坐标块不再只服务被摘步骤
    writeFileSync(
      join(root, 'scripts/ci.ts'),
      FIXTURE_CI_TS.replace(
        "'scripts/lint-stray-backups.ts'",
        "'scripts/lint-stray-backups.ts', `bun ${CLI_SRC}`",
      ),
    );
    for (const carrier of ['validate-coverage.ts', 'run-conformance.ts']) {
      writeFileSync(
        join(root, 'scripts/transcription', carrier),
        '// 夹具载体\n',
      );
    }

    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
      packageScripts: [],
    });

    const pruned = readFileSync(join(root, 'scripts/ci.ts'), 'utf8');
    expect(pruned).toContain('const CLI_SRC');
    expect(pruned).toContain(
      "import { resolveCliAndApi } from './lib/workspace.ts';",
    );
    expect(pruned).not.toContain('conformance:bun');
  });
});

describe('pruneTemplate 脚本声明手术', () => {
  test('指定脚本名从根 package.json 消失, 其余脚本原样', () => {
    const root = setupCiFixture();
    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: [],
      packageScripts: ['conformance'],
    });

    const pkg = JSON.parse(
      readFileSync(join(root, 'package.json'), 'utf8'),
    ) as {
      name: string;
      scripts: Record<string, string>;
    };
    expect('conformance' in pkg.scripts).toBe(false);
    expect(pkg.scripts.build).toBe('turbo run build');
    expect(pkg.scripts.ci).toBe('bun scripts/ci.ts');
    // 非 scripts 字段不受牵连
    expect(pkg.name).toBe('demo-monorepo');
  });

  test('脚本摘除自检: 脚本名缺失 / 脚本载体未进删除面 均抛错且不留半成品', () => {
    const missingScript = setupCiFixture();
    expect(() =>
      pruneTemplate(missingScript, {
        deletePaths: ['scripts/transcription/'],
        ciSteps: [],
        packageScripts: ['lint'],
      }),
    ).toThrow(/脚本不存在/);

    // 载体未删: 摘 conformance 却不让 transcription 目录进删除面, 生成物会留下悬空脚本
    const orphanScript = setupCiFixture();
    expect(() =>
      pruneTemplate(orphanScript, {
        deletePaths: [],
        ciSteps: [],
        packageScripts: ['conformance'],
      }),
    ).toThrow(/脚本载体/);

    // 自检不过时不得留半成品: package.json 逐字节原样
    expect(readFileSync(join(orphanScript, 'package.json'), 'utf8')).toBe(
      FIXTURE_PACKAGE_JSON,
    );
  });
});

describe('pruneTemplate 配置族 mutants 路径与 release.yml 注释同步清理', () => {
  test('摘除 scripts/transcription/ 时同步清理根配置族与 release.yml 注释残留', () => {
    const root = setupCiFixture();
    mkdirSync(join(root, '.github/workflows'), { recursive: true });
    const files: Record<string, string> = {
      '.github/workflows/ci.yml':
        'jobs:\n  verify:\n    runs-on: ubuntu-latest\n  conformance:\n    runs-on: macos-latest\n',
      '.github/workflows/release.yml':
        'jobs:\n  # 发布前置门禁 (单一事实来源): 直接复用 ci.yml 的全套三路检查 (verify / verify-windows /\n' +
        '  # conformance), 既确保 main 推送零双跑、不白烧双倍 macOS runner, 又把 Windows 兼容正式纳入发版硬门禁。\n' +
        '  checks:\n    uses: ./.github/workflows/ci.yml\n' +
        '  # 又避免前一次待审批的 waiting run 把后续 main 推送的 checks 三平台 CI 卡死在 pending。\n' +
        '  release:\n    needs: checks\n    runs-on: ubuntu-latest\n',
      'tsconfig.json':
        '{"exclude": ["dist", "node_modules", "scripts/transcription/mutants"]}\n',
      '.oxlintrc.json':
        '{"ignorePatterns": ["**/dist/**", "scripts/transcription/mutants/**"]}\n',
      '.gitignorerc.json':
        '{"custom": ["package-lock.json", "scripts/transcription/mutants/gen-*/", ".turbo/"]}\n',
      '.prettierignore': 'dist\nscripts/transcription/mutants\n',
      '.gitignore': 'node_modules/\nscripts/transcription/mutants/gen-*/\n',
      'bunfig.toml':
        '[install]\nlinker = "hoisted"\n\n[test]\npathIgnorePatterns = ["scripts/transcription/mutants/**"]\n',
    };
    for (const [rel, content] of Object.entries(files)) {
      writeFileSync(join(root, rel), content);
    }

    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
      packageScripts: ['conformance'],
      workflowJobs: ['conformance'],
    });

    for (const rel of [
      'tsconfig.json',
      '.oxlintrc.json',
      '.gitignorerc.json',
      '.prettierignore',
      '.gitignore',
      'bunfig.toml',
    ]) {
      expect(readFileSync(join(root, rel), 'utf8'), rel).not.toContain(
        'scripts/transcription/',
      );
    }
    expect(readFileSync(join(root, 'bunfig.toml'), 'utf8')).not.toContain(
      '[test]',
    );
    const relYml = readFileSync(
      join(root, '.github/workflows/release.yml'),
      'utf8',
    );
    expect(relYml).not.toMatch(/conformance/i);
    expect(relYml).toContain('全套检查 (verify / verify-windows)');
    expect(relYml).toContain('checks 双平台 CI');
  });

  test('bunfig.toml 含额外 pathIgnorePatterns 或额外 [test] 项时仅移除 transcription 条目', () => {
    const root = setupCiFixture();
    writeFileSync(
      join(root, 'bunfig.toml'),
      '[test]\ntimeout = 5000\npathIgnorePatterns = ["fixtures/**", "scripts/transcription/mutants/**"]\n',
    );
    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: [],
      packageScripts: [],
    });
    const bunfig = readFileSync(join(root, 'bunfig.toml'), 'utf8');
    expect(bunfig).toContain('[test]');
    expect(bunfig).toContain('timeout = 5000');
    expect(bunfig).toContain('pathIgnorePatterns = ["fixtures/**"]');
    expect(bunfig).not.toContain('scripts/transcription/');
  });
});

describe('pruneTemplate 设计文档索引 tech-debt.md 联动裁剪 (R2-3 #4)', () => {
  test('standard 档保留 tech-debt.md 入链; core 档删除 tech-debt.md 并替换为无死链半角 - 占位', () => {
    const setupDesigns = (readme: string): string => {
      const root = setupCiFixture();
      mkdirSync(join(root, 'docs/designs'), { recursive: true });
      writeFileSync(join(root, 'docs/designs/README.md'), readme);
      writeFileSync(join(root, 'docs/designs/tech-debt.md'), '# 技术债登记\n');
      return root;
    };
    const readme3Col =
      '# 设计文档索引\n\n| 顺序 | 文档 | 一句话 |\n| ---- | ---- | ------ |\n| 1 | [技术债登记](tech-debt.md) | 台账 |\n';

    const stdRoot = setupDesigns(readme3Col);
    pruneTemplate(stdRoot, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
      packageScripts: ['conformance'],
    });
    expect(existsSync(join(stdRoot, 'docs/designs/tech-debt.md'))).toBe(true);
    expect(
      readFileSync(join(stdRoot, 'docs/designs/README.md'), 'utf8'),
    ).toContain('[技术债登记](tech-debt.md)');

    const coreRoot = setupDesigns(readme3Col);
    pruneTemplate(coreRoot, {
      deletePaths: ['scripts/transcription/', 'docs/designs/tech-debt.md'],
      ciSteps: ['lint:coverage', 'conformance:bun'],
      packageScripts: ['conformance'],
    });
    expect(existsSync(join(coreRoot, 'docs/designs/tech-debt.md'))).toBe(false);
    const coreDesigns3 = readFileSync(
      join(coreRoot, 'docs/designs/README.md'),
      'utf8',
    );
    expect(coreDesigns3).not.toContain('tech-debt.md');
    expect(coreDesigns3).toContain('(待登记)');
    expect(coreDesigns3).not.toContain('\u2014');

    const coreRoot2Col = setupDesigns(
      '# 设计文档索引\n\n| 文档 | 一句话 |\n| ---- | ------ |\n| [技术债登记](tech-debt.md) | 台账 |\n',
    );
    pruneTemplate(coreRoot2Col, {
      deletePaths: ['docs/designs/tech-debt.md'],
      ciSteps: [],
      packageScripts: [],
    });
    const coreDesigns2 = readFileSync(
      join(coreRoot2Col, 'docs/designs/README.md'),
      'utf8',
    );
    expect(coreDesigns2).not.toContain('tech-debt.md');
    expect(coreDesigns2).toContain('| (待登记) | - |');
    expect(coreDesigns2).not.toContain('\u2014');
  });
});
