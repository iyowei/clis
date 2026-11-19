/**
 * Apple Human Interface Guidelines (HIG) 级终端色彩、全角宽度与光标微控引擎:
 * - 1:1 遵循 Apple System Colors (macOS Sequoia Dark / Light 自适应 sRGB 色阶与 4 级灰阶)
 * - 表面涂装 (paintSurface) 与 DECSCUSR 细竖线光标 (\x1b[6 q) 退出自动复位
 */
import { stdin, stdout } from 'node:process';

export const SUMMARY_LABEL_COL = 16;

export const hasColor = (): boolean =>
  Boolean(stdout.isTTY) && !process.env.NO_COLOR && process.env.TERM !== 'dumb';

export const isInteractive = (): boolean =>
  Boolean(stdin.isTTY && stdout.isTTY) && process.env.TERM !== 'dumb';

const TRUECOLOR_TERMS = [
  'iterm',
  'apple_terminal',
  'vscode',
  'ghostty',
  'warp',
  'wezterm',
];

const isTrueColor = (): boolean => {
  const ct = (process.env.COLORTERM || '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return true;
  const termProg = (process.env.TERM_PROGRAM || '').toLowerCase();
  return TRUECOLOR_TERMS.some((item) => termProg.includes(item));
};

/** 自动感知浅色与深色终端背景 (支持 CODD_THEME=light|dark 与标准 COLORFGBG 环境变量) */
export const detectLightTerminal = (): boolean => {
  const explicit = (process.env.CODD_THEME || '').toLowerCase();
  if (explicit === 'light') return true;
  if (explicit === 'dark') return false;
  const fgbg = process.env.COLORFGBG;
  if (fgbg) {
    const parts = fgbg.split(';');
    const bg = Number(parts[parts.length - 1]);
    if (Number.isFinite(bg) && bg >= 7 && bg !== 8) return true;
  }
  return false;
};

export interface SemanticTheme {
  labelPrimary: [string, string];
  labelSecondary: [string, string];
  labelTertiary: [string, string];
  separator: [string, string];
  blue: [string, string];
  blueSubtle: [string, string];
  green: [string, string];
  orange: [string, string];
  red: [string, string];
  cyan: [string, string];
  selectionBg: [string, string];
  inputBg: [string, string];
  keycapBg: [string, string];
}

const DARK_THEME: SemanticTheme = {
  labelPrimary: ['245;245;247', '255'],
  labelSecondary: ['161;161;166', '248'],
  labelTertiary: ['110;110;115', '242'],
  separator: ['56;56;58', '238'],
  blue: ['10;132;255', '39'],
  blueSubtle: ['142;192;255', '117'],
  green: ['48;209;88', '42'],
  orange: ['255;159;10', '214'],
  red: ['255;69;58', '203'],
  cyan: ['100;210;255', '81'],
  selectionBg: ['20;35;58', '236'],
  inputBg: ['28;28;32', '235'],
  keycapBg: ['44;44;48', '237'],
};

const LIGHT_THEME: SemanticTheme = {
  labelPrimary: ['29;29;31', '234'],
  labelSecondary: ['110;110;115', '242'],
  labelTertiary: ['142;142;147', '246'],
  separator: ['210;210;215', '252'],
  blue: ['0;122;255', '27'],
  blueSubtle: ['26;95;180', '25'],
  green: ['40;167;69', '34'],
  orange: ['196;102;0', '166'],
  red: ['215;0;21', '160'],
  cyan: ['0;102;204', '26'],
  selectionBg: ['230;241;255', '195'],
  inputBg: ['242;242;247', '255'],
  keycapBg: ['229;229;234', '254'],
};

export const currentTheme = (): SemanticTheme =>
  detectLightTerminal() ? LIGHT_THEME : DARK_THEME;

export const fg = (
  [rgb, c256]: [string, string],
  text: string,
  bold = false,
): string => {
  if (!hasColor()) return text;
  const b = bold ? '1;' : '';
  return isTrueColor()
    ? `\x1b[${b}38;2;${rgb}m${text}\x1b[0m`
    : `\x1b[${b}38;5;${c256}m${text}\x1b[0m`;
};

const fgOnBg = (
  [fgRgb, fg256]: [string, string],
  [bgRgb, bg256]: [string, string],
  text: string,
  bold = false,
): string => {
  if (!hasColor()) return text;
  const b = bold ? '1;' : '';
  return isTrueColor()
    ? `\x1b[${b}38;2;${fgRgb};48;2;${bgRgb}m${text}\x1b[0m`
    : `\x1b[${b}38;5;${fg256};48;5;${bg256}m${text}\x1b[0m`;
};

const ANSI_CSI_RE = new RegExp(
  `${String.fromCharCode(0x1b)}\\[[0-9;?]*[ -/]*[@-~]`,
  'g',
);

const stripAnsi = (str: string): string => str.replace(ANSI_CSI_RE, '');

const charWidth = (ch: string): number => {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    code === 0x3000 ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xffef) ||
    (code >= 0x1f300 && code <= 0x1faff);
  return wide ? 2 : 1;
};

/** 计算包含全角 CJK 字符的精确终端显示列宽, 保证双栏与色块边缘零偏移 */
export const displayWidth = (str: string): number => {
  const plain = stripAnsi(str);
  let w = 0;
  for (const ch of plain) {
    w += charWidth(ch);
  }
  return w;
};

export const padEndDisplay = (str: string, width: number): string => {
  const diff = width - displayWidth(str);
  return diff > 0 ? `${str}${' '.repeat(diff)}` : str;
};

/** 将含局部前景色的行铺满统一表面底色, 保证整条选中带或输入槽右侧边缘笔直齐整 */
export const paintSurface = (
  content: string,
  totalWidth: number,
  bgTok: [string, string],
): string => {
  const padded = padEndDisplay(content, totalWidth);
  if (!hasColor()) return padded;
  const bgSeq = isTrueColor()
    ? `\x1b[48;2;${bgTok[0]}m`
    : `\x1b[48;5;${bgTok[1]}m`;
  const reapplied = padded.replaceAll('\x1b[0m', `\x1b[0m${bgSeq}`);
  return `${bgSeq}${reapplied}\x1b[0m`;
};

export const palette = {
  title: (t: string) => fg(currentTheme().labelPrimary, t, true),
  primary: (t: string) => fg(currentTheme().labelPrimary, t, false),
  body: (t: string) => fg(currentTheme().labelSecondary, t, false),
  muted: (t: string) => fg(currentTheme().labelSecondary, t, false),
  dim: (t: string) => fg(currentTheme().labelTertiary, t, false),
  rule: (t: string) => fg(currentTheme().separator, t, false),
  blue: (t: string, bold = false) => fg(currentTheme().blue, t, bold),
  blueSubtle: (t: string) => fg(currentTheme().blueSubtle, t, false),
  green: (t: string, bold = false) => fg(currentTheme().green, t, bold),
  amber: (t: string, bold = false) => fg(currentTheme().orange, t, bold),
  red: (t: string, bold = false) => fg(currentTheme().red, t, bold),
  mono: (t: string) => fg(currentTheme().cyan, t, false),
  badge: (t: string) =>
    fgOnBg(['255;255;255', '255'], currentTheme().blue, ` ${t} `, true),
  subtleBadge: (t: string) =>
    fgOnBg(currentTheme().blue, currentTheme().keycapBg, ` ${t} `, false),
  keycap: (t: string) =>
    fgOnBg(
      currentTheme().labelSecondary,
      currentTheme().keycapBg,
      ` ${t} `,
      false,
    ),
  pillActive: (t: string) =>
    fgOnBg(['255;255;255', '255'], currentTheme().blue, `  ${t}  `, true),
  pillIdle: (t: string) =>
    fgOnBg(
      currentTheme().labelSecondary,
      currentTheme().keycapBg,
      `  ${t}  `,
      false,
    ),
};

let cursorManaged = false;
const ensureCursorExitHook = (): void => {
  if (cursorManaged) return;
  cursorManaged = true;
  process.once('exit', () => {
    if (isInteractive()) {
      stdout.write('\x1b[0 q\x1b[?25h');
    }
  });
};

export const hideCursor = (): void => {
  if (!isInteractive()) return;
  ensureCursorExitHook();
  stdout.write('\x1b[?25l');
};

export const showAppleBarCursor = (): void => {
  if (!isInteractive()) return;
  ensureCursorExitHook();
  stdout.write('\x1b[6 q\x1b[?25h');
};

export const restoreDefaultCursor = (): void => {
  if (!isInteractive()) return;
  stdout.write('\x1b[0 q\x1b[?25h');
};

export const eraseBlock = (lineCount: number): void => {
  if (!isInteractive() || lineCount <= 0) return;
  stdout.write(`\r\x1b[${lineCount}A\x1b[0J`);
};

export const getTermCols = (): number => stdout.columns || 80;

export const getBoxWidth = (min = 58, max = 88): number =>
  Math.min(max, Math.max(min, getTermCols() - 4));

/** 按终端显示宽度安全裁剪纯文本, 末尾补省略号 */
export const truncateDisplay = (
  plainText: string,
  maxWidth: number,
): string => {
  if (maxWidth <= 0) return '';
  if (displayWidth(plainText) <= maxWidth) return plainText;
  if (maxWidth === 1) return '…';
  let out = '';
  let w = 0;
  for (const ch of plainText) {
    const cw = charWidth(ch);
    if (w + cw > maxWidth - 1) break;
    out += ch;
    w += cw;
  }
  return `${out}…`;
};

const BREAK_CHARS = new Set([' ', '/', ',']);

interface LineScanResult {
  end: number;
  lastBreak: number;
}

const scanLineSegment = (
  chars: string[],
  start: number,
  maxWidth: number,
): LineScanResult => {
  let w = 0;
  let end = start;
  let lastBreak = -1;
  while (end < chars.length) {
    const ch = chars[end]!;
    const cw = charWidth(ch);
    if (w + cw > maxWidth) break;
    w += cw;
    if (BREAK_CHARS.has(ch)) {
      lastBreak = end;
    }
    end += 1;
  }
  return { end, lastBreak };
};

/** 按显示宽度优先在空格、逗号或路径分隔符处折行, 避免英文单词与路径被腰斩 */
export const wrapDisplay = (plainText: string, maxWidth: number): string[] => {
  if (maxWidth <= 4) return [truncateDisplay(plainText, Math.max(1, maxWidth))];
  if (displayWidth(plainText) <= maxWidth) return [plainText];

  const chars = [...plainText];
  const lines: string[] = [];
  let start = 0;

  while (start < chars.length) {
    const { end, lastBreak } = scanLineSegment(chars, start, maxWidth);
    if (end >= chars.length) {
      lines.push(chars.slice(start).join('').trimEnd());
      break;
    }
    if (lastBreak > start) {
      const slice = chars
        .slice(start, lastBreak + 1)
        .join('')
        .trimEnd();
      lines.push(slice || chars.slice(start, end).join(''));
      start = lastBreak + 1;
      while (start < chars.length && chars[start] === ' ') {
        start += 1;
      }
    } else {
      lines.push(chars.slice(start, end).join(''));
      start = end;
    }
  }

  return lines.length > 0 ? lines : [''];
};
