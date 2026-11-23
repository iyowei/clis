/**
 * 档位裁剪 · 真实模板端到端验证: 取 `buildTemplate` 真实产物逐档 (`full` / `standard` / `core`)
 * 裁剪, 校验文件/目录删除面、`docs/README.md` 与 PR 模板联动摘除、根 `package.json` 脚本摘除、
 * workflow job 摘除以及 `scripts/ci.ts --help` / `--conformance` 实物运行结果。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { ORIGINAL, buildTemplate } from '../scripts/build-template.ts';
import { REPO_ROOT } from '../scripts/template-manifest.ts';
import { pruneTemplate, removeRulesFor } from './tier.ts';

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

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

const MUTANT_CONFIG_CARRIERS: readonly string[] = [
  'tsconfig.json',
  '.oxlintrc.json',
  '.prettierignore',
  'bunfig.toml',
  '.gitignorerc.json',
  '_gitignore',
];

function expectMutantConfigsState(dir: string, present: boolean): void {
  for (const rel of MUTANT_CONFIG_CARRIERS) {
    const text = readFileSync(join(dir, rel), 'utf8');
    if (present) {
      expect(text, `${rel} 应含 scripts/transcription/mutants`).toContain(
        'scripts/transcription/mutants',
      );
    } else {
      expect(text, `${rel} 不得残留 scripts/transcription/`).not.toContain(
        'scripts/transcription/',
      );
    }
  }
}

function assertFullTier(fullDir: string): void {
  expect(
    existsSync(join(fullDir, 'scripts/transcription/api-harness.ts')),
  ).toBe(true);
  expect(existsSync(join(fullDir, 'docs/transcription/README.md'))).toBe(true);
  expect(
    existsSync(
      join(fullDir, 'packages/{{NAME}}/docs/protocol/behavior-contract.md'),
    ),
  ).toBe(true);
  const fullDocsReadme = readFileSync(join(fullDir, 'docs/README.md'), 'utf8');
  expect(fullDocsReadme).toContain('transcription/README.md');
  expect(fullDocsReadme).toContain(
    '../packages/{{NAME}}/docs/protocol/behavior-contract.md',
  );
  expect(fullDocsReadme).toContain(
    '../packages/{{NAME}}/docs/protocol/conformance/coverage.md',
  );
  expectMutantConfigsState(fullDir, true);
  expect(
    readFileSync(join(fullDir, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
  ).toContain('conformance suite');
  expect(existsSync(join(fullDir, 'docs/designs/tech-debt.md'))).toBe(true);
  expect(
    readFileSync(join(fullDir, 'docs/designs/README.md'), 'utf8'),
  ).toContain('[技术债登记](tech-debt.md)');
  expect(
    existsSync(
      join(
        fullDir,
        'packages/{{NAME}}/docs/protocol/conformance/corpus.schema.json',
      ),
    ),
  ).toBe(true);
  const fullScripts = (
    JSON.parse(readFileSync(join(fullDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  expect(typeof fullScripts.conformance).toBe('string');
  expect(typeof fullScripts.fuzz).toBe('string');
  expect(typeof fullScripts['fuzz:diff']).toBe('string');
  const fullHelp = spawnSync('bun', ['scripts/ci.ts', '--help'], {
    cwd: fullDir,
    encoding: 'utf8',
  });
  expect(fullHelp.status).toBe(0);
  expect(fullHelp.stdout).toContain('--conformance');
  expect(fullHelp.stdout).toContain('lint:mutants');
  expect(fullHelp.stdout).toContain('fuzz');
  expect(fullHelp.stdout).toContain('conformance:portable');
  expect(fullHelp.stdout).toContain('conformance:bun');
  expect(fullHelp.stdout).toContain('conformance:node');
}

function assertStandardTier(standardDir: string): void {
  expect(existsSync(join(standardDir, 'scripts/transcription'))).toBe(false);
  expect(existsSync(join(standardDir, 'docs/transcription'))).toBe(false);
  expect(existsSync(join(standardDir, 'packages/{{NAME}}/docs'))).toBe(false);
  const stdDocsReadme = readFileSync(
    join(standardDir, 'docs/README.md'),
    'utf8',
  );
  expect(stdDocsReadme).not.toContain('transcription/README.md');
  expect(stdDocsReadme).not.toContain('behavior-contract.md');
  expect(stdDocsReadme).not.toContain('coverage.md');
  expectMutantConfigsState(standardDir, false);
  expect(
    readFileSync(join(standardDir, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
  ).not.toContain('conformance suite');
  expect(existsSync(join(standardDir, 'docs/designs/tech-debt.md'))).toBe(true);
  expect(
    readFileSync(join(standardDir, 'docs/designs/README.md'), 'utf8'),
  ).toContain('[技术债登记](tech-debt.md)');
  expect(
    existsSync(join(standardDir, 'scripts/lint-dependency-direction.ts')),
  ).toBe(true);
  expect(existsSync(join(standardDir, 'packages/{{NAME}}/src/index.ts'))).toBe(
    true,
  );
  expect(
    existsSync(join(standardDir, 'packages/{{NAME}}-cli/src/cli.ts')),
  ).toBe(true);
  const standardScripts = (
    JSON.parse(readFileSync(join(standardDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  expect(standardScripts.conformance).toBeUndefined();
  expect(standardScripts.fuzz).toBeUndefined();
  expect(standardScripts['fuzz:diff']).toBeUndefined();
  const stdCiYml = readFileSync(
    join(standardDir, '.github/workflows/ci.yml'),
    'utf8',
  );
  const stdRelYml = readFileSync(
    join(standardDir, '.github/workflows/release.yml'),
    'utf8',
  );
  expect(stdCiYml).not.toMatch(/conformance/i);
  expect(stdRelYml).not.toMatch(/conformance/i);
  expect(stdRelYml).toContain('uses: ./.github/workflows/ci.yml');
  expect(stdRelYml).toContain('needs: checks');
  expect(readFileSync(join(standardDir, 'scripts/ci.ts'), 'utf8')).not.toMatch(
    /conformance/i,
  );
  const stdHelp = spawnSync('bun', ['scripts/ci.ts', '--help'], {
    cwd: standardDir,
    encoding: 'utf8',
  });
  expect(stdHelp.status).toBe(0);
  expect(stdHelp.stdout).toContain('lint:deps');
  expect(stdHelp.stdout).not.toContain('--conformance');
  expect(stdHelp.stdout).not.toContain('lint:mutants');
  expect(stdHelp.stdout).not.toContain('conformance:portable');
  const stdConf = spawnSync('bun', ['scripts/ci.ts', '--conformance'], {
    cwd: standardDir,
    encoding: 'utf8',
  });
  expect(stdConf.status).toBe(2);
  expect(stdConf.stderr).toContain('--conformance');
}

function assertCoreTier(coreDir: string): void {
  expect(existsSync(join(coreDir, 'scripts/transcription'))).toBe(false);
  expect(existsSync(join(coreDir, 'docs/transcription'))).toBe(false);
  expect(existsSync(join(coreDir, 'packages/{{NAME}}/docs'))).toBe(false);
  const coreDocsReadme = readFileSync(join(coreDir, 'docs/README.md'), 'utf8');
  expect(coreDocsReadme).not.toContain('transcription/README.md');
  expect(coreDocsReadme).not.toContain('behavior-contract.md');
  expect(coreDocsReadme).not.toContain('coverage.md');
  expectMutantConfigsState(coreDir, false);
  expect(
    readFileSync(join(coreDir, '.github/PULL_REQUEST_TEMPLATE.md'), 'utf8'),
  ).not.toContain('conformance suite');
  expect(existsSync(join(coreDir, 'scripts/ci.ts'))).toBe(true);
  expect(existsSync(join(coreDir, 'docs/designs/tech-debt.md'))).toBe(false);
  const coreDesignsReadme = readFileSync(
    join(coreDir, 'docs/designs/README.md'),
    'utf8',
  );
  expect(coreDesignsReadme).not.toContain('tech-debt.md');
  expect(coreDesignsReadme).toContain('(待登记)');
  expect(coreDesignsReadme).not.toContain('\u2014');
  expect(
    existsSync(join(coreDir, 'scripts/lint-dependency-direction.ts')),
  ).toBe(false);
  const coreScripts = (
    JSON.parse(readFileSync(join(coreDir, 'package.json'), 'utf8')) as {
      scripts: Record<string, string>;
    }
  ).scripts;
  expect(coreScripts.conformance).toBeUndefined();
  expect(coreScripts.fuzz).toBeUndefined();
  expect(coreScripts['fuzz:diff']).toBeUndefined();
  expect(typeof coreScripts.ci).toBe('string');

  const prunedCi = readFileSync(join(coreDir, 'scripts/ci.ts'), 'utf8');
  expect(prunedCi).not.toMatch(/conformance/i);
  expect(prunedCi).not.toContain('resolveConformanceCliSrc');
  expect(prunedCi).not.toContain('resolveProductPairs');
  expect(prunedCi).not.toContain('lint:deps');
  expect(prunedCi).toContain(
    "import { spawn, spawnSync } from 'node:child_process';",
  );
  expect(prunedCi).toContain('interface Step {');
  expect(prunedCi).toContain(
    "import { makeTmpRoot } from './lib/tmp-root.ts';",
  );

  const help = spawnSync('bun', ['scripts/ci.ts', '--help'], {
    cwd: coreDir,
    encoding: 'utf8',
  });
  expect(help.status).toBe(0);
  const printed = help.stdout;
  expect(printed).toContain('lint:backups');
  expect(printed).toContain('typecheck');
  expect(printed).not.toContain('--conformance');
  expect(printed).not.toContain('lint:deps');
  expect(printed).not.toContain('lint:coverage');
  expect(printed).not.toContain('lint:mutants');
  expect(printed).not.toContain('conformance:portable');
  expect(printed).not.toContain('conformance:bun');
  expect(printed).not.toContain('conformance:node');
  const coreConf = spawnSync('bun', ['scripts/ci.ts', '--conformance'], {
    cwd: coreDir,
    encoding: 'utf8',
  });
  expect(coreConf.status).toBe(2);
  expect(coreConf.stderr).toContain('--conformance');
}

describe('真实模板端到端', () => {
  test('三档裁剪后结构完整; core 档 bun scripts/ci.ts --help 仍可跑', () => {
    const root = makeTmpRoot('create-clis-tier-e2e-');
    createdRoots.push(root);

    const fullDir = buildTemplateCopy(root, 'full');
    pruneTemplate(fullDir, removeRulesFor('full'));
    assertFullTier(fullDir);

    const standardDir = buildTemplateCopy(root, 'standard');
    pruneTemplate(standardDir, removeRulesFor('standard'));
    assertStandardTier(standardDir);

    const coreDir = buildTemplateCopy(root, 'core');
    pruneTemplate(coreDir, removeRulesFor('core'));
    assertCoreTier(coreDir);
  });
});
