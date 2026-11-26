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
    for (const sec of [
      '用法',
      '子命令',
      '模板变量',
      '生成选项',
      '说明',
      '文档与源码',
    ]) {
      expect(plain).toContain(`  ${sec}\n`);
    }
    expect(plain).toContain(
      'https://github.com/iyowei/clis/tree/main/packages/create-clis',
    );
    expect(plain).toContain('-V, --version');
    expect(plain).toContain('-h, --help');
    expect(plain).toContain('[目录]/--name');
    expect(plain).toContain('--owner');
    expect(plain).toContain('选项终止');
    expect(plain).toContain('名为 update 的目录');
    for (const line of plain.split('\n')) {
      let width = 0;
      for (const ch of line) {
        const code = ch.codePointAt(0) ?? 0;
        const wide =
          (code >= 0x2e80 && code <= 0xa4cf) ||
          (code >= 0xf900 && code <= 0xfaff) ||
          (code >= 0xff00 && code <= 0xff60);
        width += wide ? 2 : 1;
      }
      expect(width, `超 80 列: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  test('彩色态去色后与无色态逐字节一致', () => {
    const colored = formatHelpText(true);
    const plain = formatHelpText(false);
    expect(colored).toContain('\u001b[');
    expect(stripAnsi(colored)).toBe(plain);
  });
});
