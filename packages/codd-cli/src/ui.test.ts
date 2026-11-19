/**
 * @iyowei/codd-cli 终端 UI 构件单测:
 * 覆盖全半角/CJK扩展B/零宽字符宽度、WT_SESSION/Apple_Terminal 真彩、SS3/Alt 按键分词、
 * 窄屏钳制与物理行数统计、共享行队列读取器以及窄卡片防脱色。
 */
import { describe, expect, test } from 'bun:test';

import { PassThrough } from 'node:stream';

import {
  PromptCancelledError,
  charWidth,
  countPhysicalLines,
  createLineQueueReader,
  detectLightTerminal,
  displayWidth,
  formatBoxLines,
  formatFormulaCardLines,
  formatKVLines,
  formatSummaryCardLines,
  getBoxWidth,
  isPromptCancelledError,
  isTrueColor,
  padEndDisplay,
  stripAnsi,
  tokenizeKeyStream,
  truncateDisplay,
  wrapDisplay,
} from './ui/index.ts';
import { validateManifestFileName } from './wizard.ts';

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
  test('charWidth 与 displayWidth 正确处理 ASCII、半角片假名、CJK 扩展 B、\\p{Mn}/\\p{Me}/\\p{Cf} 与 C1', () => {
    expect(displayWidth('WT_CACHE_GB')).toBe(11);
    expect(displayWidth('中文123')).toBe(7);
    // 半角片假名占 1 列 (修正 U+FF61..U+FF9F 误判为 2 列)
    expect(charWidth('ｱ')).toBe(1);
    expect(charWidth('ﾝ')).toBe(1);
    expect(charWidth('Ａ')).toBe(2);
    // CJK 扩展 B 占 2 列
    expect(charWidth('𠀀')).toBe(2);
    expect(displayWidth('𠀀a')).toBe(3);
    // 组合记号 \p{Mn} / \p{Me} / \p{Cf} / C1 / 变体选择符均占 0 列
    expect(charWidth('\u0301')).toBe(0);
    expect(displayWidth('e\u0301')).toBe(1);
    expect(charWidth('\u20dd')).toBe(0);
    expect(charWidth('\u202e')).toBe(0);
    expect(charWidth('\u0085')).toBe(0);
    expect(charWidth('\ufe0f')).toBe(0);
    expect(charWidth('\u200b')).toBe(0);
    expect(displayWidth('a\u200bb')).toBe(2);

    expect(padEndDisplay('中文', 6)).toBe('中文  ');
    expect(truncateDisplay('一二三四五', 5)).toBe('一二…');

    const wrapped = wrapDisplay('max(350 x 4, 65536) / balanced 慢查询线', 18);
    expect(wrapped.length).toBeGreaterThanOrEqual(2);
    expect(wrapped.every((line) => displayWidth(line) <= 18)).toBe(true);
  });

  test('窄屏 getBoxWidth 严格钳制在 Math.max(20, cols - 4), countPhysicalLines 准确统计折行', () => {
    const desc = Object.getOwnPropertyDescriptor(process.stdout, 'columns');
    try {
      Object.defineProperty(process.stdout, 'columns', {
        value: 44,
        configurable: true,
      });
      expect(getBoxWidth()).toBe(40);
      Object.defineProperty(process.stdout, 'columns', {
        value: 18,
        configurable: true,
      });
      expect(getBoxWidth()).toBe(20);
      Object.defineProperty(process.stdout, 'columns', {
        value: 120,
        configurable: true,
      });
      expect(getBoxWidth()).toBe(88);
    } finally {
      if (desc) Object.defineProperty(process.stdout, 'columns', desc);
    }

    expect(countPhysicalLines(['short', '123456789012', ''], 10)).toBe(4);
  });

  test('Apple_Terminal 降级为 256 色, WT_SESSION / iTerm / COLORTERM=truecolor 保持真彩', () => {
    withEnv(
      {
        WT_SESSION: undefined,
        COLORTERM: undefined,
        TERM_PROGRAM: 'Apple_Terminal',
      },
      () => {
        expect(isTrueColor()).toBe(false);
      },
    );
    withEnv(
      {
        WT_SESSION: '1234-5678',
        COLORTERM: undefined,
        TERM_PROGRAM: undefined,
      },
      () => {
        expect(isTrueColor()).toBe(true);
      },
    );
    withEnv(
      {
        WT_SESSION: undefined,
        COLORTERM: undefined,
        TERM_PROGRAM: 'iTerm.app',
      },
      () => {
        expect(isTrueColor()).toBe(true);
      },
    );
    withEnv(
      {
        WT_SESSION: undefined,
        COLORTERM: 'truecolor',
        TERM_PROGRAM: 'Apple_Terminal',
      },
      () => {
        expect(isTrueColor()).toBe(true);
      },
    );
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

  test('tokenizeKeyStream 识别 SS3 方向键、带中间字节 CSI、Alt 双字节与 CRLF', () => {
    expect(
      tokenizeKeyStream('\x1b[A\x1bOD\x1bOH\x1bb\x1b[1;5D\r\n中a'),
    ).toEqual([
      '\x1b[A',
      '\x1bOD',
      '\x1bOH',
      '\x1bb',
      '\x1b[1;5D',
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

describe('共享行队列读取器与清单文件名校验', () => {
  test('createLineQueueReader 缓冲多行管道输入与跨 chunk UTF-8, 末尾无换行不丢最后一行', async () => {
    const input = new PassThrough();
    const output = new PassThrough();
    const reader = createLineQueueReader(input, output);
    const zhBytes = Buffer.from('第3题中文', 'utf8');

    input.write('1\r\napp\n');
    input.write(zhBytes.subarray(0, 4));
    input.write(zhBytes.subarray(4));
    input.end();

    expect(await reader.question('q1: ')).toBe('1');
    expect(await reader.question('q2: ')).toBe('app');
    expect(await reader.question('q3: ')).toBe('第3题中文');
    expect(await reader.question('q4: ')).toBeNull();
    reader.close();
  });

  test('validateManifestFileName 拒绝 .json 无主名与非法字符, 放行合规路径', () => {
    expect(validateManifestFileName('.json')).not.toBeNull();
    expect(validateManifestFileName('configs/.json')).not.toBeNull();
    expect(validateManifestFileName('..json')).not.toBeNull();
    expect(validateManifestFileName('deploy.yaml')).not.toBeNull();
    expect(validateManifestFileName('bad:name.json')).not.toBeNull();
    expect(validateManifestFileName('deploy.json')).toBeNull();
    expect(validateManifestFileName('configs/prod.json')).toBeNull();
  });
});

describe('widgets 换行防撑裂与窄屏收缩验证', () => {
  test('formatBoxLines / formatSummaryCardLines / formatFormulaCardLines / formatKVLines 窄屏齐整不撑裂', () => {
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

    const narrowSummary = formatSummaryCardLines(
      '结果',
      'ok',
      [['超长左侧标签名', '/tmp/a/b/c\n/tmp/d']],
      34,
    );
    const summaryFrame = narrowSummary
      .map((l) => stripAnsi(l))
      .filter((l) => l.trimStart().startsWith('│'));
    expect(summaryFrame.length).toBeGreaterThanOrEqual(4);
    for (const ln of summaryFrame) {
      expect(ln.includes('\n')).toBe(false);
      expect(displayWidth(ln)).toBe(36);
    }

    const narrowFormula = formatFormulaCardLines(
      '2 核 · 2 GB',
      [
        {
          key: 'WT_CACHE_GB',
          label: '热数据内存缓存',
          value: '0.5 GB',
          formula: 'f',
          plainReason: '留出足够内存避免 OOM 触发重启',
        },
      ],
      36,
    );
    const formulaFrame = narrowFormula
      .map((l) => stripAnsi(l))
      .filter((l) => l.trimStart().startsWith('│'));
    for (const ln of formulaFrame) {
      expect(displayWidth(ln)).toBe(38);
    }

    const kvLines = formatKVLines([['key', 'line1\nline2']], 4, 80);
    expect(kvLines.length).toBe(2);
    expect(kvLines.every((l) => !l.includes('\n'))).toBe(true);
  });
});
