/**
 * `@iyowei/sweep-cli` 中英双语渲染、80 列行宽护栏与独立 `lang` 持久化端到端测试。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { displayWidth } from '@iyowei/cli-i18n';

import {
  RUNNER_AVAILABILITY,
  runCli,
  writeConfig,
} from './cli.e2e.fixtures.ts';
import { helpText } from './help.ts';
import { render } from './render.ts';

const tmpDirs: string[] = [];
afterEach(() => {
  for (const dir of tmpDirs.splice(0)) {
    rmSync(dir, { recursive: true, force: true });
  }
});

function makeTempDir(): string {
  const dir = join(
    tmpdir(),
    `sweep-i18n-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
  );
  mkdirSync(dir, { recursive: true });
  tmpDirs.push(dir);
  return dir;
}

describe('sweep-cli 英文排版与独立语言切换', () => {
  test('helpText(en) 满足 OF-10 降级等价且全部固定行 <= 80 列', () => {
    const plain = helpText(false, 'en');
    const colored = helpText(true, 'en');
    const ansiRe = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');
    expect(colored.replace(ansiRe, '')).toBe(plain);
    expect(plain).toContain('Multi-Stack Workspace Cleaner');
    expect(plain).toContain('lang');
    expect(plain).toContain('--lang <lang>');

    for (const line of plain.split('\n')) {
      if (line.includes('Default Config')) continue;
      expect(displayWidth(line), `过宽行: ${line}`).toBeLessThanOrEqual(80);
    }
  });

  test('render(en) 正确渲染英文预览与清理汇总', () => {
    const preview = render({
      mode: 'preview',
      roots: ['/Users/demo/dev'],
      home: '/Users/demo',
      color: false,
      locale: 'en',
      entries: [
        {
          target: '/Users/demo/dev/app/node_modules',
          bytes: 104_857_600,
          project: 'app',
          suspect: false,
        },
      ],
    });
    expect(preview).toContain('▍ SWEEP  Preview · 1 root: ~/dev');
    expect(preview).toContain('Total 1 target · 100 MB   Pass --yes to clean');

    const executed = render({
      mode: 'execute',
      roots: ['/Users/demo/dev'],
      home: '/Users/demo',
      color: false,
      locale: 'en',
      releasedBytes: 104_857_600,
      entries: [
        {
          target: '/Users/demo/dev/app/node_modules',
          bytes: 104_857_600,
          project: 'app',
          suspect: false,
          ok: true,
          trashed: true,
        },
      ],
    });
    expect(executed).toContain('▍ SWEEP  Clean · 1 root: ~/dev');
    expect(executed).toContain(
      'Summary  1 cleaned (1 trashed) · freed 100 MB · 0 failed',
    );
  });

  const bunAvailable =
    RUNNER_AVAILABILITY.find((r) => r.runner === 'bun')?.available === true;
  test.if(bunAvailable)(
    '中文系统下 sweep lang en 持久化切换为英文且支持 --lang 单次覆盖',
    async () => {
      const home = makeTempDir();
      const wsRoot = makeTempDir();
      const cfg = join(wsRoot, 'cfg.json');
      mkdirSync(join(wsRoot, 'proj', 'node_modules'), { recursive: true });
      await Bun.write(join(wsRoot, 'proj', 'package.json'), '{}');
      await Bun.write(
        cfg,
        JSON.stringify({
          version: 2,
          roots: [wsRoot],
          exclude: [],
          include: [],
          presets: { node: {} },
          rules: [],
        }),
      );
      void writeConfig;

      const env = { HOME: home, CLIS_TEST_OS_LOCALE: 'zh-Hans-CN' };

      const r1 = runCli('bun', ['config', '--config', cfg], { env });
      expect(r1.status).toBe(0);
      expect(r1.stdout).toContain('配置 · 来源: --config 指定');

      const r2 = runCli('bun', ['lang', 'en'], { env });
      expect(r2.status).toBe(0);
      expect(r2.stdout).toContain('Language Updated');

      const r3 = runCli('bun', ['config', '--config', cfg], { env });
      expect(r3.status).toBe(0);
      expect(r3.stdout).toContain('Configuration · Source: --config flag');

      const r4 = runCli('bun', ['--config', cfg], { env });
      expect(r4.status).toBe(0);
      expect(r4.stdout).toContain('Preview · 1 root:');
      expect(r4.stdout).toContain('Pass --yes to clean');

      const r5 = runCli('bun', ['config', '--config', cfg, '--lang', 'zh'], {
        env,
      });
      expect(r5.status).toBe(0);
      expect(r5.stdout).toContain('配置 · 来源: --config 指定');
    },
  );
});
