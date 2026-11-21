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
import { ORIGINAL as SNAPSHOT_ORIGINAL } from './template-snapshot.ts';

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
    // ({{REPO_URL}}) 不可解析 slug, 按 owner/name 组合注册该整体形态; 残留检测同样覆盖
    expect(
      renderTemplate(
        '仓库 {{OWNER}}/{{NAME}} 与 {{SCOPE}}/{{NAME}}-cli',
        TARGET,
        placeholder,
      ),
    ).toBe('仓库 me/my-tool 与 @me/my-tool-cli');
    expect(containsResidual('仓库 {{OWNER}}/{{NAME}}', placeholder)).toBe(true);
    // 判别用例 (repoUrl 路径段 ≠ owner/name, 如用户用别处托管): 整体形态注册与 targetSlug
    // 定义对齐 —— 裸 slug 取仓库地址的路径段; 不注册整体形态时会被 {{OWNER}} / {{NAME}}
    // 两个单形态组合替换误落 owner/name, 此断言即钉住该差异
    const split: Vocabulary = {
      ...TARGET,
      repoUrl: 'https://gitlab.com/team/proj',
    };
    expect(renderTemplate('仓库 {{OWNER}}/{{NAME}}', split, placeholder)).toBe(
      '仓库 team/proj',
    );
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

  test('独立 scope 与 scope/ 前缀形态正确替换, 不误伤裸包斜杠与 GitHub @owner (CREATE-P0-6)', () => {
    expect(
      renderTemplate('scope: {{SCOPE}}', TARGET, TEMPLATE_VOCABULARY),
    ).toBe('scope: @me');
    const bare: Vocabulary = { ...TARGET, scope: '' };
    expect(renderTemplate('scope: {{SCOPE}}', bare, TEMPLATE_VOCABULARY)).toBe(
      'scope: ',
    );
    // 无 scope 生成时 {{SCOPE}}/pkg 连斜杠一起去除, 不留下非法 /pkg
    expect(renderTemplate('{{SCOPE}}/demo', bare, TEMPLATE_VOCABULARY)).toBe(
      'demo',
    );
    // GitHub @mention (@owner) 走 owner 通道而非 scope 通道, 无 scope 时仍保留 @me
    expect(renderTemplate('mentioning @iyowei', bare, ORIGINAL)).toBe(
      'mentioning @me',
    );
    // 异名组织 scope (@org != @alice) 独立裸形态照常替换与检残留
    const diffOrg: Vocabulary = {
      ...ORIGINAL,
      scope: '@org',
      owner: 'alice',
    };
    expect(renderTemplate('org @org and @org/x', TARGET, diffOrg)).toBe(
      'org @me and @me/x',
    );
    expect(containsResidual('scope: {{SCOPE}}', TEMPLATE_VOCABULARY)).toBe(
      true,
    );
    expect(containsResidual('org @org', diffOrg)).toBe(true);
    expect(containsResidual('org @iyowei', ORIGINAL)).toBe(true);
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

  test('目标词汇以超集包含原词汇子串 (如 iyowei-lab) 时不误报, 同文件真残留仍抓出', () => {
    const supersetOwner: Vocabulary = {
      name: 'my-sweep-nm-app',
      scope: '@iyowei-org',
      binName: 'msna',
      owner: 'iyowei-lab',
      repoUrl: 'https://github.com/iyowei-lab/my-sweep-nm-app',
    };
    expect(
      containsResidual(
        'author: iyowei-lab, pkg: @iyowei-org/my-sweep-nm-app',
        ORIGINAL,
        supersetOwner,
      ),
    ).toBe(false);
    expect(
      containsResidual(
        'author: iyowei-lab, leak: iyowei',
        ORIGINAL,
        supersetOwner,
      ),
    ).toBe(true);
  });

  test('短目标词汇 (--name node / --owner i) 不切碎真实残留致失明, 哨兵防拼缝误报 (CREATE-P0-6)', () => {
    const shortTarget: Vocabulary = {
      name: 'node',
      scope: '',
      binName: 'n',
      owner: 'i',
      repoUrl: 'https://github.com/i/node',
    };
    expect(
      containsResidual('leak: sweep-node-modules', ORIGINAL, shortTarget),
    ).toBe(true);
    expect(containsResidual('leak: iyowei', ORIGINAL, shortTarget)).toBe(true);
    expect(containsResidual('ok: node and i', ORIGINAL, shortTarget)).toBe(
      false,
    );

    const sameOwner: Vocabulary = {
      name: 'my-tool',
      scope: '@me',
      binName: 'mt',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    };
    // 若使用空串剔除 iyowei, 左右碎片会粘连拼出伪残留 sweep-node-modules; 哨兵 '\0' 阻断拼接误报
    expect(
      containsResidual('sweeiyoweip-node-modules', ORIGINAL, sameOwner),
    ).toBe(false);
  });
});

describe('行为级单源: 清单 generalize 面实扫零残留', () => {
  /**
   * 独立残留清单 (字面量, 不依赖引擎的形态推导, 防同源盲区): 与 T2 清单的词面口径同源 ——
   * 无歧义复合形态 (原包目录/坐标/-cli/bin 路径/scope/slug/owner/作者名);
   * 裸词 sweep / clis 不入词面, 不参与判定。
   */
  const RESIDUAL_LITERALS = [
    'packages/sweep-cli',
    'packages/sweep/',
    'sweep-cli',
    'bin/sweep',
    '@iyowei',
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

  test('compoundOnly 源词汇下裸词 sweepStale / sweep.ts 不被误伤', () => {
    expect(renderTemplate('sweepStale', TARGET, SNAPSHOT_ORIGINAL)).toBe(
      'sweepStale',
    );
    expect(renderTemplate("file: 'sweep.ts'", TARGET, SNAPSHOT_ORIGINAL)).toBe(
      "file: 'sweep.ts'",
    );
    expect(containsResidual('sweepStale', SNAPSHOT_ORIGINAL)).toBe(false);
  });

  test('每个 generalize 文件渲染前含词汇、渲染后零残留', () => {
    for (const entry of generalizeEntries) {
      const source = readFileSync(join(REPO_ROOT, entry.path), 'utf8');
      expect(
        containsResidual(source, SNAPSHOT_ORIGINAL),
        `${entry.path} 渲染前应含原词汇 (登记口径自证)`,
      ).toBe(true);

      const rendered = renderTemplate(source, TARGET, SNAPSHOT_ORIGINAL);
      const leftovers = RESIDUAL_LITERALS.filter((term) =>
        rendered.includes(term),
      );
      expect(leftovers, `${entry.path} 残留 (独立字面清单)`).toEqual([]);
      expect(
        containsResidual(rendered, SNAPSHOT_ORIGINAL),
        `${entry.path} 残留 (引擎判定)`,
      ).toBe(false);
    }
  });
});
