/**
 * create-clis `--version` 与 `update` 自更新子命令的端到端测试 (独立分文件以守 max-lines 门禁)。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

describe('create-clis 版本与 update 子命令', () => {
  test('--version / -V 输出语义化版本号, update --help 与非法 --pm 行为准确', () => {
    const ver = spawnSync('bun', [CLI, '--version'], { encoding: 'utf8' });
    expect(ver.status).toBe(0);
    expect(ver.stdout.trim()).toMatch(/^\d+\.\d+\.\d+/);

    const shortVer = spawnSync('bun', [CLI, '-V'], { encoding: 'utf8' });
    expect(shortVer.status).toBe(0);
    expect(shortVer.stdout.trim()).toBe(ver.stdout.trim());

    const help = spawnSync('bun', [CLI, 'update', '--help'], {
      encoding: 'utf8',
    });
    expect(help.status).toBe(0);
    expect(help.stdout).toContain('create-clis update');

    const bad = spawnSync('bun', [CLI, 'update', '--pm', 'invalid-pm'], {
      encoding: 'utf8',
    });
    expect(bad.status).toBe(1);
    expect(bad.stderr).toContain('不支持');
  });
});
