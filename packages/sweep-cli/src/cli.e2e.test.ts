/**
 * cli 端到端契约 (TDD 驱动件: 本文件先行, 驱动 src/cli.ts 的实现)。
 * 断言面与分册「命令面与输出」「配置与初始化」的规格一一对应; 同一批用例参数化跑 bun 与 node 两个载体 (双运行时)。
 * 向导的 TTY 交互以伪终端冒烟覆盖 (见本文件的 pty 用例; `init.smoke.test.ts` 走真实管道), 不做交互全流程回放。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawn, spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Workspace } from '@iyowei/sweep/testing';

import {
  CLI,
  RUNNER_AVAILABILITY,
  createWorkspaceTracker,
  runCli,
  writeConfig,
} from './cli.e2e.fixtures.ts';

/** 当前 CLI 包版本号 (与 --version / -V 端到端断言单源对齐) */
const CLI_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

/** 权限注入用例在 root 或 Windows 下失效 (POSIX chmod 拦不住), 与 guard 契约测试同一口径 */
const isRoot =
  process.platform === 'win32' ||
  (typeof process.getuid === 'function' && process.getuid() === 0);

/** 伪终端冒烟可用性: 经 script 分配 pty (BSD 形式, 实测仅 darwin 可靠), 探针失败即 skip */
const ptyAvailable =
  process.platform === 'darwin' &&
  spawnSync('script', ['-q', '/dev/null', 'true'], { timeout: 10_000 })
    .status === 0;

/** 伪终端冒烟超时: 向导死锁或子进程不退一律判失败, 不无限等待 */
const PTY_TIMEOUT_MS = 20_000;

/** 伪终端用例自身的时间上限 (向导三问 + 预览远低于此值) */
const PTY_TEST_TIMEOUT_MS = 30_000;

const delay = (ms: number): Promise<void> =>
  new Promise((resolve) => setTimeout(resolve, ms));

const { make, cleanup } = createWorkspaceTracker();
afterEach(cleanup);

/** 空家目录: 平台默认配置路径 (HOME/.config/...) 因此保证 absent, 「无配置」类用例不受宿主影响 */
function emptyHome(workspace: Workspace): string {
  const home = join(workspace.root, '.home');
  mkdirSync(home, { recursive: true });
  return home;
}

/**
 * 驱动伪终端: script 分配 pty, 见到提示再投喂下一条 (整段投喂实测不可靠 —— script 会把 stdin 的
 * EOF 透传成 pty 的 EOT, readline 立即折算取消), stdin 全程开口, 收尾等子进程自行退出。
 * stdout / stderr 经 pty 合流, 调用方按合并文本断言。
 */
async function runPty(
  runner: string,
  args: string[],
  answers: { prompt: string; input: string }[],
  options: { cwd: string; env: Record<string, string> },
): Promise<{ output: string; status: number | null }> {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  delete env.SWEEP_CONFIG;
  delete env.SWEEP_NM_CONFIG;
  Object.assign(env, options.env, { NO_COLOR: '1' });

  // script 的 stdin 须是真管道: Bun 的 spawn 给的是 socketpair, BSD script 对其 tcgetattr 直接报错,
  // 故经 sh 的 `cat | script` 转一手 (cat 即读即转, 无缓冲延迟, 实测)
  const child = spawn(
    'sh',
    ['-c', 'cat | script -q /dev/null "$@"', 'sh', runner, CLI, ...args],
    {
      cwd: options.cwd,
      env,
      stdio: ['pipe', 'pipe', 'pipe'],
    },
  );

  let output = '';
  child.stdout.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });
  child.stderr.on('data', (chunk: Buffer) => {
    output += chunk.toString();
  });

  const deadline = Date.now() + PTY_TIMEOUT_MS;
  for (const step of answers) {
    while (!output.includes(step.prompt)) {
      if (Date.now() > deadline) {
        child.kill('SIGKILL');
        throw new Error(
          `伪终端冒烟超时 (未见提示 ${step.prompt}), 已收输出: ${output}`,
        );
      }
      await delay(20);
    }
    child.stdin.write(step.input);
  }

  // 问答已结束: 关 stdin 让中转的 cat 收尾退出, 管道整体收口 (此时 EOF 不再影响向导)
  child.stdin.end();

  const status = await Promise.race([
    new Promise<number | null>((resolve) => {
      child.on('exit', (code) => resolve(code));
    }),
    delay(PTY_TIMEOUT_MS).then(() => {
      child.kill('SIGKILL');
      return null;
    }),
  ]);
  return { output, status };
}

/** 预览 / 参数 / 安全闸面 (无 pty 依赖) 的用例组, 逐 runner 注册 */
function definePreviewCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 预览与参数面`, () => {
    test.skipIf(!available)(
      '预览: 列清单与 --yes 提示, 零副作用, 退出码 0',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'alpha' }, { dir: 'beta' }],
        });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('alpha');
        expect(result.stdout).toContain('beta');
        expect(result.stdout).toContain('--yes');
        expect(existsSync(join(workspace.root, 'alpha', 'node_modules'))).toBe(
          true,
        );
        expect(existsSync(join(workspace.root, 'beta', 'node_modules'))).toBe(
          true,
        );
      },
    );

    test.skipIf(!available)(
      '--exclude 与配置合并: 被排除项不列出',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'alpha' }, { dir: 'beta' }],
        });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, ['--exclude', 'alpha'], {
          env: { SWEEP_CONFIG: config },
        });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('beta');
        expect(result.stdout).not.toContain('alpha');
      },
    );

    test.skipIf(!available)(
      '--exclude 未命中: stderr 警告且不污染清单流',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, ['--exclude', 'nosuchdir'], {
          env: { SWEEP_CONFIG: config },
        });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain(
          '排除名未命中任何已扫描的目录: nosuchdir',
        );
        expect(result.stdout).not.toContain('排除名未命中');
      },
    );

    test.skipIf(!available)(
      '--include 可重复且与配置合并: 只列出白名单命中的项',
      async () => {
        const workspace = await make({
          projects: [
            { dir: 'alpha' },
            { dir: 'beta' },
            { dir: 'gamma' },
            { dir: 'delta' },
          ],
        });
        const config = writeConfig(workspace, [workspace.root], [], ['alpha']);

        const result = runCli(
          runner,
          ['--include', 'beta', '--include', 'gamma'],
          {
            env: { SWEEP_CONFIG: config },
          },
        );

        expect(result.status).toBe(0);
        for (const name of ['alpha', 'beta', 'gamma'])
          expect(result.stdout).toContain(name);
        expect(result.stdout).not.toContain('delta');
      },
    );

    test.skipIf(!available)(
      '--include 未命中: stderr 警示白名单未生效且结果为空',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        const config = writeConfig(
          workspace,
          [workspace.root],
          [],
          ['typo-name'],
        );

        const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

        expect(result.status).toBe(0);
        expect(result.stderr).toContain(
          '包含名未命中任何已扫描的目录: typo-name',
        );
        // 与排除名写错的后果不同: 白名单全零命中直接意味着扫不出东西, 须点明
        expect(result.stderr).toContain(
          '包含名单无一条命中, 本次扫描必为空结果',
        );
        expect(result.stdout).toContain('未发现');
        expect(result.stdout).not.toContain('包含名未命中');
      },
    );

    test.skipIf(!available)(
      '--include 与 --exclude 同时命中同一名: 不报未命中, 结果按 exclude 优先',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'alpha' }, { dir: 'beta' }],
        });
        const config = writeConfig(
          workspace,
          [workspace.root],
          ['beta'],
          ['alpha', 'beta'],
        );

        const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

        expect(result.status).toBe(0);
        // beta 目录客观存在且命中白名单, 只是被 exclude 优先截走: 不得报成「未命中」
        expect(result.stderr).not.toContain('包含名未命中');
        expect(result.stdout).not.toContain('包含名未命中');
        // 应给出的信号是白名单命中 (alpha 生效), 而非白名单写错的后果说明
        expect(result.stderr).not.toContain('包含名单无一条命中');
        expect(result.stdout).toContain('alpha');
        expect(result.stdout).not.toContain('beta');
      },
    );

    test.skipIf(!available)('--yes 执行: 目标删除且邻居完好', async () => {
      const workspace = await make({ projects: [{ dir: 'alpha' }] });
      const config = writeConfig(workspace, [workspace.root]);
      writeFileSync(join(workspace.root, 'alpha', 'keep.txt'), 'keep');

      const result = runCli(runner, ['--yes'], {
        env: { SWEEP_CONFIG: config },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toMatch(/释放 [\d.]+ (B|KB|MB|GB)/);
      expect(existsSync(join(workspace.root, 'alpha', 'node_modules'))).toBe(
        false,
      );
      expect(existsSync(join(workspace.root, 'alpha', 'keep.txt'))).toBe(true);
    });

    test.skipIf(!available)(
      '安全闸整批拒绝: 零删除且不出清单, 退出码 1',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        const config = writeConfig(workspace, [workspace.root]);

        // HOME 指向目标本体: 非竞态地命中安全闸不变量 ③b (home 本体), 构造整批拒绝
        const result = runCli(runner, ['--yes', '--config', config], {
          env: { HOME: join(workspace.root, 'alpha', 'node_modules') },
        });

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('整批拒绝');
        expect(result.stderr).toContain('home 本体');
        expect(result.stdout).not.toContain('SWEEP');
        expect(result.stdout).not.toContain('alpha');
        expect(existsSync(join(workspace.root, 'alpha', 'node_modules'))).toBe(
          true,
        );
      },
    );

    test.skipIf(!available)(
      '参数错误: 未知参数 / 缺值 / 多余位置参数一律退 1',
      async () => {
        const cases = [['--bogus'], ['--exclude'], ['--yes', 'extra']];

        for (const args of cases) {
          const result = runCli(runner, args);

          expect(result.status).toBe(1);
          expect(result.stderr).toContain('参数错误:');
        }
      },
    );

    test.skipIf(!available)(
      '--help: 退出码 0 且给出默认配置位置与两份名单的匹配口径',
      async () => {
        const result = runCli(runner, ['--help']);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(join('sweep', 'config.json'));
        expect(result.stdout).toContain('  子命令\n');
        expect(result.stdout).toContain('  选项\n');
        expect(result.stdout).toContain(
          '--exclude / --include 按目录名精确匹配',
        );
        expect(result.stdout).toContain('同时命中 exclude 优先');
        expect(result.stdout).toContain('--force');
        expect(result.stdout).toContain('--default');
        expect(result.stdout).toContain('migrate');
        expect(result.stdout).toContain('-V, --version');
      },
    );

    test.skipIf(!available)('--version / -V: 输出当前版本号并退 0', () => {
      for (const flag of ['--version', '-V']) {
        const result = runCli(runner, [flag]);
        expect(result.status).toBe(0);
        expect(result.stdout.trim()).toBe(CLI_VERSION);
      }
    });

    test.skipIf(!available)('init --yes: 互斥参数报错并退 1', () => {
      const result = runCli(runner, ['init', '--yes']);
      expect(result.status).toBe(1);
      expect(result.stderr).toContain('参数错误:');
      expect(result.stderr).toContain('不支持参数: --yes');
    });
  });
}

/** 执行 / 拒绝 / 配置面 (含伪终端向导) 的用例组, 逐 runner 注册 */
function defineExecuteCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 执行与拒绝面`, () => {
    test.skipIf(!available)('init 非 TTY: 报错退 1 且不落盘', async () => {
      const workspace = await make({ projects: [{ dir: 'alpha' }] });
      const config = join(workspace.root, 'new-config.json');

      const result = runCli(runner, ['init', '--config', config]);

      expect(result.status).toBe(1);
      expect(result.stderr).toContain('需要交互终端');
      expect(existsSync(config)).toBe(false);
    });

    test.skipIf(!available || isRoot)(
      '不可读目标: 占位行计失败且不删除, 退出码 1',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'alpha' }, { dir: 'locked' }],
          unreadable: ['locked/node_modules'],
        });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, ['--yes'], {
          env: { SWEEP_CONFIG: config },
        });

        expect(result.status).toBe(1);
        expect(result.stdout).toContain('?');
        expect(result.stdout).toContain('体积统计失败');
        expect(result.stdout).toContain('✗');
        expect(result.stdout).toContain('失败 1 处');
        expect(existsSync(join(workspace.root, 'locked', 'node_modules'))).toBe(
          true,
        );
        expect(existsSync(join(workspace.root, 'alpha', 'node_modules'))).toBe(
          false,
        );
      },
    );

    test.skipIf(!available)('空结果: 提示未发现, 退出码 0', async () => {
      const workspace = await make({ projects: [] });
      const config = writeConfig(workspace, [workspace.root]);

      const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('未发现可清理目标');
    });

    test.skipIf(!available)(
      '无配置 + 非 TTY (核心红线 3): sweep 与 sweep --yes 均直接报错退 1、零扫描零删除并指引 init',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        const home = emptyHome(workspace);

        for (const args of [[], ['--yes']]) {
          const result = runCli(runner, args, {
            cwd: workspace.root,
            env: { HOME: home },
          });

          expect(result.status).toBe(1);
          expect(result.stdout).toBe('');
          expect(result.stderr).toContain('未找到配置文件');
          expect(result.stderr).toContain('sweep init');
          expect(result.stderr).toContain('sweep init --default');
          expect(
            existsSync(join(workspace.root, 'alpha', 'node_modules')),
          ).toBe(true);
        }
      },
    );

    test.skipIf(!available || !ptyAvailable)(
      '首次向导 + --yes: 本轮强制预览且零删除 (伪终端, 四问分段投喂, 输出摘要零原始 JSON)',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });
        const home = emptyHome(workspace);
        // 向导默认根是家目录, 故在家目录下备一处带 package.json 锚点的 node_modules
        mkdirSync(join(home, 'beta', 'node_modules'), { recursive: true });
        writeFileSync(join(home, 'beta', 'package.json'), '{"name":"beta"}\n');

        const { output, status } = await runPty(
          runner,
          ['--yes'],
          [
            { prompt: '扫描根', input: '\n' }, // 取默认根 (家目录)
            { prompt: '激活预设', input: '\n' }, // 取推荐 6 预设
            { prompt: '排除名单', input: '\n' }, // 采用内置安全护栏
            { prompt: '包含名单', input: '\n' },
            { prompt: '确认写入', input: 'y\n' },
          ],
          { cwd: workspace.root, env: { HOME: home } },
        );

        expect(status).toBe(0);
        expect(output).toContain('首次配置已生成'); // 说明行 (stderr 经 pty 合流)
        expect(output).toContain('合计'); // 走的是预览
        expect(output).not.toContain('汇总'); // 未进入执行
        expect(output).toContain('▍ SWEEP  初始化向导');
        expect(output).toContain('  ░ 首次使用, 先确定扫描范围与清理预设');
        expect(output).toContain('[默认: ~]');
        expect(output).toContain('配置已写入: ');
        expect(output).toContain('快捷指令:');
        expect(output).not.toContain('"version": 2');
        expect(output).not.toContain('"presets": {');
        expect(output).toContain('✓');
        expect(existsSync(join(home, '.config', 'sweep', 'config.json'))).toBe(
          true,
        );
        expect(existsSync(join(workspace.root, 'alpha', 'node_modules'))).toBe(
          true,
        );
      },
      PTY_TEST_TIMEOUT_MS,
    );

    test.skipIf(!available)('非 TTY 自动降级: 输出零 ANSI 转义', async () => {
      const workspace = await make({ projects: [{ dir: 'alpha' }] });
      const config = writeConfig(workspace, [workspace.root]);

      const result = runCli(runner, [], {
        env: { SWEEP_CONFIG: config },
        noColor: false,
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('\x1b[');
    });

    test.skipIf(!available)('--config 旗标优先于环境变量', async () => {
      const workspace = await make({ projects: [{ dir: 'alpha' }] });
      const other = await make({ projects: [{ dir: 'gamma' }] });
      const envConfig = writeConfig(workspace, [workspace.root]);
      const flagConfig = writeConfig(other, [other.root]);

      const result = runCli(runner, ['--config', flagConfig], {
        env: { SWEEP_CONFIG: envConfig },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).toContain('gamma');
      expect(result.stdout).not.toContain('alpha');
    });

    test.skipIf(!available)(
      '--config 打错路径: 硬报错且未扫描, 退出码 1',
      async () => {
        const workspace = await make({ projects: [{ dir: 'alpha' }] });

        const result = runCli(
          runner,
          ['--config', join(workspace.root, 'nope.json')],
          { cwd: workspace.root },
        );

        expect(result.status).toBe(1);
        expect(result.stderr).toContain('配置不存在');
        expect(result.stdout).not.toContain('alpha');
      },
    );
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  definePreviewCases(runner, available);
  defineExecuteCases(runner, available);
}
