/**
 * sweep 帮助页单测: 覆盖分层结构 (命令与选项独立分组)、与主视图同源的标准 SGR 配色、
 * OF-10 降级恒等式、品牌收口 (零 sweep-nm 残留) 与 80 列行宽护栏。
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

describe('helpText 分层布局与主视图同源配色契约', () => {
  test('无色态零 ANSI、子命令与选项清晰分组、全要素完备且零 sweep-nm 残留', () => {
    const plain = helpText(false);
    expect(plain).not.toContain('\u001b');
    expect(plain).toContain('▍ SWEEP');
    expect(plain).toContain('sweep');
    expect(plain).toContain('SWEEP_CONFIG');
    expect(plain).toContain('init --default');
    expect(plain).toContain('migrate');
    expect(plain).toContain(
      'https://github.com/iyowei/clis/tree/main/packages/sweep-cli',
    );
    expect(plain).not.toMatch(/sweep-nm/i);

    const sections = [
      '用法',
      '子命令',
      '选项',
      '示例',
      '配置与安全',
      '退出码',
      '文档与源码',
    ];
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

    for (const sub of ['init', 'migrate', 'config', 'update']) {
      expect(cmdBlock).toContain(`    ${sub}`);
    }
    expect(cmdBlock).not.toContain('--yes');
    expect(cmdBlock).not.toContain('--exclude');

    for (const flag of [
      '--yes',
      '--force',
      '--default',
      '--exclude <name>',
      '--include <name>',
      '--config <path>',
      '-V, --version',
      '-h, --help',
    ]) {
      expect(optBlock).toContain(flag);
    }
  });

  test('OF-10 降级恒等式与主视图色盘同源: 仅用标准 SGR (零硬编码 24-bit RGB), 去色逐字节等价', () => {
    const colored = helpText(true);
    const plain = helpText(false);

    expect(colored).toContain('\u001b[1;7m▍ SWEEP \u001b[0m');
    expect(colored).toContain('\u001b[1;34m子命令\u001b[0m');
    expect(colored).toContain(
      '\u001b[2m预览工作区内可清理的构建产物与缓存\u001b[0m',
    );
    expect(colored).not.toContain('38;2;');
    expect(colored).not.toContain('48;2;');
    expect(stripAnsi(colored)).toBe(plain);
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
