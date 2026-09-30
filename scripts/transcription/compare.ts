/**
 * 转写契约套件 · 比对层。
 *
 * 职责: 拿一条语料的 expect 面逐项量被测进程的实际结果 (退出码 / stdout 逐字节 /
 * stdout 与 stderr 的子串含与禁含 / 文件系统终态), 产出失败清单。本层只判不修: 不触碰现场, 不改被测行为。
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';

import {
  type ApiExpectSpec,
  type ExpectSpec,
  type FsExpectation,
  applyVars,
  replaceVarsDeep,
} from './corpus.ts';
import type { ExecOutcome } from './fixture.ts';
import { type FailureItem, clip } from './report.ts';

/** 找两段文本的首个差异行, 返回人话摘要 (行号从 1 起) */
export function firstLineDiff(expected: string, actual: string): string {
  const expectedLines = expected.split('\n');
  const actualLines = actual.split('\n');
  const max = Math.max(expectedLines.length, actualLines.length);
  for (let index = 0; index < max; index += 1) {
    const exp = expectedLines[index];
    const act = actualLines[index];
    if (exp === act) continue;
    if (exp === undefined)
      return `第 ${index + 1} 行起实际输出更长: 实际 "${clip(act ?? '')}"`;
    if (act === undefined)
      return `第 ${index + 1} 行起期望输出更长: 期望 "${clip(exp)}"`;
    return `首个差异在第 ${index + 1} 行: 期望 "${clip(exp)}", 实际 "${clip(act)}"`;
  }
  return '全文逐行相等但不逐字节相等 (差异在行尾字节)';
}

/**
 * 文件系统终态断言: gone (不存在) / exists (存在, lstat 语义) / empty (存在且空目录)。
 * 返回 null 即通过, 否则返回失败说明。
 */
export async function checkFs(
  root: string,
  item: FsExpectation,
): Promise<string | null> {
  const full = join(root, item.path);
  let info: Awaited<ReturnType<typeof lstat>> | null;
  try {
    info = await lstat(full);
  } catch {
    info = null;
  }

  if (item.state === 'gone') {
    return info === null ? null : `期望不存在, 实际存在 (${item.path})`;
  }
  if (info === null) return `期望存在, 实际不存在 (${item.path})`;
  if (item.state === 'exists') return null;

  if (!info.isDirectory()) return `期望为空目录, 实际不是目录 (${item.path})`;
  const entries = await readdir(full);
  return entries.length === 0
    ? null
    : `期望为空目录, 实际有 ${entries.length} 项 (${item.path})`;
}

/**
 * 逐项比对一条用例的全部断言。超时与执行级失败为短路项 (后续断言无意义, 只报该条)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   expect = { exitCode: 0, stdoutExact: '▍ SWEEP-NM  预览 · 1 个根: $FIXTURE/zone\n…', fs: [{ path: 'zone/a/node_modules', state: 'exists' }] }
 *   exec = { status: 0, stdout: '…与期望一致…', stderr: '', timedOut: false }
 *
 * 步骤 1：短路项检查
 *   timedOut / spawnError 均为假, 继续逐项比对
 *
 * 步骤 2：逐项 (退出码 → stdoutExact → 子串含与禁含 → fs)
 *   全部通过 → failures = []
 *
 * Output（数据契约）
 *   return [] (通过) 或 FailureItem[] (逐项失败原因与期望 / 实际)
 * ```
 */
export async function compareCase(
  expect: ExpectSpec,
  exec: ExecOutcome,
  root: string,
): Promise<FailureItem[]> {
  const failures: FailureItem[] = [];

  if (exec.timedOut) {
    failures.push({
      kind: 'timeout',
      message: '执行超时 (超时守卫击中, 进程已被杀), 判失败',
    });
    return failures;
  }
  if (exec.spawnError !== undefined) {
    failures.push({
      kind: 'spawn',
      message: `被测命令无法执行: ${exec.spawnError}`,
    });
    return failures;
  }

  if (exec.status !== expect.exitCode) {
    failures.push({
      kind: 'exitCode',
      message: `退出码不符: 期望 ${expect.exitCode}, 实际 ${exec.status}`,
      expected: String(expect.exitCode),
      actual: String(exec.status),
    });
  }

  if (expect.stdoutExact !== undefined) {
    const wanted = applyVars(expect.stdoutExact, root);
    if (exec.stdout !== wanted) {
      failures.push({
        kind: 'stdoutExact',
        message: `stdout 与期望不逐字节相等 (${firstLineDiff(wanted, exec.stdout)})`,
        expected: wanted,
        actual: exec.stdout,
      });
    }
  }

  for (const needle of expect.stdoutContains ?? []) {
    const wanted = applyVars(needle, root);
    if (!exec.stdout.includes(wanted)) {
      failures.push({
        kind: 'stdoutContains',
        message: `stdout 缺少子串: "${clip(wanted)}"`,
      });
    }
  }

  for (const needle of expect.stdoutMustNotContain ?? []) {
    const forbidden = applyVars(needle, root);
    if (exec.stdout.includes(forbidden)) {
      failures.push({
        kind: 'stdoutMustNotContain',
        message: `stdout 出现了禁含子串: "${clip(forbidden)}"`,
      });
    }
  }

  for (const needle of expect.stderrContains ?? []) {
    const wanted = applyVars(needle, root);
    if (!exec.stderr.includes(wanted)) {
      failures.push({
        kind: 'stderrContains',
        message: `stderr 缺少子串: "${clip(wanted)}"`,
      });
    }
  }

  for (const needle of expect.stderrMustNotContain ?? []) {
    const forbidden = applyVars(needle, root);
    if (exec.stderr.includes(forbidden)) {
      failures.push({
        kind: 'stderrMustNotContain',
        message: `stderr 出现了禁含子串: "${clip(forbidden)}"`,
      });
    }
  }

  for (const item of expect.fs ?? []) {
    const problem = await checkFs(root, item);
    if (problem !== null) failures.push({ kind: 'fs', message: problem });
  }

  return failures;
}

/** 对象判定 (JSON 语义: 非 null、非数组的对象) */
const isPlainRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/** 深比较 (键序无关; 作用域为 JSON 域值: 对象 / 数组 / 原始值) */
function deepEqual(left: unknown, right: unknown): boolean {
  if (left === right) return true;
  if (Array.isArray(left) || Array.isArray(right)) {
    return (
      Array.isArray(left) &&
      Array.isArray(right) &&
      left.length === right.length &&
      left.every((item, index) => deepEqual(item, right[index]))
    );
  }
  if (isPlainRecord(left) || isPlainRecord(right)) {
    if (!isPlainRecord(left) || !isPlainRecord(right)) return false;
    const leftKeys = Object.keys(left).sort();
    const rightKeys = Object.keys(right).sort();
    return (
      leftKeys.length === rightKeys.length &&
      leftKeys.every(
        (key, index) =>
          key === rightKeys[index] && deepEqual(left[key], right[key]),
      )
    );
  }
  return false;
}

/**
 * 递归子集检查: 期望对象逐键存在且子集匹配, 期望数组等长逐项匹配, 原始值深比较。
 * 返回首个差异说明 (通过为 null); pathHint 形如 `$.hits[0].target`。
 */
function subsetDiff(
  expected: unknown,
  actual: unknown,
  pathHint: string,
): string | null {
  if (isPlainRecord(expected)) {
    if (!isPlainRecord(actual)) {
      return `${pathHint}: 期望对象, 实际 ${JSON.stringify(actual)}`;
    }
    for (const [key, value] of Object.entries(expected)) {
      if (!(key in actual)) return `${pathHint}: 缺键 ${key}`;
      const problem = subsetDiff(value, actual[key], `${pathHint}.${key}`);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (Array.isArray(expected)) {
    if (!Array.isArray(actual)) return `${pathHint}: 期望数组, 实际非数组`;
    if (expected.length !== actual.length) {
      return `${pathHint}: 数组长度 期望 ${expected.length} 实际 ${actual.length}`;
    }
    for (const [index, item] of expected.entries()) {
      const problem = subsetDiff(item, actual[index], `${pathHint}[${index}]`);
      if (problem !== null) return problem;
    }
    return null;
  }
  if (!deepEqual(expected, actual)) {
    return `${pathHint}: 期望 ${JSON.stringify(expected)}, 实际 ${JSON.stringify(actual)}`;
  }
  return null;
}

/** 事件流断言: 集合成员 (mustInclude) 与末位 (lastIs); 事件序不承诺, 故不按序比对 */
function checkEvents(
  expect: NonNullable<ApiExpectSpec['events']>,
  raw: unknown,
): FailureItem[] {
  const failures: FailureItem[] = [];
  if (!Array.isArray(raw)) {
    failures.push({
      kind: 'events',
      message:
        '期望事件断言, 但 harness 输出未附 events 数组 (步骤是否漏了 collectEvents?)',
    });
    return failures;
  }
  const kinds = raw.map((item) =>
    isPlainRecord(item) ? item.kind : undefined,
  );
  if (expect.lastIs !== undefined) {
    const last = kinds[kinds.length - 1];
    if (last !== expect.lastIs) {
      failures.push({
        kind: 'events',
        message: `末事件不符: 期望 ${expect.lastIs}, 实际 ${String(last)}`,
        expected: expect.lastIs,
        actual: typeof last === 'string' ? last : String(last),
      });
    }
  }
  for (const wanted of expect.mustInclude ?? []) {
    if (!kinds.includes(wanted)) {
      failures.push({ kind: 'events', message: `事件流缺少 kind: ${wanted}` });
    }
  }
  return failures;
}

/**
 * 逐项比对一条 api 用例的全部断言: 解析 harness 输出 JSON → result (exact / subset) /
 * error (code / name) / events (lastIs / mustInclude) / fs。超时与执行级失败为短路项
 * (与 cli 面同口径)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   expect = { result: { subset: { hits: [{ target: '$FIXTURE/zone/a/node_modules' }] } } }
 *   exec   = { status: 0, stdout: '{"ok":true,"value":{"hits":[{"target":"<realpath>/zone/a/node_modules", …}], …}}', stderr: '', timedOut: false }
 *
 * 步骤 1：形态校验
 *   outcome = { ok: true, value: { … } }, 合法 (ok 为布尔且层次正确)
 *
 * 步骤 2：result.subset 递归比对 ($FIXTURE 已替换为 realpath)
 *   $.hits[0].target 命中 → 其余相等 → failures = []
 *
 * Output（数据契约）
 *   return [] 或 FailureItem[] (kind: harness | result | error | events | fs)
 * ```
 */
export async function compareApiCase(
  expect: ApiExpectSpec,
  exec: ExecOutcome,
  root: string,
): Promise<FailureItem[]> {
  const failures: FailureItem[] = [];

  if (exec.timedOut) {
    failures.push({
      kind: 'timeout',
      message: '执行超时 (超时守卫击中, 进程已被杀), 判失败',
    });
    return failures;
  }
  if (exec.spawnError !== undefined) {
    failures.push({
      kind: 'spawn',
      message: `API harness 无法执行: ${exec.spawnError}`,
    });
    return failures;
  }
  if (exec.status !== 0) {
    const stderrNote =
      exec.stderr.trim() === '' ? '' : `; stderr: ${clip(exec.stderr.trim())}`;
    failures.push({
      kind: 'harness',
      message: `harness 非零退出 (${String(exec.status)})${stderrNote}`,
    });
    return failures;
  }
  let outcome: unknown;
  try {
    outcome = JSON.parse(exec.stdout);
  } catch {
    failures.push({
      kind: 'harness',
      message: `harness stdout 不是合法 JSON: ${clip(exec.stdout.trim())}`,
    });
    return failures;
  }
  if (!isPlainRecord(outcome) || typeof outcome.ok !== 'boolean') {
    failures.push({
      kind: 'harness',
      message: `harness 输出缺少 ok 布尔字段: ${clip(exec.stdout.trim())}`,
    });
    return failures;
  }

  if (outcome.ok === true) {
    if (expect.error !== undefined) {
      failures.push({
        kind: 'error',
        message: `期望抛错 (code=${expect.error.code}), 实际成功返回`,
      });
    }
    if (expect.result !== undefined) {
      if ('exact' in expect.result) {
        const wanted = replaceVarsDeep(expect.result.exact, root);
        if (!deepEqual(wanted, outcome.value)) {
          failures.push({
            kind: 'result',
            message: 'result 与期望深比较不等',
            expected: JSON.stringify(wanted, null, 2) ?? 'undefined',
            actual: JSON.stringify(outcome.value, null, 2) ?? 'undefined',
          });
        }
      } else {
        const wanted = replaceVarsDeep(expect.result.subset, root);
        const problem = subsetDiff(wanted, outcome.value, '$');
        if (problem !== null) {
          failures.push({
            kind: 'result',
            message: `result 子集不符: ${problem}`,
          });
        }
      }
    }
    if (expect.events !== undefined) {
      failures.push(...checkEvents(expect.events, outcome.events));
    }
  } else {
    const error = isPlainRecord(outcome.error) ? outcome.error : null;
    if (expect.result !== undefined) {
      const code = typeof error?.code === 'string' ? error.code : '?';
      const message = typeof error?.message === 'string' ? error.message : '';
      failures.push({
        kind: 'error',
        message: `期望成功返回, 实际抛错: ${code} ${message}`.trim(),
      });
    }
    if (expect.error !== undefined) {
      const actualCode = error?.code;
      if (actualCode !== expect.error.code) {
        failures.push({
          kind: 'error',
          message: `错误码不符: 期望 ${expect.error.code}, 实际 ${String(actualCode)}`,
          expected: expect.error.code,
          actual:
            typeof actualCode === 'string' ? actualCode : String(actualCode),
        });
      }
      if (
        expect.error.name !== undefined &&
        error?.name !== expect.error.name
      ) {
        failures.push({
          kind: 'error',
          message: `错误类名不符: 期望 ${expect.error.name}, 实际 ${String(error?.name)}`,
        });
      }
    }
  }

  for (const item of expect.fs ?? []) {
    const problem = await checkFs(root, item);
    if (problem !== null) failures.push({ kind: 'fs', message: problem });
  }

  return failures;
}
