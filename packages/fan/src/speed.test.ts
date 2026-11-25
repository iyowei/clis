/**
 * `speed.ts` 单元测试: 转速规格解析、百分比计算与区间限幅。
 */
import { describe, expect, test } from 'bun:test';

import { isFanError } from './errors.ts';
import { computePercent, parseSpeedSpec, resolveTargetRpm } from './speed.ts';
import type { FanInfo } from './types.ts';

const FAN_0: FanInfo = {
  index: 0,
  actualRpm: 3000,
  targetRpm: 3000,
  minRpm: 1350,
  maxRpm: 6250,
  mode: 'manual',
  percent: 33.7,
};

describe('computePercent', () => {
  test('正确换算区间百分比并夹逼在 0..100', () => {
    expect(computePercent(1350, 1350, 6250)).toBe(0);
    expect(computePercent(3800, 1350, 6250)).toBe(50);
    expect(computePercent(6250, 1350, 6250)).toBe(100);
    expect(computePercent(0, 1350, 6250)).toBe(0);
    expect(computePercent(7000, 1350, 6250)).toBe(100);
    expect(computePercent(1000, 1000, 1000)).toBe(0);
  });
});

describe('parseSpeedSpec', () => {
  test('支持 RPM 数字串与百分比串', () => {
    expect(parseSpeedSpec('4000')).toEqual({ kind: 'rpm', rpm: 4000 });
    expect(parseSpeedSpec(' 60% ')).toEqual({ kind: 'percent', percent: 60 });
    expect(parseSpeedSpec('0%')).toEqual({ kind: 'percent', percent: 0 });
    expect(parseSpeedSpec('100%')).toEqual({ kind: 'percent', percent: 100 });
  });

  test('拒绝空串、负数、NaN 与超界百分比', () => {
    for (const bad of ['', '   ', '0', '-500', 'abc', '101%', '-1%', '%']) {
      try {
        parseSpeedSpec(bad);
        throw new Error(`Expected failure for ${bad}`);
      } catch (err) {
        expect(isFanError(err)).toBe(true);
        if (isFanError(err)) expect(err.code).toBe('INVALID_SPEED');
      }
    }
  });
});

describe('resolveTargetRpm', () => {
  test('百分比按单扇区间映射, 超单扇上限 RPM 自动限幅并标记 clamped', () => {
    expect(resolveTargetRpm(FAN_0, { kind: 'percent', percent: 50 })).toEqual({
      targetRpm: 3800,
      clamped: false,
    });
    expect(resolveTargetRpm(FAN_0, { kind: 'rpm', rpm: 6500 })).toEqual({
      targetRpm: 6250,
      clamped: true,
    });
    expect(resolveTargetRpm(FAN_0, { kind: 'rpm', rpm: 3000 })).toEqual({
      targetRpm: 3000,
      clamped: false,
    });
  });
});
