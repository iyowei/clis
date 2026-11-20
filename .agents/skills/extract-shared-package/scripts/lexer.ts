/**
 * 零外部依赖 TypeScript / JavaScript 确定性词法扫描器。
 * 剥离注释与空白, 准确处理引号字符串与模板插值 `${...}` 嵌套, 提取静态 import。
 */

export interface ScannedToken {
  kind: 'ident' | 'keyword' | 'punct' | 'string' | 'number';
  value: string;
  line: number;
}

export interface ParsedImport {
  specifier: string;
  isTypeOnly: boolean;
}

const KEYWORDS: ReadonlySet<string> = new Set([
  'async',
  'await',
  'break',
  'case',
  'catch',
  'class',
  'const',
  'continue',
  'default',
  'delete',
  'do',
  'else',
  'export',
  'extends',
  'false',
  'finally',
  'for',
  'from',
  'function',
  'if',
  'implements',
  'import',
  'in',
  'instanceof',
  'interface',
  'let',
  'new',
  'null',
  'of',
  'return',
  'static',
  'super',
  'switch',
  'this',
  'throw',
  'true',
  'try',
  'type',
  'typeof',
  'undefined',
  'var',
  'void',
  'while',
  'yield',
]);

function isIdentStart(ch: string): boolean {
  return (
    (ch >= 'a' && ch <= 'z') ||
    (ch >= 'A' && ch <= 'Z') ||
    ch === '_' ||
    ch === '$'
  );
}

function isIdentPart(ch: string): boolean {
  return isIdentStart(ch) || (ch >= '0' && ch <= '9');
}

function isDigit(ch: string): boolean {
  return ch >= '0' && ch <= '9';
}

function scanTemplateSegment(
  source: string,
  startPos: number,
  startLine: number,
): { nextPos: number; line: number; enteredExpr: boolean } {
  let i = startPos;
  let line = startLine;
  while (i < source.length) {
    const ch = source[i]!;
    if (ch === '\\') {
      if (source[i + 1] === '\n') line += 1;
      i += 2;
      continue;
    }
    if (ch === '`') {
      return { nextPos: i + 1, line, enteredExpr: false };
    }
    if (ch === '$' && source[i + 1] === '{') {
      return { nextPos: i + 2, line, enteredExpr: true };
    }
    if (ch === '\n') line += 1;
    i += 1;
  }
  return { nextPos: i, line, enteredExpr: false };
}

function scanQuotedString(
  source: string,
  startPos: number,
  startLine: number,
  quote: string,
): { value: string; nextPos: number; line: number } {
  let i = startPos + 1;
  let line = startLine;
  while (i < source.length) {
    if (source[i] === '\\') {
      if (source[i + 1] === '\n') line += 1;
      i += 2;
      continue;
    }
    if (source[i] === '\n') line += 1;
    if (source[i] === quote) {
      i += 1;
      break;
    }
    i += 1;
  }
  return { value: source.slice(startPos + 1, i - 1), nextPos: i, line };
}

const MULTI_OPS = new Set([
  '===',
  '!==',
  '...',
  '=>',
  '==',
  '!=',
  '<=',
  '>=',
  '&&',
  '||',
  '??',
  '?.',
]);

/** 确定性词法扫描器: 剥离注释/空白, 保留嵌套模板与操作符结构 */
export function tokenizeSource(source: string): ScannedToken[] {
  const tokens: ScannedToken[] = [];
  const tplDepths: number[] = [];
  let braceDepth = 0;
  let line = 1;
  let i = 0;

  while (i < source.length) {
    const ch = source[i]!;
    const next = source[i + 1] ?? '';

    if (ch === '\n') {
      line += 1;
      i += 1;
      continue;
    }
    if (ch === ' ' || ch === '\t' || ch === '\r') {
      i += 1;
      continue;
    }
    if (ch === '/' && next === '/') {
      i += 2;
      while (i < source.length && source[i] !== '\n') i += 1;
      continue;
    }
    if (ch === '/' && next === '*') {
      i += 2;
      while (i < source.length - 1) {
        if (source[i] === '\n') line += 1;
        if (source[i] === '*' && source[i + 1] === '/') {
          i += 2;
          break;
        }
        i += 1;
      }
      continue;
    }
    if (ch === "'" || ch === '"') {
      const q = scanQuotedString(source, i, line, ch);
      tokens.push({ kind: 'string', value: q.value, line: q.line });
      line = q.line;
      i = q.nextPos;
      continue;
    }
    if (ch === '`') {
      const seg = scanTemplateSegment(source, i + 1, line);
      tokens.push({ kind: 'string', value: '<tpl>', line });
      line = seg.line;
      i = seg.nextPos;
      if (seg.enteredExpr) {
        tplDepths.push(braceDepth);
        braceDepth += 1;
        tokens.push({ kind: 'punct', value: '${', line });
      }
      continue;
    }
    if (
      ch === '}' &&
      tplDepths.length > 0 &&
      braceDepth - 1 === tplDepths[tplDepths.length - 1]
    ) {
      braceDepth -= 1;
      tplDepths.pop();
      tokens.push({ kind: 'punct', value: '}', line });
      const seg = scanTemplateSegment(source, i + 1, line);
      line = seg.line;
      i = seg.nextPos;
      if (seg.enteredExpr) {
        tplDepths.push(braceDepth);
        braceDepth += 1;
        tokens.push({ kind: 'punct', value: '${', line });
      }
      continue;
    }
    if (isDigit(ch)) {
      const start = i;
      while (
        i < source.length &&
        (isIdentPart(source[i]!) || source[i] === '.')
      ) {
        i += 1;
      }
      tokens.push({ kind: 'number', value: source.slice(start, i), line });
      continue;
    }
    if (isIdentStart(ch)) {
      const start = i;
      while (i < source.length && isIdentPart(source[i]!)) i += 1;
      const word = source.slice(start, i);
      tokens.push({
        kind: KEYWORDS.has(word) ? 'keyword' : 'ident',
        value: word,
        line,
      });
      continue;
    }

    if (ch === '{') braceDepth += 1;
    else if (ch === '}' && braceDepth > 0) braceDepth -= 1;

    const three = source.slice(i, i + 3);
    const two = source.slice(i, i + 2);
    if (MULTI_OPS.has(three)) {
      tokens.push({ kind: 'punct', value: three, line });
      i += 3;
    } else if (MULTI_OPS.has(two)) {
      tokens.push({ kind: 'punct', value: two, line });
      i += 2;
    } else {
      tokens.push({ kind: 'punct', value: ch, line });
      i += 1;
    }
  }
  return tokens;
}

/** 统计非空且非纯注释的有效代码行数 */
export function countSloc(source: string): number {
  let count = 0;
  let inBlockComment = false;
  for (const rawLine of source.split('\n')) {
    const trimmed = rawLine.trim();
    if (trimmed === '') continue;
    if (inBlockComment) {
      if (trimmed.includes('*/')) inBlockComment = false;
      continue;
    }
    if (trimmed.startsWith('/*')) {
      if (!trimmed.includes('*/')) inBlockComment = true;
      continue;
    }
    if (trimmed.startsWith('//')) continue;
    count += 1;
  }
  return count;
}

/** 从 token 流解析全部 static import 声明 */
export function extractImports(
  tokens: readonly ScannedToken[],
): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'keyword' || tok.value !== 'import') continue;
    if (tokens[i + 1]?.value === '(') continue;

    let isTypeOnly = tokens[i + 1]?.value === 'type';
    let j = i + 1;
    while (j < tokens.length) {
      const cur = tokens[j]!;
      if (cur.value === ';') break;
      if (cur.kind === 'keyword' && cur.value === 'from') {
        const specTok = tokens[j + 1];
        if (specTok?.kind === 'string') {
          imports.push({ specifier: specTok.value, isTypeOnly });
        }
        i = j + 1;
        break;
      }
      if (cur.kind === 'string' && tokens[j - 1]?.value === 'import') {
        imports.push({ specifier: cur.value, isTypeOnly: false });
        i = j;
        break;
      }
      if (
        j > i + 1 &&
        cur.kind === 'keyword' &&
        (cur.value === 'export' ||
          cur.value === 'function' ||
          cur.value === 'const')
      ) {
        break;
      }
      if (cur.value === 'type' && tokens[j - 1]?.value === '{') {
        isTypeOnly = false;
      }
      j += 1;
    }
  }
  return imports;
}
