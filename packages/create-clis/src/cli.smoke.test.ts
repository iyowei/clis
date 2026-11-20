/**
 * create-clis 入口冒烟: 只承诺「帮助可打印且退 0」(秒级健康检查, 无夹具无生成), 双载体
 * (bun / node)。生成全链的端到端契约在 cli.e2e.test.ts; 无参数直跑会进交互问答, 不属冒烟面。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const DIST_CLI = fileURLToPath(
  new URL('../dist/create-clis.js', import.meta.url),
);
const PKG_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

/** 挂死守卫: 帮助秒回, 超时即判失败 */
const TIMEOUT_MS = 10_000;

for (const runner of ['bun', 'node']) {
  const available =
    spawnSync(runner, ['--version'], { encoding: 'utf8' }).status === 0;

  describe(`cli 入口冒烟 [${runner}]`, () => {
    test.skipIf(!available)('--help / -h: 退 0 且给出用法与旗标', () => {
      for (const flag of ['--help', '-h']) {
        const result = spawnSync(runner, [CLI, flag], {
          encoding: 'utf8',
          timeout: TIMEOUT_MS,
        });
        const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
        expect(result.status, `应退 0 (${detail})`).toBe(0);
        for (const text of ['create-clis', '--tier', '--no-install']) {
          expect(result.stdout).toContain(text);
        }
      }
    });

    test.skipIf(!available)(
      '--version / -V: 退 0 且输出与 package.json 一致的版本号',
      () => {
        for (const flag of ['--version', '-V']) {
          const result = spawnSync(runner, [CLI, flag], {
            encoding: 'utf8',
            timeout: TIMEOUT_MS,
          });
          const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
          expect(result.status, `应退 0 (${detail})`).toBe(0);
          expect(result.stdout.trim(), `flag=${flag}`).toBe(PKG_VERSION);
        }
      },
    );
  });
}

describe('产物轻量化与惰性加载守卫 (CREATE-P0-1)', () => {
  test.skipIf(!existsSync(DIST_CLI))(
    'dist/create-clis.js 不含顶层静态 import prettier, 仅按需动态 import',
    () => {
      const bundle = readFileSync(DIST_CLI, 'utf8');
      expect(bundle).not.toMatch(
        /\bimport\s+\*\s+as\s+\w+\s+from\s*["']prettier["']/,
      );
      expect(bundle).not.toMatch(/\bimport\s+[^(\n]+from\s*["']prettier["']/);
      expect(bundle).toMatch(/import\(["']prettier["']\)/);
    },
  );
});
