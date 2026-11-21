/**
 * 转写契约套件 · 通用差分模糊测试引擎 (Differential Fuzzing Runner)。
 *
 * 职责: 读取包级 `conformance/fuzz-targets.json`, 用确定性 PRNG 生成结构化对抗输入:
 * - 单目标模式 (仅参考 harness): 校验 0 崩溃 + 目标声明的全部通用不变量 (如无控制字符 / 幂等);
 * - 双目标差分模式 (`--api-target <cmd>`): 把同一组对抗输入同时喂给参考与目标 harness,
 *   逐条深比对 `{ ok, value | error.code }` 并校对不变量, 任一差异可经 `--emit-failures <dir>` 输出复现单。
 *
 * 协议适配: 优先尝试批量模式 (`{ batch }`); 仅支持单步 `{ steps }` 的外部最小 harness 在 `auto` 下自动降级。
 * 退出码: 0 全部通过; 1 检出差分偏差或不变量违例; 2 参数 / 配置 / harness 环境错误。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import { PROTOCOL_ROOT } from './corpus.ts';
import {
  type FuzzConfig,
  type FuzzTargetSpec,
  type HarnessOutcome,
  canonicalJson,
  checkInvariants,
  comparableOutcome,
  generateFuzzArgs,
} from './fuzz-generators.ts';
import {
  type FuzzFailureItem as FuzzFailure,
  type FuzzTargetSummary as TargetSummary,
  emitFuzzFailureDiagnostics,
  printFuzzReport,
} from './report.ts';

const HERE = dirname(fileURLToPath(import.meta.url));
const REPO_ROOT = resolve(HERE, '..', '..');
const DEFAULT_TARGETS_PATH = join(
  REPO_ROOT,
  PROTOCOL_ROOT,
  'conformance',
  'fuzz-targets.json',
);
const DEFAULT_REF_ARGV: readonly string[] = [
  'bun',
  join(HERE, 'api-harness.ts'),
];
const DEFAULT_SEED = 20261121;
const DEFAULT_CASES = 100;
const DEFAULT_TIMEOUT_MS = 20000;

export type DispatchMode = 'auto' | 'batch' | 'single';

export interface FuzzCliOptions {
  targetsPath: string;
  referenceTarget?: string;
  apiTarget?: string;
  seed: number;
  casesPerTarget: number;
  mode: DispatchMode;
  timeoutMs: number;
  emitFailuresDir?: string;
  json: boolean;
  help: boolean;
}

const HELP_TEXT = [
  '用法: bun scripts/transcription/run-diff-fuzz.ts [选项]',
  '',
  `  --targets <file>           模糊测试目标清单 (默认: ${PROTOCOL_ROOT}/conformance/fuzz-targets.json)`,
  '  --reference-target <cmd>   参考 API harness 命令 (默认: bun scripts/transcription/api-harness.ts)',
  '  --api-target <cmd>         待测 API harness 命令 (省略时跑参考实现不变量自检)',
  `  --seed <int>               确定性随机种子 (默认: ${DEFAULT_SEED})`,
  `  --cases <int>              每个目标生成的用例数 (默认: ${DEFAULT_CASES})`,
  '  --mode <auto|batch|single> 派发模式 (默认 auto: 优先批量, 不支持自动降级单步)',
  `  --timeout <ms>             单次 harness 调用超时毫秒 (默认: ${DEFAULT_TIMEOUT_MS})`,
  '  --emit-failures <dir>      存在失败时导出最小复现 Markdown 诊断单到指定目录',
  '  --json                     输出结构化 JSON 报告',
  '  --help                     显示本帮助',
  '',
  '退出码: 0 全部通过; 1 检出偏差或不变量违例; 2 用法 / 配置 / 环境错误',
].join('\n');

/** 将带引号的命令字符串拆分为 argv, 并把启动目录下存在的相对路径绝对化 */
function resolveCommandArgv(raw: string, cwd: string): string[] {
  const parts: string[] = [];
  let cur = '';
  let quote: string | null = null;
  for (const ch of raw) {
    if (quote !== null) {
      if (ch === quote) quote = null;
      else cur += ch;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (/\s/.test(ch)) {
      if (cur !== '') {
        parts.push(cur);
        cur = '';
      }
    } else {
      cur += ch;
    }
  }
  if (cur !== '') parts.push(cur);
  return parts.map((part, idx) => {
    if (idx === 0 || isAbsolute(part) || part.startsWith('-')) return part;
    const abs = resolve(cwd, part);
    return existsSync(abs) ? abs : part;
  });
}

const VALUE_FLAGS = new Set([
  '--targets',
  '--reference-target',
  '--api-target',
  '--seed',
  '--cases',
  '--mode',
  '--timeout',
  '--emit-failures',
]);

export function parseFuzzArgs(
  argv: string[],
): { ok: true; options: FuzzCliOptions } | { ok: false; message: string } {
  const options: FuzzCliOptions = {
    targetsPath: DEFAULT_TARGETS_PATH,
    seed: DEFAULT_SEED,
    casesPerTarget: DEFAULT_CASES,
    mode: 'auto',
    timeoutMs: DEFAULT_TIMEOUT_MS,
    json: false,
    help: false,
  };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (arg === '--json') {
      options.json = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg))
      return { ok: false, message: `未知参数: ${arg}` };
    const value = argv[i + 1];
    if (value === undefined || value.startsWith('-')) {
      return { ok: false, message: `参数 ${arg} 缺少取值` };
    }
    i += 1;
    if (arg === '--targets') options.targetsPath = value;
    else if (arg === '--reference-target') options.referenceTarget = value;
    else if (arg === '--api-target') options.apiTarget = value;
    else if (arg === '--emit-failures') options.emitFailuresDir = value;
    else if (arg === '--mode') {
      if (value !== 'auto' && value !== 'batch' && value !== 'single') {
        return { ok: false, message: '--mode 仅支持 auto|batch|single' };
      }
      options.mode = value;
    } else {
      const n = Number(value);
      if (!Number.isInteger(n) || (arg !== '--seed' && n <= 0)) {
        return { ok: false, message: `${arg} 须为合法整数, 收到: ${value}` };
      }
      if (arg === '--seed') options.seed = n;
      else if (arg === '--cases') options.casesPerTarget = n;
      else options.timeoutMs = n;
    }
  }
  return { ok: true, options };
}

/** 向单个 harness 进程发送 stdin JSON 并解析 stdout JSON */
function callHarnessRaw(
  argv: readonly string[],
  payload: unknown,
  timeoutMs: number,
):
  { ok: true; data: Record<string, unknown> } | { ok: false; message: string } {
  const result = spawnSync(argv[0]!, argv.slice(1), {
    input: `${JSON.stringify(payload)}\n`,
    encoding: 'utf8',
    timeout: timeoutMs,
    maxBuffer: 32 * 1024 * 1024,
  });
  if (result.error !== undefined) {
    return { ok: false, message: `harness 启动失败: ${result.error.message}` };
  }
  if (result.status !== 0) {
    return {
      ok: false,
      message: `harness 非零退出 (${String(result.status)}): ${(result.stderr ?? '').trim()}`,
    };
  }
  try {
    const parsed: unknown = JSON.parse((result.stdout ?? '').trim());
    if (
      typeof parsed !== 'object' ||
      parsed === null ||
      Array.isArray(parsed)
    ) {
      return { ok: false, message: 'harness 输出不是 JSON 对象' };
    }
    return { ok: true, data: parsed as Record<string, unknown> };
  } catch (error) {
    return {
      ok: false,
      message: `harness stdout 非合法 JSON: ${(error as Error).message}`,
    };
  }
}

/** 批量或单步派发一组 `{ steps }` 指令; `auto` 遇不支持 batch 的最小 harness 自动降级单步 */
export function dispatchInstructions(
  argv: readonly string[],
  instructions: readonly unknown[],
  mode: DispatchMode,
  timeoutMs: number,
): { outcomes: HarnessOutcome[]; modeUsed: 'batch' | 'single' } {
  if (mode !== 'single') {
    const res = callHarnessRaw(argv, { batch: instructions }, timeoutMs);
    if (res.ok && res.data.ok === true && Array.isArray(res.data.results)) {
      return {
        outcomes: res.data.results as HarnessOutcome[],
        modeUsed: 'batch',
      };
    }
    if (mode === 'batch') {
      throw new Error(
        `批量模式失败: ${res.ok ? JSON.stringify(res.data) : res.message}`,
      );
    }
  }
  const outcomes: HarnessOutcome[] = instructions.map((inst) => {
    const res = callHarnessRaw(argv, inst, timeoutMs);
    return res.ok
      ? (res.data as unknown as HarnessOutcome)
      : { ok: false, error: { name: 'HarnessCrash', message: res.message } };
  });
  return { outcomes, modeUsed: 'single' };
}

/** 若目标声明了 idempotent, 把首次成功值回灌验证 f(f(x)) === f(x) */
function verifyIdempotency(
  spec: FuzzTargetSpec,
  seed: number,
  argsList: readonly unknown[][],
  outcomes: readonly HarnessOutcome[],
  argv: readonly string[],
  options: FuzzCliOptions,
): FuzzFailure[] {
  const indices: number[] = [];
  const nextInsts: unknown[] = [];
  for (let i = 0; i < outcomes.length; i += 1) {
    if (outcomes[i]!.ok) {
      indices.push(i);
      nextInsts.push({
        steps: [{ call: { export: spec.export, args: [outcomes[i]!.value] } }],
      });
    }
  }
  if (nextInsts.length === 0) return [];
  const second = dispatchInstructions(
    argv,
    nextInsts,
    options.mode,
    options.timeoutMs,
  );
  const failures: FuzzFailure[] = [];
  for (let j = 0; j < indices.length; j += 1) {
    const orig = indices[j]!;
    const firstOut = outcomes[orig]!;
    const secondOut = second.outcomes[j]!;
    if (
      !secondOut.ok ||
      canonicalJson(firstOut.value) !== canonicalJson(secondOut.value)
    ) {
      failures.push({
        targetId: spec.id,
        exportName: spec.export,
        caseIndex: orig,
        seed,
        reason: `违反 idempotent: f(x)=${canonicalJson(firstOut.value)} 但 f(f(x))=${canonicalJson(secondOut.ok ? secondOut.value : secondOut.error)}`,
        args: argsList[orig]!,
        reference: firstOut,
        actual: secondOut,
      });
    }
  }
  return failures;
}

/** 对单个目标执行生成、派发、不变量检查、幂等校验与可选双实现差分比对 */
function runFuzzTarget(
  spec: FuzzTargetSpec,
  targetIndex: number,
  referenceArgv: readonly string[],
  apiArgv: readonly string[] | undefined,
  options: FuzzCliOptions,
): { summary: TargetSummary; failures: FuzzFailure[] } {
  const startedAt = Date.now();
  const targetSeed = Math.abs(options.seed + targetIndex * 7919) % 2147483646;
  const argsList = generateFuzzArgs(
    spec.generator,
    targetSeed,
    options.casesPerTarget,
    spec.generatorOptions,
  );
  const instructions = argsList.map((args) => ({
    steps: [{ call: { export: spec.export, args } }],
  }));
  const invariants = spec.invariants ?? ['no-crash'];

  const refRun = dispatchInstructions(
    referenceArgv,
    instructions,
    options.mode,
    options.timeoutMs,
  );
  const targetRun = apiArgv
    ? dispatchInstructions(
        apiArgv,
        instructions,
        options.mode,
        options.timeoutMs,
      )
    : undefined;
  const active = targetRun ? targetRun.outcomes : refRun.outcomes;
  const failures: FuzzFailure[] = [];

  for (let i = 0; i < argsList.length; i += 1) {
    const refOut = refRun.outcomes[i]!;
    const actOut = active[i]!;
    const reasons: string[] = [];
    if (typeof actOut.ok !== 'boolean')
      reasons.push('harness 输出缺少布尔字段 ok');
    else if (actOut.error?.name === 'HarnessCrash') {
      reasons.push(`harness 崩溃: ${actOut.error.message ?? ''}`);
    }
    if (targetRun && comparableOutcome(refOut) !== comparableOutcome(actOut)) {
      reasons.push(
        `参考实现与被测实现输出不一致: ref=${comparableOutcome(refOut)} vs target=${comparableOutcome(actOut)}`,
      );
    }
    reasons.push(...checkInvariants(actOut, invariants));
    if (reasons.length > 0) {
      failures.push({
        targetId: spec.id,
        exportName: spec.export,
        caseIndex: i,
        seed: targetSeed,
        reason: reasons.join('; '),
        args: argsList[i]!,
        reference: refOut,
        ...(targetRun ? { actual: actOut } : {}),
      });
    }
  }

  if (invariants.includes('idempotent')) {
    failures.push(
      ...verifyIdempotency(
        spec,
        targetSeed,
        argsList,
        active,
        apiArgv ?? referenceArgv,
        options,
      ),
    );
  }
  const failedIndices = new Set(failures.map((f) => f.caseIndex));
  return {
    summary: {
      id: spec.id,
      export: spec.export,
      cases: argsList.length,
      passed: argsList.length - failedIndices.size,
      failed: failedIndices.size,
      modeUsed: targetRun ? targetRun.modeUsed : refRun.modeUsed,
      durationMs: Date.now() - startedAt,
    },
    failures,
  };
}

function loadFuzzConfig(path: string): FuzzConfig {
  const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'));
  const obj = parsed as { schemaVersion?: unknown; targets?: unknown };
  if (
    typeof parsed !== 'object' ||
    parsed === null ||
    obj.schemaVersion !== 1 ||
    !Array.isArray(obj.targets) ||
    obj.targets.length === 0
  ) {
    throw new Error(`模糊测试目标清单格式非法或为空: ${path}`);
  }
  return parsed as FuzzConfig;
}

export function runDiffFuzzCli(argv: string[]): number {
  const parsed = parseFuzzArgs(argv);
  if (!parsed.ok) {
    process.stderr.write(`参数错误: ${parsed.message}\n\n${HELP_TEXT}\n`);
    return 2;
  }
  const options = parsed.options;
  if (options.help) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }
  let config: FuzzConfig;
  try {
    config = loadFuzzConfig(resolve(options.targetsPath));
  } catch (error) {
    process.stderr.write(`${(error as Error).message}\n`);
    return 2;
  }
  const refArgv = options.referenceTarget
    ? resolveCommandArgv(options.referenceTarget, process.cwd())
    : [...DEFAULT_REF_ARGV];
  const apiArgv = options.apiTarget
    ? resolveCommandArgv(options.apiTarget, process.cwd())
    : undefined;

  const summaries: TargetSummary[] = [];
  const allFailures: FuzzFailure[] = [];
  for (const [index, spec] of config.targets.entries()) {
    const res = runFuzzTarget(spec, index, refArgv, apiArgv, options);
    summaries.push(res.summary);
    allFailures.push(...res.failures);
  }
  if (options.emitFailuresDir && allFailures.length > 0) {
    emitFuzzFailureDiagnostics(resolve(options.emitFailuresDir), allFailures, {
      targetsPath: options.targetsPath,
      seed: options.seed,
    });
  }
  printFuzzReport(summaries, allFailures, {
    apiTarget: options.apiTarget,
    seed: options.seed,
    casesPerTarget: options.casesPerTarget,
    json: options.json,
  });
  return summaries.some((s) => s.failed > 0) ? 1 : 0;
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  try {
    process.exitCode = runDiffFuzzCli(process.argv.slice(2));
  } catch (error) {
    process.stderr.write(
      `差分模糊测试器异常: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`,
    );
    process.exitCode = 2;
  }
}
