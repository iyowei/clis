/**
 * 骨架清单登记表单测: 形状 / 存在性 / 词汇口径 / 全仓覆盖四道体检。
 *
 * 清单是模板快照机制的唯一点, 判据必须自证:
 * - snapshot 条目不得含原项目词汇 (含了就该走 generalize 替换或 reset);
 * - generalize 条目必须含原项目词汇 (不含即登记口径漂移);
 * - 全仓任何含原项目词汇的文件都必须被清单捕获 (generalize, 或落在 reset / exclude 条目内),
 *   防构建期替换面静默漏文件;
 * - 反向完备: 仓内每个文件都被某条目登记, 新增文件必须先在此分类。
 */
import { describe, expect, test } from 'bun:test';

import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, relative } from 'node:path';

import { REPO_ROOT, TEMPLATE_MANIFEST } from './template-manifest.ts';

/**
 * 原项目可识别词汇 (分类判据口径): 一律为无歧义复合形态 ——
 * 原包名 (含 `-cli` 变体前缀) / 原 scope / 原 bin 名 / 裸仓库 slug / 原 owner
 * (repoUrl 形态由 owner 覆盖) / 作者名形态 (LICENSE 与 package.json author,
 * spec 词汇表 `{{OWNER}}` 行的位置约定)。
 *
 * 收窄边界 (二轮裁定): 裸词 `sweep` / `clis` 不入词面 —— 子串匹配会误伤 `sweepStale`
 * (动词义标识符, 替换后连字符入词成语法错误) 与 `create-clis` (生成器包名, 替换后
 * 指向生成物里不存在的包); 产品义只认 `sweep-node-modules` / `sweep-nm` / `@iyowei` /
 * `iyowei/clis` 这类复合面, 落不进复合面的按条目 note 移交。
 */
const VOCABULARY = [
  'sweep-node-modules',
  '@iyowei',
  'sweep-nm',
  'iyowei/clis',
  'iyowei',
  'iTonyYo',
] as const;

/** 走查跳过目录: 依赖 / 版本控制 / 构建缓存 / 生成物 / 变异副本 / 宿主运行时状态 (口径同 root scripts/lint-doc-shared.ts) */
const SKIP_DIRS = new Set([
  'node_modules',
  '.git',
  '.turbo',
  'dist',
  'mutants',
  '.claude',
]);

/** 环境态垃圾 (仅可能在本机出现, 不入库): 完备性体检跳过, 避免测试依赖机器状态 */
const JUNK_NAMES = new Set(['.DS_Store', 'Thumbs.db']);
const JUNK_SUFFIXES = ['.modified', '.deleted', '~'] as const;

function isJunk(name: string): boolean {
  return (
    JUNK_NAMES.has(name) ||
    JUNK_SUFFIXES.some((suffix) => name.endsWith(suffix))
  );
}

/** 全仓文件走查 (相对路径, 跳过环境态垃圾) */
function walkRepo(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (!isJunk(entry.name)) {
        out.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return out;
}

/** 条目是否覆盖某文件: 精确路径命中, 或目录条目 (以 `/` 收尾) 的前缀命中 */
function covers(entryPath: string, file: string): boolean {
  return entryPath.endsWith('/')
    ? file.startsWith(entryPath)
    : file === entryPath;
}

/** 文件是否落在清单覆盖网内 (被某条目登记或落在目录条目内) */
function isCovered(file: string): boolean {
  return TEMPLATE_MANIFEST.some((entry) => covers(entry.path, file));
}

/** 文件内容是否含原项目词汇 */
function containsVocabulary(file: string): boolean {
  const content = readFileSync(join(REPO_ROOT, file), 'utf8');
  return VOCABULARY.some((term) => content.includes(term));
}

describe('TEMPLATE_MANIFEST 形状', () => {
  test('路径非空 / 相对 / 无首尾空白 / 无重复, 四类处置齐备', () => {
    const paths = TEMPLATE_MANIFEST.map((entry) => entry.path);
    for (const entry of TEMPLATE_MANIFEST) {
      expect(entry.path.length, '路径不得为空').toBeGreaterThan(0);
      expect(entry.path, '路径须无首尾空白').toBe(entry.path.trim());
      expect(entry.path.startsWith('/'), '路径须相对仓库根').toBe(false);
    }
    expect(new Set(paths).size, '路径不得重复').toBe(paths.length);
    const dispositions = new Set(TEMPLATE_MANIFEST.map((e) => e.disposition));
    expect([...dispositions].sort()).toEqual([
      'exclude',
      'generalize',
      'reset',
      'snapshot',
    ]);
  });

  test('reset / exclude 条目必写来源说明 (note), 且注明目录记法', () => {
    for (const entry of TEMPLATE_MANIFEST) {
      if (entry.disposition === 'reset' || entry.disposition === 'exclude') {
        expect(entry.note, `${entry.path} 缺 note`).toBeTruthy();
      }
      if (existsSync(join(REPO_ROOT, entry.path))) {
        const isDir = statSync(join(REPO_ROOT, entry.path)).isDirectory();
        expect(
          entry.path.endsWith('/'),
          `${entry.path} 目录记法不一致 (目录以 / 收尾)`,
        ).toBe(isDir);
      }
    }
  });

  test('snapshot / generalize 条目在仓库根真实存在且为文件', () => {
    for (const entry of TEMPLATE_MANIFEST) {
      if (
        entry.disposition !== 'snapshot' &&
        entry.disposition !== 'generalize'
      )
        continue;
      const abs = join(REPO_ROOT, entry.path);
      expect(existsSync(abs), `${entry.path} 不存在`).toBe(true);
      expect(statSync(abs).isFile(), `${entry.path} 应为文件`).toBe(true);
    }
  });
});

describe('TEMPLATE_MANIFEST 词汇口径', () => {
  test('snapshot 条目不得含原项目词汇', () => {
    const dirty = TEMPLATE_MANIFEST.filter(
      (entry) =>
        entry.disposition === 'snapshot' && containsVocabulary(entry.path),
    ).map((entry) => entry.path);
    expect(dirty, '含词汇的文件应标 generalize (或 reset)').toEqual([]);
  });

  test('generalize 条目必须含原项目词汇', () => {
    const empty = TEMPLATE_MANIFEST.filter(
      (entry) =>
        entry.disposition === 'generalize' && !containsVocabulary(entry.path),
    ).map((entry) => entry.path);
    expect(empty, '不含词汇的文件应标 snapshot').toEqual([]);
  });

  test('词面收窄边界: 子串误伤形态不判词, 复合形态可判证', () => {
    // 裸 clis 误伤 create-clis (生成器包名); 裸 sweep 误伤动词义标识符与英文句子
    for (const falsePositive of [
      'create-clis',
      'sweepStale',
      'to sweep node_modules',
    ]) {
      expect(
        VOCABULARY.some((term) => falsePositive.includes(term)),
        `${falsePositive} 不应命中判词面`,
      ).toBe(false);
    }
    for (const hit of [
      '@iyowei/sweep-node-modules',
      'sweep-node-modules-cli',
      'sweep-nm',
      'iyowei/clis',
      'iTonyYo',
    ]) {
      expect(
        VOCABULARY.some((term) => hit.includes(term)),
        `${hit} 应命中判词面`,
      ).toBe(true);
    }
  });

  test('全仓覆盖: 含原项目词汇的文件都被清单捕获', () => {
    const leaked: string[] = [];
    for (const file of walkRepo(REPO_ROOT)) {
      if (!containsVocabulary(file)) continue;
      const hit = TEMPLATE_MANIFEST.find((entry) => covers(entry.path, file));
      if (hit === undefined) leaked.push(file);
      else if (hit.disposition === 'snapshot')
        leaked.push(`${file} 标了 snapshot`);
    }
    expect(
      leaked,
      '含词汇但未被清单捕获 (generalize / reset / exclude)',
    ).toEqual([]);
  });

  test('清单完备: 仓内每个文件都被某条目登记或落在目录条目内', () => {
    const uncovered = walkRepo(REPO_ROOT).filter((file) => !isCovered(file));
    expect(uncovered, '未登记文件: 新增文件须在清单里分类').toEqual([]);
  });
});
