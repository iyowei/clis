/**
 * @iyowei/codd 构建资产、发布自证闸门与 Bun / Node 双运行时 CLI 集成测试。
 */
import { describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { PACKAGE_ROOT, buildCoddAssets } from './build-assets.ts';
import {
  CLI_FILE,
  type PackFacts,
  judgeRelease,
  readDistState,
  readPackExpectation,
  sha256File,
} from './release-artifact.ts';
import { writeDistManifest } from './write-dist-manifest.ts';

describe('@iyowei/codd 资产构建与发布自证闸门', () => {
  test('buildCoddAssets 将隐藏点文件转为无点载体并生成合法 assets/manifest.json', () => {
    const tmpPkg = mkdtempSync(join(tmpdir(), 'codd-assets-test-'));
    try {
      const podmanDir = join(tmpPkg, 'template/podman');
      const helmDir = join(tmpPkg, 'template/helm');
      mkdirSync(podmanDir, { recursive: true });
      mkdirSync(helmDir, { recursive: true });
      writeFileSync(join(podmanDir, '.dockerignore'), 'node_modules\n');
      writeFileSync(join(podmanDir, '.env.tmpl'), 'PORT={{PORT}}\n');
      writeFileSync(join(helmDir, '.helmignore'), '*.tgz\n');
      writeFileSync(join(helmDir, 'Chart.yaml'), 'name: mongodb\n');

      const emitted = buildCoddAssets(tmpPkg);
      expect(emitted).toEqual([
        'helm/Chart.yaml',
        'helm/_helmignore',
        'podman/_dockerignore',
        'podman/env.tmpl',
      ]);

      const expectation = readPackExpectation(tmpPkg);
      expect(expectation.issue).toBeNull();
      expect(expectation.files).toContain('assets/manifest.json');
      expect(expectation.files).toContain(
        'assets/template/podman/_dockerignore',
      );
      expect(expectation.files).toContain('assets/template/podman/env.tmpl');
      expect(expectation.files).toContain('assets/template/helm/_helmignore');

      mkdirSync(join(tmpPkg, 'dist'), { recursive: true });
      const cliOut = join(tmpPkg, 'dist', CLI_FILE);
      writeFileSync(cliOut, 'console.log("1.0.0");\n');
      const fakeCommit = 'a'.repeat(40);
      writeDistManifest(
        join(tmpPkg, 'dist'),
        { commit: fakeCommit, dirty: false },
        '2026-11-19T00:00:00.000Z',
      );

      const packOk: PackFacts = {
        files: [...(expectation.files ?? [])],
        issue: null,
      };
      const verdict = judgeRelease(
        {
          gitStatus: '',
          gitHead: fakeCommit,
          dist: readDistState(join(tmpPkg, 'dist')),
          pack: packOk,
        },
        expectation,
      );
      expect(verdict).toEqual({
        ok: true,
        commit: fakeCommit,
        sha256: sha256File(cliOut),
      });
    } finally {
      rmSync(tmpPkg, { recursive: true, force: true });
    }
  });

  test('构建产物经 bin/codd.mjs 在 Bun 与 Node 双运行时下均可输出版本并按指定 JSON 生成套件', () => {
    const cliDist = join(PACKAGE_ROOT, 'dist', CLI_FILE);
    if (!existsSync(cliDist)) {
      const buildRes = spawnSync('bun', ['run', 'build'], {
        cwd: PACKAGE_ROOT,
        encoding: 'utf8',
      });
      expect(buildRes.status).toBe(0);
    }

    const binEntry = join(PACKAGE_ROOT, 'bin/codd.mjs');
    for (const runtime of ['bun', 'node']) {
      const verRes = spawnSync(runtime, [binEntry, '--version'], {
        encoding: 'utf8',
      });
      expect(verRes.status).toBe(0);
      expect(verRes.stdout.trim()).toBe('1.0.0');

      const workDir = mkdtempSync(join(tmpdir(), `codd-cli-${runtime}-`));
      try {
        const initRes = spawnSync(runtime, [binEntry, '--init-schema'], {
          cwd: workDir,
          encoding: 'utf8',
        });
        expect(initRes.status).toBe(0);
        expect(existsSync(join(workDir, 'deploy.schema.json'))).toBe(true);
        expect(existsSync(join(workDir, 'deploy-2c2g.json'))).toBe(true);

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
        expect(existsSync(join(workDir, '.codd-state/.gitignore'))).toBe(true);

        // 验证即使调用方当前工作目录存在损坏的 bunfig.toml, 全局 CLI 仍能隔离启动不崩溃
        writeFileSync(
          join(workDir, 'bunfig.toml'),
          '[install.scopes]\nfoo = "bar"\n[install.scopes]\nbaz = "qux"\n',
          'utf8',
        );
        const brokenCwdRes = spawnSync(
          join(PACKAGE_ROOT, 'bin/codd'),
          ['--version'],
          {
            cwd: workDir,
            encoding: 'utf8',
          },
        );
        expect(brokenCwdRes.status).toBe(0);
        expect(brokenCwdRes.stdout.trim()).toBe('1.0.0');
      } finally {
        rmSync(workDir, { recursive: true, force: true });
      }
    }
  });
});
