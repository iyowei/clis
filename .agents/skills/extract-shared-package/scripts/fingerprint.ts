/**
 * 代码片段副作用归类、α-归一化 Shingle 指纹生成与 Rust 可转写度评估。
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

/** 评估代码单元对 TS -> Rust 确定性转写的友好程度 */
export function evaluateRustReadiness(
  tokens: readonly ScannedToken[],
  sideEffects: readonly SideEffectTag[],
  hasExplicitReturnType: boolean,
  isFunction: boolean,
): RustReadinessProfile {
  const hazards = new Set<string>();
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
    }
  }

  const nonPureEffects = sideEffects.filter((e) => e !== 'pure');
  const ioBoundaryMixed = nonPureEffects.length >= 2;
  let score = 100 - hazards.size * 25;
  if (isFunction && !hasExplicitReturnType) score -= 15;
  if (ioBoundaryMixed) score -= 20;
  if (score < 0) score = 0;

  let grade: 'high' | 'medium' | 'low' = 'high';
  if (score < 45) grade = 'low';
  else if (score < 75) grade = 'medium';

  const notes: string[] = [];
  if (hazards.size > 0) notes.push(`移除动态陷阱 (${[...hazards].join(', ')})`);
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

/** 对 Token 切片执行 α-归一化并生成 5-gram Shingle 集合 */
export function buildNormalizedShingles(tokens: readonly ScannedToken[]): {
  normalizedDigest: string;
  shingles: string[];
} {
  const norm: string[] = [];
  for (let i = 0; i < tokens.length; i += 1) {
    const tok = tokens[i]!;
    const prev = tokens[i - 1];
    if (tok.kind === 'string') norm.push('$STR');
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
