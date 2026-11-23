/**
 * 文档引用闸门单测: 在临时根上建 mini 文档树, 对三类断裂逐一验证「抓得住」,
 * 对保守口径 (裸 § 跳过 / 代码块内跳过 / ADR 豁免词) 逐一验证「不误报」。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import {
  collectAdrNumbers,
  collectSectionNumbers,
  findAllIssues,
  findOrphanDocIssues,
  resolveSectionTarget,
  stripFencedCode,
} from './lint-doc-references.ts';

/** 临时根 (跟随套件惯例落 ~/tmp; 一测一根, 结束后整体清理) */
const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = makeTmpRoot('doc-refs-');
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

  test('四反引号围栏嵌套三反引号代码块时不提前闭合反转', () => {
    const input = [
      '````md',
      '示例外层:',
      '```ts',
      '[内层伪链](inside-code.md)',
      '```',
      '[仍在外层围栏内](still-fenced.md)',
      '````',
      '正文行 [真坏链](real-broken.md)',
    ].join('\n');
    const out = stripFencedCode(input).split('\n');
    expect(out.slice(0, 7)).toEqual(['', '', '', '', '', '', '']);
    expect(out[7]).toBe('正文行 [真坏链](real-broken.md)');
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

  test('围栏代码块与行内反引号内的链接语法不参与判定', () => {
    const root = makeRoot({
      'docs/a.md':
        '示例 `[缺](inline-missing.md)`。\n```md\n[缺](missing.md)\n```\n',
    });
    expect(findAllIssues(root).filter((f) => f.kind === 'link')).toHaveLength(
      0,
    );
  });

  test('包根 README 禁止逃出包目录的相对链接 (防 npm 404); 包内链接与 GitHub URL 放行', () => {
    const root = makeRoot({
      'docs/guide.md': '# Guide\n',
      'packages/demo/README.md': [
        '[外逃](../../docs/guide.md)',
        '[包内](README.zh-CN.md)',
        '[绝对](https://github.com/iyowei/clis/blob/main/docs/guide.md)',
      ].join('\n'),
      'packages/demo/README.zh-CN.md': '# 中文\n',
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'link');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('packages/demo/README.md');
    expect(issues[0]!.reference).toBe('../../docs/guide.md');
  });

  test('包根 README 指向未纳入 package.json files 的包内文档亮红灯, npm 强制项与白名单项放行', () => {
    const root = makeRoot({
      'packages/demo/package.json': JSON.stringify({
        name: '@x/demo',
        files: ['dist', 'LICENSE'],
      }),
      'packages/demo/LICENSE': 'MIT\n',
      'packages/demo/README.zh-CN.md': '# 中文\n',
      'packages/demo/docs/README.md': '# 内部文档\n',
      'packages/demo/README.md': [
        '[中文](README.zh-CN.md)',
        '[协议](LICENSE)',
        '[未发布文档](docs/README.md)',
      ].join('\n'),
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'link');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reference).toBe('docs/README.md');
    expect(issues[0]!.message).toContain('未纳入 package.json files');
  });

  test('支持带可选 "title" 的行内链接与顶层引用式链接定义 (死链拦截 + 孤儿可达边)', () => {
    const root = makeRoot({
      'README.md': '见 [总索引](docs/README.md "文档总入口")。\n',
      'docs/README.md': [
        '# 总索引',
        '见 [首篇 ADR](adrs/0001-first.md) 与 [甲][ref-a] 与 [坏标题](missing-titled.md "标题")。',
        '',
        '[ref-a]: ./via-ref.md "可选标题"',
        '[ref-bad]: ./missing-ref.md',
      ].join('\n'),
      'docs/via-ref.md': '# 引用式链接可达文档\n',
    });
    const all = findAllIssues(root);
    const links = all.filter((f) => f.kind === 'link');
    expect(links.map((f) => f.reference)).toEqual([
      'missing-titled.md',
      './missing-ref.md',
    ]);
    expect(all.filter((f) => f.kind === 'orphan')).toEqual([]);
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

  test('别名解析: 窗口内出现通用协议别名即锁定目标文档, 非通用词不强绑', () => {
    const lineContract = '见「行为契约」§2 的';
    expect(
      resolveSectionTarget(
        lineContract,
        lineContract.indexOf('§'),
        'docs',
        new Map(),
      ),
    ).toBe('packages/sweep/docs/protocol/behavior-contract.md');
    const lineCoverage = '见「覆盖表」§1 的';
    expect(
      resolveSectionTarget(
        lineCoverage,
        lineCoverage.indexOf('§'),
        'docs',
        new Map(),
      ),
    ).toBe('packages/sweep/docs/protocol/conformance/coverage.md');
    const lineUnbound = '见「可编程 API 面」§5.1 的';
    expect(
      resolveSectionTarget(
        lineUnbound,
        lineUnbound.indexOf('§'),
        'docs',
        new Map(),
      ),
    ).toBeNull();
  });

  test('同名文档跨包引用优先命中同包而非回退根 docs/', () => {
    const root = makeRoot({
      'docs/designs/architecture.md': '## 1. 根架构\n',
      'packages/pkg-a/docs/designs/architecture.md': '## 2. 包内架构\n',
      'packages/pkg-a/docs/adrs/0030-x.md': '见 architecture.md §2。\n',
    });
    expect(
      findAllIssues(root).filter((f) => f.kind === 'section'),
    ).toHaveLength(0);
  });
});

describe('ADR 编号', () => {
  test('存在的编号过, 幽灵编号抓出; 豁免词行跳过', () => {
    const root = makeRoot({
      'docs/a.md': '见 ADR 0001 与 ADR 0099 (含历史二字但不应豁免)。\n',
      'docs/b.md': 'ADR 0088 尚未创建, 按历史约定处理。\n',
      'docs/c.md': 'ADR 0077 属于历史已删编号。\n',
    });
    expect([...collectAdrNumbers(root)]).toEqual(['0001']);
    const issues = findAllIssues(root).filter((f) => f.kind === 'adr');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('docs/a.md');
    expect(issues[0]!.reference).toBe('ADR 0099');
  });

  test('两级查找面: 包级 ADR (packages/*/docs/adrs) 同样被收集与校验', () => {
    const root = makeRoot({
      'docs/a.md': '见 ADR 0021 与 ADR 0022。\n',
      'packages/x/docs/adrs/0021-in-package.md': '# ADR 0021: 包级\n',
    });
    // 夹具自带 docs/adrs/0001-first.md, 与包级 0021 一并被收集
    expect([...collectAdrNumbers(root)]).toEqual(['0001', '0021']);
    const issues = findAllIssues(root).filter((f) => f.kind === 'adr');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.reference).toBe('ADR 0022');
  });

  test('跨级 ADR 编号重号碰撞直接抓出', () => {
    const root = makeRoot({
      'packages/x/docs/adrs/0001-dup.md': '# ADR 0001: 重号\n',
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'adr');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.message).toContain('重号碰撞');
  });
});

describe('本仓 GitHub 绝对链接与 HTML 相对 href', () => {
  test('本仓 GitHub blob/tree (main|HEAD)、workflows 及越界逃逸与 .git/ 前缀归一化校验', () => {
    const root = makeRoot({
      '.github/workflows/ci.yml': 'name: CI\n',
      'docs/exists.md': '# 存在\n',
      'docs/a.md': [
        '[好](https://github.com/iyowei/clis/blob/main/docs/exists.md#sec)',
        '[HEAD](https://github.com/iyowei/clis/blob/HEAD/docs/exists.md)',
        '[树](https://github.com/iyowei/clis/tree/main/docs)',
        '[工作流](https://github.com/iyowei/clis/actions/workflows/ci.yml)',
        '[徽章](https://github.com/iyowei/clis/actions/workflows/ci.yml/badge.svg)',
        '[断](https://github.com/iyowei/clis/blob/main/docs/gone.md)',
        '[缺工作流](https://github.com/iyowei/clis/actions/workflows/missing.yml)',
        '[越界](https://github.com/iyowei/clis/blob/main/../../outside.md)',
        '[外仓](https://github.com/other/repo/blob/main/nope.md)',
      ].join('\n'),
    });
    const issues = findAllIssues(
      root,
      'https://github.com/iyowei/clis.git/',
    ).filter((f) => f.kind === 'link');
    expect(issues.map((i) => [i.line, i.reference])).toEqual([
      [6, 'https://github.com/iyowei/clis/blob/main/docs/gone.md'],
      [7, 'https://github.com/iyowei/clis/actions/workflows/missing.yml'],
      [8, 'https://github.com/iyowei/clis/blob/main/../../outside.md'],
    ]);
  });

  test('.html 非 script/style 相对 href 校验存在性, 跳过锚点/外链/script 内伪 href', () => {
    const root = makeRoot({
      'docs/target.md': '# 目标\n',
      'docs/board.html': [
        '<!doctype html>',
        '<style>.a { content: "href=\\"missing-style.md\\""; }</style>',
        '<script>const s = `<a href="missing-script.md">x</a>`;</script>',
        '<a href="./target.md#top">好</a>',
        '<a href="#local">锚</a>',
        '<a href="mailto:test@example.com">邮</a>',
        '<a href="./missing-html.md">坏</a>',
      ].join('\n'),
    });
    const issues = findAllIssues(root).filter((f) => f.kind === 'link');
    expect(issues).toHaveLength(1);
    expect(issues[0]!.file).toBe('docs/board.html');
    expect(issues[0]!.line).toBe(7);
    expect(issues[0]!.reference).toBe('./missing-html.md');
  });
});

describe('findOrphanDocIssues 孤儿文档零入度拦截', () => {
  test('完整仓库 (含 docs/README.md) 中抓出零入度孤儿 .md, 自然入口与已入链文档放行', () => {
    const root = makeRoot({
      'README.md': '# Root\n见 [总索引](docs/README.md)。\n',
      'AGENTS.md': '# Agents\n',
      'CONTRIBUTING.md': '# Contributing\n',
      'packages/demo/CHANGELOG.md': '# Changelog\n',
      '.github/PULL_REQUEST_TEMPLATE.md': '# PR\n',
      'docs/README.md':
        '# 总索引\n见 [首篇 ADR](adrs/0001-first.md) 与 [看板](board.html) 与 [GitHub 链接](https://github.com/iyowei/clis/blob/main/docs/via-gh.md)。\n',
      'docs/board.html': '<a href="./via-html.md">通过 HTML 入链</a>\n',
      'docs/via-html.md': '# HTML 入链文档\n',
      'docs/via-gh.md': '# GitHub URL 入链文档\n',
      'docs/orphan.md': '# 无人引用的孤岛文档\n',
    });
    const orphans = findOrphanDocIssues(root);
    expect(orphans).toHaveLength(1);
    expect(orphans[0]!.file).toBe('docs/orphan.md');
    expect(orphans[0]!.kind).toBe('orphan');
  });

  test('BFS 有向图可达性精准抓出自链文档、孤岛互指环与未挂接的 tech-debt.md', () => {
    const root = makeRoot({
      'README.md': '# Root\n见 [总索引](docs/README.md)。\n',
      'docs/README.md':
        '# 总索引\n见 [首篇 ADR](adrs/0001-first.md) 与 [设计](designs/README.md)。\n',
      'docs/designs/README.md': '# 设计索引\n| 1 | (待登记) | 占位 |\n',
      'docs/designs/tech-debt.md': '# 未挂接的技术债台账\n',
      'docs/self-loop.md': '自指 [自身](self-loop.md)。\n',
      'docs/ring-a.md': '互指 [乙](ring-b.md)。\n',
      'docs/ring-b.md': '互指 [甲](ring-a.md)。\n',
    });
    const orphans = findOrphanDocIssues(root).map((f) => f.file);
    expect(orphans).toEqual([
      'docs/designs/tech-debt.md',
      'docs/ring-a.md',
      'docs/ring-b.md',
      'docs/self-loop.md',
    ]);
  });

  test('无 docs/README.md 的单测微夹具不触发孤儿拦截', () => {
    const root = makeRoot({
      'docs/isolated.md': '# 独立微夹具\n',
    });
    expect(findOrphanDocIssues(root)).toEqual([]);
  });
});

describe('中文文档排版守卫 (TD-04)', () => {
  test('拦截非代码中文行的双破折号、西文长破折号与全角标点; 放行代码块、反引号、英文行与豁免文件', () => {
    const root = makeRoot({
      'README.md': 'English prose — em-dash without Chinese is allowed.\n',
      'CHANGELOG.md': '### 变更 — 全角，豁免生成物\n',
      'CODE_OF_CONDUCT.md': '行为准则 — 全角，豁免标准文本\n',
      'docs/clean.md': [
        '# 干净中文排版',
        '正常半角标点, 冒号: 分号; 括号 (内容) 与反引号内 `—— — ，：；（）` 均合法。',
        '[中文名](https://example.com/a—b)',
        '| 列一 | 列二 |',
        '| --- | --- |',
        '```md',
        '代码块内 —— — ，：；（） 不拦',
        '```',
      ].join('\n'),
      'docs/bad.md': [
        '第一行含双破折号——违规。',
        '第二行含西文长破折号 — 违规。',
        '第三行含全角逗号，违规。',
        '第四行含全角括号（违规）。',
        '`foo`：`bar`（反引号邻接无汉字行全角冒号与括号均不漏网）',
      ].join('\n'),
    });
    const typos = findAllIssues(root).filter((f) => f.kind === 'typography');
    expect(typos.map((t) => [t.file, t.line, t.reference])).toEqual([
      ['docs/bad.md', 1, '——'],
      ['docs/bad.md', 2, '—'],
      ['docs/bad.md', 3, '，'],
      ['docs/bad.md', 4, '（'],
      ['docs/bad.md', 4, '）'],
      ['docs/bad.md', 5, '：'],
      ['docs/bad.md', 5, '（'],
      ['docs/bad.md', 5, '）'],
    ]);
  });
});
