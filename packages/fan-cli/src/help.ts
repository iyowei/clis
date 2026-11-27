/**
 * `@iyowei/fan-cli` 帮助页单轴线左对齐排版渲染 (零外部依赖, 中英双语 Apple HIG 排版)。
 *
 * 排版红线 (全仓所有 CLI 强制遵循):
 * 每个语种独立调用 `computeHelpDescColumn` 按东亚显示列宽 (`CJK=2, ASCII=1`) 计算全页唯一的右栏列线 `descCol`,
 * 所有两栏分区 (子命令 / 选项 / 示例 / 环境与持久化 / 退出码) 共用同一 `descCol`, 彻底杜绝右栏参差不齐与 80+ 列溢出。
 */
import {
  type Locale,
  alignHelpRow,
  computeHelpDescColumn,
  t,
} from '@iyowei/cli-i18n';

import {
  CATALOG_EN,
  CATALOG_ZH,
  type ExampleRow,
  GITHUB_URL,
  type HelpCatalog,
  type NoteRow,
  type OptionRow,
} from './help-catalog.ts';
import { BAR_BLOCK, displayWidth, paint } from './render.ts';

export { displayWidth };

const RULE_WIDTH = 76;

function examplePlainParts(row: ExampleRow): string[] {
  return [row.cmd, ...(row.tail ?? []).map(([, value]) => value)];
}

function computeDescColumn(cat: HelpCatalog): number {
  return computeHelpDescColumn([
    ...cat.subcommands.map((r) => r.name),
    ...cat.options.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...cat.metaOptions.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...cat.examples.map((r) => examplePlainParts(r).join(' ')),
    ...cat.envNotes.map((r) => r.label),
    ...cat.exitCodes.map((r) => r.label),
  ]);
}

export const HELP_DESC_COL = computeDescColumn(CATALOG_ZH);

export function helpText(color: boolean, locale: Locale = 'zh'): string {
  const cat = t(locale, CATALOG_ZH, CATALOG_EN);
  const descCol = computeDescColumn(cat);
  const s = {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    section: (text: string) => paint(text, '1;34', color),
    bold: (text: string) => paint(text, '1', color),
    dim: (text: string) => paint(text, '2', color),
    token: (text: string) => paint(text, '36', color),
    green: (text: string) => paint(text, '1;32', color),
    red: (text: string) => paint(text, '1;31', color),
  };

  const alignRow = (styledLeft: string, plainLeft: string, desc: string) =>
    alignHelpRow(styledLeft, plainLeft, desc, descCol);

  const styleCommandName = (name: string): string => {
    const sp = name.indexOf(' ');
    if (sp === -1) return s.bold(name);
    return `${s.bold(name.slice(0, sp))} ${s.dim(name.slice(sp + 1))}`;
  };

  const commandRows = cat.subcommands.map((row) =>
    alignRow(styleCommandName(row.name), row.name, s.dim(row.desc)),
  );

  const formatOpt = (row: OptionRow) => {
    const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
    const styled =
      row.arg === undefined
        ? s.token(row.flag)
        : `${s.token(row.flag)} ${s.dim(row.arg)}`;
    return alignRow(styled, plain, s.dim(row.desc));
  };

  const formatEx = (row: ExampleRow) => {
    const plain = examplePlainParts(row).join(' ');
    const styled = [s.bold(row.cmd)];
    for (const [kind, value] of row.tail ?? []) {
      styled.push(kind === 'flag' ? s.token(value) : s.dim(value));
    }
    return alignRow(styled.join(' '), plain, s.dim(row.desc));
  };

  const styleNoteLabel = (row: NoteRow) => {
    if (row.tone === 'green') return s.green(row.label);
    if (row.tone === 'red') return s.red(row.label);
    return s.bold(row.label);
  };

  const formatNote = (row: NoteRow) =>
    alignRow(styleNoteLabel(row), row.label, s.dim(row.desc));

  return [
    '',
    `  ${s.badge('FAN')}  ${s.bold(cat.subtitle)}`,
    `  ${s.dim(cat.summary)}`,
    `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section(cat.sections.usage)}`,
    `    ${s.bold('fan')} ${s.dim(cat.usageArgs[0])}`,
    `    ${s.bold('fan')} ${s.dim(cat.usageArgs[1])}`,
    '',
    `  ${s.section(cat.sections.subcommands)}`,
    ...commandRows,
    '',
    `  ${s.section(cat.sections.options)}`,
    ...cat.options.map(formatOpt),
    '',
    ...cat.metaOptions.map(formatOpt),
    '',
    `  ${s.section(cat.sections.examples)}`,
    ...cat.examples.map(formatEx),
    '',
    `  ${s.section(cat.sections.notes)}`,
    ...cat.envNotes.map(formatNote),
    '',
    `  ${s.section(cat.sections.exitCodes)}`,
    ...cat.exitCodes.map(formatNote),
    '',
    `  ${s.section(cat.sections.docs)}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
