/**
 * Apple 原生质感终端交互控件:
 * - selectOption: Spotlight / System Settings 级单选高亮面板
 * - askConfirm: 双胶囊分段切换器 (Segmented Pill Toggle)
 * - Ctrl+C 与输入流关闭 (end/close) 均清理 raw mode 并抛出 PromptCancelledError 由上层收口
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  currentTheme,
  displayWidth,
  eraseBlock,
  fg,
  getBoxWidth,
  hideCursor,
  isInteractive,
  paintSurface,
  palette,
  restoreDefaultCursor,
  truncateDisplay,
  wrapDisplay,
} from './ansi.ts';
import { printCompletedRow } from './widgets.ts';

export class PromptCancelledError extends Error {
  constructor(message = '已取消配置向导') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

export const isPromptCancelledError = (
  err: unknown,
): err is PromptCancelledError =>
  err instanceof PromptCancelledError ||
  (typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'PromptCancelledError');

const ESC_SEQ_RE = new RegExp(`^${String.fromCharCode(0x1b)}\\[[0-9;?]*[@-~]`);

/** 将终端原始输入块 (含连发按键或剪贴板粘贴流) 拆解为独立按键事件序列 */
export const tokenizeKeyStream = (chunk: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      const m = ESC_SEQ_RE.exec(chunk.slice(i));
      if (m) {
        tokens.push(m[0]);
        i += m[0].length;
        continue;
      }
      tokens.push('\x1b');
      i += 1;
      continue;
    }
    if (chunk[i] === '\r' && chunk[i + 1] === '\n') {
      tokens.push('\r');
      i += 2;
      continue;
    }
    const cp = chunk.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    tokens.push(ch);
    i += ch.length;
  }
  return tokens;
};

export interface SelectOption<T> {
  label: string;
  badge?: string;
  hint?: string;
  value: T;
}

export interface SelectConfig<T> {
  label: string;
  summaryLabel?: string;
  subtitle?: string;
  options: SelectOption<T>[];
  defaultIndex?: number;
}

const appendOptionLines = <T>(
  opt: SelectOption<T>,
  active: boolean,
  cardW: number,
  outLines: string[],
): void => {
  const theme = currentTheme();
  if (!active) {
    const idleText = truncateDisplay(opt.label, Math.max(18, cardW - 7));
    const badgeIdle = opt.badge ? `  ${palette.dim(`[${opt.badge}]`)}` : '';
    outLines.push(
      `      ${palette.dim('○')}  ${palette.muted(idleText)}${badgeIdle}`,
    );
    return;
  }

  const badgePlain = opt.badge ? ` ${opt.badge} ` : '';
  const titleMaxW = Math.max(16, cardW - 8 - displayWidth(badgePlain));
  const titleClipped = truncateDisplay(opt.label, titleMaxW);
  const gap = Math.max(
    1,
    cardW - 6 - displayWidth(titleClipped) - displayWidth(badgePlain),
  );
  const badgeStyled = opt.badge ? fg(theme.blue, badgePlain, true) : '';
  const row1Content = `${palette.blue('▎', true)} ${palette.blue('●', true)}  ${palette.title(titleClipped)}${' '.repeat(gap)}${badgeStyled}`;
  outLines.push(`    ${paintSurface(row1Content, cardW, theme.selectionBg)}`);

  if (opt.hint) {
    for (const hl of wrapDisplay(opt.hint, Math.max(18, cardW - 7))) {
      const rowHint = `${palette.blue('▎', true)}    ${palette.blueSubtle(hl)}`;
      outLines.push(`    ${paintSurface(rowHint, cardW, theme.selectionBg)}`);
    }
  }
};

const selectOptionNonInteractive = async <T>(
  cfg: SelectConfig<T>,
): Promise<T> => {
  const { label, summaryLabel, options, defaultIndex = 0 } = cfg;
  const summaryKey = summaryLabel ?? label;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    console.log(`    ${palette.title(label)}`);
    for (let i = 0; i < options.length; i += 1) {
      const opt = options[i]!;
      const hintSuffix = opt.hint ? ` — ${opt.hint}` : '';
      console.log(`      ${i + 1}) ${opt.label}${hintSuffix}`);
    }
    for (;;) {
      let raw: string;
      try {
        raw = await rl.question(
          `    请选择 [1-${options.length}, 默认 ${defaultIndex + 1}]: `,
        );
      } catch {
        throw new PromptCancelledError('输入流已关闭, 已取消配置向导');
      }
      const ans = raw.trim();
      if (ans === '') {
        const picked = options[defaultIndex]!;
        printCompletedRow(summaryKey, picked.label);
        return picked.value;
      }
      if (/^\d+$/.test(ans)) {
        const idx = Number(ans) - 1;
        if (idx >= 0 && idx < options.length) {
          const picked = options[idx]!;
          printCompletedRow(summaryKey, picked.label);
          return picked.value;
        }
      }
      console.log(
        `    ${palette.red(`✕ 请输入 1 到 ${options.length} 之间的数字序号 (当前输入: ${ans})`)}`,
      );
    }
  } finally {
    rl.close();
  }
};

export const selectOption = async <T>(cfg: SelectConfig<T>): Promise<T> => {
  if (!isInteractive()) return await selectOptionNonInteractive(cfg);

  const { label, summaryLabel, subtitle, options, defaultIndex = 0 } = cfg;
  const summaryKey = summaryLabel ?? label;
  let idx = defaultIndex;
  let renderedCount = 0;

  const render = (): void => {
    if (renderedCount > 0) eraseBlock(renderedCount);
    const cardW = getBoxWidth() - 4;
    const outLines: string[] = [];

    outLines.push(`    ${palette.blue('▸', true)}  ${palette.title(label)}`);
    if (subtitle) {
      for (const ln of wrapDisplay(subtitle, cardW - 4)) {
        outLines.push(`       ${palette.muted(ln)}`);
      }
    }
    for (let i = 0; i < options.length; i += 1) {
      appendOptionLines(options[i]!, i === idx, cardW, outLines);
    }

    const footer =
      cardW >= 54
        ? `    ${palette.keycap('↑↓')} ${palette.dim('上下选择')}   ${palette.keycap(`1-${options.length}`)} ${palette.dim('数字快选')}   ${palette.keycap('Enter')} ${palette.dim('确认')}`
        : `    ${palette.keycap('↑↓')} ${palette.dim('选择')}  ${palette.keycap('Enter')} ${palette.dim('确认')}`;
    outLines.push(footer);

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedCount = outLines.length;
  };

  hideCursor();
  render();

  return await new Promise<T>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onClose);
      stdin.off('close', onClose);
      stdout.off('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      restoreDefaultCursor();
    };
    const onResize = (): void => {
      if (settled) return;
      // 终端尺寸变化时重置行数基线并从当前行重绘, 避免按旧列宽误擦上方已完成摘要
      renderedCount = 0;
      stdout.write('\r\x1b[0J');
      render();
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PromptCancelledError('输入流已关闭, 已取消配置向导'));
    };
    const onData = (buf: Buffer): void => {
      for (const s of tokenizeKeyStream(buf.toString('utf8'))) {
        if (s === '\u0003') {
          settled = true;
          cleanup();
          eraseBlock(renderedCount);
          reject(new PromptCancelledError('已取消配置向导'));
          return;
        }
        if (s === '\r' || s === '\n') {
          settled = true;
          cleanup();
          eraseBlock(renderedCount);
          const picked = options[idx]!;
          printCompletedRow(summaryKey, picked.label);
          resolve(picked.value);
          return;
        }
        if (s === '\x1b[A' || s === 'k') {
          idx = (idx - 1 + options.length) % options.length;
          render();
        } else if (s === '\x1b[B' || s === 'j') {
          idx = (idx + 1) % options.length;
          render();
        } else if (/^[1-9]$/.test(s)) {
          const n = Number(s) - 1;
          if (n >= 0 && n < options.length) {
            idx = n;
            render();
          }
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onClose);
    stdin.once('close', onClose);
    stdout.on('resize', onResize);
  });
};

export interface AskConfirmConfig {
  label: string;
  summaryLabel?: string;
  hint?: string;
  yesLabel?: string;
  noLabel?: string;
  defaultYes?: boolean;
}

const TOGGLE_KEYS = new Set(['\x1b[C', '\x1b[D', '\t', ' ', 'h', 'l']);

const askConfirmNonInteractive = async (
  cfg: AskConfirmConfig,
): Promise<boolean> => {
  const {
    label,
    summaryLabel,
    yesLabel = '保存',
    noLabel = '跳过',
    defaultYes = true,
  } = cfg;
  const summaryKey = summaryLabel ?? label;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      let raw: string;
      try {
        raw = await rl.question(
          `    ${label} [${defaultYes ? 'Y/n' : 'y/N'}]: `,
        );
      } catch {
        throw new PromptCancelledError('输入流已关闭, 已取消配置向导');
      }
      const ans = raw.trim().toLowerCase();
      if (ans === '') {
        printCompletedRow(summaryKey, defaultYes ? yesLabel : noLabel);
        return defaultYes;
      }
      if (ans === 'y' || ans === 'yes') {
        printCompletedRow(summaryKey, yesLabel);
        return true;
      }
      if (ans === 'n' || ans === 'no') {
        printCompletedRow(summaryKey, noLabel);
        return false;
      }
      console.log(`    ${palette.red('✕ 请输入 y 或 n (直接回车采用默认值)')}`);
    }
  } finally {
    rl.close();
  }
};

export const askConfirm = async (cfg: AskConfirmConfig): Promise<boolean> => {
  if (!isInteractive()) return await askConfirmNonInteractive(cfg);

  const {
    label,
    summaryLabel,
    hint,
    yesLabel = '保存',
    noLabel = '跳过',
    defaultYes = true,
  } = cfg;
  const summaryKey = summaryLabel ?? label;
  let yes = defaultYes;
  let renderedCount = 0;

  const render = (): void => {
    if (renderedCount > 0) eraseBlock(renderedCount);
    const cardW = getBoxWidth() - 4;
    const outLines: string[] = [];

    outLines.push(`    ${palette.blue('▸', true)}  ${palette.title(label)}`);
    if (hint) {
      for (const hl of wrapDisplay(hint, Math.max(20, cardW - 4))) {
        outLines.push(`       ${palette.muted(hl)}`);
      }
    }

    const yBtn = yes
      ? palette.pillActive(`● ${yesLabel}`)
      : palette.pillIdle(`○ ${yesLabel}`);
    const nBtn = !yes
      ? palette.pillActive(`● ${noLabel}`)
      : palette.pillIdle(`○ ${noLabel}`);
    outLines.push(`       ${yBtn}   ${nBtn}`);
    outLines.push(
      `    ${palette.keycap('←→')} ${palette.dim('切换')}   ${palette.keycap('y / n')} ${palette.dim('快捷键')}   ${palette.keycap('Enter')} ${palette.dim('确认')}`,
    );

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedCount = outLines.length;
  };

  hideCursor();
  render();

  return await new Promise<boolean>((resolve, reject) => {
    let settled = false;
    const cleanup = (): void => {
      stdin.off('data', onData);
      stdin.off('end', onClose);
      stdin.off('close', onClose);
      stdout.off('resize', onResize);
      if (stdin.isTTY) stdin.setRawMode(false);
      stdin.pause();
      restoreDefaultCursor();
    };
    const onResize = (): void => {
      if (settled) return;
      renderedCount = 0;
      stdout.write('\r\x1b[0J');
      render();
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      cleanup();
      reject(new PromptCancelledError('输入流已关闭, 已取消配置向导'));
    };
    const onData = (buf: Buffer): void => {
      for (const s of tokenizeKeyStream(buf.toString('utf8'))) {
        if (s === '\u0003') {
          settled = true;
          cleanup();
          eraseBlock(renderedCount);
          reject(new PromptCancelledError('已取消配置向导'));
          return;
        }
        if (s === '\r' || s === '\n') {
          settled = true;
          cleanup();
          eraseBlock(renderedCount);
          printCompletedRow(summaryKey, yes ? yesLabel : noLabel);
          resolve(yes);
          return;
        }
        if (TOGGLE_KEYS.has(s)) {
          yes = !yes;
          render();
        } else if (s.toLowerCase() === 'y') {
          yes = true;
          render();
        } else if (s.toLowerCase() === 'n') {
          yes = false;
          render();
        }
      }
    };
    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onClose);
    stdin.once('close', onClose);
    stdout.on('resize', onResize);
  });
};
