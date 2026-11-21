/**
 * 双运行时冒烟: 在真实 Node.js 子进程中加载构建产物 `dist/index.js`,
 * 验证核心导出 (`parseUpdateArgs` / `compareSemver` / `formatUpdateHelp` / `runSelfUpdate`)
 * 在纯 Node 环境下无 Bun 专有 API 依赖。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DIST_ENTRY = join(PKG_ROOT, 'dist', 'index.js');

const HAS_NODE =
  spawnSync('node', ['--version'], { stdio: 'ignore' }).status === 0;

describe('cli-updater 双运行时冒烟 (Node.js 加载 dist/index.js)', () => {
  test.skipIf(!HAS_NODE)(
    '纯 Node 进程导入 dist/index.js 并执行参数解析、版本比较与 help 渲染',
    () => {
      expect(existsSync(DIST_ENTRY)).toBe(true);
      const entryUrl = pathToFileURL(DIST_ENTRY).href;
      const script = `
        import * as updater from ${JSON.stringify(entryUrl)};
        const parsed = updater.parseUpdateArgs(['--check', '--verbose']);
        const cmp = updater.compareSemver('1.3.0', '1.2.9');
        const help = updater.formatUpdateHelp('demo', '@demo/demo-cli', false);
        const lines = [];
        const code = await updater.runSelfUpdate({
          binName: 'demo',
          meta: {
            name: '@demo/demo-cli',
            version: '1.0.0',
            isPrivate: false,
            rawPackageRoot: '/mock/demo',
            packageRoot: '/mock/demo',
          },
          argv: ['--help'],
          io: { out: (l) => lines.push(l), err: () => {} },
        });
        process.stdout.write(JSON.stringify({
          ok: parsed.ok,
          check: parsed.ok ? parsed.options.check : false,
          verbose: parsed.ok ? parsed.options.verbose : false,
          cmp,
          hasHelp: help.includes('demo update'),
          code,
          hasOutHelp: lines.join('\\n').includes('demo update'),
        }));
      `;
      const res = spawnSync('node', ['--input-type=module', '-e', script], {
        encoding: 'utf8',
      });
      expect(res.status, res.stderr).toBe(0);
      const out = JSON.parse(res.stdout) as Record<string, unknown>;
      expect(out).toEqual({
        ok: true,
        check: true,
        verbose: true,
        cmp: 1,
        hasHelp: true,
        code: 0,
        hasOutHelp: true,
      });
    },
  );
});
