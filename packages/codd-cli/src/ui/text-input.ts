/**
 * Apple 原生质感单行文本输入框 (细竖线光标 + 灰色幽灵默认值 + Tab 一键补全)。
 * 支持 stdin end/close 安全退出、stdout resize 防花屏重绘, Ctrl+C 抛 PromptCancelledError 由上层收口。
 */
import { stdin, stdout } from 'node:process';
import { createInterface } from 'node:readline/promises';

import {
  currentTheme,
  displayWidth,
  eraseBlock,
  getBoxWidth,
  hideCursor,
  isInteractive,
  paintSurface,
  palette,
  restoreDefaultCursor,
  showAppleBarCursor,
  truncateDisplay,
  wrapDisplay,
} from './ansi.ts';
import { PromptCancelledError, tokenizeKeyStream } from './prompts.ts';
import { printCompletedRow } from './widgets.ts';

export interface AskTextConfig {
  label: string;
  summaryLabel?: string;
  hint?: string;
  placeholder?: string;
  defaultVal?: string;
  emptySummary?: string;
  validate?: (v: string) => string | null;
}

interface TextEditBuffer {
  chars: string[];
  cursor: number;
}

const HOME_KEYS = new Set(['\u0001', '\x1b[H', '\x1b[1~']);
const END_KEYS = new Set(['\u0005', '\x1b[F', '\x1b[4~']);

const mutateTextBuffer = (
  buf: TextEditBuffer,
  key: string,
  defaultVal: string,
): void => {
  if (
    (key === '\t' || key === '\x1b[C') &&
    buf.chars.length === 0 &&
    defaultVal
  ) {
    buf.chars = [...defaultVal];
    buf.cursor = buf.chars.length;
    return;
  }
  if (key === '\x1b[D') {
    buf.cursor = Math.max(0, buf.cursor - 1);
    return;
  }
  if (key === '\x1b[C') {
    buf.cursor = Math.min(buf.chars.length, buf.cursor + 1);
    return;
  }
  if (HOME_KEYS.has(key)) {
    buf.cursor = 0;
    return;
  }
  if (END_KEYS.has(key)) {
    buf.cursor = buf.chars.length;
    return;
  }
  if (key === '\u0015') {
    buf.chars = [];
    buf.cursor = 0;
    return;
  }
  if (key === '\u007f' || key === '\b') {
    if (buf.cursor > 0) {
      buf.chars.splice(buf.cursor - 1, 1);
      buf.cursor -= 1;
    }
    return;
  }
  if (key === '\x1b[3~') {
    if (buf.cursor < buf.chars.length) {
      buf.chars.splice(buf.cursor, 1);
    }
    return;
  }
  if (key.startsWith('\x1b')) return;

  const code = key.codePointAt(0) ?? 0;
  if (code >= 32 && code !== 127) {
    buf.chars.splice(buf.cursor, 0, key);
    buf.cursor += 1;
  }
};

const pickPromptGlyph = (
  hasError: boolean,
  hasInput: boolean,
  isLiveValid: boolean,
): string => {
  if (hasError) return palette.red('❯', true);
  if (hasInput && isLiveValid) return palette.green('❯', true);
  return palette.blue('❯', true);
};

const buildTextFooter = (
  hasInput: boolean,
  hasDefault: boolean,
  cardW: number,
): string => {
  const parts: string[] = [];
  if (!hasInput && hasDefault) {
    parts.push(`${palette.keycap('Enter')} ${palette.dim('采用默认值')}`);
    if (cardW >= 58) {
      parts.push(`${palette.keycap('Tab')} ${palette.dim('填入并修改默认值')}`);
    }
  } else if (!hasInput) {
    parts.push(`${palette.keycap('Enter')} ${palette.dim('留空跳过')}`);
  } else {
    parts.push(`${palette.keycap('Enter')} ${palette.dim('确认输入')}`);
    if (cardW >= 58) {
      parts.push(`${palette.keycap('Ctrl+U')} ${palette.dim('清空重填')}`);
    }
  }
  return `    ${parts.join('   ')}`;
};

const askTextNonInteractive = async (cfg: AskTextConfig): Promise<string> => {
  const {
    label,
    summaryLabel,
    defaultVal = '',
    emptySummary = '未填写 (使用默认设置)',
    validate,
  } = cfg;
  const summaryKey = summaryLabel ?? label;
  const rl = createInterface({ input: stdin, output: stdout });
  try {
    for (;;) {
      const defText = defaultVal ? ` [默认: ${defaultVal}]` : '';
      let raw: string;
      try {
        raw = await rl.question(`    ${label}${defText}: `);
      } catch {
        throw new PromptCancelledError('输入流已关闭, 已取消配置向导');
      }
      const val = raw.trim() || defaultVal;
      const err = validate ? validate(val) : null;
      if (!err) {
        printCompletedRow(summaryKey, val || emptySummary);
        return val;
      }
      console.log(`    ${palette.red(`✕ ${err}`)}`);
    }
  } finally {
    rl.close();
  }
};

export const askText = async (cfg: AskTextConfig): Promise<string> => {
  if (!isInteractive()) return await askTextNonInteractive(cfg);

  const {
    label,
    summaryLabel,
    hint,
    placeholder,
    defaultVal = '',
    emptySummary = '未填写 (使用默认设置)',
    validate,
  } = cfg;
  const summaryKey = summaryLabel ?? label;

  const editBuf: TextEditBuffer = { chars: [], cursor: 0 };
  let errorMsg: string | null = null;
  let renderedLines = 0;
  let cursorUpFromBottom = 0;

  const moveCursorToBottom = (): void => {
    if (cursorUpFromBottom > 0) {
      stdout.write(`\x1b[${cursorUpFromBottom}B\r`);
      cursorUpFromBottom = 0;
    } else {
      stdout.write('\r');
    }
  };

  const render = (): void => {
    hideCursor();
    moveCursorToBottom();
    if (renderedLines > 0) eraseBlock(renderedLines);

    const cardW = getBoxWidth() - 4;
    const outLines: string[] = [];

    outLines.push(`    ${palette.blue('▸', true)}  ${palette.title(label)}`);
    if (hint) {
      for (const hl of wrapDisplay(hint, Math.max(20, cardW - 4))) {
        outLines.push(`       ${palette.muted(hl)}`);
      }
    }

    const currentStr = editBuf.chars.join('');
    const effectiveCandidate = currentStr.trim() || defaultVal;
    const isLiveValid = validate ? validate(effectiveCandidate) === null : true;
    const promptGlyph = pickPromptGlyph(
      Boolean(errorMsg),
      currentStr.length > 0,
      isLiveValid,
    );

    const fieldInnerBudget = Math.max(16, cardW - 6);
    let fieldContent: string;
    let cursorColumn1Based: number;

    if (currentStr.length === 0) {
      const ghostRaw = defaultVal || placeholder || '可留空, 直接按回车跳过';
      const ghostClipped = truncateDisplay(ghostRaw, fieldInnerBudget);
      fieldContent = `  ${promptGlyph}  ${palette.dim(ghostClipped)}`;
      cursorColumn1Based = 10;
    } else {
      let visBefore = editBuf.chars.slice(0, editBuf.cursor).join('');
      const after = editBuf.chars.slice(editBuf.cursor).join('');
      while (
        displayWidth(visBefore) > fieldInnerBudget - 2 &&
        visBefore.length > 1
      ) {
        visBefore = [...visBefore].slice(1).join('');
      }
      const remainW = Math.max(0, fieldInnerBudget - displayWidth(visBefore));
      const visAfter = truncateDisplay(after, remainW);
      fieldContent = `  ${promptGlyph}  ${palette.primary(`${visBefore}${visAfter}`)}`;
      cursorColumn1Based = 10 + displayWidth(visBefore);
    }

    const inputRowIndex = outLines.length;
    outLines.push(
      `    ${paintSurface(fieldContent, cardW, currentTheme().inputBg)}`,
    );

    if (errorMsg) {
      for (const el of wrapDisplay(errorMsg, Math.max(20, cardW - 6))) {
        outLines.push(`       ${palette.red(`✕ ${el}`)}`);
      }
    }

    outLines.push(
      buildTextFooter(currentStr.length > 0, Boolean(defaultVal), cardW),
    );

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedLines = outLines.length;

    cursorUpFromBottom = renderedLines - inputRowIndex;
    stdout.write(`\x1b[${cursorUpFromBottom}A\x1b[${cursorColumn1Based}G`);
    showAppleBarCursor();
  };

  render();

  return await new Promise<string>((resolve, reject) => {
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
      moveCursorToBottom();
      renderedLines = 0;
      stdout.write('\r\x1b[0J');
      render();
    };
    const onClose = (): void => {
      if (settled) return;
      settled = true;
      moveCursorToBottom();
      cleanup();
      reject(new PromptCancelledError('输入流已关闭, 已取消配置向导'));
    };

    const onData = (buf: Buffer): void => {
      const keys = tokenizeKeyStream(buf.toString('utf8'));
      let dirty = false;

      for (const s of keys) {
        if (s === '\u0003') {
          settled = true;
          if (dirty) render();
          moveCursorToBottom();
          cleanup();
          eraseBlock(renderedLines);
          reject(new PromptCancelledError('已取消配置向导'));
          return;
        }

        if (s === '\r' || s === '\n') {
          if (dirty) {
            render();
            dirty = false;
          }
          const finalVal = editBuf.chars.join('').trim() || defaultVal;
          const err = validate ? validate(finalVal) : null;
          moveCursorToBottom();
          if (!err) {
            settled = true;
            cleanup();
            eraseBlock(renderedLines);
            printCompletedRow(summaryKey, finalVal || emptySummary);
            resolve(finalVal);
            return;
          }
          errorMsg = err;
          render();
          return;
        }

        dirty = true;
        errorMsg = null;
        mutateTextBuffer(editBuf, s, defaultVal);
      }

      if (dirty) render();
    };

    stdin.setRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onClose);
    stdin.once('close', onClose);
    stdout.on('resize', onResize);
  });
};
