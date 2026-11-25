/**
 * `@iyowei/cli-updater` 双语渲染与语言覆盖测试:
 * 验证英文帮助页对齐、`--lang en` 覆盖中文系统语言、`runSelfUpdate` 英文状态流转。
 */
import { describe, expect, test } from 'bun:test';

import { formatUpdateHelp, runSelfUpdate } from './index.ts';

describe('cli-updater 中英双语支持', () => {
  test('formatUpdateHelp(en) 生成对齐的英文帮助页且单行宽度 <= 88', () => {
    const help = formatUpdateHelp('fan', '@iyowei/fan-cli', false, 'en');
    expect(help).toContain('Self-Update (@iyowei/fan-cli)');
    expect(help).toContain('--lang <lang>');
    expect(help).toContain('Usage');
    expect(help).toContain('Options');
    for (const line of help.split('\n')) {
      expect(line.length).toBeLessThanOrEqual(88);
    }
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
