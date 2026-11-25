/**
 * 纯函数转速规格解析、限幅与百分比换算 (零 IO, 跨平台可单测)。
 */
import { FanError } from './errors.ts';
import type { FanInfo, SpeedSpec } from './types.ts';

/** 计算当前实际转速在 `[minRpm, maxRpm]` 区间内的百分比 (保留 1 位小数, 夹逼到 `0..100`) */
export function computePercent(
  actualRpm: number,
  minRpm: number,
  maxRpm: number,
): number {
  const span = maxRpm - minRpm;
  if (span <= 0) return 0;
  const raw = ((actualRpm - minRpm) / span) * 100;
  const clamped = Math.max(0, Math.min(100, raw));
  return Math.round(clamped * 10) / 10;
}

/** 解析字符串或结构化转速输入: 支持纯数字 RPM (如 `4000`) 与百分比 (如 `60%`) */
export function parseSpeedSpec(input: string | SpeedSpec): SpeedSpec {
  if (typeof input !== 'string') {
    if (input.kind === 'percent') {
      if (
        !Number.isFinite(input.percent) ||
        input.percent < 0 ||
        input.percent > 100
      ) {
        throw new FanError(
          'INVALID_SPEED',
          `百分比必须在 0% 到 100% 之间, 收到 ${String(input.percent)}`,
        );
      }
      return input;
    }
    if (!Number.isFinite(input.rpm) || input.rpm <= 0) {
      throw new FanError(
        'INVALID_SPEED',
        `RPM 必须为正数, 收到 ${String(input.rpm)}`,
      );
    }
    return input;
  }

  const trimmed = input.trim();
  if (trimmed === '') {
    throw new FanError('INVALID_SPEED', '转速不能为空');
  }
  if (trimmed.endsWith('%')) {
    const rawPct = trimmed.slice(0, -1).trim();
    const pct = Number(rawPct);
    if (rawPct === '' || !Number.isFinite(pct) || pct < 0 || pct > 100) {
      throw new FanError(
        'INVALID_SPEED',
        `百分比必须在 0% 到 100% 之间, 收到 ${input}`,
      );
    }
    return { kind: 'percent', percent: pct };
  }

  const rpm = Number(trimmed);
  if (!Number.isFinite(rpm) || rpm <= 0) {
    throw new FanError('INVALID_SPEED', `RPM 必须为正数, 收到 ${input}`);
  }
  return { kind: 'rpm', rpm };
}

/** 根据目标风扇允许区间解析最终目标 RPM 与是否发生了跨风扇区间夹逼 */
export function resolveTargetRpm(
  fan: FanInfo,
  spec: SpeedSpec,
): { targetRpm: number; clamped: boolean } {
  if (spec.kind === 'percent') {
    const raw = fan.minRpm + (spec.percent / 100) * (fan.maxRpm - fan.minRpm);
    return { targetRpm: Math.round(raw), clamped: false };
  }
  const clampedRpm = Math.max(fan.minRpm, Math.min(fan.maxRpm, spec.rpm));
  return {
    targetRpm: clampedRpm,
    clamped: Math.abs(clampedRpm - spec.rpm) >= 1,
  };
}
