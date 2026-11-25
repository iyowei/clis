/**
 * `@iyowei/fan-cli` 双运行时 (Bun + Node) 端到端契约测试。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

const RUNNERS = ['bun', 'node'] as const;
const RUNNER_AVAILABILITY = RUNNERS.map((runner) => ({
  runner,
  available: spawnSync(runner, ['-v'], { timeout: 10_000 }).status === 0,
}));

function runSubprocess(runner: string, args: string[]) {
  return spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    env: { ...process.env, NO_COLOR: '1' },
    timeout: 10_000,
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  if (!available) {
    console.warn(`[Skip] 未检测到运行时 ${runner}, 跳过对应 e2e 用例`);
    continue;
  }

  describe(`fan-cli 双运行时 e2e [${runner}]`, () => {
    test('--version / -V 与 --help / -h', () => {
      const ver = runSubprocess(runner, ['-V']);
      expect(ver.status, ver.stderr).toBe(0);
      expect(ver.stdout.trim()).toBe(CLI_VERSION);

      const help = runSubprocess(runner, ['--help']);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('FAN');
      expect(help.stdout).toContain('apply');
      expect(help.stdout).toContain('persist');
      expect(help.stdout).toContain('--once');
    });

    test('update --help 与非法参数退 1', () => {
      const upd = runSubprocess(runner, ['update', '--help']);
      expect(upd.status, upd.stderr).toBe(0);

      const bad = runSubprocess(runner, ['set']);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('缺少目标转速');

      const badOnce = runSubprocess(runner, ['status', '--once']);
      expect(badOnce.status).toBe(1);
      expect(badOnce.stderr).toContain('--once');
    });

    const canReadAppleSmc =
      process.platform === 'darwin' && existsSync('/usr/bin/python3');

    test.skipIf(!canReadAppleSmc)(
      'macOS 真机 status / persist status --json 只读冒烟',
      () => {
        const res = runSubprocess(runner, ['status', '--json']);
        expect(res.status, res.stderr).toBe(0);
        const parsed = JSON.parse(res.stdout) as { fans: unknown[] };
        expect(parsed.fans.length).toBeGreaterThanOrEqual(1);

        const persistRes = runSubprocess(runner, [
          'persist',
          'status',
          '--json',
        ]);
        expect(persistRes.status, persistRes.stderr).toBe(0);
        const persistParsed = JSON.parse(persistRes.stdout) as {
          label: string;
        };
        expect(persistParsed.label).toBe('com.iyowei.fan');
      },
    );
  });
}
