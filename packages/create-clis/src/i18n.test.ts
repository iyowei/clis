/**
 * `create-clis` 中英双语帮助页排版与 `lang` 子命令端到端测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { displayWidth } from '@iyowei/cli-i18n';

import { formatHelpText } from './help.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

describe('create-clis 英文排版与独立语言偏好', () => {
  test('formatHelpText(en) 满足降级等价且全部行宽 <= 80 列', () => {
    const plain = formatHelpText(false, 'en');
    const colored = formatHelpText(true, 'en');
    const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    expect(colored.replace(ansiRe, '')).toBe(plain);
    expect(plain).toContain('CLI Monorepo Scaffolder');
    expect(plain).toContain('lang');
    expect(plain).toContain('--lang <lang>');

    for (const line of plain.split('\n')) {
      expect(displayWidth(line), `过宽行: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  test('中文系统下 create-clis lang en 持久化切换为英文且支持 --lang 单次覆盖', () => {
    const home = join(
      tmpdir(),
      `create-clis-i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
    );
    mkdirSync(home, { recursive: true });
    tmpDirs.push(home);

    const baseEnv = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      NO_COLOR: '1',
      CLIS_TEST_OS_LOCALE: 'zh-Hans-CN',
    };

    const r1 = spawnSync('bun', [CLI, '--help'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('clis 集合仓脚手架');

    const r2 = spawnSync('bun', [CLI, 'lang', 'en'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('Language Updated');

    const r3 = spawnSync('bun', [CLI, '--help'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(r3.status).toBe(0);
    expect(r3.stdout).toContain('CLI Monorepo Scaffolder');

    const r4 = spawnSync('bun', [CLI, '--help', '--lang', 'zh'], {
      encoding: 'utf8',
      env: baseEnv,
    });
    expect(r4.status).toBe(0);
    expect(r4.stdout).toContain('clis 集合仓脚手架');
  });
});
