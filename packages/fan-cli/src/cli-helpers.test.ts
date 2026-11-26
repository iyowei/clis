/**
 * `cli-helpers.ts` 边界覆盖:
 * - `localizeFanError` 英文/中文错误映射
 */
import { describe, expect, test } from 'bun:test';

import { FanError } from '@iyowei/fan';

import { localizeFanError } from './cli-helpers.ts';

describe('cli-helpers 本地化', () => {
  test('localizeFanError 正确覆盖 STATE_CORRUPT 与注入 platform', () => {
    const errState = new FanError('STATE_CORRUPT', 'invalid syntax');
    expect(localizeFanError(errState, 'en')).toBe(
      'Corrupted fan state file: invalid syntax',
    );
    expect(localizeFanError(errState, 'zh')).toBe('invalid syntax');

    const errPlatform = new FanError(
      'UNSUPPORTED_PLATFORM',
      '仅支持 macOS (当前: freebsd)',
    );
    expect(localizeFanError(errPlatform, 'en', 'darwin')).toContain(
      'current: freebsd',
    );
  });
});
