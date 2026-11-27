/**
 * `@iyowei/wake-cli` 双语帮助文案契约测试。
 */
import { describe, expect, test } from 'bun:test';

import { helpText } from './help.ts';

describe('wake-cli helpText', () => {
  test('中英文帮助均输出全部核心选项并分别指向对应语言用户文档, 关闭 color 时零 ANSI', () => {
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
  });
});
