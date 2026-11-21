/**
 * Apple 原生质感单行文本输入框 (`askText`), 供 `wizard.ts` 与 `wizard-steps.ts` 调用。
 * 交互态走 `withRawModeSession` (细竖线光标 + 灰色幽灵默认值 + 空输入 `Tab`/`→` 填入默认值 +
 * `Home`/`End`/`Ctrl+U`/左右移/超宽横向滚动视窗 + 实时校验提示符变色); 非交互/管道态走 `readNonInteractiveLine`。
 */
import { stdout } from 'node:process';

import {
  countPhysicalLines,
  currentTheme,
  displayWidth,
  eraseBlock,
  getBoxWidth,
  getTermCols,
  hideCursor,
  isInteractive,
  paintSurface,
  palette,
  showAppleBarCursor,
  truncateDisplay,
  wrapMultiline,
} from './ansi.ts';
import { readNonInteractiveLine } from './line-reader.ts';
import { PromptCancelledError, withRawModeSession } from './raw-session.ts';
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

const LEFT_KEYS = new Set(['\x1b[D', '\x1bOD']);
const RIGHT_KEYS = new Set(['\x1b[C', '\x1bOC']);
const HOME_KEYS = new Set(['\u0001', '\x1b[H', '\x1bOH', '\x1b[1~']);
const END_KEYS = new Set(['\u0005', '\x1b[F', '\x1bOF', '\x1b[4~']);

const mutateTextBuffer = (
  buf: TextEditBuffer,
  key: string,
  defaultVal: string,
): void => {
  if (
    (key === '\t' || RIGHT_KEYS.has(key)) &&
    buf.chars.length === 0 &&
    defaultVal
  ) {
    buf.chars = [...defaultVal];
    buf.cursor = buf.chars.length;
    return;
  }
  if (LEFT_KEYS.has(key)) {
    buf.cursor = Math.max(0, buf.cursor - 1);
    return;
  }
  if (RIGHT_KEYS.has(key)) {
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
  for (;;) {
    const defText = defaultVal ? ` [默认: ${defaultVal}]` : '';
    const raw = await readNonInteractiveLine(`    ${label}${defText}: `);
    if (raw === null) {
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
};

/**
 * 渲染单行文本输入框并返回通过 `validate` 校验的最终字符串 (留空回车采用 `defaultVal`)。
 * 交互态回车校验失败时在输入框下方就地展示红色错误并留在会话内继续编辑, 通过后折叠为单行完成摘要。
 *
 * ### 数据流转示例
 * ```text
 * Input:  cfg = { label: '实例名', defaultVal: 'app', validate: (v) => DNS_LABEL_RE.test(v) ? null : '非法' }
 * Step 1: 空输入展示灰色幽灵 'app'; 若按 Tab/→ 填入缓冲区, 或键入字符更新 editBuf 并按列宽横向裁切视窗
 * Step 2: 按 Enter -> finalVal = chars.join('').trim() || defaultVal -> 执行 validate(finalVal)
 * Step 3: 校验失败则设 errorMsg 就地重绘; 校验通过则 controls.finish(finalVal) 擦除输入区并打印完成行
 * Output: Promise<string>
 * ```
 */
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

    const termCols = getTermCols();
    const cardW = Math.max(16, getBoxWidth() - 4);
    const outLines: string[] = [];

    const labelLines = wrapMultiline(label, Math.max(12, cardW - 4));
    outLines.push(
      `    ${palette.blue('▸', true)}  ${palette.title(labelLines[0] ?? '')}`,
    );
    for (let i = 1; i < labelLines.length; i += 1) {
      outLines.push(`       ${palette.title(labelLines[i]!)}`);
    }
    if (hint) {
      for (const hl of wrapMultiline(hint, Math.max(12, cardW - 4))) {
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

    const fieldInnerBudget = Math.max(10, cardW - 6);
    let fieldContent: string;
    let cursorColumn1Based: number;

    if (currentStr.length === 0) {
      const ghostRaw = defaultVal || placeholder || '可留空, 直接按回车跳过';
      const ghostClipped = truncateDisplay(ghostRaw, fieldInnerBudget);
      fieldContent = `  ${promptGlyph}  ${palette.dim(ghostClipped)}`;
      cursorColumn1Based = Math.min(termCols, 10);
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
      cursorColumn1Based = Math.min(termCols, 10 + displayWidth(visBefore));
    }

    const inputRowIndex = outLines.length;
    outLines.push(
      `    ${paintSurface(fieldContent, cardW, currentTheme().inputBg)}`,
    );

    if (errorMsg) {
      for (const el of wrapMultiline(errorMsg, Math.max(12, cardW - 6))) {
        outLines.push(`       ${palette.red(`✕ ${el}`)}`);
      }
    }

    outLines.push(
      buildTextFooter(currentStr.length > 0, Boolean(defaultVal), cardW),
    );

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedLines = countPhysicalLines(outLines, termCols);

    cursorUpFromBottom = countPhysicalLines(
      outLines.slice(inputRowIndex),
      termCols,
    );
    stdout.write(`\x1b[${cursorUpFromBottom}A\x1b[${cursorColumn1Based}G`);
    showAppleBarCursor();
  };

  render();

  return await withRawModeSession<string>({
    onResize: () => {
      moveCursorToBottom();
      renderedLines = 0;
      stdout.write('\r\x1b[0J');
      render();
    },
    onBeforeClose: () => {
      moveCursorToBottom();
    },
    onAfterCancel: () => {
      moveCursorToBottom();
      eraseBlock(renderedLines);
    },
    onKeys: (keys, controls) => {
      let dirty = false;
      for (const s of keys) {
        if (s === '\r' || s === '\n') {
          if (dirty) {
            render();
            dirty = false;
          }
          const finalVal = editBuf.chars.join('').trim() || defaultVal;
          const err = validate ? validate(finalVal) : null;
          moveCursorToBottom();
          if (!err) {
            controls.finish(finalVal, () => {
              eraseBlock(renderedLines);
              printCompletedRow(summaryKey, finalVal || emptySummary);
            });
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
    },
  });
};
