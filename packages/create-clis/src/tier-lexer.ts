/**
 * TypeScript / JavaScript 轻量词法走查 (供 tier.ts 括号配平与块边界定位共用):
 * 跳过单行/块注释、单/双引号字符串、正则字面量与模板字面量文本体, 并正确追踪模板插值
 * `${ ... }` 内的嵌套大括号与嵌套模板字面量。
 */

const REGEX_PRECEDING_KEYWORDS = new Set([
  'return',
  'case',
  'throw',
  'in',
  'of',
  'typeof',
  'void',
  'delete',
  'new',
  'await',
  'yield',
  'else',
  'do',
]);

const REGEX_PRECEDING_CHARS = new Set([
  '(',
  '[',
  '{',
  ',',
  ';',
  ':',
  '=',
  '!',
  '?',
  '&',
  '|',
  '^',
  '~',
  '+',
  '-',
  '*',
  '%',
  '<',
  '>',
]);

function isIdentChar(ch: string): boolean {
  return /[A-Za-z0-9_$]/.test(ch);
}

/** 跳过单/双引号字符串字面量 (返回闭合引号后的下标) */
function skipQuoted(source: string, start: number, quote: string): number {
  let index = start + 1;
  while (index < source.length) {
    const current = source[index];
    if (current === '\\') index += 2;
    else if (current === quote) return index + 1;
    else index += 1;
  }
  return index;
}

/** 跳过正则字面量 `/.../` (兼容字符类 `[...]` 内的 `/` 与反斜杠转义) */
function skipRegexLiteral(source: string, start: number): number {
  let index = start + 1;
  let inClass = false;
  while (index < source.length) {
    const current = source[index];
    if (current === '\\') {
      index += 2;
      continue;
    }
    if (current === '\n') return start + 1;
    if (current === '[') inClass = true;
    else if (current === ']') inClass = false;
    else if (current === '/' && !inClass) {
      index += 1;
      while (index < source.length && /[a-z]/i.test(source[index]!)) index += 1;
      return index;
    }
    index += 1;
  }
  return index;
}

/** 扫描模板字面量文本段, 遇 `${` 返回 enteredExpr=true, 遇闭合反引号返回 enteredExpr=false */
function scanTemplateBody(
  source: string,
  start: number,
): { next: number; enteredExpr: boolean } {
  let index = start;
  while (index < source.length) {
    const current = source[index];
    if (current === '\\') {
      index += 2;
      continue;
    }
    if (current === '`') return { next: index + 1, enteredExpr: false };
    if (current === '$' && source[index + 1] === '{') {
      return { next: index + 2, enteredExpr: true };
    }
    index += 1;
  }
  return { next: index, enteredExpr: false };
}

/** 推进一次模板字面量段扫描并更新插值栈与 canStartRegex 状态 */
function enterTemplateSegment(
  source: string,
  start: number,
  templateBraceDepths: number[],
): { index: number; canStartRegex: boolean } {
  const scanned = scanTemplateBody(source, start);
  if (scanned.enteredExpr) {
    templateBraceDepths.push(0);
    return { index: scanned.next, canStartRegex: true };
  }
  return { index: scanned.next, canStartRegex: false };
}

/** 代码字符走查: 跳过注释 / 字符串 / 正则 / 模板文本体, 追踪模板插值 `${ ... }` 嵌套大括号 */
export function* codeChars(
  source: string,
  from = 0,
): Generator<{ char: string; index: number }> {
  let index = from;
  let canStartRegex = true;
  const templateBraceDepths: number[] = [];

  while (index < source.length) {
    const char = source[index]!;
    const next = source[index + 1];

    if (char === '/' && next === '/') {
      const eol = source.indexOf('\n', index);
      if (eol < 0) return;
      index = eol + 1;
      continue;
    }
    if (char === '/' && next === '*') {
      const end = source.indexOf('*/', index + 2);
      if (end < 0) return;
      index = end + 2;
      continue;
    }
    if (char === "'" || char === '"') {
      index = skipQuoted(source, index, char);
      canStartRegex = false;
      continue;
    }
    if (char === '`') {
      const state = enterTemplateSegment(
        source,
        index + 1,
        templateBraceDepths,
      );
      index = state.index;
      canStartRegex = state.canStartRegex;
      continue;
    }
    if (char === '/' && canStartRegex) {
      index = skipRegexLiteral(source, index);
      canStartRegex = false;
      continue;
    }

    if (templateBraceDepths.length > 0 && (char === '{' || char === '}')) {
      const top = templateBraceDepths.length - 1;
      if (char === '{') {
        templateBraceDepths[top] = templateBraceDepths[top]! + 1;
      } else if (templateBraceDepths[top] === 0) {
        templateBraceDepths.pop();
        const state = enterTemplateSegment(
          source,
          index + 1,
          templateBraceDepths,
        );
        index = state.index;
        canStartRegex = state.canStartRegex;
        continue;
      } else {
        templateBraceDepths[top] = templateBraceDepths[top]! - 1;
      }
    }

    if (isIdentChar(char)) {
      let wordEnd = index + 1;
      while (wordEnd < source.length && isIdentChar(source[wordEnd]!)) {
        wordEnd += 1;
      }
      canStartRegex = REGEX_PRECEDING_KEYWORDS.has(
        source.slice(index, wordEnd),
      );
      for (let pos = index; pos < wordEnd; pos += 1) {
        yield { char: source[pos]!, index: pos };
      }
      index = wordEnd;
      continue;
    }

    if (!/\s/.test(char)) canStartRegex = REGEX_PRECEDING_CHARS.has(char);
    yield { char, index };
    index += 1;
  }
}
