/**
 * `@iyowei/fan` 领域错误码与结构化错误类: 供 API 与 `@iyowei/fan-cli` 统一判别分支。
 */
export type FanErrorCode =
  | 'UNSUPPORTED_PLATFORM'
  | 'SMC_UNAVAILABLE'
  | 'SMC_COMMAND_FAILED'
  | 'INVALID_FAN_INDEX'
  | 'INVALID_SPEED'
  | 'PERMISSION_DENIED'
  | 'STATE_CORRUPT'
  | 'DAEMON_FAILED';

/** 唯一导出的结构化错误类 (携带稳定 `code` 判别字段) */
export class FanError extends Error {
  readonly code: FanErrorCode;

  constructor(code: FanErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'FanError';
    this.code = code;
  }
}

/** 跨 realm 安全的错误类型守卫 */
export function isFanError(value: unknown): value is FanError {
  return (
    value instanceof Error &&
    value.name === 'FanError' &&
    typeof (value as { code?: unknown }).code === 'string'
  );
}
