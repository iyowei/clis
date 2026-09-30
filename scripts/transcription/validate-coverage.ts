/**
 * 语料台账校验闸门: 行为契约条款 × 语料 specRefs × coverage 豁免登记的三角对账。
 *
 * 动机: 2026-09-30 复审立案「台账校验靠手跑 jq / comm」; 三边一致性是确定性事实, 不该靠
 * 人记得跑, 故固化为闸门 (套件维护规则「条款变更须同步语料与覆盖表」的物理化)。
 *
 * 校验 (硬红灯两类):
 * - 悬空引用: 任一语料 specRefs 里的条款号在行为契约主表中不存在;
 * - 漏登记: 存在「无任何语料引用」且「未出现在 coverage.md 未覆盖条款区」的条款。
 * 口径: 未覆盖条款区 = coverage.md 中 `## 二、` 标题起至下一个 `## ` 前; 区内行首单元格里
 * 的条款号即为已登记豁免 (含 `BC-21 / BC-22` 一格式多号)。豁免区中「已被语料引用」的条款
 * (部分豁免形态, 如「静态形态已覆盖 / 竞态形态模块级」) 只作 INFO 打印, 不判错。
 *
 * 用法: bun scripts/transcription/validate-coverage.ts
 * 退出码: 0 全绿; 1 存在悬空引用或漏登记。
 */
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lint-doc-shared.ts';

const CONTRACT_MD = 'docs/sweep/protocol/behavior-contract.md';
const COVERAGE_MD = 'docs/sweep/protocol/conformance/coverage.md';
const CORPUS_DIR = 'docs/sweep/protocol/conformance/corpus';

/** 条款号形态 (行首表格单元格): BC-01 / OF-15 / EC-08 */
const CLAUSE_IN_CELL = /(?:BC|OF|EC)-\d+/g;

/** 从行为契约主表提取全部条款号 (行首单元格以条款号开头的表格行) */
export function extractContractNumbers(text: string): Set<string> {
  const numbers = new Set<string>();
  for (const line of text.split('\n')) {
    const cell = line.match(/^\|\s*([^|]*?)\s*\|/)?.[1];
    if (!cell) continue;
    for (const m of cell.matchAll(/^(?:BC|OF|EC)-\d+$/g)) numbers.add(m[0]);
  }
  return numbers;
}

/** 从 coverage.md 的「二、未覆盖条款」段提取豁免登记的条款号集合 */
export function extractExemptNumbers(text: string): Set<string> {
  const numbers = new Set<string>();
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith('## 二、');
      continue;
    }
    if (!inSection) continue;
    const cell = line.match(/^\|\s*([^|]*?)\s*\|/)?.[1];
    if (!cell) continue;
    for (const m of cell.matchAll(CLAUSE_IN_CELL)) numbers.add(m[0]);
  }
  return numbers;
}

/** 读全部语料, 汇总 specRefs 引用集合; 单个文件解析失败即抛 (语料损坏属硬错) */
export function collectCorpusRefs(corpusDir: string): Set<string> {
  const refs = new Set<string>();
  for (const name of readdirSync(corpusDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(corpusDir, name), 'utf8')) as {
      specRefs?: unknown;
    };
    if (!Array.isArray(parsed.specRefs)) {
      throw new Error(`${name}: 缺 specRefs 数组`);
    }
    for (const ref of parsed.specRefs) refs.add(String(ref));
  }
  return refs;
}

/** 三角对账的产物 */
export interface CoverageReconciliation {
  /** 悬空引用: 语料引用了契约里不存在的条款号 */
  dangling: string[];
  /** 漏登记: 无引用且未在豁免区登记的条款号 */
  unregistered: string[];
  /** INFO: 在豁免区但已有语料引用的条款号 (部分豁免形态合法) */
  partial: string[];
}

/** 三边对账 (纯函数, 供测试) */
export function reconcile(
  contract: Set<string>,
  referenced: Set<string>,
  exempt: Set<string>,
): CoverageReconciliation {
  const dangling = [...referenced].filter((n) => !contract.has(n)).sort();
  const unregistered = [...contract]
    .filter((n) => !referenced.has(n) && !exempt.has(n))
    .sort();
  const partial = [...exempt].filter((n) => referenced.has(n)).sort();
  return { dangling, unregistered, partial };
}

/** 在给定仓库根上跑全量对账 (供测试注入临时根) */
export function validateCoverage(
  root: string = REPO_ROOT,
): CoverageReconciliation {
  const contract = extractContractNumbers(
    readFileSync(join(root, CONTRACT_MD), 'utf8'),
  );
  const exempt = extractExemptNumbers(
    readFileSync(join(root, COVERAGE_MD), 'utf8'),
  );
  const referenced = collectCorpusRefs(join(root, CORPUS_DIR));
  return reconcile(contract, referenced, exempt);
}

/** 主流程: 打印对账结果并以退出码收口 (0 全绿 / 1 断裂) */
function main(): void {
  let result: CoverageReconciliation;
  try {
    result = validateCoverage();
  } catch (error) {
    process.stderr.write(
      `台账读取失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  const { dangling, unregistered, partial } = result;
  if (dangling.length > 0) {
    process.stderr.write(
      `悬空引用 (语料引用了契约里不存在的条款): ${dangling.join(' / ')}\n`,
    );
  }
  if (unregistered.length > 0) {
    process.stderr.write(
      `漏登记 (无引用且未在未覆盖条款区登记): ${unregistered.join(' / ')}\n`,
    );
  }
  if (dangling.length === 0 && unregistered.length === 0) {
    process.stdout.write(
      `语料台账校验全绿 ✓ (悬空引用 0 / 漏登记 0${partial.length > 0 ? `; 部分豁免 ${partial.join(' / ')}` : ''})\n`,
    );
    return;
  }
  process.exitCode = 1;
}

// 仅作为入口执行时跑主流程 (被 import 时不执行, 供测试)
if (import.meta.main) main();
