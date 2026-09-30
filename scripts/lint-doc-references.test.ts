/**
 * 文档引用闸门单测: 在临时根上建 mini 文档树, 对三类断裂逐一验证「抓得住」,
 * 对保守口径 (裸 § 跳过 / 代码块内跳过 / ADR 豁免词) 逐一验证「不误报」。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  collectAdrNumbers,
  collectSectionNumbers,
  findAllIssues,
  resolveSectionTarget,
  stripFencedCode,
} from './lint-doc-references.ts';

/** 临时根 (跟随套件惯例落 ~/tmp; 一测一根, 结束后整体清理) */
const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(homedir(), 'tmp', 'doc-refs-'));
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  mkdirSync(join(root, 'docs', 'adrs'), { recursive: true });
  writeFileSync(
    join(root, 'docs', 'adrs', '0001-first.md'),
    '# ADR 0001: 首篇\n',
  );
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('stripFencedCode', () => {
  test('围栏内行置空, 围栏外与行数原样保留', () => {
    const input = ['外一', '```ts', '](不存在.md)', '```', '外二'].join('\n');
    const out = stripFencedCode(input).split('\n');
    expect(out).toHaveLength(5);
    expect(out[0]).toBe('外一');
    expect(out[2]).toBe('');
    expect(out[4]).toBe('外二');
  });
});

describe('collectSectionNumbers', () => {
  test('收集 ## N. / ### N.M / #### N.M.K 编号', () => {
    const numbers = collectSectionNumbers(
      ['## 3. 契约', '### 3.4 平移表', '#### 3.4.1 细则', '### 无编号'].join(
        '\n',
      ),
    );
    expect([...numbers].sort()).toEqual(['3', '3.4', '3.4.1']);
  });
});

describe('相对链接', () => {
  test('存在即过, 不存在抓出 (file:line 定位)', () => {
    const root = makeRoot({
      'docs/a.md': '见 [乙](b.md) 与 [缺](missing.md)。\n',
      'docs/b.md': '# 乙\n',
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'link');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('docs/a.md');
    expect(issues[0]!.line).toBe(1);
    expect(issues[0]!.reference).toBe('missing.md');
  });

  test('根相对 (/x.md) 按仓库根解析; 外链与纯锚点跳过', () => {
    const root = makeRoot({
      'docs/a.md':
        '[根](../root-ok.md) [外](https://example.com/x.md) [锚](#局部) [也外](mailto:x@y.z)\n',
      'root-ok.md': '# 根\n',
    });
    expect(findAllIssues(root).filter((f) => f.kind === 'link')).toHaveLength(
      0,
    );
  });

  test('围栏代码块内的链接不参与判定', () => {
    const root = makeRoot({
      'docs/a.md': '```md\n[缺](missing.md)\n```\n',
    });
    expect(findAllIssues(root).filter((f) => f.kind === 'link')).toHaveLength(
      0,
    );
  });
});

describe('§章节引用', () => {
  test('目标文档存在节号即过; 无该节号抓出', () => {
    const root = makeRoot({
      'docs/a.md': '见 api-surface.md §3.4 与 api-surface.md §9.9。\n',
      'docs/api-surface.md': '## 3. 契约\n### 3.4 平移表\n',
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'section');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reference).toBe('§9.9');
  });

  test('子节存在视为命中 (§3 指向的节内有 3.4)', () => {
    const root = makeRoot({
      'docs/a.md': '见 api-surface.md §3。\n',
      'docs/api-surface.md': '## 3. 契约\n### 3.4 平移表\n',
    });
    expect(
      findAllIssues(root).filter((f) => f.kind === 'section'),
    ).toHaveLength(0);
  });

  test('裸 § 无目标线索时跳过 (保守口径, 不误报)', () => {
    const root = makeRoot({
      'docs/a.md': '见 §9 「取舍」 与 设计文档 §7。\n',
    });
    expect(
      findAllIssues(root).filter((f) => f.kind === 'section'),
    ).toHaveLength(0);
  });

  test('别名解析: 窗口内出现已知别名即锁定目标文档', () => {
    const line = '见「可编程 API 面」§3.4 的';
    expect(
      resolveSectionTarget(line, line.indexOf('§'), 'docs', new Map()),
    ).toBe('docs/designs/api-surface.md');
  });
});

describe('ADR 编号', () => {
  test('存在的编号过, 幽灵编号抓出; 豁免词行跳过', () => {
    const root = makeRoot({
      'docs/a.md': '见 ADR 0001 与 ADR 0099。\n',
      'docs/b.md': 'ADR 0088 尚未创建, 按历史约定处理。\n',
    });
    expect([...collectAdrNumbers(root)]).toEqual(['0001']);
    const issues = findAllIssues(root).filter((f) => f.kind === 'adr');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('docs/a.md');
    expect(issues[0]!.reference).toBe('ADR 0099');
  });
});
