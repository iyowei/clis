/**
 * 代码片段副作用归类、α-归一化 Shingle 指纹生成与 Rust 可转写度深度评估。
 *
 * 相比初版仅查 any/Proxy/eval, 补齐 5 类真实影响 Rust 所有权与类型系统的结构陷阱:
 * - unbounded-record: Record<string, unknown|any> 或动态索引签名
 * - untyped-throw: 非结构化 throw 语句
 * - mut-closure-capture: 函数内定义闭包且存在可变局部变量捕获修改
 * - dynamic-typeof-narrowing: 大量基于 typeof / Array.isArray 的运行时分叉收窄
 * - recursive-self-ref: 自引用递归接口/类型定义 (须 Box<T> 或索引池化)
 */
import { createHash } from 'node:crypto';

import type { ScannedToken } from './lexer.ts';
import type { RustReadinessProfile, SideEffectTag } from './types.ts';

const FS_MARKERS: readonly string[] = [
  'node:fs',
  'readFileSync',
  'writeFileSync',
  'mkdirSync',
  'rmSync',
  'readdirSync',
  'statSync',
  'lstatSync',
  'existsSync',
  'copyFileSync',
  'renameSync',
];

const PROCESS_MARKERS: readonly string[] = [
  'node:child_process',
  'spawnSync',
  'spawn',
  'execSync',
  'execFileSync',
  'process.exit',
  'Bun.spawn',
];

const TTY_MARKERS: readonly string[] = [
  'node:readline',
  'isTTY',
  'process.stdin',
  'process.stdout',
  'process.stderr',
  'setRawMode',
];

const ENV_MARKERS: readonly string[] = [
  'process.env',
  'Bun.env',
  'HOME',
  'USERPROFILE',
];

const NETWORK_MARKERS: readonly string[] = [
  'node:http',
  'node:https',
  'fetch',
  'WebSocket',
];

const MUT_ARRAY_METHODS = new Set([
  'push',
  'pop',
  'shift',
  'unshift',
  'splice',
  'sort',
]);

export function sha256Short(text: string, len = 12): string {
  return createHash('sha256').update(text).digest('hex').slice(0, len);
}

/** 扫描代码块宿主副作用标签 */
export function detectSideEffects(
  text: string,
  builtins: readonly string[],
): SideEffectTag[] {
  const tags = new Set<SideEffectTag>();
  const combined = `${builtins.join(' ')}\n${text}`;
  if (FS_MARKERS.some((m) => combined.includes(m))) tags.add('fs');
  if (PROCESS_MARKERS.some((m) => combined.includes(m))) tags.add('process');
  if (TTY_MARKERS.some((m) => combined.includes(m))) tags.add('tty');
  if (ENV_MARKERS.some((m) => combined.includes(m))) tags.add('env');
  if (NETWORK_MARKERS.some((m) => combined.includes(m))) tags.add('network');
  if (tags.size === 0) tags.add('pure');
  return [...tags].sort();
}

function collectLetDeclNames(
  tokens: readonly ScannedToken[],
  letIdx: number,
  declDepth: number,
): { names: Array<{ name: string; declDepth: number }>; nextIdx: number } {
  const names: Array<{ name: string; declDepth: number }> = [];
  let p = letIdx + 1;
  let subDepth = 0;
  let expectName = true;
  const letLine = tokens[letIdx]!.line;
  while (p < tokens.length) {
    const t = tokens[p]!;
    if (t.value === '(' || t.value === '{' || t.value === '[') {
      subDepth += 1;
      expectName = false;
    } else if (t.value === ')' || t.value === '}' || t.value === ']') {
      if (subDepth === 0) break;
      subDepth -= 1;
    } else if (subDepth === 0) {
      if (t.value === ';') return { names, nextIdx: p };
      if (t.line > letLine && expectName) break;
      if (t.value === ',') {
        expectName = true;
        p += 1;
        continue;
      }
      if (t.value === '=' || t.value === ':') {
        expectName = false;
      } else if (expectName && t.kind === 'ident') {
        names.push({ name: t.value, declDepth });
        expectName = false;
      } else if (
        t.kind === 'keyword' &&
        (t.value === 'let' ||
          t.value === 'const' ||
          t.value === 'if' ||
          t.value === 'return')
      ) {
        break;
      }
    }
    p += 1;
  }
  return { names, nextIdx: Math.max(letIdx, p - 1) };
}

function detectMutClosureCapture(tokens: readonly ScannedToken[]): boolean {
  const declaredLets: Array<{ name: string; declDepth: number }> = [];
  const blockClosureDepths: number[] = [];
  let exprClosureParenDepth = -1;
  let exprClosureBraceDepth = -1;
  let depth = 0;
  let parenDepth = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const next = tokens[i + 1];

    const pv = tok.kind === 'punct' ? tok.value : '';
    const nextPv = next?.kind === 'punct' ? next.value : '';

    if (pv === '(') parenDepth += 1;
    else if (pv === ')') {
      if (exprClosureParenDepth > 0 && parenDepth === exprClosureParenDepth) {
        exprClosureParenDepth = -1;
        exprClosureBraceDepth = -1;
      }
      parenDepth = Math.max(0, parenDepth - 1);
    }

    if (pv === '=>' && next !== undefined) {
      if (nextPv === '{') {
        blockClosureDepths.push(depth + 1);
        exprClosureParenDepth = -1;
        exprClosureBraceDepth = -1;
      } else {
        exprClosureParenDepth = parenDepth;
        exprClosureBraceDepth = depth;
      }
      continue;
    }

    if (tok.kind === 'keyword' && tok.value === 'function' && i > 0) {
      let scan = i + 1;
      let pD = 0;
      while (scan < tokens.length) {
        const st = tokens[scan]!;
        const sv = st.kind === 'punct' ? st.value : '';
        if (sv === '(') pD += 1;
        else if (sv === ')') pD = Math.max(0, pD - 1);
        else if (pD === 0 && sv === '{') {
          blockClosureDepths.push(depth + 1);
          break;
        } else if (pD === 0 && sv === ';') break;
        scan += 1;
      }
      continue;
    }

    if (pv === '{' || pv === '${') {
      depth += 1;
      continue;
    }

    if (pv === '}') {
      if (
        blockClosureDepths.length > 0 &&
        blockClosureDepths[blockClosureDepths.length - 1] === depth
      ) {
        blockClosureDepths.pop();
      }
      for (let k = declaredLets.length - 1; k >= 0; k -= 1) {
        if (declaredLets[k]!.declDepth >= depth) declaredLets.splice(k, 1);
      }
      depth = Math.max(0, depth - 1);
      if (exprClosureBraceDepth >= 0 && depth < exprClosureBraceDepth) {
        exprClosureParenDepth = -1;
        exprClosureBraceDepth = -1;
      }
      continue;
    }

    if (
      exprClosureBraceDepth >= 0 &&
      depth === exprClosureBraceDepth &&
      parenDepth === exprClosureParenDepth &&
      (pv === ';' || pv === ',')
    ) {
      exprClosureParenDepth = -1;
      exprClosureBraceDepth = -1;
      continue;
    }

    if (tok.kind === 'keyword' && tok.value === 'let') {
      const { names, nextIdx } = collectLetDeclNames(tokens, i, depth);
      for (const item of names) declaredLets.push(item);
      if (
        nextIdx > i &&
        !tokens.slice(i, nextIdx + 1).some((t) => t.value === '=>')
      ) {
        // 仅跳过纯声明标识符阶段, 继续扫描初始化右侧可能存在的闭包
      }
      continue;
    }

    const blockTop =
      blockClosureDepths.length > 0
        ? blockClosureDepths[blockClosureDepths.length - 1]!
        : -1;
    const exprDepth =
      exprClosureBraceDepth >= 0 ? exprClosureBraceDepth + 1 : -1;
    const activeClosureDepth = Math.max(blockTop, exprDepth);

    if (activeClosureDepth > 0 && tok.kind === 'ident') {
      const captured = declaredLets.some(
        (d) => d.name === tok.value && d.declDepth < activeClosureDepth,
      );
      if (!captured) continue;
      if (
        next?.value === '=' ||
        next?.value === '+=' ||
        next?.value === '-=' ||
        next?.value === '*=' ||
        next?.value === '++' ||
        next?.value === '--' ||
        (next?.value === '.' &&
          MUT_ARRAY_METHODS.has(tokens[i + 2]?.value ?? ''))
      ) {
        return true;
      }
    }
  }
  return false;
}

function hasUnboundedRecord(tokens: readonly ScannedToken[]): boolean {
  for (let i = 0; i < tokens.length - 4; i += 1) {
    if (
      tokens[i]!.value === 'Record' &&
      tokens[i + 1]?.value === '<' &&
      tokens[i + 2]?.value === 'string' &&
      tokens[i + 3]?.value === ',' &&
      (tokens[i + 4]?.value === 'unknown' || tokens[i + 4]?.value === 'any')
    ) {
      return true;
    }
    if (
      tokens[i]!.value === '[' &&
      tokens[i + 2]?.value === ':' &&
      tokens[i + 3]?.value === 'string' &&
      tokens[i + 4]?.value === ']' &&
      tokens[i + 5]?.value === ':' &&
      (tokens[i + 6]?.value === 'unknown' || tokens[i + 6]?.value === 'any')
    ) {
      return true;
    }
  }
  return false;
}

/** 评估代码单元对 TS -> Rust 确定性转写的友好程度 */
export function evaluateRustReadiness(
  tokens: readonly ScannedToken[],
  sideEffects: readonly SideEffectTag[],
  hasExplicitReturnType: boolean,
  isFunction: boolean,
): RustReadinessProfile {
  const hazards = new Set<string>();
  let typeofCount = 0;

  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1];
    const next = tokens[i + 1];
    if (
      tok.kind === 'ident' &&
      tok.value === 'any' &&
      (prev?.value === ':' || prev?.value === 'as' || prev?.value === '<')
    ) {
      hazards.add('any-type');
    } else if (tok.value === 'Proxy' || tok.value === 'Reflect') {
      hazards.add('meta-programming');
    } else if (tok.value === 'eval' && next?.value === '(') {
      hazards.add('dynamic-eval');
    } else if (tok.value === 'import' && next?.value === '(') {
      hazards.add('dynamic-import');
    } else if (
      tok.value === 'new' &&
      next?.kind === 'ident' &&
      next.value === 'Function'
    ) {
      hazards.add('dynamic-function');
    } else if (tok.kind === 'keyword' && tok.value === 'throw') {
      hazards.add('untyped-throw');
    } else if (
      (tok.kind === 'keyword' && tok.value === 'typeof') ||
      (tok.value === 'Array' &&
        next?.value === '.' &&
        tokens[i + 2]?.value === 'isArray')
    ) {
      typeofCount += 1;
    }
  }

  if (hasUnboundedRecord(tokens)) hazards.add('unbounded-record');
  if (typeofCount >= 1) hazards.add('dynamic-typeof-narrowing');
  if (detectMutClosureCapture(tokens)) hazards.add('mut-closure-capture');

  const nonPureEffects = sideEffects.filter((e) => e !== 'pure');
  const ioBoundaryMixed = nonPureEffects.length >= 2;
  let score = 100 - hazards.size * 20;
  if (isFunction && !hasExplicitReturnType) score -= 15;
  if (ioBoundaryMixed) score -= 20;
  if (score < 0) score = 0;

  let grade: 'high' | 'medium' | 'low' = 'high';
  if (score < 45) grade = 'low';
  else if (score < 75) grade = 'medium';

  const notes: string[] = [];
  if (hazards.size > 0) notes.push(`清理转写障碍 (${[...hazards].join(', ')})`);
  if (isFunction && !hasExplicitReturnType)
    notes.push('补齐显式返回值类型注解');
  if (ioBoundaryMixed) {
    notes.push(`将纯计算与多层宿主 I/O (${nonPureEffects.join('+')}) 分离`);
  }

  return {
    score,
    grade,
    hazards: [...hazards].sort(),
    ioBoundaryMixed,
    recommendation:
      notes.length === 0
        ? '强契约低耦合, 可直接一对一转写为 Rust crate'
        : notes.join('; '),
  };
}

/** 评估导出 interface / type 是否自引用递归 */
export function evaluateTypeRustReadiness(
  typeName: string,
  declTokens: readonly ScannedToken[],
): RustReadinessProfile {
  const hazards: string[] = [];
  // 从下标 2 (跳过 type/interface 与自身名) 后若再出现同名引用即属递归结构
  const isSelfRef = declTokens
    .slice(2)
    .some((t) => t.kind === 'ident' && t.value === typeName);
  if (isSelfRef) hazards.push('recursive-self-ref');
  if (hasUnboundedRecord(declTokens)) hazards.push('unbounded-record');

  const score = Math.max(0, 100 - hazards.length * 25);
  let grade: 'high' | 'medium' | 'low' = 'high';
  if (score < 45) grade = 'low';
  else if (score < 75) grade = 'medium';

  return {
    score,
    grade,
    hazards: hazards.sort(),
    ioBoundaryMixed: false,
    recommendation:
      hazards.length === 0
        ? '显式类型契约可直接映射为 Rust struct/enum'
        : `类型须显式适配 (${hazards.join(', ')}: 递归改 Box/索引池, 字典改枚举)`,
  };
}

/** 对 Token 切片执行 α-归一化并生成 5-gram Shingle 集合 */
export function buildNormalizedShingles(tokens: readonly ScannedToken[]): {
  normalizedDigest: string;
  shingles: string[];
} {
  const norm: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1];
    if (tok.kind === 'string' || tok.kind === 'regex') norm.push('$STR');
    else if (tok.kind === 'number') norm.push('$NUM');
    else if (tok.kind === 'ident') {
      norm.push(
        prev?.value === '.' || prev?.value === '?.' ? tok.value : '$ID',
      );
    } else norm.push(tok.value);
  }

  const joined = norm.join(' ');
  const normalizedDigest = sha256Short(joined);
  const shingleSet = new Set<string>();
  const windowSize = 5;
  if (norm.length <= windowSize) {
    if (norm.length > 0) shingleSet.add(sha256Short(joined, 8));
  } else {
    for (let i = 0; i <= norm.length - windowSize; i += 1) {
      shingleSet.add(sha256Short(norm.slice(i, i + windowSize).join(' '), 8));
    }
  }

  return { normalizedDigest, shingles: [...shingleSet].sort() };
}
