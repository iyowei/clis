/**
 * 词法切片公共语法助手: 平衡括弧、泛型跳过、多深度参数统计、条件/箭头返回类型安全跳过。
 */
import {
  buildNormalizedShingles,
  detectSideEffects,
  evaluateRustReadiness,
  sha256Short,
} from './fingerprint.ts';
import { type ScannedToken, countSloc } from './lexer.ts';
import type { SymbolUnit, WorkspacePackageNode } from './types.ts';

export interface FileScanContext {
  pkg: WorkspacePackageNode;
  relFile: string;
  isInfra: boolean;
  sourceLines: readonly string[];
  tokens: readonly ScannedToken[];
  builtins: readonly string[];
  relativeImports: readonly string[];
  internalTypeImports: readonly string[];
}

export interface BuildFnSpec {
  declStartIdx: number;
  bodyStartIdx: number;
  bodyEndIdx?: number;
  fnName: string;
  paramCount: number;
  hasReturnType: boolean;
  exported: boolean;
}

const TYPE_PREFIX_TOKENS = new Set([
  ':',
  '|',
  '&',
  '=>',
  '(',
  '[',
  '<',
  'is',
  'asserts',
  'extends',
  'infer',
  'keyof',
  'readonly',
]);

const TYPE_CONTINUATION_NEXT = new Set(['?', '|', '&', '=>', '>']);

export function findMatchingBrace(
  tokens: readonly ScannedToken[],
  openIdx: number,
): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.kind !== 'punct') continue;
    if (tok.value === '{' || tok.value === '${') depth += 1;
    else if (tok.value === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

export function skipGenericArgs(
  tokens: readonly ScannedToken[],
  startIdx: number,
): number {
  const first = tokens[startIdx];
  if (first?.kind !== 'punct' || first.value !== '<') return startIdx;
  let angle = 0;
  let cur = startIdx;
  while (cur < tokens.length) {
    const tok = tokens[cur]!;
    if (tok.kind === 'punct') {
      if (tok.value === '<') angle += 1;
      else if (tok.value === '>') {
        angle -= 1;
        if (angle === 0) return cur + 1;
      }
    }
    cur += 1;
  }
  return cur;
}

/** 平衡统计顶层逗号参数个数 (正确穿透泛型 <>、回调 () => void 与解构默认值 {}, 且屏蔽字符串字面量干扰) */
export function inspectSignature(
  tokens: readonly ScannedToken[],
  openParenIdx: number,
): { closeParenIdx: number; paramCount: number; hasReturnType: boolean } {
  let parenDepth = 0;
  let angleDepth = 0;
  let braceDepth = 0;
  let bracketDepth = 0;
  let commaCount = 0;
  let hasContent = false;
  let closeIdx = openParenIdx;

  for (let i = openParenIdx; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const pv = tok.kind === 'punct' ? tok.value : '';
    if (pv === '(') parenDepth += 1;
    else if (pv === ')') {
      parenDepth -= 1;
      if (parenDepth === 0) {
        closeIdx = i;
        break;
      }
    } else if (pv === '<') angleDepth += 1;
    else if (pv === '>' && angleDepth > 0) angleDepth -= 1;
    else if (pv === '{' || pv === '${') braceDepth += 1;
    else if (pv === '}' && braceDepth > 0) braceDepth -= 1;
    else if (pv === '[') bracketDepth += 1;
    else if (pv === ']' && bracketDepth > 0) bracketDepth -= 1;
    else if (
      parenDepth === 1 &&
      angleDepth === 0 &&
      braceDepth === 0 &&
      bracketDepth === 0 &&
      pv === ','
    ) {
      if (!(tokens[i + 1]?.kind === 'punct' && tokens[i + 1]?.value === ')')) {
        commaCount += 1;
      }
    } else if (parenDepth >= 1) {
      hasContent = true;
    }
  }

  return {
    closeParenIdx: closeIdx,
    paramCount: hasContent ? commaCount + 1 : 0,
    hasReturnType:
      tokens[closeIdx + 1]?.kind === 'punct' &&
      tokens[closeIdx + 1]?.value === ':',
  };
}

function hasStatementKeywords(
  tokens: readonly ScannedToken[],
  startBraceIdx: number,
  endBraceIdx: number,
): boolean {
  const slice = tokens.slice(startBraceIdx, endBraceIdx + 1);
  return slice.some(
    (t) =>
      t.kind === 'keyword' &&
      (t.value === 'return' ||
        t.value === 'if' ||
        t.value === 'for' ||
        t.value === 'const' ||
        t.value === 'let'),
  );
}

/** 平衡跳过返回类型注解 (含内联对象、条件类型 extends {...} ? A : B 与高阶箭头类型), 精准定位函数体 `{` */
export function findFunctionBodyStart(
  tokens: readonly ScannedToken[],
  closeParenIdx: number,
): number {
  let pos = closeParenIdx + 1;
  let parenDepth = 0;
  let bracketDepth = 0;
  let braceDepth = 0;
  let angleDepth = 0;

  while (pos < tokens.length) {
    const tok = tokens[pos]!;
    const pv = tok.kind === 'punct' ? tok.value : '';
    const atTop =
      parenDepth === 0 &&
      bracketDepth === 0 &&
      braceDepth === 0 &&
      angleDepth === 0;

    if (atTop && pv === ';') return -1;
    if (atTop && pv === '{') {
      const prev = tokens[pos - 1]?.value ?? '';
      if (!TYPE_PREFIX_TOKENS.has(prev)) return pos;
      const candidateEnd = findMatchingBrace(tokens, pos);
      const afterVal = tokens[candidateEnd + 1]?.value ?? '';
      if (
        !TYPE_CONTINUATION_NEXT.has(afterVal) &&
        prev !== 'extends' &&
        hasStatementKeywords(tokens, pos, candidateEnd)
      ) {
        return pos;
      }
      pos = candidateEnd + 1;
      continue;
    }

    if (pv === '(') parenDepth += 1;
    else if (pv === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (pv === '[') bracketDepth += 1;
    else if (pv === ']') bracketDepth = Math.max(0, bracketDepth - 1);
    else if (pv === '<') angleDepth += 1;
    else if (pv === '>') angleDepth = Math.max(0, angleDepth - 1);
    else if (pv === '{' || pv === '${') braceDepth += 1;
    else if (pv === '}') braceDepth = Math.max(0, braceDepth - 1);
    pos += 1;
  }
  return -1;
}

export function buildFunctionUnit(
  ctx: FileScanContext,
  spec: BuildFnSpec,
): { unit: SymbolUnit; nextIndex: number } {
  const bodyEnd =
    spec.bodyEndIdx ?? findMatchingBrace(ctx.tokens, spec.bodyStartIdx);
  const startLine = ctx.tokens[spec.declStartIdx]!.line;
  const endLine = ctx.tokens[bodyEnd]!.line;
  const sliceText = ctx.sourceLines.slice(startLine - 1, endLine).join('\n');
  const fullTokens = ctx.tokens.slice(spec.declStartIdx, bodyEnd + 1);
  const bodyTokens = ctx.tokens.slice(spec.bodyStartIdx, bodyEnd + 1);
  const sideEffects = detectSideEffects(sliceText, ctx.builtins);
  const rustReadiness = evaluateRustReadiness(
    fullTokens,
    sideEffects,
    spec.hasReturnType,
    true,
  );
  const { normalizedDigest, shingles } = buildNormalizedShingles(bodyTokens);

  return {
    unit: {
      id: `${ctx.pkg.name}::${ctx.relFile}#${spec.fnName}@${startLine}`,
      pkgName: ctx.pkg.name,
      pkgDir: ctx.pkg.dir,
      domainId: ctx.pkg.domainId,
      layer: ctx.pkg.layer,
      file: ctx.relFile,
      name: spec.fnName,
      symbolKind: 'function',
      exported: spec.exported,
      isInfra: ctx.isInfra,
      startLine,
      endLine,
      sloc: countSloc(sliceText),
      paramCount: spec.paramCount,
      hasExplicitReturnType: spec.hasReturnType,
      rawDigest: sha256Short(sliceText),
      normalizedDigest,
      shingles,
      sideEffects,
      builtins: [...ctx.builtins],
      relativeImports: [...ctx.relativeImports],
      internalTypeImports: [...ctx.internalTypeImports],
      rustReadiness,
    },
    nextIndex: bodyEnd,
  };
}
