/**
 * create-clis 入口冒烟: 只承诺「帮助可打印且退 0」(秒级健康检查, 无夹具无生成), 双载体
 * (bun / node)。生成全链的端到端契约在 cli.e2e.test.ts; 无参数直跑会进交互问答, 不属冒烟面。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** 挂死守卫: 帮助秒回, 超时即判失败 */
const TIMEOUT_MS = 10_000;

for (const runner of ['bun', 'node']) {
  const available =
    spawnSync(runner, ['--version'], { encoding: 'utf8' }).status === 0;

  describe(`cli 入口冒烟 [${runner}]`, () => {
    test.skipIf(!available)('--help 可打印且退 0', () => {
      const result = spawnSync(runner, [CLI, '--help'], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.status, `应退 0 (${detail})`).toBe(0);
      expect(result.stdout).toContain('create-clis');
    });
  });
}
