/**
 * create-clis 帮助页单测: 验证 Apple HIG 分层、零 ANSI 降级恒等式与 80 列行宽护栏。
 */
import { describe, expect, test } from 'bun:test';

import { formatHelpText } from './help.ts';

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

describe('create-clis formatHelpText', () => {
  test('无色态零 ANSI、子命令与模板变量 / 生成选项独立分区', () => {
    const plain = formatHelpText(false);
    expect(plain).not.toContain('\u001b');
    for (const sec of ['用法', '子命令', '模板变量', '生成选项', '说明']) {
      expect(plain).toContain(`  ${sec}\n`);
    }
    expect(plain).toContain('-V, --version');
    expect(plain).toContain('-h, --help');
  });

  test('彩色态去色后与无色态逐字节一致', () => {
    const colored = formatHelpText(true);
    const plain = formatHelpText(false);
    expect(colored).toContain('\u001b[');
    expect(stripAnsi(colored)).toBe(plain);
  });
});
