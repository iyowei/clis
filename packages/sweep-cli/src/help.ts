/**
 * 帮助页文案与单轴线左对齐分层排版渲染 (零外部依赖, 中英双语均严守 80 列行宽与 OF-10 降级恒等式):
 * 红线: 命令面以 `cli-surface.md` 为唯一事实来源; 新增子命令或旗标须与语料 `cli-help` 同批更新 (BC-30)。
 *
 * 排版红线 (全仓所有 CLI 强制遵循):
 * 子命令 / 选项 / 示例 / 配置与安全 / 退出码共五组两栏区必须共享同一个右栏起始列线 (`descCol`),
 * 折行续行同样缩进到 `4 + descCol` 列, 禁止各分组单独设定列宽导致右栏参差不齐。
 */
import {
  type Locale,
  alignHelpRow,
  computeHelpDescColumn,
  displayWidth,
} from '@iyowei/cli-i18n';
import { resolveConfigPath } from '@iyowei/sweep';

import {
  type OptionRow,
  type SweepHelpCatalog,
  buildSweepHelpCatalog,
} from './help-catalog.ts';
import { BAR_BLOCK, paint, sanitizeLine } from './render.ts';

const RULE_WIDTH = 76;
const MAX_LINE_COLS = 80;
const LINE_INDENT = '    ';
const GITHUB_URL =
  'https://github.com/iyowei/clis/tree/main/packages/sweep-cli';

function createStyler(color: boolean) {
  return {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    bold: (s: string) => paint(s, '1', color),
    dim: (s: string) => paint(s, '2', color),
    section: (s: string) => paint(s, '1;34', color),
    token: (s: string) => paint(s, '36', color),
    green: (s: string) => paint(s, '1;32', color),
    red: (s: string) => paint(s, '1;31', color),
  };
}

/** 按空格与词后标点切分可断行单元, 确保闭合括号和选项标志不被孤立折断 */
function splitTokensPreservingSpaces(text: string): string[] {
  const result: string[] = [];
  let cur = '';
  for (const ch of text) {
    if (ch === ' ') {
      if (cur !== '') {
        result.push(cur);
        cur = '';
      }
      result.push(' ');
      continue;
    }
    if ('、,;.)]'.includes(ch)) {
      cur += ch;
      result.push(cur);
      cur = '';
      continue;
    }
    const code = ch.codePointAt(0) ?? 0;
    const isCjk = code >= 0x4e00 && code <= 0x9fff;
    if (isCjk) {
      if (cur !== '') result.push(cur);
      cur = ch;
      continue;
    }
    cur += ch;
  }
  if (cur !== '') result.push(cur);
  return result;
}

/** 将超长段落按显示列宽安全折行 (不切断连续选项或路径令牌) */
function wrapSegment(text: string, maxWidth: number): string[] {
  if (displayWidth(text) <= maxWidth) return [text];
  const tokens = splitTokensPreservingSpaces(text);
  const out: string[] = [];
  let line = '';
  for (const tok of tokens) {
    if (line === '') {
      line = tok.trimStart();
      continue;
    }
    const candidate = `${line}${tok}`;
    if (displayWidth(candidate) <= maxWidth) {
      line = candidate;
    } else {
      out.push(line.trimEnd());
      line = tok.trimStart();
    }
  }
  if (line !== '') out.push(line.trimEnd());
  return out;
}

function formatWrappedBlock(
  styledLeft: string,
  plainLeft: string,
  descLines: readonly string[],
  descCol: number,
  paintDesc: (s: string) => string,
): string[] {
  const first = descLines[0] ?? '';
  const rows = [
    alignHelpRow(styledLeft, plainLeft, paintDesc(first), descCol, LINE_INDENT),
  ];
  const contIndent = ' '.repeat(LINE_INDENT.length + descCol);
  for (let i = 1; i < descLines.length; i += 1) {
    rows.push(`${contIndent}${paintDesc(descLines[i]!)}`);
  }
  return rows;
}

function computeDescColumn(cat: SweepHelpCatalog): number {
  return computeHelpDescColumn(
    [
      ...cat.subcommands.map((r) => r.name),
      ...cat.actionOptions.map((r) =>
        r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
      ),
      ...cat.metaOptions.map((r) =>
        r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
      ),
      ...cat.examples.map((r) =>
        [r.cmd, r.flag, r.arg]
          .filter((p): p is string => p !== undefined)
          .join(' '),
      ),
      ...cat.notes.map((r) => r.label),
      ...cat.exitCodes.map((r) => r.code),
    ],
    2,
  );
}

function renderOptions(
  rows: readonly OptionRow[],
  s: ReturnType<typeof createStyler>,
  descCol: number,
  maxRightCols: number,
): string[] {
  return rows.flatMap((row) => {
    const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
    const styled =
      row.arg === undefined
        ? s.token(row.flag)
        : `${s.token(row.flag)} ${s.dim(row.arg)}`;
    return formatWrappedBlock(
      styled,
      plain,
      wrapSegment(row.desc, maxRightCols),
      descCol,
      s.dim,
    );
  });
}

/** 帮助页: 分层布局 + 主视图同源标准 SGR 单色系 (80 列内防截断, 全页右栏单轴左对齐, 降级无 ANSI 逐字等价) */
export function helpText(color: boolean, locale: Locale = 'zh'): string {
  const configPath = sanitizeLine(resolveConfigPath({ env: {} }).path);
  const cat = buildSweepHelpCatalog(locale, configPath);
  const s = createStyler(color);
  const descCol = computeDescColumn(cat);
  const maxRightCols = MAX_LINE_COLS - LINE_INDENT.length - descCol;
  const contIndent = ' '.repeat(LINE_INDENT.length + descCol);

  const commandRows = cat.subcommands.flatMap((row) =>
    formatWrappedBlock(
      s.bold(row.name),
      row.name,
      wrapSegment(row.desc, maxRightCols),
      descCol,
      s.dim,
    ),
  );
  const exampleRows = cat.examples.flatMap((row) => {
    const plain = [row.cmd, row.flag, row.arg]
      .filter((p): p is string => p !== undefined)
      .join(' ');
    const styledParts = [s.bold(row.cmd)];
    if (row.flag !== undefined) styledParts.push(s.token(row.flag));
    if (row.arg !== undefined) styledParts.push(s.dim(row.arg));
    return formatWrappedBlock(
      styledParts.join(' '),
      plain,
      wrapSegment(row.desc, maxRightCols),
      descCol,
      s.dim,
    );
  });
  const noteRows = cat.notes.flatMap((row) => {
    const wrapped = row.paragraphs.flatMap((p) => wrapSegment(p, maxRightCols));
    if (row.rawFirstLine !== undefined) {
      const first = alignHelpRow(
        s.bold(row.label),
        row.label,
        s.token(row.rawFirstLine),
        descCol,
        LINE_INDENT,
      );
      return [first, ...wrapped.map((ln) => `${contIndent}${s.dim(ln)}`)];
    }
    return formatWrappedBlock(
      s.bold(row.label),
      row.label,
      wrapped,
      descCol,
      s.dim,
    );
  });
  const exitRows = cat.exitCodes.flatMap((row) =>
    formatWrappedBlock(
      row.tone === 'green' ? s.green(row.code) : s.red(row.code),
      row.code,
      wrapSegment(row.desc, maxRightCols),
      descCol,
      s.dim,
    ),
  );

  return [
    '',
    `  ${s.badge('SWEEP')}  ${s.bold(cat.subtitle)}`,
    `  ${s.dim(cat.summary)}`,
    `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section(cat.sections.usage)}`,
    `    ${s.bold('sweep')} ${s.dim(cat.usageArgs[0])}`,
    `    ${s.bold('sweep')} ${s.dim(cat.usageArgs[1])}`,
    '',
    `  ${s.section(cat.sections.commands)}`,
    ...commandRows,
    '',
    `  ${s.section(cat.sections.options)}`,
    ...renderOptions(cat.actionOptions, s, descCol, maxRightCols),
    '',
    ...renderOptions(cat.metaOptions, s, descCol, maxRightCols),
    '',
    `  ${s.section(cat.sections.examples)}`,
    ...exampleRows,
    '',
    `  ${s.section(cat.sections.safety)}`,
    ...noteRows,
    '',
    `  ${s.section(cat.sections.exitCodes)}`,
    ...exitRows,
    '',
    `  ${s.section(cat.sections.docs)}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
