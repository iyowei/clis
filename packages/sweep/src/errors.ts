/**
 * 库抛出的唯一错误类型与跨实例判别工具 (契约基准: packages/sweep/docs/designs/api-surface.md §3.1 / §3.6)。
 * 上下游: 依赖 codes.ts 的 SweepErrorCode (配置 / 迁移 / 参数 / 取消共 8 项) 与 config / delete 类型;
 * 供 config / migrate / guard / delete / sweep 抛错及外部调用方按 code 精确收窄处理。
 * 核心红线: 能列出结果的失败走返回值, 仅无法开始或无法继续的失败抛 SweepError;
 * 本类是全仓不导出类惯例的唯一例外 (保留 instanceof 与 stack), 跨实例判别一律走 isSweepError。
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
  CONFIG_NEEDS_MIGRATION: { path: string; version: number };
  CONFIG_MIGRATION_FAILED: { path: string; backupPath?: string };
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
  'CONFIG_NEEDS_MIGRATION',
  'CONFIG_MIGRATION_FAILED',
  'INVALID_ARGUMENT',
  'CANCELLED',
] satisfies SweepErrorCode[]);

/** 库抛出的唯一错误类型 (配置 / 迁移 / 参数 / 取消 8 项错误码共用) */
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
 * 类型守卫: 不依赖类身份, 走「Error 形状 + name + message + code 白名单」判别。
 * 扩展 / 打包环境里同一进程可能存在两份库实例, 此时 instanceof SweepError 会假阴;
 * 需要跨实例判别的调用方一律用它。
 *
 * ### 数据流转示例
 * - Input: `err = { name: 'SweepError', code: 'CANCELLED', message: '...', details: { phase: 'remove', partial } }`
 * - 校验: 非空对象 -> `name === 'SweepError'` -> `typeof message === 'string'` -> `SWEEP_ERROR_CODES.has(code)`
 * - Output: `true`, 类型收窄为 `NarrowedSweepError`, 分支 `err.code === 'CANCELLED'` 后可直接安全读取 `err.details?.partial`
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
