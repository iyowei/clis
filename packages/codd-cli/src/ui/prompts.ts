/**
 * Apple 原生质感终端选择与确认控件 (`selectOption` 单选面板 + `askConfirm` 双胶囊切换器), 供 `wizard.ts` / `wizard-steps.ts` 调用。
 * 交互态经 `withRawModeSession` 驱动实时重绘与 60ms resize 防抖, 非交互/管道态自动降级至共享行队列 (`readNonInteractiveLine`);
 * 确认后擦除控件面板并折叠为单行 `printCompletedRow` 摘要, Ctrl+C/D 或 EOF 统一抛 `PromptCancelledError`。
 */
import { stdout } from 'node:process';

import { ct } from '../i18n.ts';
import {
  countPhysicalLines,
  currentTheme,
  displayWidth,
  eraseBlock,
  fg,
  getBoxWidth,
  getTermCols,
  hideCursor,
  isInteractive,
  paintSurface,
  palette,
  truncateDisplay,
  wrapMultiline,
} from './ansi.ts';
import { readNonInteractiveLine } from './line-reader.ts';
import {
  PromptCancelledError,
  isPromptCancelledError,
  tokenizeKeyStream,
  withRawModeSession,
} from './raw-session.ts';
import { printCompletedRow } from './widgets.ts';

export { PromptCancelledError, isPromptCancelledError, tokenizeKeyStream };

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

const sanitizeOneLine = (text: string): string =>
  text.replace(/\r?\n/g, ' ').trim();

const appendWrappedLabel = (
  label: string,
  cardW: number,
  outLines: string[],
): void => {
  const labelLines = wrapMultiline(label, Math.max(12, cardW - 4));
  outLines.push(
    `    ${palette.blue('▸', true)}  ${palette.title(labelLines[0] ?? '')}`,
  );
  for (let i = 1; i < labelLines.length; i += 1) {
    outLines.push(`       ${palette.title(labelLines[i]!)}`);
  }
};

const appendOptionLines = <T>(
  opt: SelectOption<T>,
  active: boolean,
  cardW: number,
  outLines: string[],
): void => {
  const theme = currentTheme();
  const cleanLabel = sanitizeOneLine(opt.label);
  const cleanBadge = opt.badge ? sanitizeOneLine(opt.badge) : '';

  if (!active) {
    const badgeTag = cleanBadge ? `  [${cleanBadge}]` : '';
    const badgeW = displayWidth(badgeTag);
    const showBadge = cleanBadge && cardW - 7 - badgeW >= 10;
    const textBudget = Math.max(8, cardW - 7 - (showBadge ? badgeW : 0));
    const idleText = truncateDisplay(cleanLabel, textBudget);
    const badgeIdle = showBadge ? `  ${palette.dim(`[${cleanBadge}]`)}` : '';
    outLines.push(
      `      ${palette.dim('○')}  ${palette.muted(idleText)}${badgeIdle}`,
    );
    return;
  }

  const badgePlain = cleanBadge ? ` ${cleanBadge} ` : '';
  const badgeW = displayWidth(badgePlain);
  const showBadge = Boolean(cleanBadge) && cardW - 8 - badgeW >= 8;
  const effBadgePlain = showBadge ? badgePlain : '';
  const titleMaxW = Math.max(8, cardW - 8 - displayWidth(effBadgePlain));
  const titleClipped = truncateDisplay(cleanLabel, titleMaxW);
  const gap = Math.max(
    1,
    cardW - 6 - displayWidth(titleClipped) - displayWidth(effBadgePlain),
  );
  const badgeStyled = showBadge ? fg(theme.blue, effBadgePlain, true) : '';
  const row1Content = `${palette.blue('▎', true)} ${palette.blue('●', true)}  ${palette.title(titleClipped)}${' '.repeat(gap)}${badgeStyled}`;
  outLines.push(`    ${paintSurface(row1Content, cardW, theme.selectionBg)}`);

  if (opt.hint) {
    for (const hl of wrapMultiline(opt.hint, Math.max(12, cardW - 7))) {
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
  console.log(`    ${palette.title(label)}`);
  for (let i = 0; i < options.length; i += 1) {
    const opt = options[i]!;
    const hintSuffix = opt.hint ? ` — ${opt.hint}` : '';
    console.log(`      ${i + 1}) ${opt.label}${hintSuffix}`);
  }
  for (;;) {
    const raw = await readNonInteractiveLine(
      ct(
        `    请选择 [1-${options.length}, 默认 ${defaultIndex + 1}]: `,
        `    Select [1-${options.length}, default ${defaultIndex + 1}]: `,
      ),
    );
    if (raw === null) {
      throw new PromptCancelledError(
        ct(
          '输入流已关闭, 已取消配置向导',
          'Input stream closed; wizard cancelled',
        ),
      );
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
      `    ${palette.red(
        ct(
          `✕ 请输入 1 到 ${options.length} 之间的数字序号 (当前输入: ${ans})`,
          `✕ Enter a number between 1 and ${options.length} (received: ${ans})`,
        ),
      )}`,
    );
  }
};

const UP_KEYS = new Set(['\x1b[A', '\x1bOA', 'k']);
const DOWN_KEYS = new Set(['\x1b[B', '\x1bOB', 'j']);

/**
 * 渲染单选高亮面板并返回所选项的 `value` (支持 `↑↓` / `j k` / `1-9` 数字快选 / `Enter` 确认)。
 * 非交互态回退为编号菜单 + 共享行队列读取 (`''` 采纳 `defaultIndex`, EOF 抛 `PromptCancelledError`)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  cfg = { label: '选择部署方式', options: [{ label: '单机', value: 'single' }, { label: '三机', value: 'replica-set' }] }
 * Step 1: isInteractive() -> true 进入 withRawModeSession; 初始 idx = defaultIndex (0), 隐藏光标并绘制面板
 * Step 2: 收到按键序列 ['\x1b[B', '\r'] -> 下移 idx=1 重绘 -> Enter 触发 controls.finish('replica-set')
 * Step 3: 恢复终端状态 -> eraseBlock 擦除面板 -> printCompletedRow 打印最终单行摘要
 * Output: Promise<'replica-set'>
 * ```
 */
export const selectOption = async <T>(cfg: SelectConfig<T>): Promise<T> => {
  if (!isInteractive()) return await selectOptionNonInteractive(cfg);

  const { label, summaryLabel, subtitle, options, defaultIndex = 0 } = cfg;
  const summaryKey = summaryLabel ?? label;
  let idx = defaultIndex;
  let renderedCount = 0;

  const render = (): void => {
    if (renderedCount > 0) eraseBlock(renderedCount);
    const termCols = getTermCols();
    const cardW = Math.max(16, getBoxWidth() - 4);
    const outLines: string[] = [];

    appendWrappedLabel(label, cardW, outLines);
    if (subtitle) {
      for (const ln of wrapMultiline(subtitle, Math.max(12, cardW - 4))) {
        outLines.push(`       ${palette.muted(ln)}`);
      }
    }
    for (let i = 0; i < options.length; i += 1) {
      appendOptionLines(options[i]!, i === idx, cardW, outLines);
    }

    const footer =
      cardW >= 54
        ? `    ${palette.keycap('↑↓')} ${palette.dim(ct('上下选择', 'Navigate'))}   ${palette.keycap(`1-${options.length}`)} ${palette.dim(ct('数字快选', 'Quick Select'))}   ${palette.keycap('Enter')} ${palette.dim(ct('确认', 'Confirm'))}`
        : `    ${palette.keycap('↑↓')} ${palette.dim(ct('选择', 'Select'))}  ${palette.keycap('Enter')} ${palette.dim(ct('确认', 'Confirm'))}`;
    outLines.push(footer);

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedCount = countPhysicalLines(outLines, termCols);
  };

  hideCursor();
  render();

  return await withRawModeSession<T>({
    onResize: () => {
      renderedCount = 0;
      stdout.write('\r\x1b[0J');
      render();
    },
    onAfterCancel: () => {
      eraseBlock(renderedCount);
    },
    onKeys: (keys, controls) => {
      for (const s of keys) {
        if (s === '\r' || s === '\n') {
          const picked = options[idx]!;
          controls.finish(picked.value, () => {
            eraseBlock(renderedCount);
            printCompletedRow(summaryKey, picked.label);
          });
          return;
        }
        if (UP_KEYS.has(s)) {
          idx = (idx - 1 + options.length) % options.length;
          render();
        } else if (DOWN_KEYS.has(s)) {
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
    },
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

const TOGGLE_KEYS = new Set([
  '\x1b[C',
  '\x1b[D',
  '\x1bOC',
  '\x1bOD',
  '\t',
  ' ',
  'h',
  'l',
]);

const askConfirmNonInteractive = async (
  cfg: AskConfirmConfig,
): Promise<boolean> => {
  const {
    label,
    summaryLabel,
    yesLabel = ct('保存', 'Save'),
    noLabel = ct('跳过', 'Skip'),
    defaultYes = true,
  } = cfg;
  const summaryKey = summaryLabel ?? label;
  for (;;) {
    const raw = await readNonInteractiveLine(
      `    ${label} [${defaultYes ? 'Y/n' : 'y/N'}]: `,
    );
    if (raw === null) {
      throw new PromptCancelledError(
        ct(
          '输入流已关闭, 已取消配置向导',
          'Input stream closed; wizard cancelled',
        ),
      );
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
    console.log(
      `    ${palette.red(
        ct(
          '✕ 请输入 y 或 n (直接回车采用默认值)',
          '✕ Enter y or n (or press Enter for default)',
        ),
      )}`,
    );
  }
};

/**
 * 渲染双胶囊布尔确认控件 (交互态支持 `←→` / `Tab` / `Space` / `h l` 切换与 `y`/`n` 直选, 非交互态回退 `Y/n` 行输入)。
 */
export const askConfirm = async (cfg: AskConfirmConfig): Promise<boolean> => {
  if (!isInteractive()) return await askConfirmNonInteractive(cfg);

  const {
    label,
    summaryLabel,
    hint,
    yesLabel = ct('保存', 'Save'),
    noLabel = ct('跳过', 'Skip'),
    defaultYes = true,
  } = cfg;
  const summaryKey = summaryLabel ?? label;
  let yes = defaultYes;
  let renderedCount = 0;

  const render = (): void => {
    if (renderedCount > 0) eraseBlock(renderedCount);
    const termCols = getTermCols();
    const cardW = Math.max(16, getBoxWidth() - 4);
    const outLines: string[] = [];

    appendWrappedLabel(label, cardW, outLines);
    if (hint) {
      for (const hl of wrapMultiline(hint, Math.max(12, cardW - 4))) {
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
    const footer =
      cardW >= 48
        ? `    ${palette.keycap('←→')} ${palette.dim(ct('切换', 'Switch'))}   ${palette.keycap('y / n')} ${palette.dim(ct('快捷键', 'Shortcut'))}   ${palette.keycap('Enter')} ${palette.dim(ct('确认', 'Confirm'))}`
        : `    ${palette.keycap('←→')} ${palette.dim(ct('切换', 'Switch'))}  ${palette.keycap('Enter')} ${palette.dim(ct('确认', 'Confirm'))}`;
    outLines.push(footer);

    stdout.write(outLines.map((l) => `\x1b[2K${l}\n`).join(''));
    renderedCount = countPhysicalLines(outLines, termCols);
  };

  hideCursor();
  render();

  return await withRawModeSession<boolean>({
    onResize: () => {
      renderedCount = 0;
      stdout.write('\r\x1b[0J');
      render();
    },
    onAfterCancel: () => {
      eraseBlock(renderedCount);
    },
    onKeys: (keys, controls) => {
      for (const s of keys) {
        if (s === '\r' || s === '\n') {
          controls.finish(yes, () => {
            eraseBlock(renderedCount);
            printCompletedRow(summaryKey, yes ? yesLabel : noLabel);
          });
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
    },
  });
};
