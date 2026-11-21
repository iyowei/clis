/**
 * `config` 查询面、`init --default`、`migrate` 与旧路径自动迁移的端到端契约:
 * 同一批用例参数化跑 bun 与 node 两个载体 (双运行时)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  PRESET_NAMES,
  resolveConfigPath,
  resolveLegacyConfigPath,
} from '@iyowei/sweep';

import {
  CLI,
  RUNNER_AVAILABILITY,
  createWorkspaceTracker,
  runCli,
} from './cli.e2e.fixtures.ts';

const dirs: string[] = [];
const { make, cleanup: cleanupWorkspaces } = createWorkspaceTracker();

/** 临时目录 (取 realpath 归一形态: macOS /var 为软链, 否则 init/migrate 写入锚点会拒写) */
function tempDir(): string {
  const dir = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-config-')));
  dirs.push(dir);
  return dir;
}

afterEach(async () => {
  await cleanupWorkspaces();
  for (const dir of dirs) {
    try {
      rmSync(dir, { recursive: true, force: true });
    } catch (error) {
      const code = (error as { code?: string } | null)?.code ?? String(error);
      process.stderr.write(
        `[Warning] 临时配置目录清理失败 (${code}), 请人工清理: ${dir}\n`,
      );
    }
  }
  dirs.length = 0;
});

function writeConfigFile(dir: string): string {
  const file = join(dir, 'sweep-config.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      roots: [dir],
      exclude: [],
      include: [],
      presets: { node: {} },
      rules: [],
    }),
  );
  return file;
}

function platformPaths(home: string): { current: string; legacy: string } {
  const env = { APPDATA: join(home, 'AppData', 'Roaming') };
  return {
    current: resolveConfigPath({ homedir: home, env }).path,
    legacy: resolveLegacyConfigPath({ homedir: home, env }),
  };
}

/** config 查询面与 update/TERM=dumb 降级用例组 */
function defineQueryCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 配置查询面`, () => {
    test.skipIf(!available)(
      'config: 平台默认来源报平台默认路径与不存在状态, 退出码 0',
      () => {
        const home = tempDir();
        const result = runCli(runner, ['config'], { env: { HOME: home } });

        expect(result.status).toBe(0);
        const { current } = platformPaths(home);
        expect(result.stdout).toContain('▍ SWEEP  配置 · 来源: 平台默认');
        expect(result.stdout).toContain(current);
        expect(result.stdout).toContain('  ░ 文件状态: 不存在');
      },
    );

    test.skipIf(!available)(
      'config: --config 优先于 SWEEP_CONFIG, 分别准确汇报来源与状态',
      () => {
        const flagConfig = writeConfigFile(tempDir());
        const envConfig = writeConfigFile(tempDir());

        const viaFlag = runCli(runner, ['--config', flagConfig, 'config'], {
          env: { SWEEP_CONFIG: envConfig },
        });
        expect(viaFlag.status).toBe(0);
        expect(viaFlag.stdout).toContain('配置 · 来源: --config 指定');
        expect(viaFlag.stdout).toContain(flagConfig);
        expect(viaFlag.stdout).toContain('文件状态: 存在');
        expect(viaFlag.stdout).not.toContain(envConfig);

        const viaEnv = runCli(runner, ['config'], {
          env: { SWEEP_CONFIG: envConfig },
        });
        expect(viaEnv.status).toBe(0);
        expect(viaEnv.stdout).toContain('配置 · 来源: 环境变量 SWEEP_CONFIG');
        expect(viaEnv.stdout).toContain(envConfig);
        expect(viaEnv.stdout).toContain('文件状态: 存在');
      },
    );

    test.skipIf(!available)(
      'update: --help 退出 0 且保留多行帮助与列对齐, 非法 --pm 退出 1 (X-P0-2)',
      () => {
        const help = runCli(runner, ['update', '--help']);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('sweep update');
        expect(help.stdout).toContain('--check');
        expect(help.stdout.split('\n').length).toBeGreaterThanOrEqual(10);

        const bad = runCli(runner, ['update', '--pm', 'bogus']);
        expect(bad.status).toBe(1);
        expect(bad.stderr).toContain('不支持');
      },
    );

    test.skipIf(!available)(
      'v2 配置 roots 为空数组: 报错退 1 且附带配置文件路径上下文 (SWEEPCLI-P1-3)',
      () => {
        const dir = tempDir();
        const emptyRootsCfg = join(dir, 'empty-roots.json');
        writeFileSync(
          emptyRootsCfg,
          JSON.stringify({ version: 2, roots: [], presets: { node: {} } }),
        );

        const result = runCli(runner, ['--config', emptyRootsCfg]);

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('不能为空数组');
        expect(result.stderr).toContain(emptyRootsCfg);
      },
    );

    const canRunPty =
      process.platform === 'darwin' &&
      spawnSync('script', ['-q', '/dev/null', 'true'], { timeout: 10_000 })
        .status === 0;

    test.skipIf(!available || !canRunPty)(
      'TERM=dumb 在 TTY 下同样降级为无 ANSI 纯文本 (SWEEPCLI-P0-2)',
      () => {
        const env: Record<string, string> = {
          ...(process.env as Record<string, string>),
          TERM: 'dumb',
        };
        delete env.NO_COLOR;
        const result = spawnSync(
          'script',
          ['-q', '/dev/null', runner, CLI, '--help'],
          { encoding: 'utf8', env, timeout: 10_000 },
        );

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('▍ SWEEP');
        expect(result.stdout).not.toContain('SWEEP-NM');
        expect(result.stdout).not.toContain('\x1b[');
      },
    );
  });
}

/** `init --default`、`migrate` 与旧路径自动迁移用例组 */
function defineInitAndMigrateCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] init --default 与配置迁移面`, () => {
    test.skipIf(!available)(
      'init --default 非 TTY 首次落盘 (摘要零原始 JSON), 再次运行拒绝静默覆盖退 1',
      () => {
        const home = tempDir();
        const { current } = platformPaths(home);

        const first = runCli(runner, ['init', '--default'], {
          env: { HOME: home },
        });
        expect(first.status).toBe(0);
        expect(first.stdout).toContain('▍ SWEEP  初始化配置');
        expect(first.stdout).toContain('配置已写入:');
        expect(first.stdout).toContain('激活预设 (6 项):');
        expect(first.stdout).toContain('(内置安全护栏)');
        expect(first.stdout).toContain('快捷指令:');
        expect(first.stdout).toContain('sweep config');
        expect(first.stdout).not.toContain('"version": 2');
        expect(first.stdout).not.toContain('"presets": {');
        expect(existsSync(current)).toBe(true);

        const saved = JSON.parse(readFileSync(current, 'utf8')) as {
          version: number;
          presets: Record<string, unknown>;
          exclude?: unknown;
        };
        expect(saved.version).toBe(2);
        expect(Object.keys(saved.presets)).toEqual([...PRESET_NAMES]);
        expect(saved.exclude).toBeUndefined();

        const second = runCli(runner, ['init', '--default'], {
          env: { HOME: home },
        });
        expect(second.status).toBe(1);
        expect(second.stderr).toContain('非交互模式下拒绝静默覆盖');
      },
    );

    test.skipIf(!available)(
      '旧路径 v1 自动无损迁移: 源目录生成 .modified 备份、仅激活 node、stderr 报 info 并正常预览',
      async () => {
        const home = tempDir();
        const { current, legacy } = platformPaths(home);
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        // 放一个 Rust 项目验证不会悄悄激活 rust 预设
        mkdirSync(join(workspace.root, 'rust-app', 'target'), {
          recursive: true,
        });
        writeFileSync(
          join(workspace.root, 'rust-app', 'Cargo.toml'),
          '[package]\nname="r"\n',
        );

        const v1Raw = `${JSON.stringify({ roots: [workspace.root], exclude: [] }, null, 2)}\n`;
        mkdirSync(dirname(legacy), { recursive: true });
        writeFileSync(legacy, v1Raw);

        const result = runCli(runner, [], { env: { HOME: home } });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain('[info] 已自动无损迁移配置到 v2');
        expect(result.stderr).toContain('[info] 新增可用预设:');
        expect(result.stdout).toContain('alpha');
        expect(result.stdout).not.toContain('rust-app');

        const legacyDirFiles = readdirSync(dirname(legacy));
        const backups = legacyDirFiles.filter((name) =>
          /^config\.json\.\d{8}_\d{6}\.modified$/.test(name),
        );
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dirname(legacy), backups[0]!), 'utf8')).toBe(
          v1Raw,
        );

        expect(existsSync(current)).toBe(true);
        const migrated = JSON.parse(readFileSync(current, 'utf8')) as {
          version: number;
          presets: Record<string, unknown>;
        };
        expect(migrated.version).toBe(2);
        expect(Object.keys(migrated.presets)).toEqual(['node']);
      },
    );

    test.skipIf(!available)(
      'sweep migrate 显式迁移 (摘要零原始 JSON) 及已有 v2 幂等提示退 0',
      () => {
        const dir = tempDir();
        const cfg = join(dir, 'config.json');
        const v1Raw = `${JSON.stringify({ roots: [dir], exclude: ['vendor'] }, null, 2)}\n`;
        writeFileSync(cfg, v1Raw);

        const first = runCli(runner, ['migrate', '--config', cfg]);
        expect(first.status).toBe(0);
        expect(first.stdout).toContain('▍ SWEEP  配置迁移');
        expect(first.stdout).toContain('配置已迁移:');
        expect(first.stdout).toContain('原配置已备份:');
        expect(first.stdout).toContain('新增可用预设:');
        expect(first.stdout).toContain('快捷指令:');
        expect(first.stdout).not.toContain('"version": 2');
        expect(first.stdout).not.toContain('"presets": {');

        const backups = readdirSync(dir).filter((name) =>
          /^config\.json\.\d{8}_\d{6}\.modified$/.test(name),
        );
        expect(backups).toHaveLength(1);
        expect(readFileSync(join(dir, backups[0]!), 'utf8')).toBe(v1Raw);

        const second = runCli(runner, ['migrate', '--config', cfg]);
        expect(second.status).toBe(0);
        expect(second.stdout).toContain('当前配置已是最新版 v2, 无需迁移');
      },
    );

    test.skipIf(!available)(
      '非无损旧配置 (含未知字段 / version: 3): 非 TTY 中止退 1 且不写盘不生成备份',
      () => {
        for (const payload of [
          { roots: ['/tmp'], mystery: true },
          { version: 3, roots: ['/tmp'], presets: { node: {} } },
        ]) {
          const dir = tempDir();
          const cfg = join(dir, 'config.json');
          const raw = `${JSON.stringify(payload)}\n`;
          writeFileSync(cfg, raw);

          const result = runCli(runner, ['--config', cfg]);
          expect(result.status).toBe(1);
          expect(result.stderr).toContain('无法自动迁移');
          expect(readFileSync(cfg, 'utf8')).toBe(raw);
          expect(
            readdirSync(dir).filter((n) => n.endsWith('.modified')),
          ).toHaveLength(0);
        }
      },
    );
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  defineQueryCases(runner, available);
  defineInitAndMigrateCases(runner, available);
}
