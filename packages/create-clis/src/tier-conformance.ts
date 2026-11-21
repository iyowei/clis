/**
 * 档位裁剪 · `CONFORMANCE_GROUP` 与 `--conformance` 入口同步摘除 (由 `tier.ts` 在 `pruneCiSource` 调用):
 * 当 `scripts/ci.ts` 中 `CONFORMANCE_GROUP` 的全部真实验收步骤 (`conformance:*`) 被摘除、
 * 仅剩 `'build'` 或空数组时, 同步摘除 `CONFORMANCE_GROUP` 声明、`HELP_TEXT` 中的 `--conformance`
 * 说明行、`resolveSteps` 中的 `--conformance` 识别与返回分支, 并将全链合并简化为直接返回
 * `[...VERIFY_GROUP]`, 确保生成物执行 `bun scripts/ci.ts --conformance` 响亮拒绝 (防裁剪后假绿)。
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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

/** 旧形态 CLI 入口坐标块 (保留以兼容单测手写夹具) */
const CLI_COORDINATE_BLOCK =
  /\/\*\* CLI 入口坐标[^\n]*\nconst \{ cli \} = resolveCliAndApi\(process\.cwd\(\)\);\nconst CLI_SRC = [^\n]*\n\n?/;

/** 旧形态导入 */
const CLI_COORDINATE_IMPORT =
  /^import \{ resolveCliAndApi \} from '\.\/lib\/workspace\.ts';\n/m;

/** 新形态惰性派生函数声明锚点 (不硬耦合 JSDoc 中文文案, 靠括号配平精确定位函数体) */
const LAZY_CONFORMANCE_DECL =
  /^function resolveConformanceCliSrc\s*\([^)]*\)[^{]*\{/m;

/** 新形态导入 */
const LAZY_CONFORMANCE_IMPORT =
  /^import \{ resolveProductPairs \} from '\.\/lib\/workspace\.ts';\n/m;

/** 定位配对闭合花括号 `}` */
function findMatchingBrace(
  source: string,
  openIndex: number,
  ciScript: string,
): number {
  let depth = 0;
  for (const { char, index } of codeChars(source, openIndex)) {
    if (char === '{') depth += 1;
    else if (char === '}') {
      depth -= 1;
      if (depth === 0) return index;
    }
  }
  throw new Error(
    `${ciScript} 形态预期不符: 第 ${openIndex} 字符起的 \`{\` 未闭合`,
  );
}

/** 术后载体摘除: 「只服务被摘步骤」的顶层声明与来源导入一并摘净 (兼顾新旧两种形态) */
export function pruneOrphanedCarriers(
  source: string,
  ciScript: string,
): string {
  let out = source;
  const legacyBlock = CLI_COORDINATE_BLOCK.exec(out);
  if (legacyBlock !== null) {
    const withoutBlock = out.replace(legacyBlock[0], '');
    if (!withoutBlock.includes('CLI_SRC')) {
      const withoutImport = withoutBlock.replace(CLI_COORDINATE_IMPORT, '');
      out = withoutImport.includes('resolveCliAndApi')
        ? withoutBlock
        : withoutImport;
    }
  }
  const lazyDecl = LAZY_CONFORMANCE_DECL.exec(out);
  if (lazyDecl !== null) {
    const openBrace = lazyDecl.index + lazyDecl[0].length - 1;
    const closeBrace = findMatchingBrace(out, openBrace, ciScript);
    let end = out.indexOf('\n', closeBrace);
    end = end < 0 ? out.length : end + 1;
    if (out[end] === '\n') end += 1;
    const start = expandOverLeadingComment(out, lazyDecl.index);
    const withoutBlock = out.slice(0, start) + out.slice(end);
    if (!withoutBlock.includes('resolveConformanceCliSrc')) {
      const withoutImport = withoutBlock.replace(LAZY_CONFORMANCE_IMPORT, '');
      out = withoutImport.includes('resolveProductPairs')
        ? withoutBlock
        : withoutImport;
    }
  }
  return out;
}

/** 增强档降级时同步摘除 docs/README.md 的「## 转写协议」章节与 PR 模板 conformance checklist 行 */
export function planConformanceDocPrunes(
  targetDir: string,
  deletePaths: readonly string[],
  conformanceDocsDir: string,
): Map<string, string> {
  const updates = new Map<string, string>();
  if (!deletePaths.includes(conformanceDocsDir)) return updates;

  const docsReadmePath = join(targetDir, 'docs/README.md');
  if (existsSync(docsReadmePath)) {
    const source = readFileSync(docsReadmePath, 'utf8');
    const pruned = source
      .replace(/\n## 转写协议[\s\S]*?(?=\n## |$)/, '')
      .replace(/\n{3,}/g, '\n\n');
    if (pruned !== source) updates.set(docsReadmePath, pruned);
  }

  const prPath = join(targetDir, '.github/PULL_REQUEST_TEMPLATE.md');
  if (existsSync(prPath)) {
    const source = readFileSync(prPath, 'utf8');
    const pruned = source.replace(
      /^- \[ \] [^\n]*conformance suite[^\n]*\n/gm,
      '',
    );
    if (pruned !== source) updates.set(prPath, pruned);
  }
  return updates;
}
