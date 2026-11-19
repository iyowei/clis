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

import { ConfigError } from '@iyowei/codd';

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
      help: false,
      version: false,
    });

    expect(parseCliArgs(['wizard'])).toMatchObject({ wizard: true });
    expect(parseCliArgs(['-i'])).toMatchObject({ wizard: true });
    expect(parseCliArgs(['init'])).toMatchObject({ initSchema: true });
    expect(parseCliArgs(['--init-schema'])).toMatchObject({ initSchema: true });
    expect(parseCliArgs(['-h'])).toMatchObject({ help: true });
    expect(parseCliArgs(['-v'])).toMatchObject({ version: true });

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

  test('拦截 -c / -o 缺值、紧跟另一 flag、空内联值、重复位置参数与未知选项', () => {
    const badInputs: string[][] = [
      ['-c'],
      ['--config'],
      ['-c', '--dry-run'],
      ['--config='],
      ['-o'],
      ['--out', '--dry-run'],
      ['--out='],
      ['a.json', 'b.json'],
      ['-c', 'a.json', 'b.json'],
      ['--unknown-flag'],
      ['--', 'a.json', 'b.json'],
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

    const verRes = spawnSync('bun', [cliEntry, '--version'], {
      encoding: 'utf8',
    });
    expect(verRes.status).toBe(0);
    expect(verRes.stdout.trim()).toBe(PKG_VERSION);
  });

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
      expect(init2.stdout).toContain('.gitignore 已存在, 已跳过写入');

      const dryRes = spawnSync(
        'bun',
        [cliEntry, 'deploy-2c2g.json', '--dry-run'],
        { cwd: workDir, encoding: 'utf8' },
      );
      expect(dryRes.status).toBe(0);
      expect(existsSync(join(workDir, 'dist'))).toBe(false);
      expect(existsSync(join(workDir, '.codd-state'))).toBe(false);

      const badRes = spawnSync('bun', [cliEntry, '-c', '--dry-run'], {
        cwd: workDir,
        encoding: 'utf8',
      });
      expect(badRes.status).toBe(1);
    } finally {
      rmSync(workDir, { recursive: true, force: true });
    }
  });
});

const hasBuiltCli = existsSync(join(PACKAGE_ROOT, 'dist/cli.js'));

describe('构建产物双运行时与工作目录隔离验证 (Bun & Node)', () => {
  test.skipIf(!hasBuiltCli)(
    '经 bin/codd.mjs 在 Bun 与 Node 下输出版本、生成套件, 且损坏 bunfig.toml 不影响 bin/codd 启动',
    () => {
      const binEntry = join(PACKAGE_ROOT, 'bin/codd.mjs');
      for (const runtime of ['bun', 'node']) {
        const verRes = spawnSync(runtime, [binEntry, '--version'], {
          encoding: 'utf8',
        });
        expect(verRes.status).toBe(0);
        expect(verRes.stdout.trim()).toBe(PKG_VERSION);

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
          rmSync(workDir, { recursive: true, force: true });
        }
      }
    },
  );
});
