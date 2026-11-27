/**
 * `@iyowei/codd-cli` 英文 Apple HIG 排版、干跑公式卡片与独立 `lang` 持久化端到端测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { displayWidth } from '@iyowei/cli-i18n';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const tmpDirs: string[] = [];

afterEach(() => {
  for (const d of tmpDirs.splice(0)) {
    rmSync(d, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `codd-i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

describe('codd-cli 英文界面与独立语言偏好', () => {
  test('中文系统下 codd lang en 持久化切换为英文并正确渲染 init / --dry-run / --help', () => {
    const home = makeTempDir();
    const work = makeTempDir();
    const env = {
      ...process.env,
      HOME: home,
      USERPROFILE: home,
      APPDATA: join(home, 'AppData', 'Roaming'),
      NO_COLOR: '1',
      CLIS_TEST_OS_LOCALE: 'zh-Hans-SG',
    };

    const r1 = spawnSync('bun', [CLI, '--help'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(r1.status).toBe(0);
    expect(r1.stdout).toContain('MongoDB 部署配置生成器');

    const r2 = spawnSync('bun', [CLI, 'lang', 'en'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(r2.status).toBe(0);
    expect(r2.stdout).toContain('Language Updated');

    const r3 = spawnSync('bun', [CLI, '--help'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(r3.status).toBe(0);
    expect(r3.stdout).toContain('MongoDB 9.0 Provisioning Generator');
    expect(r3.stdout).toContain('Commands');
    expect(r3.stdout).toContain('--lang <lang>');
    expect(r3.stdout).toContain(
      'https://github.com/iyowei/clis/tree/main/packages/codd-cli',
    );

    const rInit = spawnSync('bun', [CLI, 'init'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(rInit.status).toBe(0);
    expect(rInit.stdout).toContain('Starter Templates Exported');

    const rDry = spawnSync('bun', [CLI, 'deploy-2c2g.json', '--dry-run'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(rDry.status).toBe(0);
    expect(rDry.stdout).toContain('Optimal Sizing Parameters');
    expect(rDry.stdout).toContain('WiredTiger Cache');
    expect(rDry.stdout).toContain('Dry-Run Preview (No Files Written)');

    const rOverride = spawnSync('bun', [CLI, '--help', '--lang', 'zh'], {
      cwd: work,
      encoding: 'utf8',
      env,
    });
    expect(rOverride.status).toBe(0);
    expect(rOverride.stdout).toContain('MongoDB 部署配置生成器');

    const alignedChecks: ReadonlyArray<{
      stdout: string;
      sections: string[];
    }> = [
      {
        stdout: r3.stdout,
        sections: ['Commands', 'Options', 'Examples', 'Exit Codes'],
      },
      {
        stdout: rOverride.stdout,
        sections: ['子命令', '选项', '示例', '退出码'],
      },
    ];
    for (const { stdout, sections } of alignedChecks) {
      const alignedSet = new Set(sections);
      let section = '';
      const cols = new Set<number>();
      for (const line of stdout.split('\n')) {
        const trimmed = line.trim();
        if (/^  \S/.test(line)) {
          section = trimmed;
          continue;
        }
        if (!alignedSet.has(section) || trimmed === '') continue;
        const contMatch = /^( {5,})(\S.*)$/.exec(line);
        if (contMatch) {
          cols.add(contMatch[1]!.length - 4);
          continue;
        }
        const rowMatch = /^(    .+?)( {2,})(\S.*)$/.exec(line);
        expect(rowMatch, `未匹配两栏行: ${line}`).not.toBeNull();
        cols.add(displayWidth(rowMatch![1]!.slice(4)) + rowMatch![2]!.length);
      }
      expect(cols.size).toBe(1);
    }
  });
});
