/**
 * @iyowei/codd-cli 参数解析与端到端 CLI 行为测试:
 * 覆盖 parseCliArgs 全部旗标与边缘拒绝用例, 以及 --help / --version / --init-schema / --dry-run / 双运行时产物验证。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { ConfigError, digitalRoot } from '@iyowei/codd';

import { parseCliArgs } from './args.ts';

const PACKAGE_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PKG_VERSION = (
  JSON.parse(readFileSync(join(PACKAGE_ROOT, 'package.json'), 'utf8')) as {
    version: string;
  }
).version;

describe('parseCliArgs 参数解析', () => {
  test('默认参数、子命令与短/长旗标解析正确', () => {
    expect(parseCliArgs([])).toEqual({
      rotate: 'none',
      newFingerprint: false,
      dryRun: false,
      wizard: false,
      initSchema: false,
      update: false,
      help: false,
      version: false,
    });

    expect(parseCliArgs(['wizard'])).toMatchObject({ wizard: true });
    expect(parseCliArgs(['-i'])).toMatchObject({ wizard: true });
    expect(parseCliArgs(['init'])).toMatchObject({ initSchema: true });
    expect(parseCliArgs(['--init-schema'])).toMatchObject({ initSchema: true });
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true });
    expect(parseCliArgs(['-V'])).toMatchObject({ version: true });
    expect(parseCliArgs(['-v'])).toMatchObject({ version: true });
    expect(parseCliArgs(['--version'])).toMatchObject({ version: true });

    expect(
      parseCliArgs([
        '-c',
        'prod.json',
        '-o',
        'out-prod',
        '--rotate',
        '--new-fingerprint',
        '--dry-run',
      ]),
    ).toMatchObject({
      manifestPath: 'prod.json',
      outDir: 'out-prod',
      rotate: 'apps',
      newFingerprint: true,
      dryRun: true,
    });

    expect(
      parseCliArgs([
        '--config=staging.json',
        '--out=./custom',
        '--rotate-all',
        '--rotate',
      ]),
    ).toMatchObject({
      manifestPath: 'staging.json',
      outDir: './custom',
      rotate: 'all',
    });
  });

  test('支持 -- 终止符并将后续以 - 开头的参数按位置清单处理', () => {
    expect(
      parseCliArgs(['--dry-run', '--', '-special-deploy.json']),
    ).toMatchObject({
      dryRun: true,
      manifestPath: '-special-deploy.json',
    });
  });

  test('拦截 -c / -o 缺值、紧跟另一 flag、空值、重复清单、模式互斥、非首位 update 与未知选项', () => {
    const badInputs: string[][] = [
      ['-c'],
      ['--config'],
      ['-c', '--dry-run'],
      ['--config='],
      ['-c', '   '],
      ['-o'],
      ['--out', '--dry-run'],
      ['--out='],
      ['a.json', 'b.json'],
      ['-c', 'a.json', 'b.json'],
      ['a.json', '-c', 'b.json'],
      ['-c', 'a.json', '-c', 'b.json'],
      ['--config=a.json', '-c', 'b.json'],
      ['--', ''],
      ['--', 'a.json', 'b.json'],
      ['init', '--dry-run'],
      ['init', 'wizard'],
      ['deploy.json', 'init'],
      ['init', '-c', 'a.json'],
      ['init', '--out', './x'],
      ['init', '--rotate'],
      ['--dry-run', 'update'],
      ['wizard', 'update'],
      ['--unknown-flag'],
    ];
    for (const argv of badInputs) {
      expect(() => parseCliArgs(argv)).toThrow(ConfigError);
    }
  });
});

describe('CLI 端到端行为 (源码直跑)', () => {
  const cliEntry = join(PACKAGE_ROOT, 'src/cli.ts');

  test('--help 展示 codd init 与全部核心命令, --version 与 package.json 动态一致', () => {
    const helpRes = spawnSync('bun', [cliEntry, '--help'], {
      encoding: 'utf8',
    });
    expect(helpRes.status).toBe(0);
    expect(helpRes.stdout).toContain('codd init');
    expect(helpRes.stdout).toContain('codd wizard');
    expect(helpRes.stdout).toContain('--init-schema');
    expect(helpRes.stdout).toContain('终止选项解析');
    expect(helpRes.stdout).toContain('-V, -v, --version');

    for (const flag of ['--version', '-V', '-v']) {
      const verRes = spawnSync('bun', [cliEntry, flag], {
        encoding: 'utf8',
      });
      expect(verRes.status, `flag=${flag}`).toBe(0);
      expect(verRes.stdout.trim(), `flag=${flag}`).toBe(PKG_VERSION);
    }

    const updHelp = spawnSync('bun', [cliEntry, 'update', '--help'], {
      encoding: 'utf8',
    });
    expect(updHelp.status).toBe(0);
    expect(updHelp.stdout).toContain('codd update');

    const updSrc = spawnSync('bun', [cliEntry, 'update', '--check'], {
      encoding: 'utf8',
    });
    expect(updSrc.status).toBe(0);
    expect(updSrc.stdout).toContain('本地源码工作树');
  }, 30_000);

  test('--init-schema 首次创建 .gitignore 并明确提示, 二次运行跳过且明确提示; --dry-run 零落盘', () => {
    const workDir = mkdtempSync(join(tmpdir(), 'codd-cli-e2e-'));
    try {
      const init1 = spawnSync('bun', [cliEntry, 'init'], {
        cwd: workDir,
        encoding: 'utf8',
      });
      expect(init1.status).toBe(0);
      expect(existsSync(join(workDir, 'deploy.schema.json'))).toBe(true);
      expect(existsSync(join(workDir, 'deploy-2c2g.json'))).toBe(true);
      expect(existsSync(join(workDir, '.gitignore'))).toBe(true);
      expect(init1.stdout).toContain('已创建');
      expect(init1.stdout).toContain('.gitignore');

      const init2 = spawnSync('bun', [cliEntry, '--init-schema'], {
        cwd: workDir,
        encoding: 'utf8',
      });
      expect(init2.status).toBe(0);
      // printAlert 按终端宽度自动折行, Windows 长临时路径会把提示词折成两行, 折叠空白再断言
      expect(init2.stdout.replace(/\s+/g, ' ')).toContain(
        '.gitignore 已存在, 已跳过写入',
      );

      const dryRes = spawnSync(
        'bun',
        [cliEntry, 'deploy-2c2g.json', '--dry-run'],
        { cwd: workDir, encoding: 'utf8' },
      );
      expect(dryRes.status).toBe(0);
      expect(dryRes.stdout).toContain('配置校验与参数预览');
      expect(dryRes.stdout).not.toContain('安装包已准备就绪');
      expect(existsSync(join(workDir, 'dist'))).toBe(false);
      expect(existsSync(join(workDir, '.codd-state'))).toBe(false);

      // 致命错误应走 stderr 而非 stdout (CODDCLI-P1-1)
      const badRes = spawnSync('bun', [cliEntry, '-c', '--dry-run'], {
        cwd: workDir,
        encoding: 'utf8',
      });
      expect(badRes.status).toBe(1);
      expect(badRes.stderr).toContain('缺少取值');
      expect(badRes.stdout.trim()).toBe('');

      // 管道输入完整跑完多题向导 (CODDCLI-P0-1 端到端回归: 不在第 2 题 EOF 退 130)
      const pipeAnswers = [
        '1', // mode: single
        'pipeapp', // name
        '27117', // port
        '1', // hardware preset 2c2g
        '1', // workload balanced
        'app:appu', // apps
        '1', // os: linux
        '127.0.0.1', // bindIp
        '/home/ops/srv/backups', // backupDir
        '', // sshTarget skip
      ].join('\n');
      const pipeRes = spawnSync('bun', [cliEntry, 'wizard', '--dry-run'], {
        cwd: workDir,
        input: `${pipeAnswers}\n`,
        encoding: 'utf8',
      });
      expect(pipeRes.status).toBe(0);
      expect(pipeRes.stdout).toContain('single-pipeapp');
      expect(pipeRes.stdout).toContain('配置校验与参数预览');
      expect(existsSync(join(workDir, 'dist'))).toBe(false);

      // replica-set 管道向导拦截重复 bindIp 并允许纠错重填后通过 (CODDCLI-P1-3)
      const rsPipeAnswers = [
        '2', // mode: replica-set
        'rsha', // name
        '27117', // port
        '1', // 2c2g
        '1', // balanced
        'app:appu', // apps
        '1', // node1 linux
        '10.8.0.11', // node1 ip
        '/home/ops/srv/backups', // node1 backup
        '', // node1 ssh
        '1', // node2 linux
        '10.8.0.11', // node2 duplicate ip -> 应拦截提示
        '10.8.0.12', // node2 corrected ip
        '/home/ops/srv/backups', // node2 backup
        '', // node2 ssh
        '1', // node3 linux
        '10.8.0.13', // node3 ip
        '/home/ops/srv/backups', // node3 backup
        '', // node3 ssh
      ].join('\n');
      const rsPipeRes = spawnSync('bun', [cliEntry, 'wizard', '--dry-run'], {
        cwd: workDir,
        input: `${rsPipeAnswers}\n`,
        encoding: 'utf8',
      });
      expect(rsPipeRes.status).toBe(0);
      expect(rsPipeRes.stdout).toContain('已被前一台节点使用');
      expect(rsPipeRes.stdout).toContain('replica-set-rsha');

      // 端口题直接回车采纳向导推荐的数根 3/6/9 安全 5 位端口, hint 说明常规默认 27117
      const recPortAnswers = [
        '1', // mode: single
        'recport', // name
        '', // port: 直接回车采纳动态推荐安全端口
        '1', // hardware preset 2c2g
        '1', // workload balanced
        'app:appu', // apps
        '1', // os: linux
        '127.0.0.1', // bindIp
        '/home/ops/srv/backups', // backupDir
        '', // sshTarget skip
        'y', // 保存配置清单
        'deploy-recport.json', // 清单文件名
      ].join('\n');
      const recRes = spawnSync('bun', [cliEntry, 'wizard'], {
        cwd: workDir,
        input: `${recPortAnswers}\n`,
        encoding: 'utf8',
      });
      expect(recRes.status).toBe(0);
      const savedManifest = JSON.parse(
        readFileSync(join(workDir, 'deploy-recport.json'), 'utf8'),
      ) as { port: number };
      expect(recRes.stdout).toContain(
        `数据库监听哪个端口? [默认: ${savedManifest.port}]:`,
      );
      expect(savedManifest.port).toBeGreaterThanOrEqual(10002);
      expect(savedManifest.port).toBeLessThanOrEqual(29997);
      expect([3, 6, 9]).toContain(digitalRoot(savedManifest.port));
    } finally {
      rmSync(workDir, {
        recursive: true,
        force: true,
        maxRetries: 5,
        retryDelay: 100,
      });
    }
  }, 30_000);
});

const hasBuiltCli = existsSync(join(PACKAGE_ROOT, 'dist/cli.js'));

describe('构建产物双运行时与工作目录隔离验证 (Bun & Node)', () => {
  test.skipIf(!hasBuiltCli)(
    '经 bin/codd.mjs 在 Bun 与 Node 下输出版本、生成套件, 且损坏 bunfig.toml 不影响 bin/codd 启动',
    () => {
      const binEntry = join(PACKAGE_ROOT, 'bin/codd.mjs');
      for (const runtime of ['bun', 'node']) {
        for (const flag of ['--version', '-V']) {
          const verRes = spawnSync(runtime, [binEntry, flag], {
            encoding: 'utf8',
          });
          expect(verRes.status, `${runtime} ${flag}`).toBe(0);
          expect(verRes.stdout.trim(), `${runtime} ${flag}`).toBe(PKG_VERSION);
        }

        const workDir = mkdtempSync(join(tmpdir(), `codd-dist-${runtime}-`));
        try {
          const customCfg = join(workDir, 'deploy-staging.json');
          writeFileSync(
            customCfg,
            JSON.stringify(
              {
                mode: 'single',
                name: 'staging',
                hardware: { cpuCores: 2, memoryGb: 4, diskGb: 50 },
                apps: [{ db: 'shop', user: 'shopu' }],
                nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }],
              },
              null,
              2,
            ),
            'utf8',
          );

          const genRes = spawnSync(runtime, [binEntry, 'deploy-staging.json'], {
            cwd: workDir,
            encoding: 'utf8',
          });
          expect(genRes.status).toBe(0);
          const generatedBundles = readdirSync(join(workDir, 'dist'));
          expect(generatedBundles.length).toBe(1);
          expect(generatedBundles[0]?.startsWith('mongo-staging-')).toBe(true);
          expect(existsSync(join(workDir, '.codd-state/.gitignore'))).toBe(
            true,
          );

          if (process.platform !== 'win32') {
            writeFileSync(
              join(workDir, 'bunfig.toml'),
              '[install.scopes]\nfoo = "bar"\n[install.scopes]\nbaz = "qux"\n',
              'utf8',
            );
            const brokenCwdRes = spawnSync(
              '/bin/sh',
              [join(PACKAGE_ROOT, 'bin/codd'), '--version'],
              { cwd: workDir, encoding: 'utf8' },
            );
            expect(brokenCwdRes.status).toBe(0);
            expect(brokenCwdRes.stdout.trim()).toBe(PKG_VERSION);
          }
        } finally {
          rmSync(workDir, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      }
    },
    30_000,
  );
});
