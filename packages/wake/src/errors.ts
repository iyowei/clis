/**
 * `@iyowei/wake` 领域错误与错误码定义。
 * 所有可预期的配置、校验、网络与中继故障统一经 `WakeError` 抛出。
 */

export type WakeErrorCode =
  | 'CONFIG_ABSENT'
  | 'CONFIG_READ_FAILED'
  | 'CONFIG_INVALID'
  | 'CONFIG_WRITE_FAILED'
  | 'TARGET_NOT_FOUND'
  | 'INVALID_TARGET'
  | 'INVALID_MAC'
  | 'INVALID_HOST'
  | 'INVALID_PORT'
  | 'INVALID_BROADCAST'
  | 'INVALID_RELAY'
  | 'NETWORK_FAILED'
  | 'RELAY_FAILED';

/** 唤醒流程结构化错误 */
export class WakeError extends Error {
  readonly code: WakeErrorCode;

  constructor(code: WakeErrorCode, message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'WakeError';
    this.code = code;
  }
}

/** 判别未知异常是否为 `WakeError` */
export function isWakeError(value: unknown): value is WakeError {
  return value instanceof WakeError;
}
