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

/** 抛错附带的上下文: 判别联合, 按 code 取对应一支 */
export type SweepErrorDetails =
  | { path: string; errno?: string } // CONFIG_READ_FAILED
  | { path: string } // CONFIG_CORRUPT_JSON
  | { path: string; field: string } // CONFIG_CORRUPT_SHAPE (field = 首个不符的字段名)
  | { path: string; source: ConfigSource } // CONFIG_ABSENT (只有显式来源会抛)
  | { field: string } // INVALID_ARGUMENT (构造期同步抛)
  | { phase: SweepPhase; partial?: RemovalResult }; // CANCELLED (partial 只在 phase === 'remove' 时出现)

/** isSweepError 校验 code 取值的运行时全表 (与 SweepErrorCode 类型保持同步) */
const SWEEP_ERROR_CODES: ReadonlySet<string> = new Set([
  'CONFIG_READ_FAILED',
  'CONFIG_CORRUPT_JSON',
  'CONFIG_CORRUPT_SHAPE',
  'CONFIG_ABSENT',
  'INVALID_ARGUMENT',
  'CANCELLED',
] satisfies SweepErrorCode[]);

/** 库抛出的唯一错误类型 (config / 参数 / 取消三档共用) */
export class SweepError extends Error {
  override readonly name = 'SweepError' as const;
  readonly code: SweepErrorCode;
  readonly details?: SweepErrorDetails;

  constructor(
    code: SweepErrorCode,
    message: string,
    details?: SweepErrorDetails,
  ) {
    super(message);
    this.code = code;
    this.details = details;
  }
}

/**
 * 类型守卫: 不依赖类身份, 走「Error 形状 + name + code 取值」判别。
 * 扩展 / 打包环境里同一进程可能存在两份库实例, 此时 instanceof SweepError 会假阴;
 * 需要跨实例判别的调用方一律用它。
 */
export function isSweepError(value: unknown): value is SweepError {
  if (typeof value !== 'object' || value === null) return false;
  const candidate = value as { name?: unknown; code?: unknown };
  return (
    candidate.name === 'SweepError' &&
    typeof candidate.code === 'string' &&
    SWEEP_ERROR_CODES.has(candidate.code)
  );
}
