/**
 * 差分模糊测试 · 规范 JSON 深比较与通用不变量校验 (纯函数, 零 IO, 零领域硬编码)。
 * 由 `fuzz-generators.ts` 统一再导出, 供 `run-diff-fuzz.ts` 与单测消费。
 */

export type InvariantName =
  | 'no-crash'
  | 'ok-string'
  | 'non-empty-string'
  | 'no-control-chars'
  | 'no-newlines'
  | 'idempotent';

/** API harness 单条规范输出形状 */
export interface HarnessOutcome {
  ok: boolean;
  value?: unknown;
  error?: {
    name?: string;
    code?: string;
    message?: string;
    details?: unknown;
  };
}

/** 递归按对象键字典序归一后序列化, 用于跨语言/跨运行时确定性深等价比较 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => {
      if (a < b) return -1;
      return a > b ? 1 : 0;
    });
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(',')}}`;
}

/** 提取用于跨实现差分比较的可比较载荷 (成功比 value; 失败比 error.code 或 error.name) */
export function comparableOutcome(outcome: HarnessOutcome): string {
  if (outcome.ok) return canonicalJson({ ok: true, value: outcome.value });
  return canonicalJson({
    ok: false,
    code: outcome.error?.code ?? null,
    name: outcome.error?.name ?? 'Error',
  });
}

/** 检查字符串是否包含禁止的控制字符 (C0 除 \t, DEL, C1, bidi 与零宽/BOM) */
export function hasForbiddenControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (
      (code >= 0x00 && code <= 0x08) ||
      (code >= 0x0b && code <= 0x1f) ||
      (code >= 0x7f && code <= 0x9f) ||
      (code >= 0x200b && code <= 0x200f) ||
      (code >= 0x202a && code <= 0x202e) ||
      (code >= 0x2066 && code <= 0x2069) ||
      code === 0xfeff
    ) {
      return true;
    }
  }
  return false;
}

/** 校验单次执行结果是否满足目标声明的全部非幂等不变量 (返回违例原因列表) */
export function checkInvariants(
  outcome: HarnessOutcome,
  invariants: readonly InvariantName[],
): string[] {
  const violations: string[] = [];
  for (const inv of invariants) {
    if (inv === 'no-crash' || inv === 'idempotent') continue;
    if (inv === 'ok-string') {
      if (!outcome.ok || typeof outcome.value !== 'string') {
        violations.push(
          `违反 ok-string: ok=${String(outcome.ok)}, typeof value=${typeof outcome.value}`,
        );
      }
      continue;
    }
    if (inv === 'non-empty-string') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        outcome.value === ''
      ) {
        violations.push('违反 non-empty-string: 结果不是非空字符串');
      }
      continue;
    }
    if (inv === 'no-control-chars') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        hasForbiddenControlChar(outcome.value)
      ) {
        violations.push(
          `违反 no-control-chars: 输出含裸控制/bidi 字符 (${JSON.stringify(outcome.value)})`,
        );
      }
      continue;
    }
    if (inv === 'no-newlines') {
      if (
        !outcome.ok ||
        typeof outcome.value !== 'string' ||
        outcome.value.includes('\n') ||
        outcome.value.includes('\r')
      ) {
        violations.push(
          `违反 no-newlines: 输出含换行符 (${JSON.stringify(outcome.value)})`,
        );
      }
    }
  }
  return violations;
}

export type DispatchMode = 'auto' | 'batch' | 'single';

export interface FuzzCliOptions {
  targetsPath: string;
  allProducts: boolean;
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

/** 解析差分模糊测试命令行参数 (支持负整数 --seed 与 --all-products) */
export function parseFuzzArgsWithDefaults(
  argv: string[],
  defaults: {
    targetsPath: string;
    seed: number;
    cases: number;
    timeoutMs: number;
  },
): { ok: true; options: FuzzCliOptions } | { ok: false; message: string } {
  const options: FuzzCliOptions = {
    targetsPath: defaults.targetsPath,
    allProducts: false,
    seed: defaults.seed,
    casesPerTarget: defaults.cases,
    mode: 'auto',
    timeoutMs: defaults.timeoutMs,
    json: false,
    help: false,
  };
  let explicitTargets = false;
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
    if (arg === '--all-products') {
      options.allProducts = true;
      continue;
    }
    if (!VALUE_FLAGS.has(arg)) {
      return { ok: false, message: `未知参数: ${arg}` };
    }
    const value = argv[i + 1];
    const allowNegative = arg === '--seed' && /^-?\d+$/.test(value ?? '');
    if (value === undefined || (!allowNegative && value.startsWith('-'))) {
      return { ok: false, message: `参数 ${arg} 缺少取值` };
    }
    i += 1;
    if (arg === '--targets') {
      options.targetsPath = value;
      explicitTargets = true;
    } else if (arg === '--reference-target') options.referenceTarget = value;
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
  if (!options.help && options.allProducts && explicitTargets) {
    return {
      ok: false,
      message: '--all-products 与 --targets 互斥, 不能同时指定',
    };
  }
  return { ok: true, options };
}
