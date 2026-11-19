/**
 * codd-cli 适配层 (release-artifact.ts) 专有面钉住:
 * 固定项 + 资产清单动态合并、隐藏不可发名拦截、注入式 pack 解析与真实 npm pack 对齐回归。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ASSET_DIR,
  ASSET_MANIFEST_FILE,
  ASSET_TEMPLATE_DIR,
  CLI_FILE,
  PACKAGE_ROOT,
  judgePackFiles,
  parsePackFiles,
  readPackExpectation,
  readPackFiles,
} from './release-artifact.ts';
import {
  STAGED_EXPECTED_PACK,
  makeTempDir,
  stageTemplateAssets,
} from './release.fixtures.ts';

describe('发行面白名单 · 动态合并 (固定项 + 资产清单)', () => {
  test('资产清单展开为 assets/template/ 前缀的路径, 固定项原样列前', async () => {
    const temp = await makeTempDir('codd-cli-whitelist-');
    try {
      await stageTemplateAssets(temp.root, {
        'helm/Chart.yaml': 'name: mongo-replica\n',
        'podman/env.tmpl': 'PORT={{PORT}}\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.issue).toBeNull();
      expect(expectation.files).toEqual([
        ...STAGED_EXPECTED_PACK,
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/podman/env.tmpl`,
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  test('资产含隐藏不可发名 (.gitignore / .dockerignore / .env.tmpl) → 拒绝', async () => {
    const temp = await makeTempDir('codd-cli-unshippable-');
    try {
      await stageTemplateAssets(temp.root, {
        'helm/Chart.yaml': 'name: mongo\n',
        'podman/.dockerignore': 'node_modules\n',
        'podman/.env.tmpl': 'PORT=27117\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.files).toBeNull();
      expect(expectation.issue).toContain('.dockerignore');
      expect(expectation.issue).toContain('.env.tmpl');
      expect(expectation.issue).toContain('载体名');
    } finally {
      await temp.cleanup();
    }
  });

  test('载体名形态的资产照常进入白名单', async () => {
    const temp = await makeTempDir('codd-cli-carrier-');
    try {
      await stageTemplateAssets(temp.root, {
        'helm/Chart.yaml': 'name: mongo\n',
        'podman/_dockerignore': 'node_modules\n',
        'podman/env.tmpl': 'PORT=27117\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.issue).toBeNull();
      expect(expectation.files).toContain(
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/podman/_dockerignore`,
      );
      expect(expectation.files).toContain(
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/podman/env.tmpl`,
      );
    } finally {
      await temp.cleanup();
    }
  });

  test('资产清单缺失 / 损坏 / 形状不符 → issue', async () => {
    const temp = await makeTempDir('codd-cli-broken-');
    try {
      expect(readPackExpectation(temp.root).files).toBeNull();

      const manifestPath = join(temp.root, ASSET_DIR, ASSET_MANIFEST_FILE);
      await mkdir(join(temp.root, ASSET_DIR), { recursive: true });
      await writeFile(manifestPath, 'not json');
      expect(readPackExpectation(temp.root).issue).toContain('不是合法 JSON');

      await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 2, files: ['a'] }),
      );
      expect(readPackExpectation(temp.root).issue).toContain('schemaVersion');

      await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 1, files: [] }),
      );
      expect(readPackExpectation(temp.root).issue).toContain('files 字段');
    } finally {
      await temp.cleanup();
    }
  });
});

describe('发行面白名单 · 注入式 (喂假 pack 输出)', () => {
  test('解析 npm pack --json 输出并校验集合相等与控制字符降噪', () => {
    const raw = JSON.stringify([
      {
        filename: 'iyowei-codd-cli-1.0.0.tgz',
        files: [
          { path: 'README.md', size: 100 },
          { path: `dist/${CLI_FILE}`, size: 50000 },
        ],
      },
    ]);
    expect(parsePackFiles(raw)).toEqual(['README.md', `dist/${CLI_FILE}`]);
    expect(parsePackFiles('bad')).toBeNull();
    expect(parsePackFiles('[]')).toBeNull();

    expect(
      judgePackFiles([...STAGED_EXPECTED_PACK].reverse(), STAGED_EXPECTED_PACK)
        .ok,
    ).toBe(true);

    const verdict = judgePackFiles(
      [...STAGED_EXPECTED_PACK, 'bad\u001b[31m.txt'],
      STAGED_EXPECTED_PACK,
    );
    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('bad?[31m.txt');
  });
});

const hasDist = existsSync(join(PACKAGE_ROOT, 'dist', CLI_FILE));
const hasAssets = existsSync(
  join(PACKAGE_ROOT, ASSET_DIR, ASSET_MANIFEST_FILE),
);
const skipPackTest = process.env.CI_SKIP_PACK_TEST === '1';

if (!hasDist || !hasAssets) {
  console.warn(
    '[Skip] 工作树缺构建产物 (先 bun run build); 本用例守护发行面杂质与资产漂移回归',
  );
} else if (skipPackTest) {
  console.warn(
    '[Skip] 已设置 CI_SKIP_PACK_TEST=1, 跳过重复的真机 npm pack 对齐 (已在 Linux CI 与 prepublishOnly 覆盖)',
  );
}

describe('发行面白名单 · 真实 npm 对齐 (本仓库实测)', () => {
  test.skipIf(!hasDist || !hasAssets || skipPackTest)(
    '本包工作树的 pack 清单与白名单逐项一致 (真机 readPackFiles 回归)',
    () => {
      const facts = readPackFiles(PACKAGE_ROOT);
      const expectation = readPackExpectation(PACKAGE_ROOT);
      const expected = expectation.files ?? [];

      expect(facts.issue).toBeNull();
      expect(expectation.issue).toBeNull();
      const verdict = judgePackFiles(facts.files ?? [], expected);
      expect(verdict.ok ? '' : verdict.reason).toBe('');
    },
    30_000,
  );
});
