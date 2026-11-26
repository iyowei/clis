/**
 * `@iyowei/wake-cli` 双语帮助页渲染器 (与 `fan-cli` / `sweep-cli` 同源的 Apple HIG 分层结构与 SGR 色盘)。
 */
import { type Locale } from '@iyowei/cli-i18n';

import { CATALOG_EN, CATALOG_ZH } from './help-catalog.ts';
import {
  BAR_BLOCK,
  displayWidth,
  padDisplay,
  paint,
} from './render-primitives.ts';

function renderExampleLine(
  item: (typeof CATALOG_ZH.examples)[number],
  color: boolean,
  cmdColWidth: number,
): string {
  const parts = [paint(item.cmd, '1', color)];
  let plain = item.cmd;
  for (const [kind, val] of item.tail ?? []) {
    plain += ` ${val}`;
    parts.push(paint(val, kind === 'arg' ? '36' : '2', color));
  }
  const pad = ' '.repeat(Math.max(2, cmdColWidth - displayWidth(plain) + 2));
  return `  ${parts.join(' ')}${pad}${paint(item.desc, '2', color)}`;
}

/** 渲染双语 CLI 分层帮助面板 */
export function helpText(
  version: string,
  color: boolean,
  locale: Locale = 'zh',
): string {
  const c = locale === 'zh' ? CATALOG_ZH : CATALOG_EN;
  const heading = (title: string): string => paint(title, '1', color);
  const lines: string[] = [];

  const badge = paint(`${BAR_BLOCK} WAKE `, '1;7', color);
  lines.push(
    `${badge}  ${paint(c.subtitle, '1', color)} ${paint(`v${version}`, '2', color)}`,
  );
  lines.push(`  ${paint(c.summary, '2', color)}`);
  lines.push('');

  lines.push(heading(c.sections.usage));
  for (const u of c.usageArgs) {
    lines.push(`  ${paint('wake', '1', color)} ${u}`);
  }
  lines.push('');

  lines.push(heading(c.sections.subcommands));
  const subCol =
    Math.max(...c.subcommands.map((s) => displayWidth(s.name))) + 3;
  for (const item of c.subcommands) {
    lines.push(
      `  ${paint(padDisplay(item.name, subCol), '36', color)}${paint(item.desc, '2', color)}`,
    );
  }
  lines.push('');

  lines.push(heading(c.sections.options));
  const optLabels = c.options.map((o) =>
    o.arg !== undefined ? `${o.flag} ${o.arg}` : o.flag,
  );
  const optCol = Math.max(...optLabels.map((l) => displayWidth(l))) + 3;
  for (let i = 0; i < c.options.length; i += 1) {
    const item = c.options[i]!;
    const flagStyled = paint(item.flag, '36', color);
    const argStyled =
      item.arg !== undefined ? ` ${paint(item.arg, '2', color)}` : '';
    const plainWidth = displayWidth(optLabels[i]!);
    const pad = ' '.repeat(Math.max(2, optCol - plainWidth));
    lines.push(
      `  ${flagStyled}${argStyled}${pad}${paint(item.desc, '2', color)}`,
    );
  }
  lines.push('');

  lines.push(heading(c.sections.examples));
  const exCmdWidth = Math.max(
    ...c.examples.map((ex) => {
      const lenParts = [ex.cmd, ...(ex.tail ?? []).map(([, v]) => v)];
      return displayWidth(lenParts.join(' '));
    }),
  );
  for (const item of c.examples) {
    lines.push(renderExampleLine(item, color, exCmdWidth));
  }
  lines.push('');

  lines.push(heading(c.sections.notes));
  const noteCol = Math.max(...c.notes.map((n) => displayWidth(n.label))) + 3;
  for (const item of c.notes) {
    lines.push(
      `  ${paint(padDisplay(item.label, noteCol), '33', color)}${paint(item.desc, '2', color)}`,
    );
  }
  lines.push('');

  lines.push(heading(c.sections.exitCodes));
  for (const item of c.exitCodes) {
    const sgr = item.tone === 'green' ? '32' : '31';
    lines.push(`  ${paint(padDisplay(item.label, 4), sgr, color)}${item.desc}`);
  }
  lines.push('');

  lines.push(heading(c.sections.docs));
  lines.push(
    `  ${paint('GitHub:', '2', color)} https://github.com/iyowei/clis/tree/main/packages/wake-cli`,
  );
  lines.push(
    `  ${paint('Docs:  ', '2', color)} https://github.com/iyowei/clis/blob/main/packages/wake-cli/docs/README.md`,
  );

  return lines.join('\n');
}
