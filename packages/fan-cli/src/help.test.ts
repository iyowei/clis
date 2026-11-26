/**
 * `help.ts` 单元测试: 覆盖全部子命令/选项、无 ANSI 降级等价性及全分段精确垂直左对齐。
 */
import { describe, expect, test } from 'bun:test';

import { HELP_DESC_COL, displayWidth, helpText } from './help.ts';

const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function stripAnsi(text: string): string {
  return text.replace(ANSI_CSI_RE, '');
}

describe('helpText', () => {
  test('包含全部子命令与选项, 且无颜色版与去色版逐字等价', () => {
    const plain = helpText(false);
    const colored = helpText(true);

    expect(plain).not.toContain('\u001B');
    expect(stripAnsi(colored)).toBe(plain);
    for (const token of [
      'status',
      'set',
      'max',
      'min',
      'auto',
      'apply',
      'persist',
      'install',
      'uninstall',
      'update',
      '--fan',
      '--once',
      '--no-save',
      '--json',
      '--watch',
      '-w',
      '-V, --version',
      '-h, --help',
      '--check',
      'fan set 60%',
    ]) {
      expect(plain).toContain(token);
    }
  });

  test('所有分段的右侧说明严格对齐到同一视觉列线', () => {
    const plain = helpText(false);
    const lines = plain.split('\n');
    const alignedSections = new Set([
      '子命令',
      '选项',
      '示例',
      '环境与持久化',
      '退出码',
    ]);

    let currentSection = '';
    const columnsSeen = new Set<number>();

    for (const line of lines) {
      const heading = line.trim();
      if (/^  \S/.test(line)) {
        currentSection = heading;
        continue;
      }
      if (!alignedSections.has(currentSection) || heading === '') continue;

      const match = /^(    .+?)( {2,})(\S.*)$/.exec(line);
      expect(match, `未匹配到两栏结构: ${line}`).not.toBeNull();
      const leftPlusIndent = match![1]!;
      const gap = match![2]!;
      const leftWidth = displayWidth(leftPlusIndent.slice(4));
      const descStartCol = leftWidth + gap.length;
      expect(descStartCol).toBe(HELP_DESC_COL);
      columnsSeen.add(descStartCol);
    }

    expect(columnsSeen.size).toBe(1);
    expect([...columnsSeen][0]).toBe(HELP_DESC_COL);
  });

  test('英文 helpText 去色等价且分段右侧说明严格对齐到同一视觉列线', () => {
    const plain = helpText(false, 'en');
    const colored = helpText(true, 'en');
    expect(plain).not.toContain('\u001B');
    expect(stripAnsi(colored)).toBe(plain);

    const alignedSections = new Set([
      'Commands',
      'Options',
      'Examples',
      'Persistence & Safety',
      'Exit Codes',
    ]);
    let currentSection = '';
    const columnsSeen = new Set<number>();
    for (const line of plain.split('\n')) {
      const heading = line.trim();
      if (/^  \S/.test(line)) {
        currentSection = heading;
        continue;
      }
      if (!alignedSections.has(currentSection) || heading === '') continue;
      const match = /^(    .+?)( {2,})(\S.*)$/.exec(line);
      expect(match, `未匹配到英文两栏结构: ${line}`).not.toBeNull();
      const leftWidth = displayWidth(match![1]!.slice(4));
      columnsSeen.add(leftWidth + match![2]!.length);
    }
    expect(columnsSeen.size).toBe(1);
  });
});
