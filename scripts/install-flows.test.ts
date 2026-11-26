/**
 * POSIX `install.sh` 产品门禁 (404 / macOS-only)、各 CLI 独立环境变量前缀 + CLI 自定义 URL 参数
 * (`--installer-url` / `--bun-url` / `--registry` / `--from-tarball` 本地与远程直链)、
 * 生产依赖补装与共享私有 Bun 卸载回收 E2E 测试。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildHermeticPosixBin,
  createMockInstallerServer,
  runAsync,
} from './lib/install-test-fixtures.ts';
import { makeTmpRoot } from './lib/tmp-root.ts';

const ROOT = resolve(import.meta.dir, '..');
const tempDirs: string[] = [];

function hostBunZipName(): string {
  if (process.platform === 'darwin') {
    return process.arch === 'arm64'
      ? 'bun-darwin-aarch64.zip'
      : 'bun-darwin-x64.zip';
  }
  return process.arch === 'arm64'
    ? 'bun-linux-aarch64.zip'
    : 'bun-linux-x64.zip';
}

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
  describe('POSIX install.sh 产品约束、环境 URL 自定义与卸载周期', () => {
    const mock = createMockInstallerServer(ROOT);
    afterAll(() => {
      mock.stop();
    });

    test('未发布包 (404) 指引、--from-tarball 离线安装及 fan 平台门禁', async () => {
      const base = mock.url();
      const root = allocTmp('clis-e2e-sweep-fan-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const binPath = buildHermeticPosixBin(root, { includeRealBun: true });
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');

      const res404 = await runAsync(
        'sh',
        [join(ROOT, 'packages/sweep-cli/install.sh'), '--no-path'],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            PATH: binPath,
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: binDir,
            NPM_CONFIG_REGISTRY: `${base}/reg`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(res404.status).not.toBe(0);
      expect(res404.stderr).toContain('404');

      const tgzPath = join(root, 'sweep.tgz');
      writeFileSync(tgzPath, mock.getFixtureTgz('sweep'));
      const resSweep = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/sweep-cli/install.sh'),
          '--from-tarball',
          tgzPath,
          '--no-path',
        ],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            PATH: binPath,
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: binDir,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(resSweep.status).toBe(0);
      const runSweep = await runAsync(join(binDir, 'sweep'), ['--version'], {
        timeoutMs: 20_000,
        env: { HOME: home, PATH: binPath },
      });
      expect(runSweep.status).toBe(0);
      expect(runSweep.stdout.trim()).toBe('0.4.0 (isolated=1)');

      const fanTgz = join(root, 'fan.tgz');
      writeFileSync(fanTgz, mock.getFixtureTgz('fan'));
      const resFan = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/fan-cli/install.sh'),
          '--from-tarball',
          fanTgz,
          '--no-path',
        ],
        {
          timeoutMs: 20_000,
          env: {
            HOME: home,
            PATH: binPath,
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: binDir,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      if (process.platform === 'darwin') {
        expect(resFan.status).toBe(0);
      } else {
        expect(resFan.status).not.toBe(0);
        expect(resFan.stderr).toContain('仅支持 macOS');
      }
    });

    test('支持工具前缀环境变量与远程 tarball 补装 dependencies 及卸载回收', async () => {
      const base = mock.url();
      mock.resetRequestedUrls();
      mock.setCorruptBunSha(false);
      const root = allocTmp('clis-e2e-custom-urls-deps-');
      const home = join(root, 'home');
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      const tmpArea = join(root, 'tmp');
      mkdirSync(home, { recursive: true });
      mkdirSync(tmpArea, { recursive: true });

      const envBase = {
        HOME: home,
        TMPDIR: tmpArea,
        PATH: buildHermeticPosixBin(root),
        CODD_INSTALL_HOME: dataDir,
        CODD_BIN_DIR: binDir,
        CODD_INSTALLER_URL: `${base}/custom-mirror/clis-install.sh`,
        CODD_BUN_URL: `${base}/custom-bun/dl/${hostBunZipName()}?mirror=1`,
        CODD_REGISTRY: `${base}/reg`,
        CLIS_NON_INTERACTIVE: '1',
      };

      const wrapperSh = readFileSync(
        join(ROOT, 'packages/codd-cli/install.sh'),
        'utf8',
      );
      const pipedRes = await runAsync('sh', ['-s', '--', '--no-path'], {
        input: wrapperSh,
        timeoutMs: 30_000,
        env: envBase,
      });
      if (pipedRes.status !== 0) {
        throw new Error(
          `pipedRes stderr: ${pipedRes.stderr}\nstdout: ${pipedRes.stdout}`,
        );
      }
      const hits = mock.getRequestedUrls();
      expect(hits).toContain('/custom-mirror/clis-install.sh');
      expect(hits).toContain(`/custom-bun/dl/${hostBunZipName()}?mirror=1`);
      expect(hits).toContain('/custom-bun/dl/SHASUMS256.txt');
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(true);
      expect(readdirSync(tmpArea)).toEqual([]);

      const resDeps = await runAsync(
        'sh',
        [
          join(ROOT, 'packages/create-clis/install.sh'),
          '--from-tarball',
          `${base}/tar/create-clis.tgz`,
          '--no-path',
        ],
        {
          timeoutMs: 30_000,
          env: {
            HOME: home,
            TMPDIR: tmpArea,
            PATH: buildHermeticPosixBin(join(root, 'bun-sub'), {
              includeRealBun: true,
            }),
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: binDir,
            CREATE_CLIS_REGISTRY: `${base}/reg`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      if (resDeps.status !== 0) {
        throw new Error(
          `resDeps stderr: ${resDeps.stderr}\nstdout: ${resDeps.stdout}`,
        );
      }
      expect(
        existsSync(
          join(
            dataDir,
            'apps',
            'create-clis',
            'node_modules',
            'fixture-dep',
            'package.json',
          ),
        ),
      ).toBe(true);

      const rmCodd = await runAsync(
        'sh',
        [join(ROOT, 'install.sh'), '--tool', 'codd', '--uninstall'],
        { timeoutMs: 20_000, env: envBase },
      );
      expect(rmCodd.status).toBe(0);
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(true);

      const rmLast = await runAsync(
        'sh',
        [join(ROOT, 'install.sh'), '--tool', 'create-clis', '--uninstall'],
        {
          timeoutMs: 20_000,
          env: {
            ...envBase,
            CREATE_CLIS_INSTALL_HOME: dataDir,
            CREATE_CLIS_BIN_DIR: binDir,
          },
        },
      );
      expect(rmLast.status).toBe(0);
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(false);
    });
  });

  describe('POSIX install.sh 各工具专属前缀与 URL 参数覆盖校验', () => {
    const mock = createMockInstallerServer(ROOT);
    afterAll(() => {
      mock.stop();
    });

    test('支持 --installer-url / --bun-url / --registry 与工具专属环境变量优先级', async () => {
      const base = mock.url();
      mock.resetRequestedUrls();
      const root = allocTmp('clis-e2e-cli-flags-');
      const home = join(root, 'home');
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      const tmpArea = join(root, 'tmp');
      mkdirSync(home, { recursive: true });
      mkdirSync(tmpArea, { recursive: true });
      const hermetic = buildHermeticPosixBin(root);

      const wrapperSh = readFileSync(
        join(ROOT, 'packages/codd-cli/install.sh'),
        'utf8',
      );
      const cliRes = await runAsync(
        'sh',
        [
          '-s',
          '--',
          '--installer-url',
          `${base}/custom-mirror/clis-install.sh`,
          '--bun-url',
          `${base}/custom-bun/dl/{file}?via=flag`,
          '--registry',
          `${base}/reg`,
          '--no-path',
        ],
        {
          input: wrapperSh,
          timeoutMs: 30_000,
          env: {
            HOME: home,
            TMPDIR: tmpArea,
            PATH: hermetic,
            CODD_INSTALL_HOME: dataDir,
            CODD_BIN_DIR: binDir,
            CODD_INSTALLER_URL: 'http://127.0.0.1:1/should-not-use',
            CODD_BUN_URL: 'http://127.0.0.1:1/should-not-use',
            CLIS_INSTALLER_URL: 'http://127.0.0.1:1/should-not-use',
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      if (cliRes.status !== 0) {
        throw new Error(
          `cliRes stderr: ${cliRes.stderr}\nstdout: ${cliRes.stdout}`,
        );
      }
      const hits = mock.getRequestedUrls();
      expect(hits).toContain('/custom-mirror/clis-install.sh');
      expect(hits).toContain('/custom-bun/dl/SHASUMS256.txt?via=flag');
      expect(hits).toContain('/reg/@iyowei%2Fcodd-cli/latest');
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(true);
      expect(existsSync(join(binDir, 'codd'))).toBe(true);
    });

    test('独立环境变量前缀 CODD_INSTALLER_URL 生效且拒绝非法 URL', async () => {
      const base = mock.url();
      mock.resetRequestedUrls();
      const root = allocTmp('clis-e2e-prefix-env-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });
      const hermetic = buildHermeticPosixBin(root);

      const badRes = await runAsync(
        'sh',
        [
          join(ROOT, 'install.sh'),
          '--tool',
          'codd',
          '--bun-url',
          'ftp://invalid.example/bun.zip',
          '--registry',
          `${base}/reg`,
          '--no-path',
        ],
        {
          timeoutMs: 10_000,
          env: {
            HOME: home,
            PATH: hermetic,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(badRes.status).not.toBe(0);
      expect(badRes.stderr).toContain('--bun-url');

      const wrapperSh = readFileSync(
        join(ROOT, 'packages/codd-cli/install.sh'),
        'utf8',
      );
      const okRes = await runAsync(
        'sh',
        ['-s', '--', '--from-tarball', `${base}/tar/codd.tgz`, '--no-path'],
        {
          input: wrapperSh,
          timeoutMs: 30_000,
          env: {
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: buildHermeticPosixBin(join(root, 'bun2'), {
              includeRealBun: true,
            }),
            CODD_INSTALL_HOME: join(root, 'data2'),
            CODD_BIN_DIR: join(root, 'bin2'),
            CODD_INSTALLER_URL: `${base}/custom-mirror/clis-install.sh`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      if (okRes.status !== 0) {
        throw new Error(
          `okRes stderr: ${okRes.stderr}\nstdout: ${okRes.stdout}`,
        );
      }
      expect(mock.getRequestedUrls()).toContain(
        '/custom-mirror/clis-install.sh',
      );
      expect(existsSync(join(root, 'bin2', 'codd'))).toBe(true);
    });
  });
}
