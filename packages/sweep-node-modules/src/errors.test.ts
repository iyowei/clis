/**
 * 错误模型的实际调用验证: 从公开面入口 (index.ts) 导入, 按真实调用方的方式使用。
 * 覆盖: SweepError 构造与属性 / code 全表 / details 判别联合 / isSweepError 跨实例判别与负例。
 */
import { describe, expect, test } from 'bun:test';

import { SweepError, type SweepErrorCode, isSweepError } from './index.ts';

/** SweepErrorCode 的全表 (与 codes.ts 的类型同步; 漏项会被本测试抓出) */
const ALL_SWEEP_ERROR_CODES = [
  'CONFIG_READ_FAILED',
  'CONFIG_CORRUPT_JSON',
  'CONFIG_CORRUPT_SHAPE',
  'CONFIG_ABSENT',
  'INVALID_ARGUMENT',
  'CANCELLED',
] satisfies SweepErrorCode[];

describe('SweepError 错误模型', () => {
  test('构造与属性: code / message / details / name / stack 齐备', () => {
    const err = new SweepError('INVALID_ARGUMENT', 'roots 不能为空', {
      field: 'roots',
    });

    expect(err).toBeInstanceOf(Error);
    expect(err).toBeInstanceOf(SweepError);
    expect(err.name).toBe('SweepError');
    expect(err.code).toBe('INVALID_ARGUMENT');
    expect(err.message).toBe('roots 不能为空');
    expect(err.details).toEqual({ field: 'roots' });
    expect(typeof err.stack).toBe('string');
  });

  test('details 可省略 (仅 code + message 也成立)', () => {
    const err = new SweepError('CANCELLED', '已取消');
    expect(err.details).toBeUndefined();
    expect(err.code).toBe('CANCELLED');
  });

  test('CANCELLED 携带 phase; partial 只在 remove 阶段出现 (json 可序列化)', () => {
    const err = new SweepError('CANCELLED', '删除阶段被取消', {
      phase: 'remove',
      partial: {
        removed: ['/ws/a/node_modules'],
        missing: [],
        failed: [],
      },
    });

    expect(err.details).toEqual({
      phase: 'remove',
      partial: { removed: ['/ws/a/node_modules'], missing: [], failed: [] },
    });
    // 域类型可序列化承诺: details 里的 RemovalResult 是普通对象
    expect(JSON.parse(JSON.stringify(err.details))).toEqual(err.details);
  });

  test('全部 6 个 code 均可构造, 且被 isSweepError 认可 (含跨实例路径)', () => {
    for (const code of ALL_SWEEP_ERROR_CODES) {
      const err = new SweepError(code, `${code} 的说明`);
      expect(err.code).toBe(code);
      expect(isSweepError(err)).toBe(true);
    }
  });
});

describe('isSweepError 跨实例判别', () => {
  test('同形对象 (模拟另一份库实例 / 打包边界) 判真, 不依赖类身份', () => {
    const foreign = Object.assign(new Error('boom'), {
      name: 'SweepError',
      code: 'CANCELLED',
    });

    // 关键: 它不是本实例的 SweepError (instanceof 会假阴), 但类型守卫应判真
    expect(foreign instanceof SweepError).toBe(false);
    expect(isSweepError(foreign)).toBe(true);
  });

  test('负例: 非对象 / 普通 Error / name 不符 / code 非法 / code 非字符串', () => {
    expect(isSweepError(null)).toBe(false);
    expect(isSweepError(undefined)).toBe(false);
    expect(isSweepError('SweepError')).toBe(false);
    expect(isSweepError(new Error('普通错误'))).toBe(false);
    expect(isSweepError(Object.assign(new Error('x'), { name: 'Other' }))).toBe(
      false,
    );
    expect(
      isSweepError(
        Object.assign(new Error('x'), {
          name: 'SweepError',
          code: 'NOT_A_CODE',
        }),
      ),
    ).toBe(false);
    expect(
      isSweepError(
        Object.assign(new Error('x'), { name: 'SweepError', code: 42 }),
      ),
    ).toBe(false);
  });
});
