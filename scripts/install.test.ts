/**
 * 跨平台一键安装脚本静态合同与 POSIX 运行时自适应 E2E 测试。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync } from 'node:fs';
import { join, resolve } from 'node:path';

import {
  buildHermeticPosixBin,
  createMockInstallerServer,
  resolveHostNode22Plus,
  runAsync,
} from './lib/install-test-fixtures.ts';
import { resolveCliPackages } from './lib/smoke-install-paths.ts';
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

describe('全仓 CLI 一键安装脚本封装一致性与跨平台静态合同', () => {
  test('所有带 bin 的工作区 CLI 包均提供独立前缀封装与完整自定义 URL 支持', () => {
    const cliPackages = resolveCliPackages(ROOT);
    expect(cliPackages.length).toBeGreaterThanOrEqual(4);

    const expectedPrefix: Record<string, string> = {
      codd: 'CODD',
      'create-clis': 'CREATE_CLIS',
      fan: 'FAN',
      sweep: 'SWEEP',
      wake: 'WAKE',
    };

    for (const target of cliPackages) {
      const binName = target.bins[0]?.name;
      expect(binName).toBeTruthy();
      const prefix = expectedPrefix[binName!];
      expect(prefix).toBeTruthy();

      const shPath = join(ROOT, target.pkg.dir, 'install.sh');
      const ps1Path = join(ROOT, target.pkg.dir, 'install.ps1');
      expect(existsSync(shPath), `缺少 ${target.pkg.dir}/install.sh`).toBe(
        true,
      );
      expect(existsSync(ps1Path), `缺少 ${target.pkg.dir}/install.ps1`).toBe(
        true,
      );

      const shText = readFileSync(shPath, 'utf8');
      const ps1Text = readFileSync(ps1Path, 'utf8');
      expect(shText).toContain(`TOOL='${binName}'`);
      expect(shText).toContain(`${prefix}_INSTALLER_URL`);
      expect(shText).not.toMatch(/(?:^|[^A-Z_])CLIS_INSTALLER_URL/);
      expect(shText).toContain('--installer-url');
      expect(shText).not.toContain('gh-proxy.com');
      expect(shText).not.toContain('get.2sb.org');
      expect(ps1Text).toContain(`$Tool = '${binName}'`);
      expect(ps1Text).toContain(`${prefix}_INSTALLER_URL`);
      expect(ps1Text).not.toMatch(/(?:^|[^A-Z_])CLIS_INSTALLER_URL/);
      expect(ps1Text).toContain('-InstallerUrl');
      expect(ps1Text).not.toContain('gh-proxy.com');
      expect(ps1Text).not.toContain('get.2sb.org');

      if (process.platform !== 'win32') {
        const res = spawnSync('sh', ['-n', shPath], {
          encoding: 'utf8',
          timeout: 10_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        });
        expect(res.status).toBe(0);
      }
    }

    const rootSh = readFileSync(join(ROOT, 'install.sh'), 'utf8');
    const rootPs1Raw = readFileSync(join(ROOT, 'install.ps1'));
    expect(rootSh).toContain('CLIS_BUN_ISOLATED=1');
    expect(rootSh).toContain('--installer-url');
    expect(rootSh).toContain('--bun-url');
    expect(rootSh).toContain('--registry');
    expect(rootSh).toContain('--from-tarball');
    expect(rootSh).toContain('CODD_INSTALLER_URL');
    expect(rootSh).toContain('FAN_INSTALLER_URL');
    expect(rootSh).toContain('WAKE_INSTALLER_URL');
    expect(rootSh).toContain('SWEEP_INSTALLER_URL');
    expect(rootSh).toContain('CREATE_CLIS_INSTALLER_URL');
    expect(rootSh).not.toContain('gh-proxy.com');
    expect(rootSh).not.toContain('get.2sb.org');
    expect(rootSh).not.toContain('registry.npmmirror.com');
    const rootPs1 = rootPs1Raw.toString('utf8').replace(/^\uFEFF/, '');
    expect(rootPs1).toContain('Write-Utf8NoBom');
    expect(rootPs1).toContain('Tls12');
    expect(rootPs1).toContain('-InstallerUrl');
    expect(rootPs1).toContain('-BunUrl');
    expect(rootPs1).toContain('-Registry');
    expect(rootPs1).toContain('-FromTarball');
    expect(rootPs1).not.toContain('gh-proxy.com');
    expect(rootPs1).not.toContain('get.2sb.org');
    expect(rootPs1).not.toContain('registry.npmmirror.com');
    expect(rootPs1).toContain('CLIS_BUN_ISOLATED=1');
  });

  if (process.platform === 'win32') {
    test('Windows PowerShell AST 语法解析与 fan 平台拒绝自检', () => {
      const psExe = 'powershell.exe';
      const parseCmd =
        "$e=$null;[void][System.Management.Automation.Language.Parser]::ParseFile('install.ps1',[ref]$null,[ref]$e);if($e.Count -gt 0){$e|Out-String;exit 1}";
      const parsed = spawnSync(
        psExe,
        ['-NoProfile', '-NonInteractive', '-Command', parseCmd],
        {
          cwd: ROOT,
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(parsed.status).toBe(0);

      const fanRes = spawnSync(
        psExe,
        [
          '-NoProfile',
          '-NonInteractive',
          '-File',
          join(ROOT, 'install.ps1'),
          '-Tool',
          'fan',
        ],
        {
          encoding: 'utf8',
          timeout: 30_000,
          stdio: ['ignore', 'pipe', 'pipe'],
        },
      );
      expect(fanRes.status).toBe(1);
      expect(fanRes.stderr).toContain('仅支持 macOS');
    });
  }
});

if (process.platform !== 'win32') {
  describe('POSIX install.sh 运行时自适应与校验防线', () => {
    const mock = createMockInstallerServer(ROOT);
    afterAll(() => {
      mock.stop();
    });

    test('无 Bun 且仅有旧 Node (v18) 时下载 SHA-256 校验后的隔离私有 Bun 并自洽运行', async () => {
      const base = mock.url();
      mock.resetBunFetchHits();
      mock.setCorruptBunSha(false);
      const root = allocTmp('clis-e2e-priv-');
      const home = join(root, 'home');
      const dataDir = join(root, 'data');
      const binDir = join(root, 'bin');
      const hermeticBin = buildHermeticPosixBin(root, { oldNodeMajor: 18 });
      mkdirSync(home, { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });

      const installRes = await runAsync(
        'sh',
        [join(ROOT, 'packages/codd-cli/install.sh'), '--no-path'],
        {
          timeoutMs: 30_000,
          env: {
            HOME: home,
            TMPDIR: join(root, 'tmp'),
            PATH: hermeticBin,
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: binDir,
            CLIS_BUN_URL: `${base}/bun-rel`,
            NPM_CONFIG_REGISTRY: `${base}/reg`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      if (installRes.status !== 0) {
        throw new Error(
          `stderr: ${installRes.stderr}\nstdout: ${installRes.stdout}`,
        );
      }
      expect(installRes.stdout).toContain('低于最低要求');
      expect(mock.getBunFetchHits()).toBeGreaterThanOrEqual(2);
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(true);
      expect(
        existsSync(join(dataDir, 'apps', 'codd', '.clis-install.json')),
      ).toBe(true);

      const runRes = await runAsync(join(binDir, 'codd'), ['--version'], {
        timeoutMs: 20_000,
        env: { HOME: home, PATH: hermeticBin },
      });
      expect(runRes.status).toBe(0);
      expect(runRes.stdout.trim()).toBe('1.4.1 (isolated=1)');
    });

    test('私有 Bun 下载包 SHA-256 被篡改时立即拒绝安装', async () => {
      const base = mock.url();
      mock.setCorruptBunSha(true);
      const root = allocTmp('clis-e2e-badsha-');
      mkdirSync(join(root, 'home'), { recursive: true });
      mkdirSync(join(root, 'tmp'), { recursive: true });

      const res = await runAsync(
        'sh',
        [join(ROOT, 'install.sh'), '--tool', 'codd', '--no-path'],
        {
          timeoutMs: 20_000,
          env: {
            HOME: join(root, 'home'),
            TMPDIR: join(root, 'tmp'),
            PATH: buildHermeticPosixBin(root),
            CLIS_INSTALL_HOME: join(root, 'data'),
            CLIS_BIN_DIR: join(root, 'bin'),
            CLIS_BUN_URL: `${base}/bun-rel`,
            NPM_CONFIG_REGISTRY: `${base}/reg`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      mock.setCorruptBunSha(false);
      expect(res.status).not.toBe(0);
      expect(res.stderr).toContain('SHA-256');
    });

    test('检测到系统 Bun 或 Node (>= 22.18) 时跳过私有 Bun 下载', async () => {
      const base = mock.url();
      mock.resetBunFetchHits();
      const root = allocTmp('clis-e2e-sysrt-');
      const home = join(root, 'home');
      mkdirSync(home, { recursive: true });
      const bunBinPath = buildHermeticPosixBin(root, { includeRealBun: true });
      const dataDir = join(root, 'data');

      const resBun = await runAsync(
        'sh',
        [join(ROOT, 'install.sh'), '--tool', 'codd', '--no-path'],
        {
          timeoutMs: 30_000,
          env: {
            HOME: home,
            PATH: bunBinPath,
            CLIS_INSTALL_HOME: dataDir,
            CLIS_BIN_DIR: join(root, 'bin'),
            CLIS_BUN_URL: `${base}/bun-rel`,
            NPM_CONFIG_REGISTRY: `${base}/reg`,
            CLIS_NON_INTERACTIVE: '1',
          },
        },
      );
      expect(resBun.status).toBe(0);
      expect(mock.getBunFetchHits()).toBe(0);
      expect(existsSync(join(dataDir, 'runtime', 'bun'))).toBe(false);

      const hostNode = resolveHostNode22Plus();
      if (hostNode !== undefined) {
        const rootNode = allocTmp('clis-e2e-node-');
        mkdirSync(join(rootNode, 'home'), { recursive: true });
        const nodeOnlyBin = buildHermeticPosixBin(rootNode, {
          includeRealNode: hostNode,
        });
        const nodeBinDir = join(rootNode, 'bin');
        const resNode = await runAsync(
          'sh',
          [join(ROOT, 'install.sh'), '--tool', 'codd', '--no-path'],
          {
            timeoutMs: 30_000,
            env: {
              HOME: join(rootNode, 'home'),
              PATH: nodeOnlyBin,
              CLIS_INSTALL_HOME: join(rootNode, 'data'),
              CLIS_BIN_DIR: nodeBinDir,
              CLIS_BUN_URL: `${base}/bun-rel`,
              NPM_CONFIG_REGISTRY: `${base}/reg`,
              CLIS_NON_INTERACTIVE: '1',
            },
          },
        );
        expect(resNode.status).toBe(0);
        expect(mock.getBunFetchHits()).toBe(0);
        const runNode = await runAsync(
          join(nodeBinDir, 'codd'),
          ['--version'],
          {
            timeoutMs: 20_000,
            env: { HOME: join(rootNode, 'home'), PATH: nodeOnlyBin },
          },
        );
        expect(runNode.status).toBe(0);
        expect(runNode.stdout.trim()).toBe('1.4.1 (isolated=0)');
      }
    });
  });
}
