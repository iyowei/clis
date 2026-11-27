/**
 * `@iyowei/cli-updater` 双语渲染与语言覆盖测试:
 * 验证英文帮助页对齐、`--lang en` 覆盖中文系统语言、`runSelfUpdate` 英文状态流转。
 */
import { describe, expect, test } from 'bun:test';

import { displayWidth } from '@iyowei/cli-i18n';

import { formatUpdateHelp, runSelfUpdate } from './index.ts';

describe('cli-updater 中英双语支持', () => {
  test('formatUpdateHelp 在中英文下所有两栏分区右栏左对齐到同一垂直列线且英文行宽 <= 88', () => {
    for (const locale of ['zh', 'en'] as const) {
      const help = formatUpdateHelp('fan', '@iyowei/fan-cli', false, locale);
      const alignedSections = new Set(
        locale === 'zh' ? ['选项', '说明'] : ['Options', 'Notes'],
      );
      let section = '';
      const cols = new Set<number>();
      for (const line of help.split('\n')) {
        if (locale === 'en') {
          expect(line.length).toBeLessThanOrEqual(88);
        }
        const trimmed = line.trim();
        if (/^  \S/.test(line)) {
          section = trimmed;
          continue;
        }
        if (!alignedSections.has(section) || trimmed === '') continue;
        const m = /^(    .+?)( {2,})(\S.*)$/.exec(line);
        expect(m, `${locale} 未匹配两栏: ${line}`).not.toBeNull();
        cols.add(displayWidth(m![1]!.slice(4)) + m![2]!.length);
      }
      expect(cols.size, `${locale} 右栏未对齐到单列`).toBe(1);
    }

    const helpEn = formatUpdateHelp('fan', '@iyowei/fan-cli', false, 'en');
    expect(helpEn).toContain('Self-Update (@iyowei/fan-cli)');
    expect(helpEn).toContain('--lang <lang>');
    expect(helpEn).toContain('Usage');
    expect(helpEn).toContain('Options');
  });

  test('runSelfUpdate 支持 --lang en 在中文系统环境下输出完整英文视图', async () => {
    const outLines: string[] = [];
    const errLines: string[] = [];
    const code = await runSelfUpdate({
      binName: 'fan',
      argv: ['--check', '--lang', 'en'],
      meta: {
        name: '@iyowei/fan-cli',
        version: '1.0.0',
        isPrivate: false,
        rawPackageRoot:
          '/Users/me/.bun/install/global/node_modules/@iyowei/fan-cli',
        packageRoot:
          '/Users/me/.bun/install/global/node_modules/@iyowei/fan-cli',
      },
      io: {
        out: (l) => outLines.push(l),
        err: (l) => errLines.push(l),
      },
      deps: {
        env: { CLIS_TEST_OS_LOCALE: 'zh-CN' },
        pathExists: () => false,
        fetchLatest: async (_pkg, registry) => ({
          ok: true,
          version: '1.2.0',
          registry,
        }),
      },
    });
    expect(code).toBe(0);
    expect(errLines).toEqual([]);
    const out = outLines.join('\n');
    expect(out).toContain('Self-Update');
    expect(out).toContain('Current');
    expect(out).toContain('Origin');
    expect(out).toContain('bun global install (Bun global directory (~/.bun))');
    expect(out).toContain('Update available: v1.0.0 → v1.2.0');
    expect(out).toContain("Run 'fan update' to upgrade");
  });
});
