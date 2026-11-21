/**
 * 语料台账深度校验闸门: 行为契约 × 双面语料 (specRefs + 结构校验) × coverage 覆盖表/豁免/替代测试 × mutants.json 多维对账。
 * 触发方: `scripts/ci.ts` (`lint:coverage` 并行只读闸门) 或手动执行 (默认遍历仓内全部带 `docs/protocol/` 的双包产品)。
 *
 * 校验面 (全部硬红灯):
 * 1. 悬空引用: 语料 specRefs 引用了契约主表中不存在的条款;
 * 2. 漏登记: 契约条款既无语料引用、又未在 coverage.md `## 二、` 登记豁免;
 * 3. 悬空豁免: `## 二、` 登记了契约主表中不存在的条款;
 * 4. 覆盖表漂移: `## 一、` 表格的用例数或用例 ID 集合与实有 `corpus/*.json` 不一致;
 * 5. 表面盲区: 契约「可验收」列含 `CLI 黑盒` / `API 黑盒` 且未在 `## 二、` 豁免时, 对应 kind 语料数不得为 0;
 * 6. 替代护栏失踪: `## 二、` 反引号标注的 `*.test.ts` / `*.smoke.ts` 测试文件必须在对应产品或共享包内真实存在;
 * 7. 变异表同步: `## 三、` 变异体 ID 集合须与 `conformance/mutants.json` 一致;
 * 8. 语料结构校验: 逐条过 `validateCase`, 文件名与 id 一致。
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

import { REPO_ROOT } from '../lint-doc-shared.ts';
import { CONTRACT_REL, CORPUS_REL, COVERAGE_REL } from './corpus.ts';
import {
  type ProtocolProduct,
  discoverProtocolProducts,
} from './protocol-discovery.ts';
import {
  CLAUSE_ID_SOURCE,
  SPEC_REF_PATTERN,
  validateCase,
} from './validate.ts';

const CLAUSE_IN_CELL = new RegExp(CLAUSE_ID_SOURCE, 'g');

export interface ContractClauseMeta {
  id: string;
  needsCli: boolean;
  needsApi: boolean;
}

/** 从行为契约主表提取全部条款号及其可验收双面标记 */
export function extractContractClauses(
  text: string,
): Map<string, ContractClauseMeta> {
  const map = new Map<string, ContractClauseMeta>();
  for (const line of text.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    const id = cells[0] ?? '';
    if (!SPEC_REF_PATTERN.test(id)) continue;
    const verifiable = cells[cells.length - 1] ?? '';
    map.set(id, {
      id,
      needsCli: verifiable.includes('CLI 黑盒'),
      needsApi: verifiable.includes('API 黑盒'),
    });
  }
  return map;
}

/** 从行为契约主表提取全部条款号 (兼容既有单测导出) */
export function extractContractNumbers(text: string): Set<string> {
  return new Set(extractContractClauses(text).keys());
}

/** 从 coverage.md `## 一、` 提取每条条款登记的用例数与用例 ID 集合 */
export function extractCoverageTable(
  text: string,
): Map<string, { count: number; cases: string[] }> {
  const map = new Map<string, { count: number; cases: string[] }>();
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith('## 一、');
      continue;
    }
    if (!inSection || !line.trimStart().startsWith('|')) continue;
    const cells = line
      .trim()
      .replace(/^\|/, '')
      .replace(/\|$/, '')
      .split('|')
      .map((c) => c.trim());
    const id = cells[0] ?? '';
    if (!SPEC_REF_PATTERN.test(id) || cells.length < 3) continue;
    const count = Number(cells[1]);
    const cases = (cells[2] ?? '')
      .split(',')
      .map((s) => s.replace(/^`|`$/g, '').trim())
      .filter((s) => s !== '')
      .sort();
    map.set(id, { count, cases });
  }
  return map;
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

/** 从 coverage.md `## 二、` 提取全部反引号引用的替代测试文件名 (`*.test.ts` / `*.smoke.ts`) */
function extractMentionedTestFiles(text: string): string[] {
  const files = new Set<string>();
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith('## 二、');
      continue;
    }
    if (!inSection) continue;
    for (const m of line.matchAll(
      /`([A-Za-z0-9_./-]+\.(?:test|smoke)\.(?:ts|mjs))`/g,
    )) {
      const ref = m[1]!;
      if (!ref.includes('*')) files.add(ref);
    }
  }
  return [...files].sort();
}

/** 从 coverage.md `## 三、` 提取变异表登记的 mutant ID 集合 */
function extractDocumentedMutants(text: string): Set<string> {
  const ids = new Set<string>();
  let inSection = false;
  for (const line of text.split('\n')) {
    if (line.startsWith('## ')) {
      inSection = line.startsWith('## 三、');
      continue;
    }
    if (!inSection || !line.trimStart().startsWith('|')) continue;
    const cell = line.match(/^\|\s*([^|]*?)\s*\|/)?.[1]?.trim() ?? '';
    const m = /^`?([a-z0-9]+(?:-[a-z0-9]+)+)`?(?:\s|\(|$)/.exec(cell);
    if (m !== null) ids.add(m[1]!);
  }
  return ids;
}

/** 读全部语料, 汇总每个条款对应的 CLI / API 用例 ID 清单并校验结构 */
function scanCorpusEntries(corpusDir: string): {
  referenced: Set<string>;
  casesByClause: Map<string, string[]>;
  kindsByClause: Map<string, Set<'cli' | 'api'>>;
  schemaProblems: string[];
} {
  const referenced = new Set<string>();
  const casesByClause = new Map<string, string[]>();
  const kindsByClause = new Map<string, Set<'cli' | 'api'>>();
  const schemaProblems: string[] = [];

  for (const name of readdirSync(corpusDir).sort()) {
    if (!name.endsWith('.json')) continue;
    const parsed = JSON.parse(readFileSync(join(corpusDir, name), 'utf8')) as {
      id?: unknown;
      kind?: unknown;
      specRefs?: unknown;
    };
    if (!Array.isArray(parsed.specRefs)) {
      throw new Error(`${name}: 缺 specRefs 数组`);
    }
    const id =
      typeof parsed.id === 'string' ? parsed.id : name.replace(/\.json$/, '');
    const kind: 'cli' | 'api' = parsed.kind === 'api' ? 'api' : 'cli';
    // 若为真实语料 (具备 fixture 字段) 则校验完整 schema 子集, 保留对轻量单测夹具的兼容
    if ('fixture' in parsed) {
      const probs = validateCase(parsed);
      for (const p of probs) schemaProblems.push(`${name}: ${p}`);
      if (`${id}.json` !== name) {
        schemaProblems.push(`${name}: 文件名与 id "${id}" 不一致`);
      }
    }
    for (const rawRef of parsed.specRefs) {
      const ref = String(rawRef);
      referenced.add(ref);
      const list = casesByClause.get(ref) ?? [];
      list.push(id);
      casesByClause.set(ref, list);
      const kindSet = kindsByClause.get(ref) ?? new Set<'cli' | 'api'>();
      kindSet.add(kind);
      kindsByClause.set(ref, kindSet);
    }
  }
  return { referenced, casesByClause, kindsByClause, schemaProblems };
}

/** 读全部语料, 汇总 specRefs 引用集合 (兼容既有单测导出) */
export function collectCorpusRefs(corpusDir: string): Set<string> {
  return scanCorpusEntries(corpusDir).referenced;
}

export interface CoverageReconciliation {
  dangling: string[];
  unregistered: string[];
  partial: string[];
  danglingExempt?: string[];
  tableMismatches?: string[];
  surfaceGaps?: string[];
  missingTests?: string[];
  mutantMismatches?: string[];
  schemaProblems?: string[];
}

/** 三边对账 (纯函数, 兼容既有单测导出) */
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

/** 递归收集目录下全部文件名 (用于验证豁免区提及的替代测试文件是否存在) */
function collectFileNames(dir: string, out: Set<string>): void {
  if (!existsSync(dir)) return;
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (
      entry.name === 'node_modules' ||
      entry.name === 'dist' ||
      entry.name === 'assets'
    ) {
      continue;
    }
    const full = join(dir, entry.name);
    if (entry.isDirectory()) collectFileNames(full, out);
    else if (entry.isFile()) out.add(entry.name);
  }
}

function validateProductPaths(
  root: string,
  paths: {
    contractRel: string;
    coverageRel: string;
    corpusRel: string;
    mutantsRel?: string;
    searchDirs?: string[];
  },
): CoverageReconciliation {
  const contractText = readFileSync(join(root, paths.contractRel), 'utf8');
  const coverageText = readFileSync(join(root, paths.coverageRel), 'utf8');
  const clauses = extractContractClauses(contractText);
  const contract = new Set(clauses.keys());
  const exempt = extractExemptNumbers(coverageText);
  const scanned = scanCorpusEntries(join(root, paths.corpusRel));
  const base = reconcile(contract, scanned.referenced, exempt);

  const danglingExempt = [...exempt].filter((n) => !contract.has(n)).sort();
  const tableMismatches: string[] = [];
  const docTable = extractCoverageTable(coverageText);
  if (docTable.size > 0) {
    for (const [clause, actualCases] of scanned.casesByClause.entries()) {
      const sortedActual = [...new Set(actualCases)].sort();
      const row = docTable.get(clause);
      if (row === undefined) {
        tableMismatches.push(`${clause}: 第一节覆盖表缺失该条款`);
        continue;
      }
      if (row.count !== sortedActual.length) {
        tableMismatches.push(
          `${clause}: 覆盖表用例数为 ${row.count}, 实有 ${sortedActual.length}`,
        );
      }
      if (row.cases.join(',') !== sortedActual.join(',')) {
        tableMismatches.push(
          `${clause}: 覆盖表用例清单与实有 corpus/*.json 不一致`,
        );
      }
    }
    for (const clause of docTable.keys()) {
      if (!scanned.casesByClause.has(clause)) {
        tableMismatches.push(`${clause}: 覆盖表有登记但无任何语料引用`);
      }
    }
  }

  const surfaceGaps: string[] = [];
  for (const [id, meta] of clauses.entries()) {
    if (exempt.has(id)) continue;
    const kinds = scanned.kindsByClause.get(id) ?? new Set<'cli' | 'api'>();
    if (meta.needsCli && !kinds.has('cli')) {
      surfaceGaps.push(`${id}: 契约标注需 CLI 黑盒, 但无 cli 语料覆盖且未豁免`);
    }
    if (meta.needsApi && !kinds.has('api')) {
      surfaceGaps.push(`${id}: 契约标注需 API 黑盒, 但无 api 语料覆盖且未豁免`);
    }
  }

  const missingTests: string[] = [];
  if (paths.searchDirs !== undefined && paths.searchDirs.length > 0) {
    const existingFiles = new Set<string>();
    for (const dir of paths.searchDirs) collectFileNames(dir, existingFiles);
    for (const ref of extractMentionedTestFiles(coverageText)) {
      const ok = ref.includes('/')
        ? existsSync(join(root, ref))
        : existingFiles.has(ref);
      if (!ok) missingTests.push(ref);
    }
  }

  const mutantMismatches: string[] = [];
  if (
    paths.mutantsRel !== undefined &&
    existsSync(join(root, paths.mutantsRel))
  ) {
    const manifest = JSON.parse(
      readFileSync(join(root, paths.mutantsRel), 'utf8'),
    ) as { mutants?: { id: string }[] };
    const actualMutants = new Set((manifest.mutants ?? []).map((m) => m.id));
    const docMutants = extractDocumentedMutants(coverageText);
    for (const id of actualMutants) {
      if (!docMutants.has(id)) {
        mutantMismatches.push(
          `${id}: 存在于 mutants.json 但 coverage.md 第三节未登记`,
        );
      }
    }
    for (const id of docMutants) {
      if (!actualMutants.has(id)) {
        mutantMismatches.push(
          `${id}: 登记在 coverage.md 第三节但 mutants.json 中不存在`,
        );
      }
    }
  }

  return {
    ...base,
    ...(danglingExempt.length > 0 ? { danglingExempt } : {}),
    ...(tableMismatches.length > 0 ? { tableMismatches } : {}),
    ...(surfaceGaps.length > 0 ? { surfaceGaps } : {}),
    ...(missingTests.length > 0 ? { missingTests } : {}),
    ...(mutantMismatches.length > 0 ? { mutantMismatches } : {}),
    ...(scanned.schemaProblems.length > 0
      ? { schemaProblems: scanned.schemaProblems }
      : {}),
  };
}

/** 在给定仓库根上跑单协议根对账 (保持旧测试签名 100% 兼容) */
export function validateCoverage(
  root: string = REPO_ROOT,
  product?: ProtocolProduct,
): CoverageReconciliation {
  if (product !== undefined) {
    return validateProductPaths(root, {
      contractRel: product.contractRel,
      coverageRel: product.coverageRel,
      corpusRel: product.corpusRel,
      mutantsRel: product.mutantsRel,
      searchDirs: [
        join(root, product.api.dir),
        join(root, product.cli.dir),
        join(root, 'packages'),
      ],
    });
  }
  return validateProductPaths(root, {
    contractRel: CONTRACT_REL,
    coverageRel: COVERAGE_REL,
    corpusRel: CORPUS_REL,
  });
}

function hasFailures(res: CoverageReconciliation): boolean {
  return (
    res.dangling.length > 0 ||
    res.unregistered.length > 0 ||
    (res.danglingExempt?.length ?? 0) > 0 ||
    (res.tableMismatches?.length ?? 0) > 0 ||
    (res.surfaceGaps?.length ?? 0) > 0 ||
    (res.missingTests?.length ?? 0) > 0 ||
    (res.mutantMismatches?.length ?? 0) > 0 ||
    (res.schemaProblems?.length ?? 0) > 0
  );
}

function reportProblems(prefix: string, res: CoverageReconciliation): void {
  const emit = (label: string, items: readonly string[] | undefined): void => {
    if (items === undefined || items.length === 0) return;
    process.stderr.write(`${prefix}${label}:\n`);
    for (const item of items) process.stderr.write(`  ✗ ${item}\n`);
  };
  emit('悬空引用 (语料引用了契约不存在的条款)', res.dangling);
  emit('漏登记 (无引用且未在未覆盖条款区登记)', res.unregistered);
  emit('悬空豁免 (豁免区登记了契约不存在的条款)', res.danglingExempt);
  emit('第一节覆盖表与实有语料不一致', res.tableMismatches);
  emit('双面覆盖盲区 (契约声明 CLI/API 黑盒但缺对应语料)', res.surfaceGaps);
  emit('豁免区引用的替代测试文件不存在', res.missingTests);
  emit('第三节变异表与 mutants.json 不同步', res.mutantMismatches);
  emit('语料结构校验失败', res.schemaProblems);
}

function main(): void {
  let products: ProtocolProduct[];
  try {
    products = discoverProtocolProducts(REPO_ROOT);
  } catch (error) {
    process.stderr.write(
      `协议产品发现失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
    return;
  }
  if (products.length === 0) {
    process.stderr.write('未发现任何带 docs/protocol/ 的双包产品\n');
    process.exitCode = 1;
    return;
  }

  let anyFailed = false;
  for (const product of products) {
    let result: CoverageReconciliation;
    try {
      result = validateCoverage(REPO_ROOT, product);
    } catch (error) {
      process.stderr.write(
        `[${product.id}] 台账读取失败: ${error instanceof Error ? error.message : String(error)}\n`,
      );
      anyFailed = true;
      continue;
    }
    if (hasFailures(result)) {
      reportProblems(`[${product.id}] `, result);
      anyFailed = true;
    } else {
      const partialNote =
        result.partial.length > 0
          ? `; 部分豁免 ${result.partial.join(' / ')}`
          : '';
      process.stdout.write(
        `[${product.id}] 语料台账深度校验全绿 ✓ (契约/语料/覆盖表/双面/豁免测试/变异表全对齐${partialNote})\n`,
      );
    }
  }
  if (anyFailed) process.exitCode = 1;
}

if (import.meta.main) main();
