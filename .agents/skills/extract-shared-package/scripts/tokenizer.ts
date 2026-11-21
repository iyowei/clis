/**
 * 顶层符号提取与文件级画像聚合 (兼容有/无分号风格、高阶箭头返回类型与表达式箭头)。
 */
import {
  buildNormalizedShingles,
  detectSideEffects,
  evaluateRustReadiness,
  evaluateTypeRustReadiness,
  sha256Short,
} from './fingerprint.ts';
import { isInfraPath } from './fs-utils.ts';
import {
  extractImports,
  extractModuleSpecifiers,
  isImportDeclarationStart,
} from './import-parser.ts';
import {
  type ParsedImport,
  type ScannedToken,
  countSloc,
  tokenizeSource,
} from './lexer.ts';
import {
  TOP_LEVEL_DECL_KW,
  extractClassAndMethods,
  tryExtractArrowOrFnExpr,
  tryExtractFunctionDecl,
} from './symbol-extractors.ts';
import { type FileScanContext, findMatchingBrace } from './syntax-helpers.ts';
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
  fileShingles: string[];
  fileNormalizedDigest: string;
  sideEffects: SideEffectTag[];
  rustReadiness: RustReadinessProfile;
}

function findImportStatementEnd(
  tokens: readonly ScannedToken[],
  importIdx: number,
): number {
  let inBraces = false;
  let k = importIdx + 1;
  while (k < tokens.length) {
    const t = tokens[k]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (!inBraces && pv === ';') return k;
    if (pv === '{') inBraces = true;
    else if (pv === '}' && inBraces) inBraces = false;
    else if (!inBraces && t.kind === 'keyword' && t.value === 'from') {
      if (tokens[k + 1]?.kind === 'string') {
        return tokens[k + 2]?.kind === 'punct' && tokens[k + 2]?.value === ';'
          ? k + 2
          : k + 1;
      }
    } else if (
      !inBraces &&
      t.kind === 'string' &&
      tokens[k - 1]?.value === 'import'
    ) {
      return tokens[k + 1]?.kind === 'punct' && tokens[k + 1]?.value === ';'
        ? k + 1
        : k;
    } else if (
      !inBraces &&
      k > importIdx + 1 &&
      t.kind === 'keyword' &&
      TOP_LEVEL_DECL_KW.has(t.value)
    ) {
      return k - 1;
    }
    k += 1;
  }
  return tokens.length - 1;
}

function findTypeAliasEnd(
  tokens: readonly ScannedToken[],
  typeKwIdx: number,
): number {
  let depth = 0;
  let angle = 0;
  const startLine = tokens[typeKwIdx]!.line;
  for (let k = typeKwIdx + 1; k < tokens.length; k += 1) {
    const t = tokens[k]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (pv === '(' || pv === '{' || pv === '[') depth += 1;
    else if (pv === ')' || pv === '}' || pv === ']')
      depth = Math.max(0, depth - 1);
    else if (pv === '<') angle += 1;
    else if (pv === '>' && angle > 0) angle -= 1;
    else if (depth === 0 && angle === 0) {
      if (pv === ';') return k;
      if (
        t.line > startLine &&
        t.kind === 'keyword' &&
        TOP_LEVEL_DECL_KW.has(t.value)
      ) {
        return k - 1;
      }
    }
  }
  return tokens.length - 1;
}

function findReExportEnd(tokens: readonly ScannedToken[], idx: number): number {
  if (tokens[idx]?.value !== 'export') return -1;
  let cur = idx + 1;
  if (tokens[cur]?.kind === 'keyword' && tokens[cur]?.value === 'type')
    cur += 1;
  if (!(
    tokens[cur]?.kind === 'punct' &&
    (tokens[cur]?.value === '{' || tokens[cur]?.value === '*')
  )) {
    return -1;
  }
  let inBraces = tokens[cur]?.value === '{';
  while (cur < tokens.length) {
    const t = tokens[cur]!;
    const pv = t.kind === 'punct' ? t.value : '';
    if (!inBraces && pv === ';') return -1;
    if (pv === '}') inBraces = false;
    if (!inBraces && t.kind === 'keyword' && t.value === 'from') {
      if (tokens[cur + 1]?.kind === 'string') {
        return tokens[cur + 2]?.kind === 'punct' &&
          tokens[cur + 2]?.value === ';'
          ? cur + 2
          : cur + 1;
      }
      return -1;
    }
    if (
      !inBraces &&
      cur > idx + 1 &&
      t.kind === 'keyword' &&
      t.value !== 'type' &&
      t.value !== 'as'
    ) {
      return -1;
    }
    cur += 1;
  }
  return -1;
}

/** 分析单个 TS/JS 源码文件, 返回完整符号画像与文件级可执行指纹 */
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
  for (const spec of extractModuleSpecifiers(tokens)) {
    if (spec.startsWith('.')) relativeImports.add(spec);
  }

  const isInfra = isInfraPath(relFile);
  const ctx: FileScanContext = {
    pkg,
    relFile,
    isInfra,
    sourceLines: content.split('\n'),
    tokens,
    builtins: [...builtins].sort(),
    relativeImports: [...relativeImports].sort(),
    internalTypeImports: [...internalTypeImports].sort(),
  };

  const symbols: SymbolUnit[] = [];
  const execTokens: ScannedToken[] = [];
  let braceDepth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (braceDepth === 0 && isImportDeclarationStart(tokens, i)) {
      i = findImportStatementEnd(tokens, i);
      continue;
    }
    if (braceDepth === 0 && tok.kind === 'keyword' && tok.value === 'export') {
      const reExportEnd = findReExportEnd(tokens, i);
      if (reExportEnd >= i) {
        i = reExportEnd;
        continue;
      }
    }
    if (tok.kind === 'punct' && (tok.value === '{' || tok.value === '${')) {
      braceDepth += 1;
      execTokens.push(tok);
      continue;
    }
    if (tok.kind === 'punct' && tok.value === '}') {
      braceDepth = Math.max(0, braceDepth - 1);
      execTokens.push(tok);
      continue;
    }
    if (braceDepth !== 0) {
      execTokens.push(tok);
      continue;
    }

    const exported =
      tokens[i - 1]?.value === 'export' ||
      tokens[i - 2]?.value === 'export' ||
      (tokens[i - 1]?.value === 'default' &&
        tokens[i - 2]?.value === 'export') ||
      (tokens[i - 1]?.value === 'async' &&
        tokens[i - 2]?.value === 'default' &&
        tokens[i - 3]?.value === 'export');

    if (tok.kind === 'keyword' && tok.value === 'function') {
      const res = tryExtractFunctionDecl(ctx, i, exported);
      if (res.unit !== null) symbols.push(res.unit);
      for (let k = i; k <= res.nextIndex; k += 1) execTokens.push(tokens[k]!);
      i = res.nextIndex;
      continue;
    }
    if (tok.kind === 'keyword' && tok.value === 'const') {
      const res = tryExtractArrowOrFnExpr(ctx, i, exported);
      if (res.unit !== null) symbols.push(res.unit);
      for (let k = i; k <= res.nextIndex; k += 1) execTokens.push(tokens[k]!);
      i = res.nextIndex;
      continue;
    }
    if (tok.kind === 'keyword' && tok.value === 'class') {
      const res = extractClassAndMethods(ctx, i, exported);
      for (const sym of res.symbols) symbols.push(sym);
      for (let k = i; k <= res.nextIndex; k += 1) execTokens.push(tokens[k]!);
      i = res.nextIndex;
      continue;
    }
    if (
      exported &&
      tok.kind === 'keyword' &&
      (tok.value === 'interface' || tok.value === 'type')
    ) {
      const nameTok = tokens[i + 1];
      let declEnd = i + 2;
      if (tok.value === 'interface') {
        while (declEnd < tokens.length && tokens[declEnd]!.value !== '{')
          declEnd += 1;
        if (declEnd < tokens.length)
          declEnd = findMatchingBrace(tokens, declEnd);
      } else {
        declEnd = findTypeAliasEnd(tokens, i);
      }
      if (nameTok !== undefined && nameTok.kind === 'ident') {
        symbols.push({
          id: `${pkg.name}::${relFile}#${nameTok.value}@${tok.line}`,
          pkgName: pkg.name,
          pkgDir: pkg.dir,
          domainId: pkg.domainId,
          layer: pkg.layer,
          file: relFile,
          name: nameTok.value,
          symbolKind: 'type',
          exported: true,
          isInfra,
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
          rustReadiness: evaluateTypeRustReadiness(
            nameTok.value,
            tokens.slice(i, declEnd + 1),
          ),
        });
      }
      i = declEnd;
      continue;
    }
    execTokens.push(tok);
  }

  const fileFingerprints = buildNormalizedShingles(execTokens);
  const sideEffects = detectSideEffects(content, ctx.builtins);
  return {
    sloc: countSloc(content),
    imports,
    builtins: [...ctx.builtins],
    externalDeps: [...externalDeps].sort(),
    relativeImports: [...ctx.relativeImports],
    internalTypeImports: [...internalTypeImports].sort(),
    symbols,
    fileShingles: fileFingerprints.shingles,
    fileNormalizedDigest: fileFingerprints.normalizedDigest,
    sideEffects,
    rustReadiness: evaluateRustReadiness(tokens, sideEffects, true, false),
  };
}
