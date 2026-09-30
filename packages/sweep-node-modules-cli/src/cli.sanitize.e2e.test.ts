/**
 * 输出面净化的端到端契约: 诊断 (stderr) 与报告 (stdout) 各类出口对低信任输入 (argv / 配置路径 /
 * 回退态 cwd / HOME) 的控制字节剥除与换行折叠。净化语义单源在 display.ts 的
 * sanitizeLine / sanitizeOutputLine, 条款见 behavior-contract.md OF-14; 清单面与告警面的黑盒面
 * 另由 robustness.render.test.ts 与 conformance 的 *-control-bytes 三条语料覆盖。
 * 与 cli.e2e.test.ts / cli.config.e2e.test.ts 分文件承载 (max-lines 门禁, 见 ADR 0005);
 * 同一批用例参数化跑 bun 与 node 两个载体 (双运行时)。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const RUNNERS = ['bun', 'node'];

/** 含控制字节的目录名在 win32 上无法创建, 该面用例只在 posix 跑 (用例自身的宿主约束, 非被测行为) */
const POSIX = process.platform !== 'win32';

/**
 * 临时工作区根: 取 realpath 形态 —— 子进程的 cwd 由内核给出规范路径, 不先规范化则逐字断言对不上
 * (macOS 的 tmpdir 穿在 /var 符号链接下)。
 */
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-nm-sanitize-')));

afterAll(() => {
  rmSync(SANDBOX, { recursive: true, force: true });
});

/** 净化样本的目录名: ESC (清屏序列引导) + RLO (视觉反转) + 换行 (劈行) 三形并置 */
const evilName = (tag: string): string => `evil\u001b[2J${tag}\u202e\nfake`;

/** 同名样本经净化后的预期 (控制字符剥除, 换行折成单空格) */
const cleanName = (tag: string): string => `evil[2J${tag} fake`;

/** 在沙箱内备一个真实目录并返回绝对路径 */
function sandboxDir(name: string): string {
  const dir = join(SANDBOX, name);
  mkdirSync(dir, { recursive: true });
  return dir;
}

/** 净化样本: ESC (清屏序列) + 换行 (劈行注入) + RLO (视觉反转) 三形并置 */
const EVIL = '/nowhere/evil\u001b[2Jname\u202e.json';

/** 跑一次 CLI: 宿主变量不得泄漏进用例 (SWEEP_NM_CONFIG 一律先清), 非 TTY + NO_COLOR 稳定断言 */
function runCli(
  runner: string,
  args: string[],
  options: { cwd?: string; env?: Record<string, string> } = {},
) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...options.env,
  };
  delete env.SWEEP_NM_CONFIG;
  env.NO_COLOR = '1';
  return spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    env,
    cwd: options.cwd,
    timeout: 10_000,
  });
}

/** 输出面净化用例组, 逐 runner 注册 */
function defineSanitizeCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 输出面净化`, () => {
    test.skipIf(!available)(
      '参数错误出口: argv 里的控制字节被剥除, 不劈行也不外泄 ESC',
      () => {
        const result = runCli(runner, [`--nope\u001b[2J\nfake\u202e`]);

        expect(result.status).toBe(1);
        expect(result.stderr).not.toContain('\u001b');
        expect(result.stderr).not.toContain('\u202e');
        // 换行被折叠成空格: 同一条消息仍在同一行内 (劈行即劈不出第二行)
        expect(result.stderr).toContain(
          '参数错误: 未知参数: --nope[2J fake (用 --help 查看用法)',
        );
      },
    );

    test.skipIf(!available)(
      'config 报告面: 路径里的控制字节经同源净化, 不外泄 ESC',
      () => {
        const result = runCli(runner, ['config', '--config', EVIL]);

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('配置路径: /nowhere/evil[2Jname.json');
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).not.toContain('\u202e');
      },
    );

    // notice 面 (非诊断性提示) 与 warn 面共用同一净化函数, 但调用点各自独立:
    // 摘除 notice 侧调用后, 承载同款控制字节样本的三条语料与模块级测试照旧全绿 (阴性对照实证),
    // 故由本用例单独钉住该出口。
    test.skipIf(!available || !POSIX)(
      'notice 面: 无配置回退的 --yes 硬拒里, cwd 的控制字节经同源净化',
      () => {
        // 回退态的根取 process.cwd() (唯一可达的外部数据位): 让 cwd 自身带样本;
        // HOME 指向空目录, 保证平台默认配置不存在、稳定走回退态
        const cwd = sandboxDir(evilName('cwd'));
        const home = sandboxDir('home');

        const result = runCli(runner, ['--yes'], { cwd, env: { HOME: home } });

        expect(result.status).toBe(1);
        expect(result.stdout).toBe('');
        expect(result.stderr).toContain(
          '拒绝执行: 当前无配置文件, --yes 不可用',
        );
        const expected = `  将扫的根: ${join(SANDBOX, cleanName('cwd'))}`;
        // 换行已折叠、控制字符已剥除: 该行仍是独立一行 (劈开即多出一行伪造的可信输出)
        expect(result.stderr.split('\n')).toContain(expected);
        expect(result.stderr).not.toContain('\u001b');
        expect(result.stderr).not.toContain('\u202e');
      },
    );

    // 帮助面的默认配置位置行插值的是平台默认路径 (源自 os.homedir()), 与 config 报告面同坐标:
    // 摘除 help 侧净化时, 该行把 HOME 里的控制字节原形直写 stdout。
    test.skipIf(!available || !POSIX)(
      '帮助面: HOME 的控制字节经同源净化, 不外泄 ESC',
      () => {
        const home = join(SANDBOX, evilName('home'));

        const result = runCli(runner, ['--help'], { env: { HOME: home } });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain(
          join(
            SANDBOX,
            cleanName('home'),
            '.config',
            'sweep-node-modules',
            'config.json',
          ),
        );
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).not.toContain('\u202e');
      },
    );
  });
}

for (const runner of RUNNERS) {
  const available = spawnSync(runner, ['-v']).status === 0;
  defineSanitizeCases(runner, available);
}
