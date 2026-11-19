/**
 * Workflow job 裁剪与 tier.ts 词法/校验加固单测 (CREATE-P0-5)。
 * 独立分文件以守 max-lines 门禁。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import {
  findResidualWorkflowJobs,
  listWorkflowJobs,
  pruneWorkflowJobs,
} from './tier-workflow.ts';
import { pruneTemplate } from './tier.ts';

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

describe('pruneWorkflowJobs 作用域与 needs 全形态裁剪 (CREATE-P0-5)', () => {
  test('追踪顶层 jobs: 块作用域, 不误伤 on / env / concurrency 内的同名二级键', () => {
    const yaml = [
      'name: CI',
      'on:',
      '  conformance:',
      '    types: [opened]',
      'env:',
      '  conformance: enabled',
      'jobs:',
      '  verify:',
      '    runs-on: ubuntu-latest',
      '  # 转写验收 job',
      '  conformance:',
      '    runs-on: macos-latest',
      '',
    ].join('\n');

    const pruned = pruneWorkflowJobs(yaml, ['conformance']);
    expect(pruned).toContain('on:\n  conformance:\n    types: [opened]');
    expect(pruned).toContain('env:\n  conformance: enabled');
    expect(pruned).toContain('  verify:\n    runs-on: ubuntu-latest');
    expect(pruned).not.toContain('macos-latest');
    expect(listWorkflowJobs(yaml)).toEqual(new Set(['verify', 'conformance']));
    expect(findResidualWorkflowJobs(pruned, ['conformance'])).toEqual([]);
  });

  test('行内数组 needs: [conformance] 全摘空时删除整行, 不留悬空 needs:', () => {
    const yaml = [
      'jobs:',
      '  conformance:',
      '    runs-on: macos-latest',
      '  release:',
      '    needs: [conformance]',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n');

    const pruned = pruneWorkflowJobs(yaml, ['conformance']);
    expect(pruned).not.toContain('needs:');
    expect(pruned).toContain('  release:\n    runs-on: ubuntu-latest');
    expect(findResidualWorkflowJobs(pruned, ['conformance'])).toEqual([]);
  });

  test('行内数组 needs: [verify, conformance] 缩为单值, 三元缩为二元', () => {
    const yaml = [
      'jobs:',
      '  verify:',
      '    runs-on: ubuntu-latest',
      '  verify-windows:',
      '    runs-on: windows-latest',
      '  conformance:',
      '    runs-on: macos-latest',
      '  gate-a:',
      '    needs: [verify, conformance]',
      '    runs-on: ubuntu-latest',
      '  gate-b:',
      '    needs: [verify, verify-windows, conformance]',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n');

    const pruned = pruneWorkflowJobs(yaml, ['conformance']);
    expect(pruned).toContain('    needs: verify\n');
    expect(pruned).toContain('    needs: [verify, verify-windows]\n');
    expect(findResidualWorkflowJobs(pruned, ['conformance'])).toEqual([]);
  });

  test('单值 needs: conformance 整行删除, 其他单值保留', () => {
    const yaml = [
      'jobs:',
      '  verify:',
      '    runs-on: ubuntu-latest',
      '  conformance:',
      '    runs-on: macos-latest',
      '  only-conf:',
      '    needs: conformance',
      '    runs-on: ubuntu-latest',
      '  keep-verify:',
      '    needs: verify',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n');

    const pruned = pruneWorkflowJobs(yaml, ['conformance']);
    expect(pruned).toContain('  only-conf:\n    runs-on: ubuntu-latest');
    expect(pruned).toContain('  keep-verify:\n    needs: verify');
    expect(findResidualWorkflowJobs(pruned, ['conformance'])).toEqual([]);
  });

  test('多行列表 needs: 全摘空时整块删除, 部分摘除时保留剩余项', () => {
    const yaml = [
      'jobs:',
      '  verify:',
      '    runs-on: ubuntu-latest',
      '  conformance:',
      '    runs-on: macos-latest',
      '  drop-all:',
      '    needs:',
      '      - conformance',
      '    runs-on: ubuntu-latest',
      '  drop-one:',
      '    needs:',
      '      - verify',
      '      - conformance',
      '    runs-on: ubuntu-latest',
      '',
    ].join('\n');

    const pruned = pruneWorkflowJobs(yaml, ['conformance']);
    expect(pruned).toContain('  drop-all:\n    runs-on: ubuntu-latest');
    expect(pruned).toContain(
      '  drop-one:\n    needs:\n      - verify\n    runs-on: ubuntu-latest',
    );
    expect(findResidualWorkflowJobs(pruned, ['conformance'])).toEqual([]);
  });
});

describe('pruneTemplate workflow 校验与 codeChars 词法边界 (CREATE-P0-5)', () => {
  test('workflow 文件缺失或目标 job 不存在时抛错且不留半成品', () => {
    const missingWf = makeTmpRoot('create-clis-wf-missing-');
    createdRoots.push(missingWf);
    expect(() =>
      pruneTemplate(missingWf, {
        deletePaths: [],
        ciSteps: [],
        packageScripts: [],
        workflowJobs: ['conformance'],
      }),
    ).toThrow(/缺少 workflow/);

    const missingJob = makeTmpRoot('create-clis-wf-nojob-');
    createdRoots.push(missingJob);
    mkdirSync(join(missingJob, '.github/workflows'), { recursive: true });
    writeFileSync(
      join(missingJob, '.github/workflows/ci.yml'),
      'jobs:\n  verify:\n    runs-on: ubuntu-latest\n',
    );
    expect(() =>
      pruneTemplate(missingJob, {
        deletePaths: [],
        ciSteps: [],
        packageScripts: [],
        workflowJobs: ['conformance'],
      }),
    ).toThrow(/workflow job 不存在/);
  });

  test('codeChars 正确处理模板插值嵌套与正则字面量, resolveConformanceCliSrc 摘除不耦合中文 JSDoc', () => {
    const root = makeTmpRoot('create-clis-lexer-');
    createdRoots.push(root);
    mkdirSync(join(root, 'scripts/transcription'), { recursive: true });
    writeFileSync(
      join(root, 'scripts/transcription/run-conformance.ts'),
      '// stub\n',
    );
    const ciSource = [
      "import { resolveProductPairs } from './lib/workspace.ts';",
      '',
      '/** 自定义英文说明 (验证不耦合固定中文 JSDoc) */',
      'function resolveConformanceCliSrc(): string {',
      '  const pairs = resolveProductPairs(process.cwd());',
      '  const re = /[\'"`({]/;',
      '  const msg = `prefix ${re.test(`nested {`) ? ({ a: 1 }).a : 0} suffix`;',
      '  return `${pairs[0]!.cli.dir}/src/cli.ts${msg.slice(0, 0)}`;',
      '}',
      '',
      'const STEPS = {',
      "  build: { command: 'bun', args: ['run', 'build'] },",
      "  'conformance:bun': {",
      "    command: 'bun',",
      "    args: () => ['scripts/transcription/run-conformance.ts', `${resolveConformanceCliSrc()}`],",
      '  },',
      '};',
      '',
      'const CONFORMANCE_GROUP = [',
      "  'build',",
      "  'conformance:bun',",
      '];',
      '',
    ].join('\n');
    writeFileSync(join(root, 'scripts/ci.ts'), ciSource);

    pruneTemplate(root, {
      deletePaths: ['scripts/transcription/'],
      ciSteps: ['conformance:bun'],
      packageScripts: [],
    });

    const pruned = readFileSync(join(root, 'scripts/ci.ts'), 'utf8');
    expect(pruned).not.toContain('conformance:bun');
    expect(pruned).not.toContain('resolveConformanceCliSrc');
    expect(pruned).not.toContain('resolveProductPairs');
    expect(pruned).toContain(
      "build: { command: 'bun', args: ['run', 'build'] }",
    );
  });
});
