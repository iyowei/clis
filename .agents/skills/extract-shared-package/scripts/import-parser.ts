/**
 * TS/JS 模块依赖导入提取器: 支持有/无分号风格、re-export、动态 import() 与全 inline type 识别。
 */
import type { ParsedImport, ScannedToken } from './lexer.ts';

const PROP_KEY_PREV_TOKENS = new Set(['.', '{', ',', ':']);

export function isImportDeclarationStart(
  tokens: readonly ScannedToken[],
  idx: number,
): boolean {
  const tok = tokens[idx]!;
  if (tok.kind !== 'keyword' || tok.value !== 'import') return false;
  if (tokens[idx + 1]?.value === '(') return false;
  const prev = tokens[idx - 1];
  if (prev !== undefined && PROP_KEY_PREV_TOKENS.has(prev.value)) return false;
  return true;
}

function areAllNamedSpecifiersTypeOnly(
  tokens: readonly ScannedToken[],
  openBraceIdx: number,
  closeBraceIdx: number,
): boolean {
  let expectHead = true;
  let sawAny = false;
  for (let k = openBraceIdx + 1; k < closeBraceIdx; k += 1) {
    const val = tokens[k]!.value;
    if (val === ',') {
      expectHead = true;
      continue;
    }
    if (expectHead) {
      sawAny = true;
      if (val !== 'type') return false;
      expectHead = false;
    }
  }
  return sawAny;
}

function resolveFromSpecifier(
  tokens: readonly ScannedToken[],
  fromIdx: number,
  isTypeOnly: boolean,
  openBraceIdx: number,
  closeBraceIdx: number,
): ParsedImport | null {
  const specTok = tokens[fromIdx + 1];
  if (specTok?.kind !== 'string') return null;
  const allInlineType =
    !isTypeOnly &&
    openBraceIdx >= 0 &&
    closeBraceIdx > openBraceIdx &&
    areAllNamedSpecifiersTypeOnly(tokens, openBraceIdx, closeBraceIdx);
  return { specifier: specTok.value, isTypeOnly: isTypeOnly || allInlineType };
}

/** 从 token 流解析全部 static import 声明 (支持无分号与全 inline type 导入) */
export function extractImports(
  tokens: readonly ScannedToken[],
): ParsedImport[] {
  const imports: ParsedImport[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    if (!isImportDeclarationStart(tokens, i)) continue;

    const isTypeOnly = tokens[i + 1]?.value === 'type';
    let inBraces = false;
    let openBraceIdx = -1;
    let closeBraceIdx = -1;
    for (let j = i + 1; j < tokens.length; j += 1) {
      const cur = tokens[j]!;
      const pv = cur.kind === 'punct' ? cur.value : '';
      if (!inBraces && pv === ';') break;
      if (pv === '{') {
        inBraces = true;
        openBraceIdx = j;
        continue;
      }
      if (pv === '}' && inBraces) {
        inBraces = false;
        closeBraceIdx = j;
        continue;
      }
      if (cur.kind === 'keyword' && cur.value === 'from' && !inBraces) {
        const parsed = resolveFromSpecifier(
          tokens,
          j,
          isTypeOnly,
          openBraceIdx,
          closeBraceIdx,
        );
        if (parsed !== null) {
          imports.push(parsed);
          i = j + 1;
        }
        break;
      }
      if (cur.kind === 'string' && tokens[j - 1]?.value === 'import') {
        imports.push({ specifier: cur.value, isTypeOnly: false });
        i = j;
        break;
      }
      if (
        !inBraces &&
        j > i + 1 &&
        cur.kind === 'keyword' &&
        (cur.value === 'export' ||
          cur.value === 'import' ||
          cur.value === 'function' ||
          cur.value === 'const' ||
          cur.value === 'class')
      ) {
        break;
      }
    }
  }
  return imports;
}

/** 联合提取全部静态 import、re-export (`export { ... } from '...'` / `export * from '...'`) 与动态 `import('...')` */
export function extractModuleSpecifiers(
  tokens: readonly ScannedToken[],
): string[] {
  const specs = new Set(extractImports(tokens).map((i) => i.specifier));
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    if (
      tok.kind === 'keyword' &&
      tok.value === 'import' &&
      tokens[i + 1]?.value === '(' &&
      tokens[i + 2]?.kind === 'string'
    ) {
      specs.add(tokens[i + 2]!.value);
      i += 2;
      continue;
    }
    if (tok.kind !== 'keyword' || tok.value !== 'export') continue;
    let cur = i + 1;
    if (tokens[cur]?.value === 'type') cur += 1;
    if (tokens[cur]?.value !== '{' && tokens[cur]?.value !== '*') continue;
    let inBraces = tokens[cur]?.value === '{';
    while (cur < tokens.length) {
      const t = tokens[cur]!;
      if (!inBraces && t.value === ';') break;
      if (t.value === '}') inBraces = false;
      if (!inBraces && t.kind === 'keyword' && t.value === 'from') {
        if (tokens[cur + 1]?.kind === 'string') {
          specs.add(tokens[cur + 1]!.value);
          i = cur + 1;
        }
        break;
      }
      if (
        !inBraces &&
        cur > i + 1 &&
        t.kind === 'keyword' &&
        t.value !== 'type' &&
        t.value !== 'as'
      ) {
        break;
      }
      cur += 1;
    }
  }
  return [...specs];
}
