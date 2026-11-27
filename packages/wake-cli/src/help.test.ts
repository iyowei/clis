/**
 * `@iyowei/wake-cli` 双语帮助文案与单轴线右栏左对齐契约测试。
 */
import { describe, expect, test } from 'bun:test';

import { displayWidth } from '@iyowei/cli-i18n';

import { helpText } from './help.ts';

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

function collectRightColumnStarts(
  plain: string,
  alignedSections: ReadonlySet<string>,
): Set<number> {
  let currentSection = '';
  const cols = new Set<number>();
  for (const line of plain.split('\n')) {
    const trimmed = line.trim();
    if (/^  \S/.test(line)) {
      currentSection = trimmed;
      continue;
    }
    if (!alignedSections.has(currentSection) || trimmed === '') continue;
    const match = /^(    .+?)( {2,})(\S.*)$/.exec(line);
    expect(match, `未匹配到两栏结构: ${line}`).not.toBeNull();
    const leftWidth = displayWidth(match![1]!.slice(4));
    cols.add(leftWidth + match![2]!.length);
  }
  return cols;
}

describe('wake-cli helpText', () => {
  test('中英文帮助均输出全部核心选项并分别指向对应语言用户文档, 且去色逐字节等价', () => {
    const zh = helpText('1.0.0', false, 'zh');
    const en = helpText('1.0.0', false, 'en');

    expect(zh).toContain('▍ WAKE');
    expect(en).toContain('▍ WAKE');
    expect(zh).not.toContain('\u001B[');
    expect(en).not.toContain('\u001B[');

    expect(zh).toContain(
      'https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.zh-CN.md',
    );
    expect(en).toContain(
      'https://github.com/iyowei/clis/blob/main/packages/wake-cli/README.md',
    );
    expect(en).not.toContain('README.zh-CN.md');

    for (const token of [
      '--config',
      '--mac',
      '--host',
      '--port',
      '--broadcast',
      '--relay',
      '--timeout',
      '--no-wait',
      '--force',
      '--local-only',
      '--no-local-fallback',
      '--name',
      '--default',
      '--yes',
      '--json',
      '--lang',
      'https://github.com/iyowei/clis/tree/main/packages/wake-cli',
    ]) {
      expect(zh).toContain(token);
      expect(en).toContain(token);
    }

    const colored = helpText('1.0.0', true, 'en');
    expect(colored).toContain('\u001B[');
    expect(stripAnsi(colored)).toBe(en);
  });

  test('中英文帮助全部两栏分区 (含使用须知/退出码/文档与源码) 右侧左对齐到同一垂直列线', () => {
    const zhCols = collectRightColumnStarts(
      helpText('1.0.0', false, 'zh'),
      new Set(['子命令', '选项', '示例', '使用须知', '退出码', '文档与源码']),
    );
    expect(zhCols.size).toBe(1);

    const enCols = collectRightColumnStarts(
      helpText('1.0.0', false, 'en'),
      new Set([
        'Commands',
        'Options',
        'Examples',
        'Notes',
        'Exit Codes',
        'Docs & Source',
      ]),
    );
    expect(enCols.size).toBe(1);
  });
});
