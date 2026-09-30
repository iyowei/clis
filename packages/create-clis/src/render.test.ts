/**
 * 泛化替换引擎单测: 五基线形态 / 实测扩展形态 / -cli 变体边界, 以及一条行为级单源实测 ——
 * 对模板清单 (scripts/template-manifest.ts) 全部 generalize 条目的真实文件跑「渲染 → 零残留」。
 *
 * 最后一条是本任务的验收核心: 原词汇的实际形态由实扫暴露 (不止 spec 词汇表五行), 替换面以
 * 实扫零残留为准, 而非纸面词汇表对齐; 该用例同时用独立字面清单复核, 防引擎自身判定盲区。
 * 替换面按二轮裁定收窄为无歧义复合形态 (裸 `sweep` / `clis` 退出, 口径见 render.ts 头注)。
 */
import { describe, expect, test } from 'bun:test';

import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT, TEMPLATE_MANIFEST } from '../scripts/template-manifest.ts';
import {
  TEMPLATE_VOCABULARY,
  type Vocabulary,
  containsResidual,
  renderTemplate,
} from './render.ts';

/** 本仓原词汇: 五基线 + 扩展形态 author (LICENSE / author 字段的展示名); 裸词形态不入替换面 */
const ORIGINAL: Vocabulary = {
  name: 'sweep-node-modules',
  scope: '@iyowei',
  binName: 'sweep-nm',
  owner: 'iyowei',
  repoUrl: 'https://github.com/iyowei/clis',
  author: 'iTonyYo',
};

/** 目标词汇 (用户变量): slug 由 repoUrl 派生, 作者名缺省回退 owner */
const TARGET: Vocabulary = {
  name: 'my-tool',
  scope: '@me',
  binName: 'mt',
  owner: 'me',
  repoUrl: 'https://github.com/me/my-tool',
};

describe('renderTemplate 词汇形态', () => {
  test('五种形态全替换且幂等', () => {
    const original = {
      name: 'sweep-node-modules',
      scope: '@iyowei',
      binName: 'sweep-nm',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/clis',
    };
    const v = {
      name: 'my-tool',
      scope: '@me',
      binName: 'mt',
      owner: 'me',
      repoUrl: 'https://github.com/me/my-tool',
    };
    const input =
      '@iyowei/sweep-node-modules 与 sweep-node-modules 与 sweep-nm 与 iyowei 与 https://github.com/iyowei/clis';
    const out = renderTemplate(input, v, original);
    expect(out).toBe(
      '@me/my-tool 与 my-tool 与 mt 与 me 与 https://github.com/me/my-tool',
    );
    expect(containsResidual(out, original)).toBe(false);
    expect(renderTemplate(out, v, original)).toBe(out); // 幂等
  });

  test('-cli 变体先长后短, 不被短形态部分命中', () => {
    expect(
      renderTemplate('@iyowei/sweep-node-modules-cli', TARGET, ORIGINAL),
    ).toBe('@me/my-tool-cli');
    expect(
      renderTemplate(
        'packages/sweep-node-modules-cli/src/cli.ts',
        TARGET,
        ORIGINAL,
      ),
    ).toBe('packages/my-tool-cli/src/cli.ts');
    expect(
      renderTemplate(
        'sweep-node-modules-cli 与 sweep-node-modules',
        TARGET,
        ORIGINAL,
      ),
    ).toBe('my-tool-cli 与 my-tool');
  });

  test('bin 名包含项目名时, 长形态 (bin) 优先生效', () => {
    const original: Vocabulary = {
      name: 'sweep',
      scope: '@iyowei',
      binName: 'sweep-nm',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/clis',
    };
    const target: Vocabulary = {
      name: 'my-tool',
      scope: '@me',
      binName: 'mt',
      owner: 'me',
      repoUrl: 'https://github.com/me/my-tool',
    };
    expect(renderTemplate('sweep-nm 与 sweep', target, original)).toBe(
      'mt 与 my-tool',
    );
  });

  test('实测扩展形态: 作者署名 / 裸 slug (无歧义复合面)', () => {
    expect(
      renderTemplate('iTonyYo (https://github.com/iTonyYo)', TARGET, ORIGINAL),
    ).toBe('me (https://github.com/me)');
    expect(renderTemplate('--repo iyowei/clis', TARGET, ORIGINAL)).toBe(
      '--repo me/my-tool',
    );
  });

  test('词面收窄边界: 裸词形态 (sweep / clis) 不在替换面, 原样保留', () => {
    // 裸 clis 误伤 create-clis (生成器包名) 与根包名; 裸 sweep 误伤动词义标识符 / 英文句子 / 产品区路径
    expect(renderTemplate('create-clis', TARGET, ORIGINAL)).toBe('create-clis');
    expect(renderTemplate('sweepStale', TARGET, ORIGINAL)).toBe('sweepStale');
    expect(
      renderTemplate(
        'Programmable API to sweep node_modules',
        TARGET,
        ORIGINAL,
      ),
    ).toBe('Programmable API to sweep node_modules');
    expect(
      renderTemplate(
        '"name": "clis" 与 docs/sweep/protocol/conformance/corpus',
        TARGET,
        ORIGINAL,
      ),
    ).toBe('"name": "clis" 与 docs/sweep/protocol/conformance/corpus');
  });

  test('仓库地址后缀形态随整段地址一并替换', () => {
    expect(
      renderTemplate(
        'git+https://github.com/iyowei/clis.git',
        TARGET,
        ORIGINAL,
      ),
    ).toBe('git+https://github.com/me/my-tool.git');
    expect(
      renderTemplate('https://github.com/iyowei/clis#readme', TARGET, ORIGINAL),
    ).toBe('https://github.com/me/my-tool#readme');
    expect(
      renderTemplate(
        '[SECURITY.md](https://github.com/iyowei/clis/blob/main/SECURITY.md)',
        TARGET,
        ORIGINAL,
      ),
    ).toBe(
      '[SECURITY.md](https://github.com/me/my-tool/blob/main/SECURITY.md)',
    );
  });

  test('目标无 scope (裸包名) 时省略包前缀', () => {
    const bare: Vocabulary = {
      name: 'my-tool',
      scope: '',
      binName: 'mt',
      owner: 'me',
      repoUrl: 'https://github.com/me/my-tool',
    };
    expect(
      renderTemplate('"@iyowei/sweep-node-modules": "0.5.1"', bare, ORIGINAL),
    ).toBe('"my-tool": "0.5.1"');
  });

  test('模板占位形态 (TEMPLATE_VOCABULARY 的 {{NAME}} 式) 构建期 / 生成期双向适用', () => {
    // 与 src/render.ts 的 TEMPLATE_VOCABULARY 同拼写: 双花括号大写形态, 不撞 JS 插值 `${}`
    const placeholder: Vocabulary = {
      name: '{{NAME}}',
      scope: '{{SCOPE}}',
      binName: '{{BIN_NAME}}',
      owner: '{{OWNER}}',
      repoUrl: '{{REPO_URL}}',
    };
    // 构建期方向: 原词汇落为占位符 (slug 由 repoUrl 派生, 作者名回退 owner; 裸词与产品区路径不在替换面)
    expect(
      renderTemplate(
        'iyowei/clis 与 sweep-nm 与 iTonyYo',
        placeholder,
        ORIGINAL,
      ),
    ).toBe('{{OWNER}}/{{NAME}} 与 {{BIN_NAME}} 与 {{OWNER}}');
    // 生成期方向: 占位符是「原词汇」, 替换与残留检测对称适用
    expect(renderTemplate('name = {{NAME}}', TARGET, placeholder)).toBe(
      'name = my-tool',
    );
    expect(containsResidual('name = {{NAME}}', placeholder)).toBe(true);
    expect(containsResidual('name = my-tool', placeholder)).toBe(false);
    // 裸 slug 组合形态 (构建期 targetSlug 写出, 如 npm-trust-guard 的仓库名): 生成期源地址
    // ({{REPO_URL}}) 不可解析 slug, 按 owner/name 组合形态回退注册, 替换与残留检测均覆盖
    expect(
      renderTemplate(
        '仓库 {{OWNER}}/{{NAME}} 与 {{SCOPE}}/{{NAME}}-cli',
        TARGET,
        placeholder,
      ),
    ).toBe('仓库 me/my-tool 与 @me/my-tool-cli');
    expect(containsResidual('仓库 {{OWNER}}/{{NAME}}', placeholder)).toBe(true);
  });

  test('占位符拼写不与 JS 模板字面量插值撞车 (三代拼写回归)', () => {
    // 单花括号拼写 `{name}` 是 `${name}` 的真子串, 生成期会把插值打成 `$用户词` (实测事故);
    // 双花括号拼写下, 代码里的插值原样保留
    expect(
      renderTemplate('`=== ${name} ===`', TARGET, TEMPLATE_VOCABULARY),
    ).toBe('`=== ${name} ===`');
    expect(
      renderTemplate('`清理陈旧产物: ${name}\\n`', TARGET, TEMPLATE_VOCABULARY),
    ).toBe('`清理陈旧产物: ${name}\\n`');
  });

  test('不含词汇的内容原样返回', () => {
    const clean = '# Contributing\n\n普通文本, 无原词汇。\n';
    expect(renderTemplate(clean, TARGET, ORIGINAL)).toBe(clean);
  });
});

describe('containsResidual 残留检测', () => {
  test('命中任一原词汇形态即判残留', () => {
    expect(containsResidual('sweep-node-modules', ORIGINAL)).toBe(true);
    expect(containsResidual('@iyowei/sweep-node-modules-cli', ORIGINAL)).toBe(
      true,
    );
    expect(containsResidual('仓库 iyowei/clis', ORIGINAL)).toBe(true);
    expect(containsResidual('Copyright (c) 2026 iTonyYo', ORIGINAL)).toBe(true);
  });

  test('词面收窄边界: 裸词子串形态不判残留', () => {
    // 与 T2 清单「词面收窄边界」用例同口径: create-clis / sweepStale / 动词义 sweep 均不判词
    expect(containsResidual('create-clis', ORIGINAL)).toBe(false);
    expect(containsResidual('sweepStale', ORIGINAL)).toBe(false);
    expect(containsResidual('见 docs/sweep/ 产品区', ORIGINAL)).toBe(false);
  });

  test('替换后与干净内容均不判残留', () => {
    expect(
      containsResidual('my-tool 与 @me/my-tool 与 docs/sweep/', ORIGINAL),
    ).toBe(false);
    expect(containsResidual('# 新项目\n', ORIGINAL)).toBe(false);
  });

  test('传入目标词汇时排除重合形态 (用户词汇与源词汇同名不误报)', () => {
    // owner 同为本仓 owner: 生成物里出现 iyowei 是预期结果, 不算残留
    const sameOwner: Vocabulary = {
      name: 'my-tool',
      scope: '@me',
      binName: 'mt',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    };
    expect(containsResidual('author: iyowei', ORIGINAL, sameOwner)).toBe(false);
    // 不传排除面时维持全量判据 (构建自检面)
    expect(containsResidual('author: iyowei', ORIGINAL)).toBe(true);
    // 与目标词汇无关的原形态照常判残留
    expect(
      containsResidual('残留 sweep-node-modules', ORIGINAL, sameOwner),
    ).toBe(true);
  });
});

describe('行为级单源: 清单 generalize 面实扫零残留', () => {
  /**
   * 独立残留清单 (字面量, 不依赖引擎的形态推导, 防同源盲区): 与 T2 清单的词面口径同源 ——
   * 6 个无歧义复合形态 (原包名含 -cli 变体前缀 / 原 scope / 原 bin 名 / 裸仓库 slug / 原 owner /
   * 作者名); 裸词 sweep / clis 不入词面, 不参与判定。
   */
  const RESIDUAL_LITERALS = [
    'sweep-node-modules',
    '@iyowei',
    'sweep-nm',
    'iyowei/clis',
    'iyowei',
    'iTonyYo',
  ] as const;

  const generalizeEntries = TEMPLATE_MANIFEST.filter(
    (entry) => entry.disposition === 'generalize',
  );

  test('清单 generalize 条目非空 (防断言空转)', () => {
    expect(generalizeEntries.length).toBeGreaterThan(0);
  });

  test('每个 generalize 文件渲染前含词汇、渲染后零残留', () => {
    for (const entry of generalizeEntries) {
      const source = readFileSync(join(REPO_ROOT, entry.path), 'utf8');
      expect(
        containsResidual(source, ORIGINAL),
        `${entry.path} 渲染前应含原词汇 (登记口径自证)`,
      ).toBe(true);

      const rendered = renderTemplate(source, TARGET, ORIGINAL);
      const leftovers = RESIDUAL_LITERALS.filter((term) =>
        rendered.includes(term),
      );
      expect(leftovers, `${entry.path} 残留 (独立字面清单)`).toEqual([]);
      expect(
        containsResidual(rendered, ORIGINAL),
        `${entry.path} 残留 (引擎判定)`,
      ).toBe(false);
    }
  });
});
