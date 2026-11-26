/**
 * `@iyowei/wake-cli` 双运行时端到端测试 (`bun` 与 `node >= 22.18` 子进程闭环)。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const PKG_ROOT = join(import.meta.dir, '..');
const SRC_ENTRY = join(PKG_ROOT, 'src', 'cli.ts');
const BIN_ENTRY = join(PKG_ROOT, 'bin', 'wake.mjs');
const DIST_CLI = join(PKG_ROOT, 'dist', 'cli.js');
const PKG_VERSION = (
  JSON.parse(readFileSync(join(PKG_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

const ISOLATED_HOME = mkdtempSync(join(tmpdir(), 'wake-e2e-home-'));
afterAll(() => {
  rmSync(ISOLATED_HOME, { recursive: true, force: true });
});

function buildEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {
    ...process.env,
    NO_COLOR: '1',
    HOME: ISOLATED_HOME,
    USERPROFILE: ISOLATED_HOME,
    APPDATA: join(ISOLATED_HOME, 'AppData', 'Roaming'),
    LOCALAPPDATA: join(ISOLATED_HOME, 'AppData', 'Local'),
    XDG_CONFIG_HOME: join(ISOLATED_HOME, '.config'),
    CLIS_TEST_OS_LOCALE: 'zh-CN',
  };
  delete env.WAKE_LANG;
  delete env.CLIS_LANG;
  return env;
}

function resolveExec(runner: string): string | null {
  const res = spawnSync(
    runner,
    ['-e', 'process.stdout.write(process.execPath)'],
    { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 10_000 },
  );
  if (res.status !== 0) return null;
  const trimmed = res.stdout.trim();
  return trimmed !== '' ? trimmed : null;
}

const RUNTIME_TARGETS: Array<{ label: string; execPath: string }> = [
  { label: 'bun', execPath: process.execPath },
];
const nodeExec = resolveExec('node');
if (nodeExec !== null) {
  RUNTIME_TARGETS.push({ label: 'node', execPath: nodeExec });
}

for (const { label, execPath } of RUNTIME_TARGETS) {
  describe(`@iyowei/wake-cli E2E (${label})`, () => {
    const entry = existsSync(DIST_CLI) ? BIN_ENTRY : SRC_ENTRY;
    const run = (args: string[]) =>
      spawnSync(execPath, [entry, ...args], {
        encoding: 'utf8',
        stdio: ['ignore', 'pipe', 'pipe'],
        env: buildEnv(),
        timeout: 20_000,
      });

    test('支持 -V、双语 --help 与 init/list/doctor 只读端到端闭环', () => {
      const ver = run(['-V']);
      expect(ver.status, ver.stderr).toBe(0);
      expect(ver.stdout.trim()).toBe(PKG_VERSION);

      const helpEn = run(['--lang', 'en', '--help']);
      expect(helpEn.status).toBe(0);
      expect(helpEn.stdout).toContain(
        'Subnet-Aware & SSH-Relay Wake-on-LAN CLI',
      );

      const sandboxCfgDir = join(ISOLATED_HOME, label);
      mkdirSync(sandboxCfgDir, { recursive: true });
      const cfgPath = join(sandboxCfgDir, 'wake.json');

      const initRes = run([
        'init',
        '--config',
        cfgPath,
        '--name',
        'lab-box',
        '--mac',
        '00:11:22:33:44:55',
        '--host',
        '192.0.2.10',
        '--yes',
      ]);
      expect(initRes.status, initRes.stderr).toBe(0);

      const listRes = run(['list', '--config', cfgPath, '--json']);
      expect(listRes.status).toBe(0);
      expect(JSON.parse(listRes.stdout).defaultTarget).toBe('lab-box');

      const docRes = run(['doctor', '--config', cfgPath, '--json']);
      expect(docRes.status).toBe(0);
      expect(JSON.parse(docRes.stdout).configExists).toBe(true);
    });
  });
}
