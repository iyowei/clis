/**
 * `config` 子命令查询面的端到端契约: 报告本次实际生效的配置来源 / 路径 / 文件状态。
 * 与 `cli.e2e.test.ts` 分文件承载 (max-lines 门禁要求实现按规模切分, 见 ADR 0005);
 * 查询面不扫描、不建工作区树 (只认配置文件路径), 故不复用其 fixture 组装。
 * 同一批用例参数化跑 bun 与 node 两个载体 (双运行时)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { resolveConfigPath } from '@iyowei/sweep-node-modules';

import { CLI, RUNNER_AVAILABILITY, runCli } from './cli.e2e.fixtures.ts';

const dirs: string[] = [];

/** 临时目录 (用例隔离): 兼作家目录与配置文件父目录, afterEach 统一清理 */
function tempDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sweep-config-'));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  // 逐目录容错: 单个清理失败降级为警告并继续, 不抛断整条链 (否则其余目录不清理、数组也不复位)
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

/** 写一份真实形状的配置 (查询面不装载内容, 只探存在性; 内容取正常形态免误导) */
function writeConfigFile(dir: string): string {
  const file = join(dir, 'sweep-config.json');
  writeFileSync(
    file,
    JSON.stringify({ roots: [dir], exclude: [], include: [] }),
  );
  return file;
}

/** config 查询面 (命令 `config` 与旗标 `--config` 形近义反) 的用例组, 逐 runner 注册 */
function defineQueryCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 配置查询面`, () => {
    test.skipIf(!available)(
      'config: 平台默认来源报平台默认路径与不存在状态, 退出码 0',
      () => {
        const home = tempDir();

        const result = runCli(runner, ['config'], { env: { HOME: home } });

        expect(result.status).toBe(0);
        // 降级形态 (管道 + NO_COLOR): 零 ANSI 但保留顶栏与中性块字符
        const expectedDefault = resolveConfigPath({
          homedir: home,
          env: { APPDATA: join(home, 'AppData', 'Roaming') },
        }).path;
        expect(result.stdout).toContain('▍ SWEEP-NM  配置 · 来源: 平台默认');
        expect(result.stdout).toContain(expectedDefault);
        expect(result.stdout).toContain('  ░ 文件状态: 不存在');
      },
    );

    test.skipIf(!available)(
      'config: --config 指定时报 flag 来源与该路径 (优先于环境变量)',
      () => {
        const flagConfig = writeConfigFile(tempDir());
        const envConfig = writeConfigFile(tempDir());

        const result = runCli(runner, ['--config', flagConfig, 'config'], {
          env: { SWEEP_NM_CONFIG: envConfig },
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('配置 · 来源: --config 指定');
        expect(result.stdout).toContain(flagConfig);
        expect(result.stdout).toContain('文件状态: 存在');
        expect(result.stdout).not.toContain(envConfig);
      },
    );

    test.skipIf(!available)(
      'config: 环境变量来源报 SWEEP_NM_CONFIG 与该路径, 退出码 0',
      () => {
        const config = writeConfigFile(tempDir());

        const result = runCli(runner, ['config'], {
          env: { SWEEP_NM_CONFIG: config },
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          '配置 · 来源: 环境变量 SWEEP_NM_CONFIG',
        );
        expect(result.stdout).toContain(config);
        expect(result.stdout).toContain('文件状态: 存在');
      },
    );

    test.skipIf(!available)(
      'update: --help 退出 0 且保留多行帮助与列对齐, 非法 --pm 退出 1 (X-P0-2)',
      () => {
        const help = runCli(runner, ['update', '--help']);
        expect(help.status).toBe(0);
        expect(help.stdout).toContain('sweep-nm update');
        expect(help.stdout).toContain('--check');
        // X-P0-2 回归断言: 禁止经 sanitizeOutputLine 压成单行, 必须保持完整多行结构
        expect(help.stdout.split('\n').length).toBeGreaterThanOrEqual(10);

        const bad = runCli(runner, ['update', '--pm', 'bogus']);
        expect(bad.status).toBe(1);
        expect(bad.stderr).toContain('不支持');
      },
    );

    test.skipIf(!available)(
      'roots 为空数组: 报错退 1 且附带配置文件路径上下文 (SWEEPCLI-P1-3)',
      () => {
        const dir = tempDir();
        const emptyRootsCfg = join(dir, 'empty-roots.json');
        writeFileSync(emptyRootsCfg, JSON.stringify({ roots: [] }));

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
        expect(result.stdout).toContain('SWEEP-NM');
        expect(result.stdout).not.toContain('\x1b[');
      },
    );
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  defineQueryCases(runner, available);
}
