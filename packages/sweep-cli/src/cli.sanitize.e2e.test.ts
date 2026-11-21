/**
 * 输出面净化的端到端契约: 诊断 (stderr) 与报告 (stdout) 各类出口对低信任输入 (argv / 配置路径 /
 * 回退态 cwd / HOME) 的控制字节剥除与换行折叠。净化语义单源在 display.ts 的
 * sanitizeLine / sanitizeOutputLine, 条款见 behavior-contract.md OF-14; 清单面与告警面的黑盒面
 * 另由 robustness.render.test.ts 与 conformance 的 *-control-bytes 三条语料覆盖。
 * 与 cli.e2e.test.ts / cli.config.e2e.test.ts 分文件承载 (max-lines 门禁, 见 ADR 0005);
 * 同一批用例参数化跑 bun 与 node 两个载体 (双运行时)。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { RUNNER_AVAILABILITY, runCli } from './cli.e2e.fixtures.ts';

/** 含控制字节的目录名在 win32 上无法创建, 该面用例只在 posix 跑 (用例自身的宿主约束, 非被测行为) */
const POSIX = process.platform !== 'win32';

/**
 * 临时工作区根: 取 realpath 形态 —— 子进程的 cwd 由内核给出规范路径, 不先规范化则逐字断言对不上
 * (macOS 的 tmpdir 穿在 /var 符号链接下)。
 */
const SANDBOX = realpathSync(mkdtempSync(join(tmpdir(), 'sweep-sanitize-')));

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
    // 借非 TTY 自动迁移的 [info] notice 出口 (路径在 HOME 外, 不被 ~ 缩写) 单独钉住 notice 净化链路。
    test.skipIf(!available || !POSIX)(
      'notice 与 warn 面: 自动迁移 notice 与无配置 warn 的路径控制字节均经同源净化',
      () => {
        const home = sandboxDir(evilName(`home-absent-${runner}`));
        const absent = runCli(runner, ['--yes'], { env: { HOME: home } });

        expect(absent.status).toBe(1);
        expect(absent.stdout).toBe('');
        expect(absent.stderr).toContain('未找到配置文件');
        expect(absent.stderr).toContain(
          join(
            SANDBOX,
            cleanName(`home-absent-${runner}`),
            '.config',
            'sweep',
            'config.json',
          ),
        );
        expect(absent.stderr).not.toContain('\u001b');
        expect(absent.stderr).not.toContain('\u202e');

        const plainHome = sandboxDir(`plain-home-${runner}`);
        const cleanRoot = sandboxDir(`clean-root-${runner}`);
        const evilCfgDir = sandboxDir(evilName(`migrate-cfg-${runner}`));
        const evilCfg = join(evilCfgDir, 'config.json');
        writeFileSync(
          evilCfg,
          JSON.stringify({ roots: [cleanRoot], exclude: [] }),
        );

        const migrated = runCli(runner, ['--config', evilCfg], {
          env: { HOME: plainHome },
        });
        expect(migrated.status).toBe(0);
        const expectedCleanPath = join(
          SANDBOX,
          cleanName(`migrate-cfg-${runner}`),
          'config.json',
        );
        const infoLine = migrated.stderr
          .split('\n')
          .find((line) => line.startsWith('[info] 已自动无损迁移配置到 v2'));
        expect(infoLine).toBeDefined();
        expect(infoLine).toContain(expectedCleanPath);
        expect(migrated.stderr).not.toContain('\u001b');
        expect(migrated.stderr).not.toContain('\u202e');
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
          join(SANDBOX, cleanName('home'), '.config', 'sweep', 'config.json'),
        );
        expect(result.stdout).not.toContain('\u001b');
        expect(result.stdout).not.toContain('\u202e');
      },
    );
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  defineSanitizeCases(runner, available);
}
