/**
 * `@iyowei/wake-cli` 双语帮助页渲染器 (与 `fan-cli` / `sweep-cli` 同源的 Apple HIG 分层结构与 SGR 色盘)。
 *
 * 排版红线 (全仓所有 CLI 强制遵循):
 * 所有两栏分区 (子命令 / 选项 / 示例 / 使用须知 / 退出码 / 文档与源码中的键值行) 必须先汇总左侧文本,
 * 通过 `computeHelpDescColumn` 按终端显示宽度 (`CJK=2, ASCII=1`) 计算全页唯一的右栏左边界 `descCol`,
 * 再由 `alignHelpRow` 统一对齐输出, 严禁按区块各自对齐导致右栏文字呈锯齿状错落。
 */
import {
  type Locale,
  alignHelpRow,
  computeHelpDescColumn,
} from '@iyowei/cli-i18n';

import { CATALOG_EN, CATALOG_ZH, type HelpCatalog } from './help-catalog.ts';
import { BAR_BLOCK, paint } from './render-primitives.ts';

const GITHUB_URL = 'https://github.com/iyowei/clis/tree/main/packages/wake-cli';
const RULE_WIDTH = 76;

function examplePlainParts(item: HelpCatalog['examples'][number]): string[] {
  return [item.cmd, ...(item.tail ?? []).map(([, val]) => val)];
}

/** 汇总全页两栏区左侧宽度并计算统一右栏左边缘列线 (确保子命令/选项/示例/须知/退出码/文档链接严格对齐) */
function computeDescColumn(cat: HelpCatalog): number {
  return computeHelpDescColumn([
    ...cat.subcommands.map((s) => s.name),
    ...cat.options.map((o) =>
      o.arg !== undefined ? `${o.flag} ${o.arg}` : o.flag,
    ),
    ...cat.examples.map((ex) => examplePlainParts(ex).join(' ')),
    ...cat.notes.map((n) => n.label),
    ...cat.exitCodes.map((e) => e.label),
    'GitHub:',
    'Docs:',
  ]);
}

function renderExampleLine(
  item: HelpCatalog['examples'][number],
  color: boolean,
  descCol: number,
): string {
  const plain = examplePlainParts(item).join(' ');
  const parts = [paint(item.cmd, '1', color)];
  for (const [kind, val] of item.tail ?? []) {
    parts.push(paint(val, kind === 'arg' ? '36' : '2', color));
  }
  return alignHelpRow(
    parts.join(' '),
    plain,
    paint(item.desc, '2', color),
    descCol,
  );
}

/** 渲染双语 CLI 分层帮助面板 */
export function helpText(
  version: string,
  color: boolean,
  locale: Locale = 'zh',
): string {
  const c = locale === 'zh' ? CATALOG_ZH : CATALOG_EN;
  const descCol = computeDescColumn(c);
  const heading = (title: string): string => `  ${paint(title, '1;34', color)}`;
  const lines: string[] = [''];

  const badge = paint(`${BAR_BLOCK} WAKE `, '1;7', color);
  lines.push(
    `  ${badge}  ${paint(c.subtitle, '1', color)} ${paint(`v${version}`, '2', color)}`,
  );
  lines.push(`  ${paint(c.summary, '2', color)}`);
  lines.push(`  ${paint('─'.repeat(RULE_WIDTH), '2', color)}`);
  lines.push('');

  lines.push(heading(c.sections.usage));
  for (const u of c.usageArgs) {
    lines.push(`    ${paint('wake', '1', color)} ${paint(u, '2', color)}`);
  }
  lines.push('');

  lines.push(heading(c.sections.subcommands));
  for (const item of c.subcommands) {
    lines.push(
      alignHelpRow(
        paint(item.name, '36', color),
        item.name,
        paint(item.desc, '2', color),
        descCol,
      ),
    );
  }
  lines.push('');

  lines.push(heading(c.sections.options));
  for (const item of c.options) {
    const plainLeft =
      item.arg !== undefined ? `${item.flag} ${item.arg}` : item.flag;
    const flagStyled = paint(item.flag, '36', color);
    const styledLeft =
      item.arg !== undefined
        ? `${flagStyled} ${paint(item.arg, '2', color)}`
        : flagStyled;
    lines.push(
      alignHelpRow(
        styledLeft,
        plainLeft,
        paint(item.desc, '2', color),
        descCol,
      ),
    );
  }
  lines.push('');

  lines.push(heading(c.sections.examples));
  for (const item of c.examples) {
    lines.push(renderExampleLine(item, color, descCol));
  }
  lines.push('');

  lines.push(heading(c.sections.notes));
  for (const item of c.notes) {
    lines.push(
      alignHelpRow(
        paint(item.label, '33', color),
        item.label,
        paint(item.desc, '2', color),
        descCol,
      ),
    );
  }
  lines.push('');

  lines.push(heading(c.sections.exitCodes));
  for (const item of c.exitCodes) {
    const sgr = item.tone === 'green' ? '1;32' : '1;31';
    lines.push(
      alignHelpRow(
        paint(item.label, sgr, color),
        item.label,
        paint(item.desc, '2', color),
        descCol,
      ),
    );
  }
  lines.push('');

  const docsUrl =
    locale === 'zh'
      ? 'https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.zh-CN.md'
      : 'https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.md';

  lines.push(heading(c.sections.docs));
  lines.push(
    alignHelpRow(
      paint('GitHub:', '2', color),
      'GitHub:',
      paint(GITHUB_URL, '36', color),
      descCol,
    ),
  );
  lines.push(
    alignHelpRow(
      paint('Docs:', '2', color),
      'Docs:',
      paint(docsUrl, '36', color),
      descCol,
    ),
  );
  lines.push('');

  return lines.join('\n');
}
