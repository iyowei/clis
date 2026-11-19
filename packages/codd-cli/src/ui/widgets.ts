/**
 * Apple System Settings 级终端排版组件: 页眉、分段步骤指示器、圆角面板与参数卡片。
 * 全部输出行在落框前先按换行符拆分, 并在窄屏下动态收缩左栏防止脱色与边框撑裂。
 */
import { stderr, stdout } from 'node:process';

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
  wrapMultiline,
} from './ansi.ts';

export { wrapMultiline };

const sanitizeSingleLine = (text: string): string =>
  text.replace(/\r?\n/g, ' ').trim();

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
    const w = Math.max(14, getBoxWidth() - 4);
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
  const maxW = Math.max(16, termCols - indent - 2);
  const cleanRows: Array<[string, string]> = rows.map(([k, v]) => [
    sanitizeSingleLine(k),
    v,
  ]);
  const naturalKeyW = Math.max(...cleanRows.map(([k]) => displayWidth(k)), 8);
  const keyW = Math.min(
    24,
    Math.max(6, Math.floor(maxW * 0.4)),
    naturalKeyW + 2,
  );
  const valW = Math.max(8, maxW - keyW - 1);
  const pad = ' '.repeat(indent);
  const out: string[] = [];
  for (const [k, v] of cleanRows) {
    const kFit = padEndDisplay(truncateDisplay(k, keyW), keyW);
    const wrapped = wrapMultiline(v, valW);
    out.push(`${pad}${palette.mono(kFit)} ${palette.muted(wrapped[0] ?? '')}`);
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
  const safeBoxW = Math.max(20, boxW);
  const innerW = safeBoxW - 6;
  const pad = ' '.repeat(indent);
  const horiz = '─'.repeat(safeBoxW - 2);
  const cleanTitle = sanitizeSingleLine(title);
  const out: string[] = [''];

  if (subtitle) {
    const cleanSub = sanitizeSingleLine(subtitle);
    const maxSubW = Math.max(6, safeBoxW - displayWidth(cleanTitle) - 4);
    const subClipped = truncateDisplay(cleanSub, maxSubW);
    const gap = Math.max(
      2,
      safeBoxW - displayWidth(cleanTitle) - displayWidth(subClipped),
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

/** 面向初级工程师的直观参数配比面板: 窄屏下动态收缩左两栏, 防止整行脱色 */
export const formatFormulaCardLines = (
  hardwareSummary: string,
  steps: FormulaStep[],
  boxW = getBoxWidth(),
): string[] => {
  const safeBoxW = Math.max(20, boxW);
  const innerW = safeBoxW - 6;
  const labels = steps.map((s) => sanitizeSingleLine(s.label || s.key));
  const rawCol1 = Math.min(
    18,
    Math.max(...labels.map((l) => displayWidth(l)), 10),
  );
  const rawCol2 = Math.min(
    15,
    Math.max(...steps.map((s) => displayWidth(sanitizeSingleLine(s.value))), 8),
  );
  const minDescW = Math.min(12, Math.max(6, Math.floor(innerW * 0.35)));
  const maxColsBudget = Math.max(8, innerW - minDescW - 4);
  const col1 =
    rawCol1 + rawCol2 <= maxColsBudget
      ? rawCol1
      : Math.max(4, Math.floor(maxColsBudget * 0.55));
  const col2 =
    rawCol1 + rawCol2 <= maxColsBudget
      ? rawCol2
      : Math.max(4, maxColsBudget - col1);
  const descW = Math.max(4, innerW - col1 - col2 - 4);

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
  return formatBoxLines(
    '已为你自动测算最佳运行参数',
    hardwareSummary,
    lines,
    2,
    safeBoxW,
  );
};

export const printFormulaCard = (
  hardwareSummary: string,
  steps: FormulaStep[],
): void => {
  for (const line of formatFormulaCardLines(hardwareSummary, steps)) {
    console.log(line);
  }
};

export const formatSummaryCardLines = (
  title: string,
  badgeText: string,
  rows: Array<[string, string]>,
  boxW = getBoxWidth(),
): string[] => {
  const safeBoxW = Math.max(20, boxW);
  const innerW = safeBoxW - 6;
  const cleanRows: Array<[string, string]> = rows.map(([k, v]) => [
    sanitizeSingleLine(k),
    v,
  ]);
  const naturalKeyW = Math.max(...cleanRows.map(([k]) => displayWidth(k)), 8);
  const maxKeyW = Math.max(6, Math.min(22, Math.floor(innerW * 0.42)));
  const keyW = Math.min(maxKeyW, naturalKeyW + 2);
  const valW = Math.max(6, innerW - keyW - 2);
  const lines: string[] = [];
  for (const [k, v] of cleanRows) {
    const kPart = palette.muted(padEndDisplay(truncateDisplay(k, keyW), keyW));
    const wrapped = wrapMultiline(v, valW);
    lines.push(`${kPart}  ${palette.mono(wrapped[0] ?? '')}`);
    for (let i = 1; i < wrapped.length; i += 1) {
      lines.push(`${' '.repeat(keyW)}  ${palette.mono(wrapped[i]!)}`);
    }
  }
  return formatBoxLines(title, badgeText, lines, 2, safeBoxW);
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
  const w = Math.max(12, getBoxWidth() - 6);
  const wrapped = wrapMultiline(msg, w);
  const glyph = alertGlyph(kind);
  const styleFn = alertStyle(kind);
  const target = kind === 'err' ? stderr : stdout;
  target.write(`    ${glyph}  ${styleFn(wrapped[0] ?? '')}\n`);
  for (let i = 1; i < wrapped.length; i += 1) {
    target.write(`       ${styleFn(wrapped[i]!)}\n`);
  }
};
