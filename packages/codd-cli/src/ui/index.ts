/**
 * codd-cli 终端 UI 构件统一导出。
 */
export {
  SUMMARY_LABEL_COL,
  type SemanticTheme,
  charWidth,
  currentTheme,
  detectLightTerminal,
  displayWidth,
  eraseBlock,
  fg,
  getBoxWidth,
  getTermCols,
  hasColor,
  hideCursor,
  isInteractive,
  isTrueColor,
  padEndDisplay,
  paintSurface,
  palette,
  restoreDefaultCursor,
  showAppleBarCursor,
  stripAnsi,
  truncateDisplay,
  wrapDisplay,
} from './ansi.ts';
export {
  type AskConfirmConfig,
  PromptCancelledError,
  type SelectConfig,
  type SelectOption,
  askConfirm,
  isPromptCancelledError,
  selectOption,
  tokenizeKeyStream,
} from './prompts.ts';
export { type AskTextConfig, askText } from './text-input.ts';
export {
  drawBox,
  formatBoxLines,
  formatKVLines,
  formatSummaryCardLines,
  printAlert,
  printCompletedRow,
  printFormulaCard,
  printHeader,
  printKV,
  printSection,
  printSubGroup,
  printSummaryCard,
  wrapMultiline,
} from './widgets.ts';
