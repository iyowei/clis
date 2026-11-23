/**
 * 台账校验闸门单测: 纯解析函数逐类断言; 集成路径在临时 mini 根上验证「悬空 / 漏登记」
 * 两类断裂抓得住、健康态全绿。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import { CONTRACT_REL, CORPUS_REL, COVERAGE_REL } from './corpus.ts';
import {
  collectCorpusRefs,
  extractContractNumbers,
  extractExemptNumbers,
  reconcile,
  validateCoverage,
} from './validate-coverage.ts';
import { validateCase } from './validate.ts';

const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = makeTmpRoot('coverage-');
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('extractContractNumbers', () => {
  test('只收行首单元格恰为条款号的主表行', () => {
    const text = [
      '| 编号 | 条款 |',
      '| --- | --- |',
      '| BC-01 | 甲 |',
      '| EC-08 | 乙 |',
      '正文提及 BC-99 不算主表行',
      '| BC-01 / BC-02 | 一格式多号不算主表单号行 |',
    ].join('\n');
    expect([...extractContractNumbers(text)].sort()).toEqual([
      'BC-01',
      'EC-08',
    ]);
  });
});

describe('extractExemptNumbers', () => {
  test('只取「二、」段内行首单元格的条款号 (含一格式多号)', () => {
    const text = [
      '## 一、覆盖表',
      '| BC-01 | 1 | 语料甲 |',
      '## 二、未覆盖条款',
      '| BC-13 | 不可黑盒 (竞态) | 说明 |',
      '| BC-21 / BC-22 | 不可黑盒 | 说明 |',
      '## 三、变异自证',
      '| BC-33 | 三节里不算 |',
    ].join('\n');
    expect([...extractExemptNumbers(text)].sort()).toEqual([
      'BC-13',
      'BC-21',
      'BC-22',
    ]);
  });
});

describe('reconcile', () => {
  test('三边对账给出悬空 / 漏登记 / 部分豁免三类', () => {
    const result = reconcile(
      new Set(['BC-01', 'BC-02', 'BC-03']),
      new Set(['BC-01', 'BC-99']),
      new Set(['BC-03', 'BC-01']),
    );
    expect(result.dangling).toEqual(['BC-99']);
    expect(result.unregistered).toEqual(['BC-02']);
    expect(result.partial).toEqual(['BC-01']);
  });
});

describe('validateCoverage 集成', () => {
  test('健康态全绿; 造一处悬空与一处漏登记即分别抓出', () => {
    const healthy = makeRoot({
      [CONTRACT_REL]:
        '| BC-01 | 甲 | 源 | CLI 黑盒 |\n| BC-02 | 乙 | 源 | 模块级 |\n',
      [COVERAGE_REL]:
        '## 一、覆盖表\n| BC-01 | 1 | a |\n## 二、未覆盖条款\n| BC-02 | 模块级 | 理由 |\n',
      [`${CORPUS_REL}/a.json`]: '{"id":"a","specRefs":["BC-01"]}\n',
    });
    expect(validateCoverage(healthy)).toEqual({
      dangling: [],
      unregistered: [],
      partial: [],
    });

    const broken = makeRoot({
      [CONTRACT_REL]:
        '| BC-01 | 甲 | 源 | CLI 黑盒 + API 黑盒 |\n| BC-02 | 乙 | 源 | CLI 黑盒 |\n',
      [COVERAGE_REL]:
        '## 一、覆盖表\n| BC-01 | 2 | wrong |\n## 二、未覆盖条款\n| BC-88 | 悬空豁免 | 无 |\n',
      [`${CORPUS_REL}/a.json`]: '{"id":"a","specRefs":["BC-01","BC-77"]}\n',
    });
    const result = validateCoverage(broken);
    expect(result.dangling).toEqual(['BC-77']);
    expect(result.unregistered).toEqual(['BC-02']);
    expect(result.danglingExempt).toEqual(['BC-88']);
    expect(result.tableMismatches?.length).toBeGreaterThan(0);
    expect(result.surfaceGaps?.some((g) => g.includes('BC-01'))).toBe(true);
  });

  test('corpus 目录单文件缺 specRefs 即抛 (语料损坏属硬错)', () => {
    const root = makeRoot({
      [`${CORPUS_REL}/bad.json`]: '{"id":"bad"}\n',
    });
    expect(() => collectCorpusRefs(join(root, CORPUS_REL))).toThrow(
      /缺 specRefs/,
    );
  });
});

describe('validateCase 严格 schema 对齐', () => {
  test('合法 cli / api 用例 (含 nested / git / noPackageJson 可选布尔键) 全绿通过', () => {
    expect(
      validateCase({
        id: 'cli-valid-case',
        specRefs: ['BC-01', 'OF-02'],
        tags: ['portable', 'smoke'],
        fixture: {
          projects: [
            {
              dir: 'proj-a',
              files: 2,
              bytesPerFile: 128,
              nested: true,
              git: false,
              noPackageJson: true,
            },
          ],
          symlinks: [{ at: 'link-a', to: 'proj-a' }],
        },
        setup: [{ write: { path: 'cfg.json', text: '{}', ageDays: 3 } }],
        run: { argv: ['--dry-run'], env: { DEMO_CFG: '1' }, cwd: '.' },
        expect: {
          exitCode: 0,
          stdoutContains: ['proj-a'],
          fs: [{ path: 'cfg.json', state: 'exists', kind: 'file' }],
        },
      }),
    ).toEqual([]);

    expect(
      validateCase({
        id: 'api-valid-case',
        kind: 'api',
        specRefs: ['BC-03'],
        fixture: {},
        env: { DEMO_ENV: 'ok' },
        steps: [{ call: { export: 'greet', args: ['world'] } }],
        expect: {
          result: { exact: 'hello world' },
          events: { lastIs: 'done', mustInclude: ['start'] },
        },
      }),
    ).toEqual([]);
  });

  test('拒绝全层级未知属性 (防拼错断言键名静默假绿) 与非布尔夹具选项', () => {
    const cliProblems = validateCase({
      id: 'bad-keys',
      specRefs: ['BC-01'],
      extraTop: 1,
      fixture: {
        bogusFix: true,
        projects: [{ dir: 'a', nested: 'yes', typoKey: 1 }],
        symlinks: [{ at: 'l', to: 'a', extraLink: 1 }],
      },
      setup: [{ write: { path: 'x.txt', text: 'hi', typoWrite: 1 }, extra: 1 }],
      run: { argv: [], typoRun: true },
      expect: {
        exitCode: 0,
        stdoutContain: ['typo-singular'],
        fs: [{ path: 'x.txt', state: 'exists', typoFs: 1 }],
      },
    });
    expect(cliProblems).toContain('case 含未知属性 "extraTop"');
    expect(cliProblems).toContain('fixture 含未知属性 "bogusFix"');
    expect(cliProblems).toContain('fixture.projects[0] 含未知属性 "typoKey"');
    expect(cliProblems).toContain('fixture.projects[0].nested 须为布尔');
    expect(cliProblems).toContain('fixture.symlinks[0] 含未知属性 "extraLink"');
    expect(cliProblems).toContain('setup[0] 含未知属性 "extra"');
    expect(cliProblems).toContain('setup[0].write 含未知属性 "typoWrite"');
    expect(cliProblems).toContain('run 含未知属性 "typoRun"');
    expect(cliProblems).toContain('expect 含未知属性 "stdoutContain"');
    expect(cliProblems).toContain('expect.fs[0] 含未知属性 "typoFs"');

    const apiProblems = validateCase({
      id: 'bad-api-keys',
      kind: 'api',
      specRefs: ['BC-02'],
      fixture: {},
      steps: [{ call: { export: 'fn', badCall: 1 }, badStep: 1 }],
      expect: {
        error: { code: 'E_X', badErr: 1 },
        events: { lastIs: 'end', badEvt: 1 },
      },
    });
    expect(apiProblems).toContain('steps[0] 含未知属性 "badStep"');
    expect(apiProblems).toContain('steps[0].call 含未知属性 "badCall"');
    expect(apiProblems).toContain('expect.error 含未知属性 "badErr"');
    expect(apiProblems).toContain('expect.events 含未知属性 "badEvt"');
  });

  test('拒绝 specRefs 与 tags 重复元素 (uniqueItems: true)', () => {
    const problems = validateCase({
      id: 'dup-items',
      specRefs: ['BC-01', 'BC-01'],
      tags: ['apfs', 'apfs'],
      fixture: {},
      run: {},
      expect: { exitCode: 0 },
    });
    expect(problems).toContain('specRefs 含重复元素 "BC-01"');
    expect(problems).toContain('tags 含重复元素 "apfs"');
  });

  test('拒绝 steps[].call 分支属性混搭畸形对象与顶层 kind: null', () => {
    const mixedCallProblems = validateCase({
      id: 'bad-step-call',
      kind: 'api',
      specRefs: ['BC-01'],
      fixture: {},
      steps: [
        { call: { export: 'x', on: 123 } },
        { call: { export: 'x', on: '', method: '' } },
        { call: { on: 'h', method: 'm', export: '' } },
        { call: { export: 'x' }, collectEvents: false },
      ],
      expect: { result: { exact: 1 } },
    });
    expect(mixedCallProblems).toContain(
      'steps[0].call 须恰为创建步 (export) 或方法步 (on + method)',
    );
    expect(mixedCallProblems).toContain(
      'steps[1].call 须恰为创建步 (export) 或方法步 (on + method)',
    );
    expect(mixedCallProblems).toContain(
      'steps[2].call 须恰为创建步 (export) 或方法步 (on + method)',
    );
    expect(mixedCallProblems).toContain(
      'steps[3]: 创建步不支持 collectEvents (仅方法步)',
    );

    const nullKindProblems = validateCase({
      id: 'null-kind',
      kind: null,
      specRefs: ['BC-01'],
      fixture: {},
      run: {},
      expect: { exitCode: 0 },
    });
    expect(nullKindProblems).toContain('kind 须为 "cli" 或 "api"');
  });
});
