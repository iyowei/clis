/**
 * 顶层函数、箭头函数/函数表达式、类及类方法提取器 (与 analyzer 词法骨架解耦)。
 */
import { sha256Short } from './fingerprint.ts';
import { type ScannedToken, countSloc } from './lexer.ts';
import {
  type FileScanContext,
  buildFunctionUnit,
  findFunctionBodyStart,
  findMatchingBrace,
  inspectSignature,
  skipGenericArgs,
} from './syntax-helpers.ts';
import type { SymbolUnit } from './types.ts';

export const CLASS_MODIFIERS = new Set([
  'public',
  'private',
  'protected',
  'static',
  'readonly',
  'async',
  'override',
  'get',
  'set',
]);

export const NON_METHOD_KEYWORDS = new Set([
  'if',
  'for',
  'while',
  'switch',
  'catch',
  'return',
  'throw',
]);

export const TOP_LEVEL_DECL_KW = new Set([
  'export',
  'import',
  'function',
  'class',
  'const',
  'let',
  'var',
  'interface',
  'type',
  'enum',
  'async',
]);

function findExprBodyEnd(
  tokens: readonly ScannedToken[],
  startIdx: number,
): number {
  let depth = 0;
  const startLine = tokens[startIdx]?.line ?? 0;
  for (let k = startIdx; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (pv === '(' || pv === '{' || pv === '[') depth += 1;
    else if (pv === ')' || pv === '}' || pv === ']') {
      if (depth === 0) return Math.max(startIdx, k - 1);
      depth -= 1;
    } else if (depth === 0) {
      if (pv === ';') return Math.max(startIdx, k - 1);
      if (
        t.line > startLine &&
        t.kind === 'keyword' &&
        TOP_LEVEL_DECL_KW.has(t.value)
      ) {
        return Math.max(startIdx, k - 1);
      }
    }
  }
  return tokens.length - 1;
}

export function tryExtractArrowOrFnExpr(
  ctx: FileScanContext,
  constIdx: number,
  exported: boolean,
): { unit: SymbolUnit | null; nextIndex: number } {
  const nameTok = ctx.tokens[constIdx + 1];
  if (nameTok === undefined || nameTok.kind !== 'ident') {
    return { unit: null, nextIndex: constIdx };
  }

  let eqIdx = constIdx + 2;
  let depth = 0;
  while (eqIdx < ctx.tokens.length) {
    const t = ctx.tokens[eqIdx]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (pv === '(' || pv === '{' || pv === '[') depth += 1;
    else if (pv === ')' || pv === '}' || pv === ']')
      depth = Math.max(0, depth - 1);
    else if (depth === 0 && pv === '=') break;
    else if (depth === 0 && pv === ';') return { unit: null, nextIndex: eqIdx };
    eqIdx += 1;
  }
  if (eqIdx >= ctx.tokens.length) return { unit: null, nextIndex: constIdx };

  let cur = eqIdx + 1;
  if (ctx.tokens[cur]?.value === 'async') cur += 1;
  if (
    ctx.tokens[cur]?.kind === 'keyword' &&
    ctx.tokens[cur]?.value === 'function'
  ) {
    cur += 1;
    if (ctx.tokens[cur]?.kind === 'ident') cur += 1;
    cur = skipGenericArgs(ctx.tokens, cur);
    if (ctx.tokens[cur]?.value !== '(')
      return { unit: null, nextIndex: constIdx };
    const sig = inspectSignature(ctx.tokens, cur);
    const bodyStart = findFunctionBodyStart(ctx.tokens, sig.closeParenIdx);
    if (bodyStart < 0) return { unit: null, nextIndex: constIdx };
    return buildFunctionUnit(ctx, {
      declStartIdx: constIdx,
      bodyStartIdx: bodyStart,
      fnName: nameTok.value,
      paramCount: sig.paramCount,
      hasReturnType: sig.hasReturnType,
      exported,
    });
  }

  cur = skipGenericArgs(ctx.tokens, cur);
  let paramCount = 0;
  let hasReturnType = false;
  let afterParamsIdx = cur;
  if (ctx.tokens[cur]?.value === '(') {
    const sig = inspectSignature(ctx.tokens, cur);
    paramCount = sig.paramCount;
    hasReturnType = sig.hasReturnType;
    afterParamsIdx = sig.closeParenIdx + 1;
  } else if (
    ctx.tokens[cur]?.kind === 'ident' &&
    ctx.tokens[cur + 1]?.value === '=>'
  ) {
    paramCount = 1;
    afterParamsIdx = cur + 1;
  } else {
    return { unit: null, nextIndex: constIdx };
  }

  const arrowCandidates: number[] = [];
  let scan = afterParamsIdx;
  let bDepth = 0;
  let angle = 0;
  const startLine = ctx.tokens[constIdx]!.line;
  while (scan < ctx.tokens.length) {
    const t = ctx.tokens[scan]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (pv === '(' || pv === '{' || pv === '[') bDepth += 1;
    else if (pv === ')' || pv === '}' || pv === ']')
      bDepth = Math.max(0, bDepth - 1);
    else if (pv === '<') angle += 1;
    else if (pv === '>' && angle > 0) angle -= 1;
    else if (bDepth === 0 && angle === 0 && pv === '=>') {
      arrowCandidates.push(scan);
      if (
        ctx.tokens[scan + 1]?.kind === 'punct' &&
        ctx.tokens[scan + 1]?.value === '{'
      ) {
        const matchEnd = findMatchingBrace(ctx.tokens, scan + 1);
        const bodySlice = ctx.tokens.slice(scan + 1, matchEnd + 1);
        const nextAfterBlock = ctx.tokens[matchEnd + 1]?.value ?? '';
        const hasBodyStmt = bodySlice.some(
          (st) =>
            st.kind === 'keyword' &&
            (st.value === 'return' ||
              st.value === 'if' ||
              st.value === 'for' ||
              st.value === 'const' ||
              st.value === 'let'),
        );
        if (!hasReturnType || nextAfterBlock !== '=>' || hasBodyStmt) {
          return buildFunctionUnit(ctx, {
            declStartIdx: constIdx,
            bodyStartIdx: scan + 1,
            fnName: nameTok.value,
            paramCount,
            hasReturnType,
            exported,
          });
        }
      } else if (!hasReturnType) {
        const exprEnd = findExprBodyEnd(ctx.tokens, scan + 1);
        return buildFunctionUnit(ctx, {
          declStartIdx: constIdx,
          bodyStartIdx: scan + 1,
          bodyEndIdx: exprEnd,
          fnName: nameTok.value,
          paramCount,
          hasReturnType,
          exported,
        });
      }
    } else if (bDepth === 0 && angle === 0) {
      if (
        pv === ';' ||
        (t.line > startLine &&
          t.kind === 'keyword' &&
          TOP_LEVEL_DECL_KW.has(t.value))
      ) {
        break;
      }
    }
    scan += 1;
  }

  const lastArrow = arrowCandidates[arrowCandidates.length - 1];
  if (lastArrow !== undefined) {
    if (ctx.tokens[lastArrow + 1]?.value === '{') {
      return buildFunctionUnit(ctx, {
        declStartIdx: constIdx,
        bodyStartIdx: lastArrow + 1,
        fnName: nameTok.value,
        paramCount,
        hasReturnType,
        exported,
      });
    }
    const exprEnd = findExprBodyEnd(ctx.tokens, lastArrow + 1);
    return buildFunctionUnit(ctx, {
      declStartIdx: constIdx,
      bodyStartIdx: lastArrow + 1,
      bodyEndIdx: exprEnd,
      fnName: nameTok.value,
      paramCount,
      hasReturnType,
      exported,
    });
  }
  return { unit: null, nextIndex: constIdx };
}

export function tryExtractFunctionDecl(
  ctx: FileScanContext,
  fnKwIdx: number,
  exported: boolean,
): { unit: SymbolUnit | null; nextIndex: number } {
  let nameIdx = fnKwIdx + 1;
  if (
    ctx.tokens[nameIdx]?.kind === 'punct' &&
    ctx.tokens[nameIdx]?.value === '*'
  ) {
    nameIdx += 1;
  }
  let fnName = 'default';
  if (ctx.tokens[nameIdx]?.kind === 'ident') {
    fnName = ctx.tokens[nameIdx]!.value;
    nameIdx += 1;
  }
  const cur = skipGenericArgs(ctx.tokens, nameIdx);
  if (ctx.tokens[cur]?.kind !== 'punct' || ctx.tokens[cur]?.value !== '(') {
    return { unit: null, nextIndex: fnKwIdx };
  }

  const sig = inspectSignature(ctx.tokens, cur);
  const bodyStart = findFunctionBodyStart(ctx.tokens, sig.closeParenIdx);
  if (bodyStart < 0) return { unit: null, nextIndex: fnKwIdx };

  return buildFunctionUnit(ctx, {
    declStartIdx: fnKwIdx,
    bodyStartIdx: bodyStart,
    fnName,
    paramCount: sig.paramCount,
    hasReturnType: sig.hasReturnType,
    exported,
  });
}

export function extractClassAndMethods(
  ctx: FileScanContext,
  classKwIdx: number,
  exported: boolean,
): { symbols: SymbolUnit[]; nextIndex: number } {
  const nameTok = ctx.tokens[classKwIdx + 1];
  const className =
    nameTok?.kind === 'ident' ? nameTok.value : 'AnonymousClass';
  let bodyStart = classKwIdx + 1;
  let angle = 0;
  while (bodyStart < ctx.tokens.length) {
    const t = ctx.tokens[bodyStart]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (pv === '<') angle += 1;
    else if (pv === '>' && angle > 0) angle -= 1;
    else if (angle === 0 && pv === '{') break;
    else if (angle === 0 && pv === ';')
      return { symbols: [], nextIndex: bodyStart };
    bodyStart += 1;
  }
  if (bodyStart >= ctx.tokens.length)
    return { symbols: [], nextIndex: classKwIdx };
  const classEnd = findMatchingBrace(ctx.tokens, bodyStart);
  const extracted: SymbolUnit[] = [
    {
      id: `${ctx.pkg.name}::${ctx.relFile}#${className}@${ctx.tokens[classKwIdx]!.line}`,
      pkgName: ctx.pkg.name,
      pkgDir: ctx.pkg.dir,
      domainId: ctx.pkg.domainId,
      layer: ctx.pkg.layer,
      file: ctx.relFile,
      name: className,
      symbolKind: 'class',
      exported,
      isInfra: ctx.isInfra,
      startLine: ctx.tokens[classKwIdx]!.line,
      endLine: ctx.tokens[classEnd]!.line,
      sloc: countSloc(
        ctx.sourceLines
          .slice(ctx.tokens[classKwIdx]!.line - 1, ctx.tokens[classEnd]!.line)
          .join('\n'),
      ),
      paramCount: 0,
      hasExplicitReturnType: true,
      rawDigest: sha256Short(`class:${className}`),
      normalizedDigest: sha256Short('class:$ID'),
      shingles: [],
      sideEffects: ['pure'],
      builtins: [...ctx.builtins],
      relativeImports: [...ctx.relativeImports],
      internalTypeImports: [...ctx.internalTypeImports],
      rustReadiness: {
        score: 85,
        grade: 'high',
        hazards: [],
        ioBoundaryMixed: false,
        recommendation: '类声明建议拆分数据结构体与纯方法 impl',
      },
    },
  ];

  let mDepth = 0;
  for (let i = bodyStart + 1; i < classEnd; i += 1) {
    const tok = ctx.tokens[i]!;
    if (tok.kind === 'punct' && (tok.value === '{' || tok.value === '${')) {
      mDepth += 1;
      continue;
    }
    if (tok.kind === 'punct' && tok.value === '}') {
      mDepth = Math.max(0, mDepth - 1);
      continue;
    }
    if (mDepth !== 0 || tok.kind !== 'ident') continue;
    if (CLASS_MODIFIERS.has(tok.value) || NON_METHOD_KEYWORDS.has(tok.value))
      continue;

    const afterName = skipGenericArgs(ctx.tokens, i + 1);
    if (ctx.tokens[afterName]?.value !== '(') continue;
    const sig = inspectSignature(ctx.tokens, afterName);
    const fnBody = findFunctionBodyStart(ctx.tokens, sig.closeParenIdx);
    if (fnBody < 0 || fnBody >= classEnd) continue;

    const methodRes = buildFunctionUnit(ctx, {
      declStartIdx: i,
      bodyStartIdx: fnBody,
      fnName: `${className}.${tok.value}`,
      paramCount: sig.paramCount,
      hasReturnType: sig.hasReturnType,
      exported,
    });
    extracted.push(methodRes.unit);
    i = methodRes.nextIndex;
  }

  return { symbols: extracted, nextIndex: classEnd };
}
