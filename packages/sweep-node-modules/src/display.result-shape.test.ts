/**
 * 展示辅助的结果形态契约: formatBytes / sanitizeLine / sanitizeOutputLine。
 * 依据 packages/sweep-node-modules/docs/designs/api-surface.md §2.6; 从公开面入口 (index.ts) 导入,
 * 按真实调用方的方式消费。不可见字符一律经 String.fromCodePoint 构造,
 * 避免源码里出现真实控制字符 (不可见即不可审)。
 */
import { describe, expect, test } from 'bun:test';

import { formatBytes, sanitizeLine, sanitizeOutputLine } from './index.ts';

const ESC = String.fromCodePoint(0x1b);
const ZERO_WIDTH = String.fromCodePoint(0x200b);
const BIDI_RLO = String.fromCodePoint(0x202e);
const BOM = String.fromCodePoint(0xfeff);

describe('formatBytes', () => {
  test('逐级 1024, 保留 1 位小数, 整数省略小数尾', () => {
    expect(formatBytes(0)).toBe('0 B');
    expect(formatBytes(1023)).toBe('1023 B');
    expect(formatBytes(1024)).toBe('1 KB');
    expect(formatBytes(1536)).toBe('1.5 KB');
    expect(formatBytes(4939212390)).toBe('4.6 GB');
    expect(formatBytes(1024 ** 2)).toBe('1 MB');
    expect(formatBytes(1024 ** 3)).toBe('1 GB');
    expect(formatBytes(1024 ** 4)).toBe('1 TB');
  });

  test('最小单位 B 取整; TB 为最大档 (超出仍以 TB 计)', () => {
    expect(formatBytes(1023.4)).toBe('1023 B');
    expect(formatBytes(1024 ** 4 * 1024)).toBe('1024 TB');
  });
});

describe('sanitizeLine', () => {
  test('剥离控制类字符: ESC / 零宽 / bidi / BOM', () => {
    expect(sanitizeLine(`a${ESC}[31mred${ESC}[0m`)).toBe('a[31mred[0m');
    expect(sanitizeLine(`x${ZERO_WIDTH}y`)).toBe('xy');
    expect(sanitizeLine(`${BOM}hello`)).toBe('hello');
    expect(sanitizeLine(`safe${BIDI_RLO}txt.exe`)).toBe('safetxt.exe');
  });

  test('空白 (含换行与制表) 折成单空格, 两端去空白', () => {
    expect(sanitizeLine('  a\nb\tc  ')).toBe('a b c');
    expect(sanitizeLine('crlf\r\nnext')).toBe('crlf next');
  });

  test('正常文本 (含中文与单一空格) 原样保留', () => {
    expect(sanitizeLine('/Users/me/项目 目录')).toBe('/Users/me/项目 目录');
  });
});

describe('sanitizeOutputLine', () => {
  test('保留行首缩进 (分级排版属排版而非外部数据), 行内其余空白照常折叠', () => {
    expect(sanitizeOutputLine('  详情: a\nb')).toBe('  详情: a b');
    expect(sanitizeOutputLine('\t制表缩进')).toBe('\t制表缩进');
    expect(sanitizeOutputLine('无缩进')).toBe('无缩进');
  });

  test('缩进之外的净化与 sanitizeLine 同源', () => {
    expect(sanitizeOutputLine(`  ${ESC}[1m注意`)).toBe('  [1m注意');
  });
});
