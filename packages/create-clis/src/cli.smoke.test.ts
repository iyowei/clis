/**
 * create-clis 入口骨架冒烟: 占位版只承诺「帮助可打印且退 0」, 双载体 (bun / node)。
 * 完整生成流程的端到端回归随后续任务接线 (cli.e2e.test.ts) 落地。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** 挂死守卫: 占位入口秒回, 超时即判失败 */
const TIMEOUT_MS = 10_000;

for (const runner of ['bun', 'node']) {
  const available =
    spawnSync(runner, ['--version'], { encoding: 'utf8' }).status === 0;

  describe(`cli 骨架冒烟 [${runner}]`, () => {
    test.skipIf(!available)('帮助可打印且退 0', () => {
      const result = spawnSync(runner, [CLI], {
        encoding: 'utf8',
        timeout: TIMEOUT_MS,
      });
      const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
      expect(result.status, `应退 0 (${detail})`).toBe(0);
      expect(result.stdout).toContain('create-clis');
    });
  });
}
