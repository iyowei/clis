/**
 * sync-assets.ts 同步重建与白名单拷贝回归单测 (CODDCLI-P0-5):
 * 1) 源包存在 scripts/build-assets.ts 且已有过期 assets/manifest.json 时, 仍强制重建刷新模板;
 * 2) 仅按 manifest.json#files 白名单拷贝, 忽略源目录内未登记的杂文件。
 */
import { afterEach, describe, expect, test } from 'bun:test';

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

import { syncCoddCliAssets } from './sync-assets.ts';

const tempDirs: string[] = [];
afterEach(() => {
  for (const dir of tempDirs.splice(0)) {
    rmSync(dir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 50,
    });
  }
});

describe('syncCoddCliAssets 模板刷新与白名单精准拷贝', () => {
  test('存在 scripts/build-assets.ts 时强制重建过期资产, 并剔除未登记杂文件', () => {
    const root = mkdtempSync(join(tmpdir(), 'codd-sync-assets-'));
    tempDirs.push(root);
    const apiRoot = join(root, 'codd');
    const cliRoot = join(root, 'codd-cli');
    mkdirSync(join(apiRoot, 'scripts'), { recursive: true });
    mkdirSync(join(apiRoot, 'assets/template/helm'), { recursive: true });
    mkdirSync(cliRoot, { recursive: true });

    // 预置过期的 assets 与一个未登记在 manifest 的杂文件
    writeFileSync(
      join(apiRoot, 'assets/manifest.json'),
      JSON.stringify({ schemaVersion: 1, files: ['helm/Chart.yaml'] }),
      'utf8',
    );
    writeFileSync(
      join(apiRoot, 'assets/template/helm/Chart.yaml'),
      'version: STALE\n',
      'utf8',
    );
    writeFileSync(
      join(apiRoot, 'assets/template/helm/stray.txt'),
      'should-not-copy\n',
      'utf8',
    );

    // 模拟 scripts/build-assets.ts: 刷新 Chart.yaml 为 FRESH (故意不删 stray.txt 以测白名单过滤)
    writeFileSync(
      join(apiRoot, 'scripts/build-assets.ts'),
      [
        "import { writeFileSync } from 'node:fs';",
        "writeFileSync('assets/template/helm/Chart.yaml', 'version: FRESH\\n', 'utf8');",
        "writeFileSync('assets/manifest.json', JSON.stringify({ schemaVersion: 1, files: ['helm/Chart.yaml'] }), 'utf8');",
      ].join('\n'),
      'utf8',
    );

    const files = syncCoddCliAssets(cliRoot, apiRoot);
    expect(files).toEqual(['helm/Chart.yaml']);
    expect(
      readFileSync(join(cliRoot, 'assets/template/helm/Chart.yaml'), 'utf8'),
    ).toBe('version: FRESH\n');
    expect(existsSync(join(cliRoot, 'assets/template/helm/stray.txt'))).toBe(
      false,
    );
  });
});
