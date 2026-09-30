/**
 * 生成器侧适配层 (release-artifact.ts) 的专有面钉住: 发行面包白名单是「固定项 + 资产清单」的
 * 动态合并 (读 assets/manifest.json 展开 assets/template/ 路径), 资产清单缺失 / 损坏即白名单
 * 无从建立; 以及 npm 面包机制硬性剔除项 (平台事实) 的如实扣除。
 * 判定链本身 (检出可信 / 产物就位 / 清单对账 / 面包白名单) 的行为钉在 verify-release.test.ts
 * 的端到端与字段级用例; 本文件只管适配层自己的读入与合并口径, 含一次真实 npm 对齐。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync } from 'node:fs';
import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  ASSET_DIR,
  ASSET_MANIFEST_FILE,
  ASSET_TEMPLATE_DIR,
  NPM_UNSHIPPABLE_BASENAMES,
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
    const temp = await makeTempDir('create-clis-whitelist-');
    try {
      await stageTemplateAssets(temp.root, {
        'README.md': '模板\n',
        'docs/README.md': '文档\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.issue).toBeNull();
      expect(expectation.files).toEqual([
        ...STAGED_EXPECTED_PACK,
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/docs/README.md`,
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  test('资产以 npm 不可发名 (真实名) 随包 → 拒绝 (白名单无从建立, 处置指向载体约定)', async () => {
    const temp = await makeTempDir('create-clis-whitelist-unshippable-');
    try {
      expect(NPM_UNSHIPPABLE_BASENAMES).toEqual(['.gitignore', '.npmrc']);
      await stageTemplateAssets(temp.root, {
        'README.md': '模板\n',
        '.gitignore': 'node_modules/\n',
        '.npmrc': 'package-lock=false\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.files).toBeNull();
      expect(expectation.issue).toContain('.gitignore, .npmrc');
      expect(expectation.issue).toContain('载体名');
    } finally {
      await temp.cleanup();
    }
  });

  test('载体名形态的资产照常进入白名单 (构建期改名的包内形态)', async () => {
    const temp = await makeTempDir('create-clis-whitelist-carrier-');
    try {
      await stageTemplateAssets(temp.root, {
        'README.md': '模板\n',
        _gitignore: 'node_modules/\n',
        _npmrc: 'package-lock=false\n',
      });

      const expectation = readPackExpectation(temp.root);

      expect(expectation.issue).toBeNull();
      expect(expectation.files).toEqual([
        ...STAGED_EXPECTED_PACK,
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/_gitignore`,
        `${ASSET_DIR}/${ASSET_TEMPLATE_DIR}/_npmrc`,
      ]);
    } finally {
      await temp.cleanup();
    }
  });

  test('资产清单缺失 / 损坏 / 形状不符 → issue (不猜结构, 交判定层拒绝)', async () => {
    const temp = await makeTempDir('create-clis-whitelist-broken-');
    try {
      expect(readPackExpectation(temp.root).files).toBeNull();

      const manifestPath = join(temp.root, ASSET_DIR, ASSET_MANIFEST_FILE);
      await mkdir(join(temp.root, ASSET_DIR), { recursive: true });
      await writeFile(manifestPath, 'not json at all');
      expect(readPackExpectation(temp.root).issue).toContain('不是合法 JSON');

      await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 2, files: [] }),
      );
      expect(readPackExpectation(temp.root).issue).toContain('schemaVersion');

      await writeFile(
        manifestPath,
        JSON.stringify({ schemaVersion: 1, files: [1] }),
      );
      expect(readPackExpectation(temp.root).issue).toContain('files 字段');
    } finally {
      await temp.cleanup();
    }
  });
});

describe('发行面白名单 · 注入式 (喂假 pack 输出, 一次 npm 都不跑)', () => {
  test('解析 npm pack --json 的输出: 取首个元素的 files[].path', () => {
    const raw = JSON.stringify([
      {
        filename: 'create-clis-0.0.0.tgz',
        files: [
          { path: 'README.md', size: 706 },
          { path: 'dist/create-clis.js', size: 51965 },
        ],
      },
    ]);

    expect(parsePackFiles(raw)).toEqual(['README.md', 'dist/create-clis.js']);
  });

  test('输出非 JSON / 结构不符 → null (不猜结构, 交由采集层落 issue)', () => {
    expect(parsePackFiles('not json at all')).toBeNull();
    expect(parsePackFiles('{"files":[]}')).toBeNull();
    expect(parsePackFiles('[]')).toBeNull();
    expect(parsePackFiles('[{"files":[{"nopath":1}]}]')).toBeNull();
    expect(parsePackFiles('[{"files":[{"path":""}]}]')).toBeNull();
  });

  test('集合相等 → 通过 (与顺序无关)', () => {
    expect(
      judgePackFiles([...STAGED_EXPECTED_PACK].reverse(), STAGED_EXPECTED_PACK)
        .ok,
    ).toBe(true);
  });

  test('差异路径剔控制字符 (路径来自 npm 输出, 属低信任输入)', () => {
    const verdict = judgePackFiles(
      [...STAGED_EXPECTED_PACK, 'bad\u001b[31m.txt'],
      STAGED_EXPECTED_PACK,
    );

    expect(verdict.ok).toBe(false);
    if (!verdict.ok) expect(verdict.reason).toContain('bad?[31m.txt');
  });
});

/**
 * 真实 npm 对齐的注册门控: 工作树无 dist/ 或资产清单 = 未构建的合法态 (safe-install 清产物后
 * 尚未重构建即如此), 此时 pack 清单必然缺产物与资产, 属「还没构建」而非「发行面杂质回归」。
 * 注册期判定 skip 并播报原因; 两者在场则全程维持原有全清单断言, 不削弱真问题抓取力。
 */
const hasDist = existsSync(join(PACKAGE_ROOT, 'dist'));
const hasAssets = existsSync(
  join(PACKAGE_ROOT, ASSET_DIR, ASSET_MANIFEST_FILE),
);

if (!hasDist || !hasAssets) {
  console.warn(
    '[Skip] 工作树缺构建产物 (先 bun run build); 本用例守护发行面杂质与资产漂移回归',
  );
}

describe('发行面白名单 · 真实 npm 对齐 (本仓库实测)', () => {
  test.skipIf(!hasDist || !hasAssets)(
    '本仓库工作树的 pack 清单与白名单逐项一致 (包根杂质 / 资产漂移的常驻回归)',
    () => {
      const facts = readPackFiles(PACKAGE_ROOT);
      const expectation = readPackExpectation(PACKAGE_ROOT);
      const expected = expectation.files ?? [];

      // 采不到即失败并显示 issue (如「需要 npm」), 不静默跳过: 该项是发行面唯一的真实对齐证据
      expect(facts.issue).toBeNull();
      expect(expectation.issue).toBeNull();
      const verdict = judgePackFiles(facts.files ?? [], expected);
      // 断言携带 reason 而非裸 false: 失败时测试输出直接给出差异清单, 一眼看清是多出还是缺少
      expect(verdict.ok ? '' : verdict.reason).toBe('');
    },
  );
});
