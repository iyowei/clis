/**
 * Apple System Settings 级终端排版组件: 页眉、分段步骤指示器、圆角面板与参数卡片。
 */
import type { FormulaStep } from '../formulas.ts';
import {
  SUMMARY_LABEL_COL,
  displayWidth,
  getBoxWidth,
  getTermCols,
  padEndDisplay,
  palette,
  truncateDisplay,
  wrapDisplay,
} from './ansi.ts';

export const printCompletedRow = (label: string, value: string): void => {
  const paddedKey = padEndDisplay(label, SUMMARY_LABEL_COL);
  console.log(
    `    ${palette.green('✓', true)}  ${palette.muted(paddedKey)}  ${palette.primary(value)}`,
  );
};

/** 顶部 Apple 产品级页眉 (带圆润品牌胶囊、右对齐环境标识与通俗导语) */
export const printHeader = (subtitle: string, lead?: string): void => {
  const w = getBoxWidth();
  const leftPlain = ` Codd   ${subtitle}`;
  const rightPlain = 'MongoDB 9.0';
  const gap = Math.max(
    2,
    w - displayWidth(leftPlain) - displayWidth(rightPlain),
  );

  console.log('');
  console.log(
    `  ${palette.badge('Codd')}  ${palette.title(subtitle)}${' '.repeat(gap)}${palette.dim(rightPlain)}`,
  );
  if (lead) {
    for (const line of wrapDisplay(lead, w)) {
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
    `  ${track}   ${palette.dim(`步骤 ${step}`)}  ${palette.title(title)}`,
  );
  if (subtitle) {
    const w = getBoxWidth() - 4;
    for (const ln of wrapDisplay(subtitle, w)) {
      console.log(`    ${palette.muted(ln)}`);
    }
  }
  console.log('');
};

export const printSubGroup = (title: string, gap = true): void => {
  if (gap) console.log('');
  console.log(`    ${palette.subtleBadge(title)}`);
};

export const printKV = (rows: Array<[string, string]>, indent = 4): void => {
  const maxW = getTermCols() - indent - 2;
  const keyW = Math.min(
    24,
    Math.max(...rows.map(([k]) => displayWidth(k)), 12) + 2,
  );
  const valW = Math.max(18, maxW - keyW - 1);
  const pad = ' '.repeat(indent);
  for (const [k, v] of rows) {
    const wrapped = wrapDisplay(v, valW);
    console.log(
      `${pad}${palette.mono(padEndDisplay(k, keyW))} ${palette.muted(wrapped[0] ?? '')}`,
    );
    for (let i = 1; i < wrapped.length; i += 1) {
      console.log(`${pad}${' '.repeat(keyW)} ${palette.muted(wrapped[i]!)}`);
    }
  }
};

/** Apple System Settings 风格圆角分组面板 */
export const drawBox = (
  title: string,
  subtitle: string | undefined,
  renderedLines: string[],
  indent = 2,
): void => {
  const boxW = getBoxWidth();
  const innerW = boxW - 6;
  const pad = ' '.repeat(indent);
  const horiz = '─'.repeat(boxW - 2);

  console.log('');
  if (subtitle) {
    const maxSubW = Math.max(12, boxW - displayWidth(title) - 4);
    const subClipped = truncateDisplay(subtitle, maxSubW);
    const gap = Math.max(
      2,
      boxW - displayWidth(title) - displayWidth(subClipped),
    );
    console.log(
      `${pad}${palette.title(title)}${' '.repeat(gap)}${palette.dim(subClipped)}`,
    );
  } else {
    console.log(`${pad}${palette.title(title)}`);
  }

  console.log(`${pad}${palette.rule(`╭${horiz}╮`)}`);
  console.log(
    `${pad}${palette.rule('│')}  ${' '.repeat(innerW)}  ${palette.rule('│')}`,
  );
  for (const line of renderedLines) {
    console.log(
      `${pad}${palette.rule('│')}  ${padEndDisplay(line, innerW)}  ${palette.rule('│')}`,
    );
  }
  console.log(
    `${pad}${palette.rule('│')}  ${' '.repeat(innerW)}  ${palette.rule('│')}`,
  );
  console.log(`${pad}${palette.rule(`╰${horiz}╯`)}`);
};

/** 面向初级工程师的直观参数配比面板: 中文名称 + 高亮结果 + 一句话通俗解释 */
export const printFormulaCard = (
  hardwareSummary: string,
  steps: FormulaStep[],
): void => {
  const boxW = getBoxWidth();
  const innerW = boxW - 6;
  const labels = steps.map((s) => s.label || s.key);
  const col1 = Math.min(
    18,
    Math.max(...labels.map((l) => displayWidth(l)), 14),
  );
  const col2 = Math.min(
    15,
    Math.max(...steps.map((s) => displayWidth(s.value)), 10),
  );
  const descW = Math.max(16, innerW - col1 - col2 - 4);

  const lines: string[] = [];
  for (const s of steps) {
    const lblPlain = truncateDisplay(s.label || s.key, col1);
    const valPlain = truncateDisplay(s.value, col2);
    const reasonText = s.plainReason || s.formula;
    const wrapped = wrapDisplay(reasonText, descW);

    const kStyled = palette.primary(padEndDisplay(lblPlain, col1));
    const vStyled = palette.green(padEndDisplay(valPlain, col2), true);
    const r0 = palette.muted(wrapped[0] ?? '');
    lines.push(`${kStyled}  ${vStyled}  ${r0}`);

    for (let i = 1; i < wrapped.length; i += 1) {
      lines.push(
        `${' '.repeat(col1)}  ${' '.repeat(col2)}  ${palette.muted(wrapped[i]!)}`,
      );
    }
  }
  drawBox('已为你自动测算最佳运行参数', hardwareSummary, lines);
};

export const printSummaryCard = (
  title: string,
  badgeText: string,
  rows: Array<[string, string]>,
): void => {
  const boxW = getBoxWidth();
  const innerW = boxW - 6;
  const keyW = Math.min(
    22,
    Math.max(...rows.map(([k]) => displayWidth(k)), 10) + 2,
  );
  const valW = Math.max(16, innerW - keyW - 2);
  const lines: string[] = [];
  for (const [k, v] of rows) {
    const kPart = palette.muted(padEndDisplay(truncateDisplay(k, keyW), keyW));
    const wrapped = wrapDisplay(v, valW);
    lines.push(`${kPart}  ${palette.mono(wrapped[0] ?? '')}`);
    for (let i = 1; i < wrapped.length; i += 1) {
      lines.push(`${' '.repeat(keyW)}  ${palette.mono(wrapped[i]!)}`);
    }
  }
  drawBox(title, badgeText, lines);
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
  const wrapped = wrapDisplay(msg, w);
  const glyph = alertGlyph(kind);
  const styleFn = alertStyle(kind);
  console.log(`    ${glyph}  ${styleFn(wrapped[0] ?? '')}`);
  for (let i = 1; i < wrapped.length; i += 1) {
    console.log(`       ${styleFn(wrapped[i]!)}`);
  }
};
