/**
 * 档位裁剪 · CONFORMANCE_GROUP 与 `--conformance` 入口同步摘除 (防裁剪后假绿):
 * 当 `scripts/ci.ts` 中 `CONFORMANCE_GROUP` 的全部真实验收步骤 (`conformance:*`) 被摘除、
 * 仅剩 `'build'` 或空数组时, 同步摘除 `CONFORMANCE_GROUP` 声明、`HELP_TEXT` 中的 `--conformance`
 * 说明行、`resolveSteps` 中的 `--conformance` 识别与返回分支, 并将全链合并简化为直接返回
 * `[...VERIFY_GROUP]`, 确保生成物执行 `bun scripts/ci.ts --conformance` 响亮以退出码 2 拒绝。
 */
import { codeChars } from './tier-lexer.ts';

/** 定位 `CONFORMANCE_GROUP` 声明行锚点 */
const CONFORMANCE_GROUP_DECL = /^const CONFORMANCE_GROUP\b[^\n]*= \[/m;

/** 定位 `HELP_TEXT` 中的 `--conformance` 说明行 */
const HELP_CONFORMANCE_LINE = /^[ \t]*'[^'\n]*--conformance[^'\n]*'[^\n]*\n/gm;

/** 定位 `HELP_TEXT` 中全链拼接的 "+ 验收组 (去重)" 尾缀 */
const HELP_FULL_CHAIN_SUFFIX = /\s*\+\s*验收组\s*\(去重\)/g;

/** 定位 `resolveSteps` 条件里对 `--conformance` 的或分支 (后置或前置两种写法) */
const MODE_COND_TRAILING = /\s*\|\|\s*arg === '--conformance'/g;
const MODE_COND_LEADING = /arg === '--conformance'\s*\|\|\s*/g;

/** 定位 `resolveSteps` 中 `--conformance` 返回分支 */
const MODE_RETURN_LINE =
  /^[ \t]*if \(modes\[0\] === '--conformance'\) return \[\.\.\.CONFORMANCE_GROUP\];\n/gm;

/** 定位 `resolveSteps` 末尾的全链合并 return (含紧贴其上的注释行) */
const FULL_CHAIN_RETURN =
  /(?:^[ \t]*\/\/[^\n]*(?:CONFORMANCE_GROUP|验收组)[^\n]*\n)?^[ \t]*return \[\s*\.\.\.VERIFY_GROUP,\s*\.\.\.CONFORMANCE_GROUP\.filter\([^\n]+\),?\s*\];/m;

/** 定位配对闭合方括号 `]` (跳过注释 / 字符串 / 正则 / 模板文本) */
function findMatchingBracket(
  source: string,
  openIndex: number,
  ciScript: string,
): number {
  let depth = 0;
  for (const { char, index } of codeChars(source, openIndex)) {
    if (char === '[') depth += 1;
    else if (char === ']') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(
    `${ciScript} 形态预期不符: 第 ${openIndex} 字符起的 \`[\` 未闭合`,
  );
}

/** 向上吞掉紧贴顶层声明的 JSDoc 块注释或连续 `//` 行注释 */
function expandOverLeadingComment(source: string, declStart: number): number {
  const before = source.slice(0, declStart);
  if (before.endsWith('*/\n')) {
    const open = before.lastIndexOf('/**');
    if (
      open >= 0 &&
      (open === 0 || before[open - 1] === '\n') &&
      before.indexOf('*/', open + 3) === before.length - 3
    ) {
      return open;
    }
  }
  const lines = before.split('\n');
  lines.pop();
  while (
    lines.length > 0 &&
    lines[lines.length - 1]!.trimStart().startsWith('//')
  ) {
    lines.pop();
  }
  return lines.length === 0 ? 0 : lines.join('\n').length + 1;
}

interface GroupSpan {
  start: number;
  end: number;
  items: string[];
}

/** 解析 `CONFORMANCE_GROUP` 声明的完整范围 (含前置注释与尾部空行) 及步骤名列表 */
function locateConformanceGroup(
  source: string,
  ciScript: string,
): GroupSpan | null {
  const match = CONFORMANCE_GROUP_DECL.exec(source);
  if (match === null) return null;
  const openBracket = match.index + match[0].length - 1;
  const closeBracket = findMatchingBracket(source, openBracket, ciScript);
  const body = source.slice(openBracket + 1, closeBracket);
  const items: string[] = [];
  for (const item of body.matchAll(/'([^'\n]+)'/g)) {
    items.push(item[1]!);
  }
  const lineEnd = source.indexOf('\n', closeBracket);
  let end = lineEnd < 0 ? source.length : lineEnd + 1;
  if (source[end] === '\n') end += 1;
  return {
    start: expandOverLeadingComment(source, match.index),
    end,
    items,
  };
}

/**
 * 若 `CONFORMANCE_GROUP` 内全部真实验收步骤 (非 `'build'`) 均已被摘除, 同步摘除该组声明与
 * `--conformance` 入口分支; 仍有真实验收步骤保留时原样返回。
 */
export function pruneEmptyConformanceGroup(
  beforeSource: string,
  afterGroupRefSource: string,
  ciScript: string,
): string {
  const before = locateConformanceGroup(beforeSource, ciScript);
  const after = locateConformanceGroup(afterGroupRefSource, ciScript);
  if (before === null || after === null) return afterGroupRefSource;

  const hadRealConformance = before.items.some((item) => item !== 'build');
  const hasRemainingRealConformance = after.items.some(
    (item) => item !== 'build',
  );
  if (!hadRealConformance || hasRemainingRealConformance) {
    return afterGroupRefSource;
  }

  let out =
    afterGroupRefSource.slice(0, after.start) +
    afterGroupRefSource.slice(after.end);
  out = out.replace(HELP_CONFORMANCE_LINE, '');
  out = out.replace(HELP_FULL_CHAIN_SUFFIX, '');
  out = out.replace(MODE_COND_TRAILING, '');
  out = out.replace(MODE_COND_LEADING, '');
  out = out.replace(MODE_RETURN_LINE, '');
  out = out.replace(FULL_CHAIN_RETURN, '  return [...VERIFY_GROUP];');

  if (out.includes('CONFORMANCE_GROUP')) {
    throw new Error(`步骤手术自检未过: CONFORMANCE_GROUP 仍残留在 ${ciScript}`);
  }
  if (out.includes("'--conformance'")) {
    throw new Error(
      `步骤手术自检未过: '--conformance' 分支仍残留在 ${ciScript}`,
    );
  }
  return out;
}
