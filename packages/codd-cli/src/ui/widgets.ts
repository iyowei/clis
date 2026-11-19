/**
 * Apple System Settings 级终端排版组件: 页眉、分段步骤指示器、圆角面板与参数卡片。
 * 全部输出行在落框前先按换行符拆分, 防止含 \n 的多行文本撑裂圆角框与双栏对齐。
 */
import type { FormulaStep } from '@iyowei/codd';

import {
  SUMMARY_LABEL_COL,
  displayWidth,
  getBoxWidth,
  getTermCols,
  padEndDisplay,
  palette,
  stripAnsi,
  truncateDisplay,
  wrapDisplay,
} from './ansi.ts';

const sanitizeSingleLine = (text: string): string =>
  text.replace(/\r?\n/g, ' ').trim();

/** 先按换行符分段, 再对每段按显示宽度安全折行 */
export const wrapMultiline = (text: string, maxWidth: number): string[] => {
  const segments = text.split(/\r?\n/);
  const lines: string[] = [];
  for (const seg of segments) {
    lines.push(...wrapDisplay(seg, maxWidth));
  }
  return lines.length > 0 ? lines : [''];
};

export const printCompletedRow = (label: string, value: string): void => {
  const paddedKey = padEndDisplay(sanitizeSingleLine(label), SUMMARY_LABEL_COL);
  console.log(
    `    ${palette.green('✓', true)}  ${palette.muted(paddedKey)}  ${palette.primary(sanitizeSingleLine(value))}`,
  );
};

/** 顶部 Apple 产品级页眉 (带圆润品牌胶囊、右对齐环境标识与通俗导语) */
export const printHeader = (subtitle: string, lead?: string): void => {
  const w = getBoxWidth();
  const cleanSub = sanitizeSingleLine(subtitle);
  const leftPlain = ` Codd   ${cleanSub}`;
  const rightPlain = 'MongoDB 9.0';
  const gap = Math.max(
    2,
    w - displayWidth(leftPlain) - displayWidth(rightPlain),
  );

  console.log('');
  console.log(
    `  ${palette.badge('Codd')}  ${palette.title(cleanSub)}${' '.repeat(gap)}${palette.dim(rightPlain)}`,
  );
  if (lead) {
    for (const line of wrapMultiline(lead, w)) {
      console.log(`  ${palette.muted(line)}`);
    }
  }
  console.log(`  ${palette.rule('─'.repeat(w))}`);
};

const renderStepTrack = (step: string): string => {
  const m = /^(\d+)\s*\/\s*(\d+)$/.exec(step.trim());
  if (!m) return palette.blue('◉', true);
  const cur = Number(m[1]);
  const tot = Number(m[2]);
  const nodes: string[] = [];
  for (let i = 1; i <= tot; i += 1) {
    if (i < cur) nodes.push(palette.green('●'));
    else if (i === cur) nodes.push(palette.blue('◉', true));
    else nodes.push(palette.dim('○'));
  }
  let joined = '';
  for (let i = 0; i < nodes.length; i += 1) {
    joined += nodes[i];
    if (i < nodes.length - 1) {
      joined += i < cur - 1 ? palette.green('━━') : palette.rule('──');
    }
  }
  return joined;
};

/** Apple 分段式步骤进度头: ●━━◉──○──○  步骤 2 / 4 · 标题 */
export const printSection = (
  step: string,
  title: string,
  subtitle?: string,
): void => {
  const track = renderStepTrack(step);
  console.log('');
  console.log(
    `  ${track}   ${palette.dim(`步骤 ${step}`)}  ${palette.title(sanitizeSingleLine(title))}`,
  );
  if (subtitle) {
    const w = getBoxWidth() - 4;
    for (const ln of wrapMultiline(subtitle, w)) {
      console.log(`    ${palette.muted(ln)}`);
    }
  }
  console.log('');
};

export const printSubGroup = (title: string, gap = true): void => {
  if (gap) console.log('');
  console.log(`    ${palette.subtleBadge(sanitizeSingleLine(title))}`);
};

export const formatKVLines = (
  rows: Array<[string, string]>,
  indent = 4,
  termCols = getTermCols(),
): string[] => {
  const maxW = termCols - indent - 2;
  const cleanRows: Array<[string, string]> = rows.map(([k, v]) => [
    sanitizeSingleLine(k),
    v,
  ]);
  const keyW = Math.min(
    24,
    Math.max(...cleanRows.map(([k]) => displayWidth(k)), 12) + 2,
  );
  const valW = Math.max(18, maxW - keyW - 1);
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [k, v] of cleanRows) {
    const wrapped = wrapMultiline(v, valW);
    out.push(
      `${pad}${palette.mono(padEndDisplay(k, keyW))} ${palette.muted(wrapped[0] ?? '')}`,
    );
    for (let i = 1; i < wrapped.length; i += 1) {
      out.push(`${pad}${' '.repeat(keyW)} ${palette.muted(wrapped[i]!)}`);
    }
  }
  return out;
};

export const printKV = (rows: Array<[string, string]>, indent = 4): void => {
  for (const line of formatKVLines(rows, indent)) {
    console.log(line);
  }
};

/** 格式化 Apple System Settings 风格圆角分组面板行数组 (先按 \n 拆行防撑裂边框) */
export const formatBoxLines = (
  title: string,
  subtitle: string | undefined,
  renderedLines: string[],
  indent = 2,
  boxW = getBoxWidth(),
): string[] => {
  const innerW = boxW - 6;
  const pad = ' '.repeat(indent);
  const horiz = '─'.repeat(boxW - 2);
  const cleanTitle = sanitizeSingleLine(title);
  const out: string[] = [''];

  if (subtitle) {
    const cleanSub = sanitizeSingleLine(subtitle);
    const maxSubW = Math.max(12, boxW - displayWidth(cleanTitle) - 4);
    const subClipped = truncateDisplay(cleanSub, maxSubW);
    const gap = Math.max(
      2,
      boxW - displayWidth(cleanTitle) - displayWidth(subClipped),
    );
    out.push(
      `${pad}${palette.title(cleanTitle)}${' '.repeat(gap)}${palette.dim(subClipped)}`,
    );
  } else {
    out.push(`${pad}${palette.title(cleanTitle)}`);
  }

  out.push(`${pad}${palette.rule(`╭${horiz}╮`)}`);
  out.push(
    `${pad}${palette.rule('│')}  ${' '.repeat(innerW)}  ${palette.rule('│')}`,
  );
  for (const rawLine of renderedLines) {
    for (const seg of rawLine.split(/\r?\n/)) {
      const fitted =
        displayWidth(seg) > innerW
          ? truncateDisplay(stripAnsi(seg), innerW)
          : seg;
      out.push(
        `${pad}${palette.rule('│')}  ${padEndDisplay(fitted, innerW)}  ${palette.rule('│')}`,
      );
    }
  }
  out.push(
    `${pad}${palette.rule('│')}  ${' '.repeat(innerW)}  ${palette.rule('│')}`,
  );
  out.push(`${pad}${palette.rule(`╰${horiz}╯`)}`);
  return out;
};

/** Apple System Settings 风格圆角分组面板 */
export const drawBox = (
  title: string,
  subtitle: string | undefined,
  renderedLines: string[],
  indent = 2,
): void => {
  for (const line of formatBoxLines(title, subtitle, renderedLines, indent)) {
    console.log(line);
  }
};

/** 面向初级工程师的直观参数配比面板: 中文名称 + 高亮结果 + 一句话通俗解释 */
export const printFormulaCard = (
  hardwareSummary: string,
  steps: FormulaStep[],
): void => {
  const boxW = getBoxWidth();
  const innerW = boxW - 6;
  const labels = steps.map((s) => sanitizeSingleLine(s.label || s.key));
  const col1 = Math.min(
    18,
    Math.max(...labels.map((l) => displayWidth(l)), 14),
  );
  const col2 = Math.min(
    15,
    Math.max(
      ...steps.map((s) => displayWidth(sanitizeSingleLine(s.value))),
      10,
    ),
  );
  const descW = Math.max(16, innerW - col1 - col2 - 4);

  const lines: string[] = [];
  for (const s of steps) {
    const lblPlain = truncateDisplay(
      sanitizeSingleLine(s.label || s.key),
      col1,
    );
    const valPlain = truncateDisplay(sanitizeSingleLine(s.value), col2);
    const wrapped = wrapMultiline(s.plainReason || s.formula, descW);

    const kStyled = palette.primary(padEndDisplay(lblPlain, col1));
    const vStyled = palette.green(padEndDisplay(valPlain, col2), true);
    lines.push(`${kStyled}  ${vStyled}  ${palette.muted(wrapped[0] ?? '')}`);
    for (let i = 1; i < wrapped.length; i += 1) {
      lines.push(
        `${' '.repeat(col1)}  ${' '.repeat(col2)}  ${palette.muted(wrapped[i]!)}`,
      );
    }
  }
  drawBox('已为你自动测算最佳运行参数', hardwareSummary, lines);
};

export const formatSummaryCardLines = (
  title: string,
  badgeText: string,
  rows: Array<[string, string]>,
  boxW = getBoxWidth(),
): string[] => {
  const innerW = boxW - 6;
  const cleanRows: Array<[string, string]> = rows.map(([k, v]) => [
    sanitizeSingleLine(k),
    v,
  ]);
  const keyW = Math.min(
    22,
    Math.max(...cleanRows.map(([k]) => displayWidth(k)), 10) + 2,
  );
  const valW = Math.max(16, innerW - keyW - 2);
  const lines: string[] = [];
  for (const [k, v] of cleanRows) {
    const kPart = palette.muted(padEndDisplay(truncateDisplay(k, keyW), keyW));
    const wrapped = wrapMultiline(v, valW);
    lines.push(`${kPart}  ${palette.mono(wrapped[0] ?? '')}`);
    for (let i = 1; i < wrapped.length; i += 1) {
      lines.push(`${' '.repeat(keyW)}  ${palette.mono(wrapped[i]!)}`);
    }
  }
  return formatBoxLines(title, badgeText, lines, 2, boxW);
};

export const printSummaryCard = (
  title: string,
  badgeText: string,
  rows: Array<[string, string]>,
): void => {
  for (const line of formatSummaryCardLines(title, badgeText, rows)) {
    console.log(line);
  }
};

const alertGlyph = (kind: 'ok' | 'warn' | 'err'): string => {
  if (kind === 'ok') return palette.green('✓', true);
  if (kind === 'warn') return palette.amber('!', true);
  return palette.red('✕', true);
};

const alertStyle = (kind: 'ok' | 'warn' | 'err'): ((t: string) => string) => {
  if (kind === 'err') return (t: string) => palette.red(t);
  if (kind === 'warn') return (t: string) => palette.amber(t);
  return palette.primary;
};

export const printAlert = (kind: 'ok' | 'warn' | 'err', msg: string): void => {
  const w = getBoxWidth() - 6;
  const wrapped = wrapMultiline(msg, w);
  const glyph = alertGlyph(kind);
  const styleFn = alertStyle(kind);
  console.log(`    ${glyph}  ${styleFn(wrapped[0] ?? '')}`);
  for (let i = 1; i < wrapped.length; i += 1) {
    console.log(`       ${styleFn(wrapped[i]!)}`);
  }
};
