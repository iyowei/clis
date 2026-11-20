/**
 * sweep-nm 帮助页单测: 覆盖 Apple HIG 分层结构 (命令与选项独立分组)、OF-10 降级恒等式、
 * 80 列行宽护栏与深/浅终端色彩切换。
 */
import { describe, expect, test } from 'bun:test';

import { helpText } from './help.ts';

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

/** 计算单行终端显示宽度 (CJK 与常见全角按 2 列, 其余按 1 列) */
function displayWidth(line: string): number {
  let width = 0;
  for (const ch of line) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

describe('helpText Apple HIG 分层与降级契约', () => {
  test('无色态零 ANSI、子命令与选项清晰分组、全要素完备', () => {
    const plain = helpText(false);
    expect(plain).not.toContain('\u001b');

    const sections = ['用法', '子命令', '选项', '示例', '配置与安全', '退出码'];
    let cursor = -1;
    for (const sec of sections) {
      const idx = plain.indexOf(`  ${sec}\n`);
      expect(idx, `应包含分区 ${sec}`).toBeGreaterThan(cursor);
      cursor = idx;
    }

    // 子命令独立在「子命令」区块, 不再与 --flag 混排
    const cmdStart = plain.indexOf('  子命令\n');
    const optStart = plain.indexOf('  选项\n');
    const exStart = plain.indexOf('  示例\n');
    const cmdBlock = plain.slice(cmdStart, optStart);
    const optBlock = plain.slice(optStart, exStart);

    for (const sub of ['init', 'config', 'update']) {
      expect(cmdBlock).toContain(`    ${sub}`);
    }
    expect(cmdBlock).not.toContain('--yes');
    expect(cmdBlock).not.toContain('--exclude');

    for (const flag of [
      '--yes',
      '--force',
      '--exclude <name>',
      '--include <name>',
      '--config <path>',
      '-V, --version',
      '-h, --help',
    ]) {
      expect(optBlock).toContain(flag);
    }
  });

  test('OF-10 降级恒等式: 彩色态去色后与无色态逐字节一致 (深浅终端皆然)', () => {
    const prevFgBg = process.env.COLORFGBG;
    try {
      delete process.env.COLORFGBG;
      const darkColored = helpText(true);
      const plain = helpText(false);
      expect(darkColored).toContain('\u001b[');
      expect(stripAnsi(darkColored)).toBe(plain);

      process.env.COLORFGBG = '0;15';
      const lightColored = helpText(true);
      expect(lightColored).toContain('\u001b[');
      expect(stripAnsi(lightColored)).toBe(plain);
    } finally {
      if (prevFgBg === undefined) delete process.env.COLORFGBG;
      else process.env.COLORFGBG = prevFgBg;
    }
  });

  test('固定文案每行宽度均在 80 列内 (防经典 80 列终端截断)', () => {
    const lines = helpText(false).split('\n');
    for (const line of lines) {
      // 跳过动态绝对路径行 (取决于宿主 HOME 长度)
      if (line.includes('默认配置')) continue;
      expect(
        displayWidth(line),
        `行过宽 (${displayWidth(line)} 列): ${line}`,
      ).toBeLessThanOrEqual(80);
    }
  });
});
