/**
 * 库抛出的唯一错误类型与判别工具。
 *
 * 契约基准: packages/sweep-node-modules/docs/designs/api-surface.md §3.6。
 * 两条通道的划分 (§3.1): 能列出结果的失败走返回值 (拒绝 / 失败 / 中止 / 未测到 / 跳过);
 * 无法开始或无法继续的失败 (配置 / 参数 / 取消) 才抛 SweepError。
 * 本类是全仓「以 createXxx() 工厂交出实例、不导出类」惯例的唯一例外:
 * 取例外的理由是调用方要 instanceof 判别与 stack 保留 (跨实例场景走 isSweepError)。
 */
import type { SweepErrorCode, SweepPhase } from './codes.ts';
import type { ConfigSource } from './config.ts';
import type { RemovalResult } from './delete.ts';

/** 按 code 索引的错误上下文映射 (支持按 code 精确收窄 details) */
export interface SweepErrorDetailsByCode {
  CONFIG_READ_FAILED: { path: string; errno?: string };
  CONFIG_CORRUPT_JSON: { path: string };
  CONFIG_CORRUPT_SHAPE: { path: string; field: string };
  CONFIG_ABSENT: { path: string; source: ConfigSource };
  INVALID_ARGUMENT: { field: string };
  CANCELLED: { phase: SweepPhase; partial?: RemovalResult };
}

/** 抛错附带的上下文: 判别联合, 按 code 取对应一支 */
export type SweepErrorDetails =
  SweepErrorDetailsByCode[keyof SweepErrorDetailsByCode];

/** isSweepError 校验 code 取值的运行时全表 (与 SweepErrorCode 类型保持同步) */
const SWEEP_ERROR_CODES: ReadonlySet<string> = /*#__PURE__*/ new Set([
  'CONFIG_READ_FAILED',
  'CONFIG_CORRUPT_JSON',
  'CONFIG_CORRUPT_SHAPE',
  'CONFIG_ABSENT',
  'INVALID_ARGUMENT',
  'CANCELLED',
] satisfies SweepErrorCode[]);

/** 库抛出的唯一错误类型 (config / 参数 / 取消三档共用) */
export class SweepError<
  Code extends SweepErrorCode = SweepErrorCode,
> extends Error {
  override readonly name = 'SweepError' as const;
  readonly code: Code;
  readonly details?: SweepErrorDetailsByCode[Code];

  constructor(
    code: Code,
    message: string,
    details?: SweepErrorDetailsByCode[Code],
    options?: ErrorOptions,
  ) {
    super(message, options);
    this.code = code;
    this.details = details;
  }
}

/** 按 code 展开的判别联合: `if (isSweepError(e) && e.code === 'CANCELLED') e.details?.partial` 直接收窄 */
export type NarrowedSweepError = {
  [K in SweepErrorCode]: SweepError<K>;
}[SweepErrorCode];

/**
 * 类型守卫: 不依赖类身份, 走「Error 形状 + name + message + code 取值」判别。
 * 扩展 / 打包环境里同一进程可能存在两份库实例, 此时 instanceof SweepError 会假阴;
 * 需要跨实例判别的调用方一律用它。
 */
export function isSweepError(value: unknown): value is NarrowedSweepError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as {
    name?: unknown;
    code?: unknown;
    message?: unknown;
  };
  return (
    candidate.name === 'SweepError' &&
    typeof candidate.message === 'string' &&
    typeof candidate.code === 'string' &&
    SWEEP_ERROR_CODES.has(candidate.code)
  );
}

/** 单步按 code 收窄守卫: 校验为 SweepError 且 code 匹配时直接窄化到对应 details 分支 */
export function isSweepErrorCode<Code extends SweepErrorCode>(
  value: unknown,
  code: Code,
): value is SweepError<Code> {
  return isSweepError(value) && value.code === code;
}
