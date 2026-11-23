/**
 * codd-cli 终端 UI 构件统一导出入口, 供 `cli.ts`、`wizard.ts` 与 `wizard-steps.ts` 消费。
 * 聚合色彩与宽度测量 (`ansi.ts`)、非交互共享行队列 (`line-reader.ts`)、Raw-Mode 会话守卫 (`raw-session.ts`)、
 * 交互选择/确认/文本输入控件 (`prompts.ts` / `text-input.ts`) 与排版卡片 (`widgets.ts`)。
 */
export {
  SUMMARY_LABEL_COL,
  type SemanticTheme,
  charWidth,
  countPhysicalLines,
  currentTheme,
  detectLightTerminal,
  displayWidth,
  eraseBlock,
  fg,
  getBoxWidth,
  getTermCols,
  hasColor,
  hasStderrColor,
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
  wrapMultiline,
} from './ansi.ts';
export {
  type LineQueueReader,
  closeSharedLineReader,
  createLineQueueReader,
  readNonInteractiveLine,
} from './line-reader.ts';
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
export {
  type RawSessionControls,
  type RawSessionHandlers,
  withRawModeSession,
} from './raw-session.ts';
export { type AskTextConfig, askText } from './text-input.ts';
export {
  drawBox,
  formatBoxLines,
  formatFormulaCardLines,
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
} from './widgets.ts';
