/**
 * create-clis `--version`、`update` 子命令与 CLI 交互/参数解析端到端回归测试
 * (独立分文件以守 max-lines 门禁)。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { buildTemplate } from '../scripts/build-template.ts';
import { REPO_ROOT } from '../scripts/template-manifest.ts';
import { ORIGINAL } from './template-snapshot.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const TEMPLATE_ROOT = makeTmpRoot('create-clis-cli-extra-tpl-');
const TEMPLATE_DIR = join(TEMPLATE_ROOT, 'template');
buildTemplate({
  repoRoot: REPO_ROOT,
  outDir: TEMPLATE_DIR,
  original: ORIGINAL,
});

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
});
afterAll(() =>
  rmSync(TEMPLATE_ROOT, {
    recursive: true,
    force: true,
    maxRetries: 5,
    retryDelay: 100,
  }),
);

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
  }, 30_000);
});

describe('create-clis CLI 前置目录校验、非 kebab 目录交互与 -- 分隔符 (CREATE-P0-7 / CREATE-P1-2)', () => {
  test('非空目录在交互问答前即早退报非空 (不进入问答再报已取消)', () => {
    const root = makeTmpRoot('create-clis-precheck-');
    createdRoots.push(root);
    const occupied = join(root, 'occupied');
    mkdirSync(occupied, { recursive: true });
    writeFileSync(join(occupied, 'keep.txt'), 'stay\n');

    const res = spawnSync('node', [CLI, occupied, '--no-git', '--no-install'], {
      encoding: 'utf8',
      input: '',
      env: { ...process.env, CREATE_CLIS_TEMPLATE_DIR: TEMPLATE_DIR },
    });
    expect(res.status).toBe(1);
    expect(res.stderr).toContain('非空');
    expect(res.stdout).not.toContain('已取消');
  }, 30_000);

  test('非 kebab-case 目录 (MyApp/) 跑 create-clis . 交互命名可正常生成', () => {
    const root = makeTmpRoot('create-clis-myapp-');
    createdRoots.push(root);
    const myAppDir = join(root, 'MyApp');
    const home = join(root, 'home');
    mkdirSync(myAppDir, { recursive: true });
    mkdirSync(home, { recursive: true });

    const res = spawnSync(
      'node',
      [CLI, '.', '--tier', 'core', '--no-git', '--no-install'],
      {
        cwd: myAppDir,
        encoding: 'utf8',
        input: 'my-app\n\n\nme\n\n',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
          CREATE_CLIS_TEMPLATE_DIR: TEMPLATE_DIR,
        },
      },
    );
    expect(res.status, `stderr=${res.stderr}`).toBe(0);
    expect(existsSync(join(myAppDir, 'packages/my-app/package.json'))).toBe(
      true,
    );
  }, 60_000);

  test('create-clis -- update 可创建名为 update 的目录而不误入 update 子命令', () => {
    const root = makeTmpRoot('create-clis-dashdash-');
    createdRoots.push(root);
    const home = join(root, 'home');
    mkdirSync(home, { recursive: true });

    const res = spawnSync(
      'node',
      [
        CLI,
        '--tier',
        'core',
        '--owner',
        'me',
        '--yes',
        '--no-git',
        '--no-install',
        '--',
        'update',
      ],
      {
        cwd: root,
        encoding: 'utf8',
        env: {
          ...process.env,
          HOME: home,
          USERPROFILE: home,
          GIT_CONFIG_GLOBAL: join(home, '.gitconfig'),
          CREATE_CLIS_TEMPLATE_DIR: TEMPLATE_DIR,
        },
      },
    );
    expect(res.status, `stderr=${res.stderr}`).toBe(0);
    expect(existsSync(join(root, 'update/packages/update/package.json'))).toBe(
      true,
    );
  }, 60_000);
});
