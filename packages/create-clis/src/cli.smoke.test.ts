/**
 * create-clis 入口冒烟: 只承诺「帮助可打印且退 0」(秒级健康检查, 无夹具无生成), 双载体
 * (bun / node)。生成全链的端到端契约在 cli.e2e.test.ts; 无参数直跑会进交互问答, 不属冒烟面。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { preparePoisonedCwd } from '../../../scripts/lib/smoke-install-paths.ts';
import { assertShimContract } from '../../../scripts/smoke-install.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const BIN_MJS = fileURLToPath(
  new URL('../bin/create-clis.mjs', import.meta.url),
);
const DIST_CLI = fileURLToPath(
  new URL('../dist/create-clis.js', import.meta.url),
);
const ASSETS_MANIFEST = fileURLToPath(
  new URL('../assets/manifest.json', import.meta.url),
);
const PKG_VERSION = (
  JSON.parse(
    readFileSync(new URL('../package.json', import.meta.url), 'utf8'),
  ) as { version: string }
).version;

/** 挂死守卫: 帮助秒回, 超时即判失败 */
const TIMEOUT_MS = 10_000;

for (const runner of ['bun', 'node']) {
  const available =
    spawnSync(runner, ['--version'], { encoding: 'utf8' }).status === 0;

  describe(`cli 入口冒烟 [${runner}]`, () => {
    test.skipIf(!available)('--help / -h: 退 0 且给出用法与旗标', () => {
      for (const flag of ['--help', '-h']) {
        const result = spawnSync(runner, [CLI, flag], {
          encoding: 'utf8',
          timeout: TIMEOUT_MS,
        });
        const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
        expect(result.status, `应退 0 (${detail})`).toBe(0);
        for (const text of ['create-clis', '--tier', '--no-install']) {
          expect(result.stdout).toContain(text);
        }
      }
    });

    test.skipIf(!available)(
      '--version / -V: 退 0 且输出与 package.json 一致的版本号',
      () => {
        for (const flag of ['--version', '-V']) {
          const result = spawnSync(runner, [CLI, flag], {
            encoding: 'utf8',
            timeout: TIMEOUT_MS,
          });
          const detail = `status=${result.status} stdout=${result.stdout} stderr=${result.stderr}`;
          expect(result.status, `应退 0 (${detail})`).toBe(0);
          expect(result.stdout.trim(), `flag=${flag}`).toBe(PKG_VERSION);
        }
      },
    );
  });
}

describe('产物轻量化与惰性加载守卫 (CREATE-P0-1)', () => {
  test.skipIf(!existsSync(DIST_CLI))(
    'dist/create-clis.js 不含顶层静态 import prettier, 仅按需动态 import',
    () => {
      const bundle = readFileSync(DIST_CLI, 'utf8');
      expect(bundle).not.toMatch(
        /\bimport\s+\*\s+as\s+\w+\s+from\s*["']prettier["']/,
      );
      expect(bundle).not.toMatch(/\bimport\s+[^(\n]+from\s*["']prettier["']/);
      expect(bundle).toMatch(/import\(["']prettier["']\)/);
    },
  );
});

const hasBuiltArtifacts = existsSync(DIST_CLI) && existsSync(ASSETS_MANIFEST);

for (const runner of ['bun', 'node']) {
  const available =
    spawnSync(runner, ['--version'], { encoding: 'utf8' }).status === 0;

  describe(`打包入口 bin/create-clis.mjs 双运行时冒烟 [${runner}]`, () => {
    test.skipIf(!available || !hasBuiltArtifacts)(
      '经 dist/create-clis.js 输出版本并用内置模板资产与 prettier 生成 core 档项目',
      () => {
        const ver = spawnSync(runner, [BIN_MJS, '-V'], {
          encoding: 'utf8',
          timeout: TIMEOUT_MS,
        });
        expect(ver.status, ver.stderr).toBe(0);
        expect(ver.stdout.trim()).toBe(PKG_VERSION);

        const sandbox = mkdtempSync(
          join(tmpdir(), `create-clis-bin-${runner}-`),
        );
        const target = join(sandbox, 'smoke-kit');
        try {
          const gen = spawnSync(
            runner,
            [
              BIN_MJS,
              target,
              '--name',
              'smoke-kit',
              '--owner',
              'smoke-owner',
              '--repo',
              'https://github.com/smoke-owner/smoke-kit',
              '--tier',
              'core',
              '--yes',
              '--no-git',
              '--no-install',
            ],
            {
              cwd: sandbox,
              encoding: 'utf8',
              timeout: 30_000,
            },
          );
          expect(gen.status, `${gen.stdout}\n${gen.stderr}`).toBe(0);
          expect(existsSync(join(target, 'package.json'))).toBe(true);
          expect(existsSync(join(target, '.gitignore'))).toBe(true);
          expect(
            existsSync(
              join(target, 'packages/smoke-kit-cli/bin/smoke-kit.mjs'),
            ),
          ).toBe(true);
        } finally {
          rmSync(sandbox, {
            recursive: true,
            force: true,
            maxRetries: 5,
            retryDelay: 100,
          });
        }
      },
      30_000,
    );
  });
}

const bunAvailable =
  spawnSync('bun', ['--version'], { encoding: 'utf8' }).status === 0;

describe('生成物最小 CLI 骨架与 smoke:install 契约协同', () => {
  test.skipIf(!bunAvailable || !hasBuiltArtifacts)(
    '离线打包生成物 smoke-kit-cli 后通过 assertShimContract 与 bunfig 隔离校验',
    () => {
      const sandbox = mkdtempSync(join(tmpdir(), 'create-clis-contract-'));
      const target = join(sandbox, 'smoke-kit');
      try {
        const gen = spawnSync(
          'bun',
          [
            BIN_MJS,
            target,
            '--name',
            'smoke-kit',
            '--scope',
            '@smoke',
            '--owner',
            'smoke-owner',
            '--repo',
            'https://github.com/smoke-owner/smoke-kit',
            '--tier',
            'core',
            '--yes',
            '--no-git',
            '--no-install',
          ],
          { cwd: sandbox, encoding: 'utf8', timeout: 30_000 },
        );
        expect(gen.status, `${gen.stdout}\n${gen.stderr}`).toBe(0);

        // 仅写入工作区内 API 包索引映射, 让离线 bun build 可解析 @smoke/smoke-kit
        const depDir = join(target, 'node_modules', '@smoke', 'smoke-kit');
        mkdirSync(depDir, { recursive: true });
        writeFileSync(
          join(depDir, 'package.json'),
          `${JSON.stringify({
            name: '@smoke/smoke-kit',
            type: 'module',
            main: '../../../packages/smoke-kit/src/index.ts',
          })}\n`,
        );

        const cliPkgDir = join(target, 'packages', 'smoke-kit-cli');
        const build = spawnSync('bun', ['run', 'build'], {
          cwd: cliPkgDir,
          encoding: 'utf8',
          timeout: 30_000,
        });
        expect(build.status, `${build.stdout}\n${build.stderr}`).toBe(0);

        const binMjs = join(cliPkgDir, 'bin', 'smoke-kit.mjs');
        const shim =
          process.platform === 'win32'
            ? join(sandbox, 'smoke-kit-shim.cmd')
            : binMjs;
        if (process.platform === 'win32') {
          writeFileSync(shim, `@echo off\r\nnode "${binMjs}" %*\r\n`);
        }

        const dirtyCwd = preparePoisonedCwd(sandbox);
        assertShimContract({
          executable: shim,
          pkgName: '@smoke/smoke-kit-cli',
          version: '0.0.0',
          binName: 'smoke-kit',
          modeLabel: 'offline-template',
          dirtyCwd,
          env: process.env,
        });
      } finally {
        rmSync(sandbox, {
          recursive: true,
          force: true,
          maxRetries: 5,
          retryDelay: 100,
        });
      }
    },
    30_000,
  );
});
