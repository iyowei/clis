/**
 * @iyowei/codd-cli 终端 UI 构件单测:
 * 覆盖零宽组合符与变体选择符宽度、Apple_Terminal 真彩降级、按键流分词与圆角框换行防撑裂。
 */
import { describe, expect, test } from 'bun:test';

import {
  PromptCancelledError,
  charWidth,
  detectLightTerminal,
  displayWidth,
  formatBoxLines,
  formatKVLines,
  formatSummaryCardLines,
  isPromptCancelledError,
  isTrueColor,
  padEndDisplay,
  stripAnsi,
  tokenizeKeyStream,
  truncateDisplay,
  wrapDisplay,
} from './ui/index.ts';

const withEnv = (
  patch: Record<string, string | undefined>,
  fn: () => void,
): void => {
  const prev: Record<string, string | undefined> = {};
  for (const [k, v] of Object.entries(patch)) {
    prev[k] = process.env[k];
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
  try {
    fn();
  } finally {
    for (const [k, v] of Object.entries(prev)) {
      if (v === undefined) delete process.env[k];
      else process.env[k] = v;
    }
  }
};

describe('ansi 宽度、颜色降级与折行算法', () => {
  test('charWidth 与 displayWidth 正确处理 ASCII、CJK、\\p{Mn} 组合符与变体选择符', () => {
    expect(displayWidth('WT_CACHE_GB')).toBe(11);
    expect(displayWidth('中文123')).toBe(7);
    // 组合重音符 e + U+0301 占 1 列而非 2 列
    expect(charWidth('\u0301')).toBe(0);
    expect(displayWidth('e\u0301')).toBe(1);
    // 变体选择符 U+FE0F 与零宽空格 U+200B 占 0 列
    expect(charWidth('\ufe0f')).toBe(0);
    expect(charWidth('\u200b')).toBe(0);
    expect(displayWidth('a\u200bb')).toBe(2);

    expect(padEndDisplay('中文', 6)).toBe('中文  ');
    expect(truncateDisplay('一二三四五', 5)).toBe('一二…');

    const wrapped = wrapDisplay('max(350 x 4, 65536) / balanced 慢查询线', 18);
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
    expect(wrapped.every((line) => displayWidth(line) <= 18)).toBe(true);
  });

  test('Apple_Terminal 降级为 256 色 (isTrueColor=false), iTerm / COLORTERM=truecolor 保持真彩', () => {
    withEnv({ COLORTERM: undefined, TERM_PROGRAM: 'Apple_Terminal' }, () => {
      expect(isTrueColor()).toBe(false);
    });
    withEnv({ COLORTERM: undefined, TERM_PROGRAM: 'iTerm.app' }, () => {
      expect(isTrueColor()).toBe(true);
    });
    withEnv({ COLORTERM: 'truecolor', TERM_PROGRAM: 'Apple_Terminal' }, () => {
      expect(isTrueColor()).toBe(true);
    });
  });

  test('深浅色终端背景检测支持 CODD_THEME 与 COLORFGBG', () => {
    withEnv({ CODD_THEME: undefined, COLORFGBG: '0;15' }, () => {
      expect(detectLightTerminal()).toBe(true);
    });
    withEnv({ CODD_THEME: undefined, COLORFGBG: '15;0' }, () => {
      expect(detectLightTerminal()).toBe(false);
    });
    withEnv({ CODD_THEME: 'light', COLORFGBG: '15;0' }, () => {
      expect(detectLightTerminal()).toBe(true);
    });
  });

  test('tokenizeKeyStream 精确拆分方向键、CRLF 与普通字符, PromptCancelledError 可按形状识别', () => {
    expect(tokenizeKeyStream('\x1b[A\r\n中a')).toEqual([
      '\x1b[A',
      '\r',
      '中',
      'a',
    ]);
    const err = new PromptCancelledError('用户按 Ctrl+C');
    expect(isPromptCancelledError(err)).toBe(true);
    expect(isPromptCancelledError({ name: 'PromptCancelledError' })).toBe(true);
    expect(isPromptCancelledError(new Error('other'))).toBe(false);
  });
});

describe('widgets 换行防撑裂验证', () => {
  test('formatBoxLines / formatSummaryCardLines / formatKVLines 对含 \\n 文本拆行且圆角框边缘完全齐整', () => {
    const boxLines = formatBoxLines(
      '摘要\n副行',
      '状态\n正常',
      ['第一行\n第二行', '第三行'],
      2,
      60,
    );
    const frameLines = boxLines
      .map((l) => stripAnsi(l))
      .filter(
        (l) =>
          l.trimStart().startsWith('╭') ||
          l.trimStart().startsWith('│') ||
          l.trimStart().startsWith('╰'),
      );
    expect(frameLines.length).toBe(7);
    for (const ln of frameLines) {
      expect(ln.includes('\n')).toBe(false);
      expect(displayWidth(ln)).toBe(62);
    }

    const summaryLines = formatSummaryCardLines(
      '结果',
      'ok',
      [['路径', '/tmp/a\n/tmp/b']],
      64,
    );
    const summaryFrame = summaryLines
      .map((l) => stripAnsi(l))
      .filter((l) => l.trimStart().startsWith('│'));
    expect(summaryFrame.length).toBeGreaterThanOrEqual(4);
    for (const ln of summaryFrame) {
      expect(ln.includes('\n')).toBe(false);
      expect(displayWidth(ln)).toBe(66);
    }

    const kvLines = formatKVLines([['key', 'line1\nline2']], 4, 80);
    expect(kvLines.length).toBe(2);
    expect(kvLines.every((l) => !l.includes('\n'))).toBe(true);
  });
});
