/**
 * 转写契约套件 · 报告与失败诊断单层。
 *
 * 职责:
 * 1. 定义用例报告数据结构 (FailureItem / CaseReport / RunSummaryMeta) 与人读 / JSON 渲染;
 *    报告字段与 JSON 形状是对外契约面 (转写方按它对照缺口), 只增不改。
 * 2. 提供全量核验水印 (`totalCorpus` / `selected` / `skipped` / `fullRunVerified`), 杜绝拿 `--filter`
 *    子集运行冒充全绿交付;
 * 3. 提供 `--emit-failures <dir>` 自包含诊断单导出: 按失败用例拆分 Markdown 文件, 自动从
 *    `behavior-contract.md` 抽取关联 `specRefs` 条款原文、断言差异、原始输出与语料 JSON,
 *    供修复者逐条定责闭环。
 */
import {
  existsSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

export interface FailureItem {
  /**
   * 断言类别 (枚举, 由 compare.ts 产出; 新增断言原语时须同步本行):
   * 两面共用: timeout | spawn | fs;
   * cli 面: exitCode | stdoutExact | stdoutContains | stderrContains
   * | stdoutMustNotContain | stderrMustNotContain;
   * api 面: harness | result | error | events
   */
  kind: string;
  /** 单行摘要 (面向人读) */
  message: string;
  /** 失败时的期望 / 实际值 (覆盖 exitCode / stdoutExact / result.exact / error.code / events.lastIs), 供 diff 工具消费 */
  expected?: string;
  actual?: string;
}

export interface CaseReport {
  id: string;
  specRefs: string[];
  status: 'pass' | 'fail';
  durationMs: number;
  failures: FailureItem[];
  /** 失败时的 stdout / stderr 原文 (诊断附件; 通过时为 undefined, 避免报告膨胀) */
  diagnostics?: { stdout: string; stderr: string };
}

/** 单次验收运行的全量核验元数据 (用于人读水印与 JSON 报告只增扩展字段) */
export interface RunSummaryMeta {
  /** 语料全集总条数 */
  totalCorpus: number;
  /** 本次筛选后实际执行的条数 */
  selected: number;
  /** 因 --filter 跳过的条数 (= totalCorpus - selected) */
  skipped: number;
  /** 使用 --filter 时的筛选子串 */
  filter?: string;
  /** 是否满足全集零跳过且零失败的全量核验标准 */
  fullRunVerified: boolean;
  /** 使用 --emit-failures 且有失败时, 诊断单落盘目录 */
  emittedFailuresDir?: string;
}

/** 补全缺省元数据 (保持旧调用签名向后兼容) */
function resolveMeta(
  reports: readonly CaseReport[],
  meta?: Partial<RunSummaryMeta>,
): RunSummaryMeta {
  const failed = reports.filter((report) => report.status === 'fail').length;
  const selected = meta?.selected ?? reports.length;
  const totalCorpus = meta?.totalCorpus ?? selected;
  const skipped = meta?.skipped ?? Math.max(0, totalCorpus - selected);
  const filter = meta?.filter;
  const filtered = skipped > 0 || filter !== undefined;
  return {
    totalCorpus,
    selected,
    skipped,
    ...(filter !== undefined ? { filter } : {}),
    fullRunVerified: meta?.fullRunVerified ?? (!filtered && failed === 0),
    ...(meta?.emittedFailuresDir !== undefined
      ? { emittedFailuresDir: meta.emittedFailuresDir }
      : {}),
  };
}

/** 行内容裁剪 (失败摘要保持单行可读) */
export const clip = (text: string, max = 120): string =>
  text.length <= max ? text : `${text.slice(0, max)}…`;

/** 以人读清单形式输出逐条验收结果与全量核验水印 (含失败项摘要与 stderr 片段) */
export function printHumanReport(
  corpusDir: string,
  target: string,
  reports: CaseReport[],
  meta?: Partial<RunSummaryMeta>,
): void {
  const resolved = resolveMeta(reports, meta);
  const lines: string[] = [];
  lines.push(`转写一致性验收 (target: "${target}" · 语料: ${corpusDir})`);
  lines.push('');
  for (const report of reports) {
    const mark = report.status === 'pass' ? '✓' : '✗';
    lines.push(
      `  ${mark} ${report.id}  [${report.specRefs.join(', ')}] ${report.durationMs}ms`,
    );
    for (const failure of report.failures) {
      lines.push(`      ${failure.message}`);
    }
    if (
      report.diagnostics !== undefined &&
      report.diagnostics.stderr.trim() !== ''
    ) {
      lines.push(
        `      [stderr] ${clip(report.diagnostics.stderr.trim(), 300)}`,
      );
    }
  }
  const failed = reports.filter((report) => report.status === 'fail').length;
  const passed = reports.length - failed;
  lines.push('');
  lines.push(
    `合计 ${reports.length} 条 (全集 ${resolved.totalCorpus} · 实跑 ${resolved.selected} · 跳过 ${resolved.skipped}): ${passed} 通过, ${failed} 失败`,
  );
  if (resolved.skipped > 0 || resolved.filter !== undefined) {
    lines.push(
      `[非全量运行] 使用了 --filter "${resolved.filter ?? ''}" (跳过 ${resolved.skipped} 条), 不可作为全绿交付依据`,
    );
  } else if (resolved.fullRunVerified) {
    lines.push(
      `[全量核验通过] 全集 ${resolved.totalCorpus}/${resolved.totalCorpus} 零跳过且全部通过`,
    );
  }
  if (resolved.emittedFailuresDir !== undefined && failed > 0) {
    lines.push(
      `[失败诊断单] 已导出 ${failed} 份自包含诊断单至: ${resolved.emittedFailuresDir}`,
    );
  }
  process.stdout.write(`${lines.join('\n')}\n`);
}

/** 以结构化 JSON 输出完整验收报告 (stdout 仅 JSON, 供机器消费; 在既有字段上只增不改) */
export function printJsonReport(
  corpusDir: string,
  target: string,
  reports: CaseReport[],
  meta?: Partial<RunSummaryMeta>,
): void {
  const resolved = resolveMeta(reports, meta);
  const failed = reports.filter((report) => report.status === 'fail').length;
  const payload = {
    target,
    corpusDir,
    total: reports.length,
    passed: reports.length - failed,
    failed,
    totalCorpus: resolved.totalCorpus,
    selected: resolved.selected,
    skipped: resolved.skipped,
    filtered: resolved.skipped > 0 || resolved.filter !== undefined,
    fullRunVerified: resolved.fullRunVerified,
    ...(resolved.filter !== undefined ? { filter: resolved.filter } : {}),
    ...(resolved.emittedFailuresDir !== undefined && failed > 0
      ? { emittedFailuresDir: resolved.emittedFailuresDir }
      : {}),
    cases: reports,
  };
  process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
}

// ---------------------------------------------------------------------------
// 自包含失败诊断单导出 (--emit-failures)
// ---------------------------------------------------------------------------

/** 切分 Markdown 表格单行单元格 (兼容内容中转义的 `\|`) */
function splitMarkdownRow(line: string): string[] {
  const trimmed = line.trim();
  const body = trimmed.replace(/^\|/, '').replace(/\|$/, '');
  const cells: string[] = [];
  let current = '';
  for (let index = 0; index < body.length; index += 1) {
    const ch = body[index]!;
    if (ch === '\\' && body[index + 1] === '|') {
      current += '|';
      index += 1;
      continue;
    }
    if (ch === '|') {
      cells.push(current.trim());
      current = '';
      continue;
    }
    current += ch;
  }
  cells.push(current.trim());
  return cells;
}

/**
 * 从行为契约 Markdown 表格中抽取目标 `specRefs` 对应的条款原文与权威出处。
 *
 * ### 数据流转示例
 * ```text
 * Input:  contractText = "| BC-18 | 无配置非 TTY 报错退 1 | 契约 §2 | CLI 黑盒 |"
 *         specRefs = ['BC-18', 'OF-14']
 * Step 1: 逐行匹配以 `| <编号> |` 开头的表格行, 切分单元格
 * Step 2: 仅收集命中 specRefs 的条款正文与权威出处
 * Output: Map { 'BC-18' => '无配置非 TTY 报错退 1 (出处: 契约 §2)' }
 * ```
 */
export function extractSpecClauses(
  contractText: string,
  specRefs: readonly string[],
): Map<string, string> {
  const wanted = new Set(specRefs);
  const found = new Map<string, string>();
  if (wanted.size === 0) return found;

  for (const line of contractText.split('\n')) {
    if (!line.trimStart().startsWith('|')) continue;
    const cells = splitMarkdownRow(line);
    if (cells.length < 2) continue;
    const code = cells[0]!.replace(/^`|`$/g, '').trim();
    if (!wanted.has(code)) continue;
    const body = cells[1]!;
    const source = cells[2];
    found.set(
      code,
      source !== undefined && source !== ''
        ? `${body} (出处: ${source})`
        : body,
    );
  }
  return found;
}

/** 渲染单条失败用例的自包含 Markdown 诊断单 */
export function renderFailureDiagnostic(
  report: CaseReport,
  caseSpec: unknown,
  clauses: ReadonlyMap<string, string>,
  context: { target: string; corpusDir: string },
): string {
  const lines: string[] = [];
  lines.push(`# 失败诊断单: \`${report.id}\``);
  lines.push('');
  lines.push(`- **被测目标**: \`${context.target}\``);
  lines.push(`- **语料目录**: \`${context.corpusDir}\``);
  lines.push(`- **耗时**: ${report.durationMs}ms`);
  lines.push(
    `- **关联条款**: ${report.specRefs.map((ref) => `\`${ref}\``).join(', ')}`,
  );
  lines.push('');
  lines.push('## 1. 关联契约条款原文');
  lines.push('');
  for (const ref of report.specRefs) {
    const clause = clauses.get(ref);
    lines.push(
      `- **${ref}**: ${clause ?? '(未在行为契约表格中定位到条款原文, 请人工核对)'}`,
    );
  }
  lines.push('');
  lines.push('## 2. 失败断言明细');
  lines.push('');
  for (const [index, failure] of report.failures.entries()) {
    lines.push(`### 失败 #${index + 1} (\`${failure.kind}\`)`);
    lines.push('');
    lines.push(failure.message);
    if (failure.expected !== undefined) {
      lines.push('');
      lines.push('期望值:');
      lines.push('```text');
      lines.push(failure.expected);
      lines.push('```');
    }
    if (failure.actual !== undefined) {
      lines.push('');
      lines.push('实际值:');
      lines.push('```text');
      lines.push(failure.actual);
      lines.push('```');
    }
    lines.push('');
  }
  lines.push('## 3. 被测原始输出');
  lines.push('');
  lines.push('### stdout');
  lines.push('```text');
  lines.push(report.diagnostics?.stdout ?? '');
  lines.push('```');
  lines.push('');
  lines.push('### stderr');
  lines.push('```text');
  lines.push(report.diagnostics?.stderr ?? '');
  lines.push('```');
  lines.push('');
  lines.push('## 4. 原始语料定义');
  lines.push('');
  lines.push('```json');
  lines.push(JSON.stringify(caseSpec, null, 2));
  lines.push('```');
  lines.push('');
  return lines.join('\n');
}

/** 清理文件名中的非法字符 (防目录穿越或路径分隔符污染) */
const safeFileStem = (id: string): string =>
  id.replace(/[^A-Za-z0-9._-]/g, '_');

/**
 * 将本次验收中的失败用例逐条导出为自包含 Markdown 诊断单, 并生成 `INDEX.md` 索引。
 * 若全部通过则不写磁盘并返回空数组; 有失败时先清空旧目录避免上一轮残留误导修复。
 */
export function emitFailureDiagnostics(
  outDir: string,
  reports: readonly CaseReport[],
  casesById: ReadonlyMap<string, unknown>,
  options: { target: string; corpusDir: string; contractPath?: string },
): string[] {
  const failedReports = reports.filter((report) => report.status === 'fail');
  if (failedReports.length === 0) return [];

  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });

  const allRefs = [
    ...new Set(failedReports.flatMap((report) => report.specRefs)),
  ];
  const clauses =
    options.contractPath !== undefined && existsSync(options.contractPath)
      ? extractSpecClauses(readFileSync(options.contractPath, 'utf8'), allRefs)
      : new Map<string, string>();

  const written: string[] = [];
  const indexLines: string[] = [
    '# 失败诊断单索引',
    '',
    `- **被测目标**: \`${options.target}\``,
    `- **失败总数**: ${failedReports.length} / ${reports.length}`,
    '',
    '| 用例 ID | 关联条款 | 失败类别 | 诊断单 |',
    '| --- | --- | --- | --- |',
  ];

  for (const report of failedReports) {
    const fileName = `${safeFileStem(report.id)}.md`;
    const filePath = join(outDir, fileName);
    const content = renderFailureDiagnostic(
      report,
      casesById.get(report.id) ?? null,
      clauses,
      { target: options.target, corpusDir: options.corpusDir },
    );
    writeFileSync(filePath, content, 'utf8');
    written.push(filePath);
    const kinds = [...new Set(report.failures.map((f) => f.kind))].join(', ');
    indexLines.push(
      `| \`${report.id}\` | ${report.specRefs.join(', ')} | ${kinds} | [\`${fileName}\`](${fileName}) |`,
    );
  }
  indexLines.push('');
  writeFileSync(join(outDir, 'INDEX.md'), indexLines.join('\n'), 'utf8');
  return written;
}

// ---------------------------------------------------------------------------
// 差分模糊测试报告与失败诊断单
// ---------------------------------------------------------------------------

export interface FuzzFailureItem {
  targetId: string;
  exportName: string;
  caseIndex: number;
  seed: number;
  reason: string;
  args: unknown[];
  reference?: unknown;
  actual?: unknown;
}

export interface FuzzTargetSummary {
  id: string;
  export: string;
  cases: number;
  passed: number;
  failed: number;
  modeUsed: 'batch' | 'single';
  durationMs: number;
}

/** 导出差分模糊测试最小复现诊断单 (`FUZZ_FAILURES.md`) */
export function emitFuzzFailureDiagnostics(
  outDir: string,
  failures: readonly FuzzFailureItem[],
  meta: { targetsPath: string; seed: number },
): void {
  if (failures.length === 0) return;
  rmSync(outDir, { recursive: true, force: true });
  mkdirSync(outDir, { recursive: true });
  const lines = [
    '# 差分模糊测试失败诊断单',
    '',
    `- **清单**: \`${meta.targetsPath}\` · **种子**: \`${meta.seed}\` · **失败条数**: ${failures.length}`,
    '',
  ];
  for (const [idx, item] of failures.slice(0, 50).entries()) {
    lines.push(
      `## #${idx + 1} \`${item.targetId}\` (\`${item.exportName}\`, case #${item.caseIndex})`,
      '',
      `- **失败原因**: ${item.reason}`,
      '- **输入 args**:',
      '```json',
      JSON.stringify(item.args, null, 2),
      '```',
      '- **参考输出**:',
      '```json',
      JSON.stringify(item.reference ?? null, null, 2),
      '```',
    );
    if (item.actual !== undefined) {
      lines.push(
        '- **被测输出**:',
        '```json',
        JSON.stringify(item.actual, null, 2),
        '```',
      );
    }
    lines.push('');
  }
  writeFileSync(join(outDir, 'FUZZ_FAILURES.md'), lines.join('\n'), 'utf8');
}

/** 输出差分模糊测试汇总报告 (人读或 JSON) */
export function printFuzzReport(
  summaries: readonly FuzzTargetSummary[],
  failures: readonly FuzzFailureItem[],
  meta: {
    apiTarget?: string;
    seed: number;
    casesPerTarget: number;
    json: boolean;
  },
): void {
  const totalCases = summaries.reduce((sum, s) => sum + s.cases, 0);
  const totalFailed = summaries.reduce((sum, s) => sum + s.failed, 0);
  if (meta.json) {
    process.stdout.write(
      `${JSON.stringify(
        {
          mode: meta.apiTarget ? 'differential' : 'invariants-only',
          seed: meta.seed,
          casesPerTarget: meta.casesPerTarget,
          totalCases,
          failedCases: totalFailed,
          targets: summaries,
          failures: failures.slice(0, 50),
        },
        null,
        2,
      )}\n`,
    );
    return;
  }
  const label = meta.apiTarget
    ? `双目标差分 (${meta.apiTarget})`
    : '参考实现不变量自检';
  process.stdout.write(
    `差分模糊测试 (${label} · seed=${meta.seed} · 每目标 ${meta.casesPerTarget} 组)\n\n`,
  );
  for (const s of summaries) {
    process.stdout.write(
      `  ${s.failed === 0 ? '✓' : '✗'} ${s.id} (${s.export})  ${s.passed}/${s.cases} 通过 [${s.modeUsed}] ${s.durationMs}ms\n`,
    );
  }
  for (const f of failures.slice(0, 10)) {
    process.stdout.write(
      `      [FAIL] ${f.targetId}#${f.caseIndex}: ${f.reason}\n`,
    );
  }
  process.stdout.write(
    `\n合计 ${totalCases} 组对抗输入: ${totalCases - totalFailed} 通过, ${totalFailed} 失败\n`,
  );
}
