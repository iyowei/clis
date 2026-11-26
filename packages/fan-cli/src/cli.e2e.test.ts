/**
 * `@iyowei/fan-cli` 双运行时 (Bun + Node) 端到端契约测试。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'fan-cli-e2e-home-'));
afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function isolatedSubprocessEnv(): Record<string, string | undefined> {
  const env: Record<string, string | undefined> = {
    ...process.env,
    NO_COLOR: '1',
    HOME: ISOLATED_HOME,
    USERPROFILE: ISOLATED_HOME,
    APPDATA: join(ISOLATED_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(ISOLATED_HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(ISOLATED_HOME, '.config'),
    CLIS_TEST_OS_LOCALE: 'zh-CN',
  };
  delete env.FAN_LANG;
  delete env.CLIS_LANG;
  return env;
}

function resolveRunnerExec(runner: string): string | null {
  const res = spawnSync(
    runner,
    ['-e', 'process.stdout.write(process.execPath)'],
    {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      timeout: 10_000,
    },
  );
  if (res.status !== 0) return null;
  const execPath = res.stdout.trim();
  return execPath !== '' ? execPath : null;
}

const RUNNERS = ['bun', 'node'] as const;
const RUNNER_AVAILABILITY = RUNNERS.map((runner) => ({
  runner,
  execPath: resolveRunnerExec(runner),
}));

function runSubprocess(execPath: string, args: string[]) {
  return spawnSync(execPath, [CLI, ...args], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: isolatedSubprocessEnv(),
    timeout: 20_000,
  });
}

for (const { runner, execPath } of RUNNER_AVAILABILITY) {
  if (execPath === null) {
    console.warn(`[Skip] 未检测到运行时 ${runner}, 跳过对应 e2e 用例`);
    continue;
  }

  describe(`fan-cli 双运行时 e2e [${runner}]`, () => {
    test('--version / -V 与 --help / -h', () => {
      const ver = runSubprocess(execPath, ['-V']);
      expect(ver.status, ver.stderr).toBe(0);
      expect(ver.stdout.trim()).toBe(CLI_VERSION);

      const help = runSubprocess(execPath, ['--help']);
      expect(help.status, help.stderr).toBe(0);
      expect(help.stdout).toContain('FAN');
      expect(help.stdout).toContain('apply');
      expect(help.stdout).toContain('persist');
      expect(help.stdout).toContain('--once');
    });

    test('update --help 与非法参数退 1', () => {
      const upd = runSubprocess(execPath, ['update', '--help']);
      expect(upd.status, upd.stderr).toBe(0);

      const bad = runSubprocess(execPath, ['set']);
      expect(bad.status).toBe(1);
      expect(bad.stderr).toContain('缺少目标转速');

      const badOnce = runSubprocess(execPath, ['status', '--once']);
      expect(badOnce.status).toBe(1);
      expect(badOnce.stderr).toContain('--once');
    });

    test.skipIf(process.platform !== 'darwin')(
      'macOS persist status --json 只读冒烟',
      () => {
        const persistRes = runSubprocess(execPath, [
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

    const canReadAppleSmc =
      process.platform === 'darwin' &&
      existsSync('/usr/bin/python3') &&
      spawnSync('/usr/bin/python3', ['-c', 'import ctypes'], {
        stdio: ['ignore', 'pipe', 'pipe'],
        timeout: 3000,
      }).status === 0;

    test.skipIf(!canReadAppleSmc)(
      'macOS 真机 status --json 只读冒烟 (无物理 SMC 宿主机保持结构化报错)',
      () => {
        const res = runSubprocess(execPath, ['status', '--json']);
        if (res.status === 0) {
          const parsed = JSON.parse(res.stdout) as { fans: unknown[] };
          expect(Array.isArray(parsed.fans)).toBe(true);
          return;
        }
        expect(res.status).toBe(1);
        expect(res.stderr).toMatch(/AppleSMC|FNum|IOServiceOpen|超时/i);
      },
      20_000,
    );

    test.skipIf(process.platform === 'darwin')(
      '非 macOS 平台执行 status 返回结构化平台不支持错误 (退出码 1)',
      () => {
        const res = runSubprocess(execPath, ['status', '--json']);
        expect(res.status).toBe(1);
        expect(res.stderr).toContain('macOS');
      },
    );
  });
}
