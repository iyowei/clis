/**
 * 台账校验闸门单测: 纯解析函数逐类断言; 集成路径在临时 mini 根上验证「悬空 / 漏登记」
 * 两类断裂抓得住、健康态全绿。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from '../lib/tmp-root.ts';
import {
  collectCorpusRefs,
  extractContractNumbers,
  extractExemptNumbers,
  reconcile,
  validateCoverage,
} from './validate-coverage.ts';

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
      'docs/sweep/protocol/behavior-contract.md':
        '| BC-01 | 甲 |\n| BC-02 | 乙 |\n',
      'docs/sweep/protocol/conformance/coverage.md':
        '## 一、覆盖表\n| BC-01 | 1 | 甲语料 |\n## 二、未覆盖条款\n| BC-02 | 模块级 | 理由 |\n',
      'docs/sweep/protocol/conformance/corpus/a.json':
        '{"id":"a","specRefs":["BC-01"]}\n',
    });
    expect(validateCoverage(healthy)).toEqual({
      dangling: [],
      unregistered: [],
      partial: [],
    });

    const broken = makeRoot({
      'docs/sweep/protocol/behavior-contract.md':
        '| BC-01 | 甲 |\n| BC-02 | 乙 |\n',
      'docs/sweep/protocol/conformance/coverage.md': '## 一、覆盖表\n',
      'docs/sweep/protocol/conformance/corpus/a.json':
        '{"id":"a","specRefs":["BC-01","BC-77"]}\n',
    });
    const result = validateCoverage(broken);
    expect(result.dangling).toEqual(['BC-77']);
    expect(result.unregistered).toEqual(['BC-02']);
  });

  test('corpus 目录单文件缺 specRefs 即抛 (语料损坏属硬错)', () => {
    const root = makeRoot({
      'docs/sweep/protocol/conformance/corpus/bad.json': '{"id":"bad"}\n',
    });
    expect(() =>
      collectCorpusRefs(join(root, 'docs/sweep/protocol/conformance/corpus')),
    ).toThrow(/缺 specRefs/);
  });
});
