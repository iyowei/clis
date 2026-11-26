/**
 * POSIX `install.sh` 非静默参数冲突拦截与显式提示机制 E2E 测试。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildHermeticPosixBin,
  buildPkgTarball,
  createMockInstallerServer,
  runAsync,
} from './lib/install-test-fixtures.ts';
import { makeTmpRoot } from './lib/tmp-root.ts';

const ROOT = resolve(import.meta.dir, '..');
const tempDirs: string[] = [];

function allocTmp(prefix: string): string {
  const d = makeTmpRoot(prefix);
  tempDirs.push(d);
  return d;
}

afterEach(() => {
  while (tempDirs.length > 0) {
    rmSync(tempDirs.pop()!, { recursive: true, force: true });
  }
});

if (process.platform !== 'win32') {
  const mock = createMockInstallerServer(ROOT);
  afterAll(() => {
    mock.stop();
  });

  describe('POSIX install.sh 非静默冲突拦截与显式提示机制', () => {
    test('互斥参数拒绝: --from-tarball 与 --version 互斥, --uninstall 与安装源旗标互斥', async () => {
      const base = mock.url();
      const root = allocTmp('clis-e2e-conflicts-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const bunBin = buildHermeticPosixBin(root, { includeRealBun: true });
      const tgzPath = join(root, 'sweep.tgz');
      writeFileSync(tgzPath, mock.getFixtureTgz('sweep'));

      const verConflict = await runAsync(
        'sh',
        [
          join(ROOT, 'install.sh'),
          '--tool',
          'sweep',
          '--from-tarball',
          tgzPath,
          '--version',
          '9.9.9',
          '--no-path',
        ],
        {
          timeoutMs: 10_000,
          env: {
            HOME: home,
            PATH: bunBin,
            CLIS_INSTALL_HOME: join(root, 'data'),
            CLIS_BIN_DIR: join(root, 'bin'),
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(verConflict.status).not.toBe(0);
      expect(verConflict.stderr).toContain('--from-tarball 与 --version');
      expect(existsSync(join(root, 'bin', 'sweep'))).toBe(false);

      const uninstConflict = await runAsync(
        'sh',
        [
          join(ROOT, 'install.sh'),
          '--tool',
          'sweep',
          '--uninstall',
          '--registry',
          `${base}/reg`,
        ],
        {
          timeoutMs: 10_000,
          env: { HOME: home, PATH: bunBin, CLIS_NON_INTERACTIVE: '1' },
        },
      );
      expect(uninstConflict.status).not.toBe(0);
      expect(uninstConflict.stderr).toContain('--uninstall');
    });

    test('非静默提示: 无用或部分生效参数及本地直调 --installer-url 均明确告知用户', async () => {
      const base = mock.url();
      mock.resetRequestedUrls();
      const root = allocTmp('clis-e2e-notices-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      const bunBin = buildHermeticPosixBin(root, { includeRealBun: true });
      const tgzPath = join(root, 'sweep.tgz');
      writeFileSync(tgzPath, mock.getFixtureTgz('sweep'));

      const warnRes = await runAsync(
        'sh',
        [
          join(ROOT, 'install.sh'),
          '--tool',
          'sweep',
          '--from-tarball',
          tgzPath,
          '--registry',
          `${base}/reg`,
          '--bun-url',
          `${base}/bun-rel`,
          '--installer-url',
          `${base}/custom-mirror/clis-install.sh`,
          '--no-path',
        ],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: bunBin,
            SWEEP_VERSION: '2.0.0',
            SWEEP_INSTALL_HOME: join(root, 'data'),
            SWEEP_BIN_DIR: join(root, 'bin'),
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(warnRes.status).toBe(0);
      expect(warnRes.stderr).toContain('SWEEP_VERSION=2.0.0');
      expect(warnRes.stderr).toContain('未使用 --bun-url');
      expect(warnRes.stderr).toContain('--registry');
      expect(warnRes.stderr).toContain('--installer-url');

      const localWrap = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/codd-cli/install.sh'),
          '--installer-url',
          `${base}/custom-mirror/clis-install.sh`,
          '--from-tarball',
          `${base}/tar/codd.tgz`,
          '--no-path',
        ],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: bunBin,
            CODD_INSTALL_HOME: join(root, 'data2'),
            CODD_BIN_DIR: join(root, 'bin2'),
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(localWrap.status).toBe(0);
      expect(mock.getRequestedUrls()).toContain(
        '/custom-mirror/clis-install.sh',
      );
      expect(localWrap.stderr).not.toContain('当前已在主安装脚本内运行');
    });
  });

  describe('POSIX install.sh 包入口防误配、manifest 自证与真实产物闭环', () => {
    test('包入口防误配与产物 manifest 自证: 拒绝跨工具 --tool、悬空参数与被篡改的 dist/manifest.json', async () => {
      const root = allocTmp('clis-e2e-sec-guards-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      const bunBin = buildHermeticPosixBin(root, { includeRealBun: true });

      const crossTool = await runAsync(
        'sh',
        [join(ROOT, 'packages/codd-cli/install.sh'), '--tool', 'sweep'],
        {
          timeoutMs: 10_000,
          env: { HOME: home, PATH: bunBin, CLIS_NON_INTERACTIVE: '1' },
        },
      );
      expect(crossTool.status).not.toBe(0);
      expect(crossTool.stderr).toContain('专属安装脚本');

      const danglingUrl = await runAsync(
        'sh',
        [join(ROOT, 'packages/codd-cli/install.sh'), '--installer-url'],
        {
          timeoutMs: 10_000,
          env: { HOME: home, PATH: bunBin, CLIS_NON_INTERACTIVE: '1' },
        },
      );
      expect(danglingUrl.status).not.toBe(0);
      expect(danglingUrl.stderr).toContain('--installer-url 需要参数值');

      // 构造 dist/manifest.json 摘要不匹配的恶意/损坏 tarball
      const tampered = buildPkgTarball({
        'package.json': JSON.stringify({
          name: '@iyowei/codd-cli',
          version: '9.9.9',
          type: 'module',
          bin: { codd: 'bin/codd.mjs' },
        }),
        'bin/codd.mjs': '#!/usr/bin/env node\nconsole.log("pwn");\n',
        'bin/bunfig.toml': 'telemetry = false\n',
        'dist/cli.js': 'console.log("tampered");\n',
        'dist/manifest.json': JSON.stringify({
          schemaVersion: 1,
          cliSha256: 'f'.repeat(64),
        }),
      });
      const tamperedPath = join(root, 'tampered.tgz');
      writeFileSync(tamperedPath, tampered.tgz);

      const tamperedRes = await runAsync(
        'sh',
        [
          join(ROOT, 'install.sh'),
          '--tool',
          'codd',
          '--from-tarball',
          tamperedPath,
          '--no-path',
        ],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: bunBin,
            CLIS_INSTALL_HOME: join(root, 'data'),
            CLIS_BIN_DIR: join(root, 'bin'),
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(tamperedRes.status).not.toBe(0);
      expect(existsSync(join(root, 'bin', 'codd'))).toBe(false);
    });

    test('真实构建产物闭环: 打包真实 @iyowei/codd-cli 与 create-clis 安装后 --version 与 update --check 全链路自洽', async () => {
      const coddDir = join(ROOT, 'packages/codd-cli');
      const createDir = join(ROOT, 'packages/create-clis');
      if (
        !existsSync(join(coddDir, 'dist', 'cli.js')) ||
        !existsSync(join(createDir, 'dist', 'create-clis.js'))
      ) {
        return;
      }
      const base = mock.url();
      const root = allocTmp('clis-e2e-real-artifact-');
      const home = join(root, 'home');
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      const packDir = join(root, 'pack');
      mkdirSync(home, { recursive: true });
      mkdirSync(packDir, { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });

      const coddFiles: Record<string, string> = {
        'package.json': readFileSync(join(coddDir, 'package.json'), 'utf8'),
        'bin/codd.mjs': readFileSync(join(coddDir, 'bin/codd.mjs'), 'utf8'),
        'bin/bunfig.toml': readFileSync(
          join(coddDir, 'bin/bunfig.toml'),
          'utf8',
        ),
        'dist/cli.js': readFileSync(join(coddDir, 'dist/cli.js'), 'utf8'),
        'dist/manifest.json': readFileSync(
          join(coddDir, 'dist/manifest.json'),
          'utf8',
        ),
      };
      const realCoddTgz = join(packDir, 'codd-cli-real.tgz');
      writeFileSync(realCoddTgz, buildPkgTarball(coddFiles).tgz);

      const createPkgRaw = JSON.parse(
        readFileSync(join(createDir, 'package.json'), 'utf8'),
      ) as Record<string, unknown>;
      delete createPkgRaw.dependencies;
      const createFiles: Record<string, string> = {
        'package.json': `${JSON.stringify(createPkgRaw, null, 2)}\n`,
        'bin/create-clis.mjs': readFileSync(
          join(createDir, 'bin/create-clis.mjs'),
          'utf8',
        ),
        'bin/bunfig.toml': readFileSync(
          join(createDir, 'bin/bunfig.toml'),
          'utf8',
        ),
        'dist/create-clis.js': readFileSync(
          join(createDir, 'dist/create-clis.js'),
          'utf8',
        ),
        'dist/manifest.json': readFileSync(
          join(createDir, 'dist/manifest.json'),
          'utf8',
        ),
      };
      const realCreateTgz = join(packDir, 'create-clis-real.tgz');
      writeFileSync(realCreateTgz, buildPkgTarball(createFiles).tgz);

      const bunBin = buildHermeticPosixBin(root, { includeRealBun: true });
      const commonEnv = {
        HOME: home,
        USERPROFILE: home,
        APPDATA: join(home, 'AppData', 'Roaming'),
        LOCALAPPDATA: join(home, 'AppData', 'Local'),
        XDG_CONFIG_HOME: join(home, '.config'),
        TMPDIR: join(root, 'tmp'),
        PATH: bunBin,
        CLIS_INSTALL_HOME: dataDir,
        CLIS_BIN_DIR: binDir,
        CLIS_NON_INTERACTIVE: '1',
      };

      const instCodd = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/codd-cli/install.sh'),
          '--from-tarball',
          realCoddTgz,
          '--no-path',
        ],
        { timeoutMs: 30_000, env: commonEnv },
      );
      expect(instCodd.status).toBe(0);

      const instCreate = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/create-clis/install.sh'),
          '--from-tarball',
          realCreateTgz,
          '--no-path',
        ],
        { timeoutMs: 30_000, env: commonEnv },
      );
      expect(instCreate.status).toBe(0);

      for (const [bin, regEnv] of [
        ['codd', 'CODD_REGISTRY'],
        ['create-clis', 'CREATE_CLIS_REGISTRY'],
      ] as const) {
        const verRes = await runAsync(join(binDir, bin), ['--version'], {
          timeoutMs: 20_000,
          env: commonEnv,
        });
        expect(verRes.status).toBe(0);
        expect(verRes.stdout.trim()).toMatch(/^\d+\.\d+\.\d+$/);

        const checkRes = await runAsync(
          join(binDir, bin),
          ['update', '--check', '--lang', 'zh'],
          {
            timeoutMs: 20_000,
            env: {
              ...commonEnv,
              [regEnv]: `${base}/reg`,
              NO_COLOR: '1',
            },
          },
        );
        expect(checkRes.status).toBe(0);
        expect(checkRes.stdout).toContain('独立脚本安装');
      }
    });
  });
}
