/**
 * 顶层符号提取与文件级画像聚合 (封装 lexer + fingerprint)。
 */
import {
  buildNormalizedShingles,
  detectSideEffects,
  evaluateRustReadiness,
  sha256Short,
} from './fingerprint.ts';
import {
  type ParsedImport,
  type ScannedToken,
  countSloc,
  extractImports,
  tokenizeSource,
} from './lexer.ts';
import type {
  RustReadinessProfile,
  SideEffectTag,
  SymbolUnit,
  WorkspacePackageNode,
} from './types.ts';

export { tokenizeSource, countSloc, extractImports };

export interface AnalyzedFileResult {
  sloc: number;
  imports: ParsedImport[];
  builtins: string[];
  externalDeps: string[];
  relativeImports: string[];
  internalTypeImports: string[];
  symbols: SymbolUnit[];
  sideEffects: SideEffectTag[];
  rustReadiness: RustReadinessProfile;
}

interface FileScanContext {
  pkg: WorkspacePackageNode;
  relFile: string;
  sourceLines: readonly string[];
  tokens: readonly ScannedToken[];
  builtins: readonly string[];
  relativeImports: readonly string[];
  internalTypeImports: readonly string[];
}

function findMatchingBrace(
  tokens: readonly ScannedToken[],
  openIdx: number,
): number {
  let depth = 0;
  for (let i = openIdx; i < tokens.length; i += 1) {
    const val = tokens[i]!.value;
    if (val === '{' || val === '${') depth += 1;
    else if (val === '}') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return tokens.length - 1;
}

function skipGenericArgs(
  tokens: readonly ScannedToken[],
  startIdx: number,
): number {
  if (tokens[startIdx]?.value !== '<') return startIdx;
  let angle = 0;
  let cur = startIdx;
  while (cur < tokens.length) {
    if (tokens[cur]!.value === '<') angle += 1;
    else if (tokens[cur]!.value === '>') {
      angle -= 1;
      if (angle === 0) return cur + 1;
    }
    cur += 1;
  }
  return cur;
}

function inspectSignature(
  tokens: readonly ScannedToken[],
  openParenIdx: number,
): { closeParenIdx: number; paramCount: number; hasReturnType: boolean } {
  let depth = 0;
  let commaCount = 0;
  let hasContent = false;
  let closeIdx = openParenIdx;

  for (let i = openParenIdx; i < tokens.length; i += 1) {
    const val = tokens[i]!.value;
    if (val === '(') depth += 1;
    else if (val === ')') {
      depth -= 1;
      if (depth === 0) {
        closeIdx = i;
        break;
      }
    } else if (depth === 1 && val === ',') {
      commaCount += 1;
    } else if (depth >= 1) {
      hasContent = true;
    }
  }

  return {
    closeParenIdx: closeIdx,
    paramCount: hasContent ? commaCount + 1 : 0,
    hasReturnType: tokens[closeIdx + 1]?.value === ':',
  };
}

interface BuildFnSpec {
  declStartIdx: number;
  bodyStartIdx: number;
  fnName: string;
  paramCount: number;
  hasReturnType: boolean;
  exported: boolean;
}

function buildFunctionUnit(
  ctx: FileScanContext,
  spec: BuildFnSpec,
): { unit: SymbolUnit; nextIndex: number } {
  const bodyEnd = findMatchingBrace(ctx.tokens, spec.bodyStartIdx);
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

function tryExtractArrowConst(
  ctx: FileScanContext,
  constIdx: number,
  exported: boolean,
): { unit: SymbolUnit | null; nextIndex: number } {
  const nameTok = ctx.tokens[constIdx + 1];
  if (nameTok === undefined || nameTok.kind !== 'ident') {
    return { unit: null, nextIndex: constIdx };
  }

  let eqIdx = constIdx + 2;
  let parenDepth = 0;
  while (eqIdx < ctx.tokens.length) {
    const val = ctx.tokens[eqIdx]!.value;
    if (val === '(') parenDepth += 1;
    else if (val === ')') parenDepth = Math.max(0, parenDepth - 1);
    else if (parenDepth === 0 && val === '=') break;
    else if (parenDepth === 0 && val === ';') {
      return { unit: null, nextIndex: eqIdx };
    }
    eqIdx += 1;
  }
  if (eqIdx >= ctx.tokens.length) return { unit: null, nextIndex: constIdx };

  let cur = eqIdx + 1;
  if (ctx.tokens[cur]?.value === 'async') cur += 1;
  cur = skipGenericArgs(ctx.tokens, cur);
  if (ctx.tokens[cur]?.value !== '(')
    return { unit: null, nextIndex: constIdx };

  const sig = inspectSignature(ctx.tokens, cur);
  let scan = sig.closeParenIdx + 1;
  let seenArrow = false;
  while (scan < ctx.tokens.length) {
    const val = ctx.tokens[scan]!.value;
    if (val === '=>') seenArrow = true;
    else if (val === '{' && seenArrow) {
      return buildFunctionUnit(ctx, {
        declStartIdx: constIdx,
        bodyStartIdx: scan,
        fnName: nameTok.value,
        paramCount: sig.paramCount,
        hasReturnType: sig.hasReturnType,
        exported,
      });
    } else if (val === ';' || (!seenArrow && val === '{')) {
      return { unit: null, nextIndex: constIdx };
    }
    scan += 1;
  }
  return { unit: null, nextIndex: constIdx };
}

function tryExtractFunctionDecl(
  ctx: FileScanContext,
  fnKwIdx: number,
  exported: boolean,
): { unit: SymbolUnit | null; nextIndex: number } {
  const nameTok = ctx.tokens[fnKwIdx + 1];
  if (nameTok === undefined || nameTok.kind !== 'ident') {
    return { unit: null, nextIndex: fnKwIdx };
  }

  const cur = skipGenericArgs(ctx.tokens, fnKwIdx + 2);
  if (ctx.tokens[cur]?.value !== '(') return { unit: null, nextIndex: fnKwIdx };

  const sig = inspectSignature(ctx.tokens, cur);
  let bodyStart = sig.closeParenIdx + 1;
  while (
    bodyStart < ctx.tokens.length &&
    ctx.tokens[bodyStart]!.value !== '{'
  ) {
    if (ctx.tokens[bodyStart]!.value === ';') {
      return { unit: null, nextIndex: bodyStart };
    }
    bodyStart += 1;
  }
  if (bodyStart >= ctx.tokens.length) return { unit: null, nextIndex: fnKwIdx };

  return buildFunctionUnit(ctx, {
    declStartIdx: fnKwIdx,
    bodyStartIdx: bodyStart,
    fnName: nameTok.value,
    paramCount: sig.paramCount,
    hasReturnType: sig.hasReturnType,
    exported,
  });
}

/** 分析单个 TS/JS 源码文件, 返回完整符号画像与文件摘要 */
export function analyzeSourceFile(
  pkg: WorkspacePackageNode,
  relFile: string,
  content: string,
): AnalyzedFileResult {
  const tokens = tokenizeSource(content);
  const imports = extractImports(tokens);
  const builtins = new Set<string>();
  const externalDeps = new Set<string>();
  const relativeImports = new Set<string>();
  const internalTypeImports = new Set<string>();

  for (const imp of imports) {
    if (imp.specifier.startsWith('node:')) builtins.add(imp.specifier);
    else if (imp.specifier.startsWith('.')) {
      relativeImports.add(imp.specifier);
      if (imp.isTypeOnly) internalTypeImports.add(imp.specifier);
    } else {
      const parts = imp.specifier.split('/');
      externalDeps.add(
        imp.specifier.startsWith('@') ? parts.slice(0, 2).join('/') : parts[0]!,
      );
    }
  }

  const ctx: FileScanContext = {
    pkg,
    relFile,
    sourceLines: content.split('\n'),
    tokens,
    builtins: [...builtins].sort(),
    relativeImports: [...relativeImports].sort(),
    internalTypeImports: [...internalTypeImports].sort(),
  };
  const symbols: SymbolUnit[] = [];

  let braceDepth = 0;
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (tok.value === '{' || tok.value === '${') {
      braceDepth += 1;
      continue;
    }
    if (tok.value === '}') {
      if (braceDepth > 0) braceDepth -= 1;
      continue;
    }
    if (braceDepth !== 0) continue;

    const exported =
      tokens[i - 1]?.value === 'export' || tokens[i - 2]?.value === 'export';
    if (tok.kind === 'keyword' && tok.value === 'function') {
      const res = tryExtractFunctionDecl(ctx, i, exported);
      if (res.unit !== null) symbols.push(res.unit);
      i = res.nextIndex;
      continue;
    }
    if (tok.kind === 'keyword' && tok.value === 'const') {
      const res = tryExtractArrowConst(ctx, i, exported);
      if (res.unit !== null) symbols.push(res.unit);
      i = res.nextIndex;
      continue;
    }
    if (
      exported &&
      tok.kind === 'keyword' &&
      (tok.value === 'class' ||
        tok.value === 'interface' ||
        tok.value === 'type')
    ) {
      const nameTok = tokens[i + 1];
      if (nameTok !== undefined && nameTok.kind === 'ident') {
        symbols.push({
          id: `${pkg.name}::${relFile}#${nameTok.value}@${tok.line}`,
          pkgName: pkg.name,
          pkgDir: pkg.dir,
          domainId: pkg.domainId,
          layer: pkg.layer,
          file: relFile,
          name: nameTok.value,
          symbolKind: tok.value === 'class' ? 'class' : 'type',
          exported: true,
          startLine: tok.line,
          endLine: tok.line,
          sloc: 1,
          paramCount: 0,
          hasExplicitReturnType: true,
          rawDigest: sha256Short(`${tok.value}:${nameTok.value}`),
          normalizedDigest: sha256Short(`${tok.value}:$ID`),
          shingles: [],
          sideEffects: ['pure'],
          builtins: [...ctx.builtins],
          relativeImports: [...ctx.relativeImports],
          internalTypeImports: [...ctx.internalTypeImports],
          rustReadiness: {
            score: 100,
            grade: 'high',
            hazards: [],
            ioBoundaryMixed: false,
            recommendation: '显式类型契约可直接映射为 Rust struct/enum',
          },
        });
      }
    }
  }

  const sideEffects = detectSideEffects(content, ctx.builtins);
  return {
    sloc: countSloc(content),
    imports,
    builtins: [...ctx.builtins],
    externalDeps: [...externalDeps].sort(),
    relativeImports: [...ctx.relativeImports],
    internalTypeImports: [...ctx.internalTypeImports],
    symbols,
    sideEffects,
    rustReadiness: evaluateRustReadiness(tokens, sideEffects, true, false),
  };
}
