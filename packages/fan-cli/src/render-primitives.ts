/**
 * `@iyowei/fan-cli` 终端原子样式、列宽度量与渐变进度块渲染原语。
 */
import { type Locale, t } from '@iyowei/cli-i18n';
import type { FanInfo, FanPersistedState, FanWarning } from '@iyowei/fan';

export const BAR_BLOCK = '▍';
export const NEUTRAL_BLOCK = '░';
const BANNER = 'FAN';
export const PANEL_WIDTH_ZH = 64;
export const PANEL_WIDTH_EN = 67;
const GAUGE_FILLED_CHAR = '◼';
const GAUGE_EMPTY_CHAR = '▪';

type Rgb = readonly [number, number, number];

const GRADIENT_STOPS: readonly (readonly [number, Rgb])[] = [
  [0.0, [52, 211, 153]],
  [0.45, [56, 189, 248]],
  [0.78, [251, 191, 36]],
  [1.0, [251, 113, 133]],
];
const EMPTY_CELL_RGB: Rgb = [68, 75, 89];

export function paint(text: string, sgr: string, color: boolean): string {
  return color ? `\u001B[${sgr}m${text}\u001B[0m` : text;
}

function paintRgb(text: string, [r, g, b]: Rgb, color: boolean): string {
  return color
    ? `\u001B[38;2;${String(r)};${String(g)};${String(b)}m${text}\u001B[0m`
    : text;
}

function interpolateGaugeColor(ratio: number): Rgb {
  const clamped = Math.max(0, Math.min(1, ratio));
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i += 1) {
    const [t0, c0] = GRADIENT_STOPS[i]!;
    const [t1, c1] = GRADIENT_STOPS[i + 1]!;
    if (clamped <= t1) {
      const local = t1 === t0 ? 0 : (clamped - t0) / (t1 - t0);
      return [
        Math.round(c0[0] + (c1[0] - c0[0]) * local),
        Math.round(c0[1] + (c1[1] - c0[1]) * local),
        Math.round(c0[2] + (c1[2] - c0[2]) * local),
      ];
    }
  }
  return GRADIENT_STOPS[GRADIENT_STOPS.length - 1]![1];
}

function isFullWidthCodePoint(code: number): boolean {
  return (
    code === 0x3000 ||
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2329 && code <= 0x232a) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe10 && code <= 0xfe19) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff01 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6) ||
    (code >= 0x1f300 && code <= 0x1faff) ||
    (code >= 0x20000 && code <= 0x2fffd) ||
    (code >= 0x30000 && code <= 0x3fffd)
  );
}

/** 计算纯文本字符串在终端中的精确显示列宽 (东亚全角计 2 列, ASCII 计 1 列) */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (code < 32 || (code >= 0x7f && code <= 0x9f)) continue;
    width += isFullWidthCodePoint(code) ? 2 : 1;
  }
  return width;
}

export function padEndDisplay(text: string, targetWidth: number): string {
  return text + ' '.repeat(Math.max(0, targetWidth - displayWidth(text)));
}

/** 渲染顶部品牌胶囊页眉 (以负空间留白代替横贯分割线, 右端与风扇范围列严格对齐) */
export function headerLines(
  title: string,
  rightTag: string,
  color: boolean,
  locale: Locale = 'zh',
): string[] {
  const panelWidth = locale === 'en' ? PANEL_WIDTH_EN : PANEL_WIDTH_ZH;
  const badgePlain = `${BAR_BLOCK} ${BANNER} `;
  const leftPlain = `${badgePlain}  ${title}`;
  const gap = Math.max(
    2,
    panelWidth - displayWidth(leftPlain) - displayWidth(rightTag),
  );
  const head = `  ${paint(badgePlain, '1;7', color)}  ${paint(title, '1', color)}${' '.repeat(gap)}${paint(rightTag, '2', color)}`;
  return [head, ''];
}

export function neutralLine(text: string, color: boolean): string {
  return `  ${paint(`${NEUTRAL_BLOCK} ${text}`, '2', color)}`;
}

export function okNoteLine(text: string, color: boolean): string {
  return `  ${paint('✓', '32', color)} ${paint(text, '2', color)}`;
}

export function warnNoteLine(text: string, color: boolean): string {
  return `  ${paint('!', '33', color)} ${paint(text, '33', color)}`;
}

export function renderGaugeBar(
  percent: number,
  cells: number,
  color: boolean,
): string {
  const clamped = Math.max(0, Math.min(100, percent));
  const filled = Math.round((clamped / 100) * cells);
  const empty = Math.max(0, cells - filled);
  const denom = Math.max(1, cells - 1);
  const parts: string[] = [];
  for (let i = 0; i < filled; i += 1) {
    parts.push(
      paintRgb(GAUGE_FILLED_CHAR, interpolateGaugeColor(i / denom), color),
    );
  }
  if (empty > 0) {
    parts.push(paintRgb(GAUGE_EMPTY_CHAR.repeat(empty), EMPTY_CELL_RGB, color));
  }
  return parts.join('');
}

function classifyPersistedStrategy(
  state: FanPersistedState | null | undefined,
): { hasFloor: boolean; hasExplicitFixed: boolean } {
  if (state === null || state === undefined) {
    return { hasFloor: false, hasExplicitFixed: false };
  }
  let hasFloor = false;
  let hasExplicitFixed = false;
  for (const entry of Object.values(state.fans)) {
    if (entry.mode !== 'manual') continue;
    const isMax = entry.kind === 'percent' && entry.value >= 100;
    if (isMax) continue;
    if (entry.strategy === 'fixed') {
      hasExplicitFixed = true;
    } else {
      hasFloor = true;
    }
  }
  return { hasFloor, hasExplicitFixed };
}

/** 渲染持久化调速策略补充提示行 (保底下限高温提速 vs `--fixed` 锁定转速) */
export function renderStrategyNoteLine(
  state: FanPersistedState | null | undefined,
  locale: Locale,
  color: boolean,
): string | null {
  const { hasFloor, hasExplicitFixed } = classifyPersistedStrategy(state);
  if (hasFloor) {
    return okNoteLine(
      t(
        locale,
        '保底下限模式 · 温度升高自动提速, 降温回落至设定阈值',
        'Floor mode · Auto-ramps when hot, never drops below target',
      ),
      color,
    );
  }
  if (hasExplicitFixed) {
    return neutralLine(
      t(
        locale,
        '固定转速模式 (--fixed) · 恒定维持目标转速',
        'Fixed speed mode (--fixed) · Constant target RPM',
      ),
      color,
    );
  }
  return null;
}

/** 为 `status` / `apply` 的已存预设摘要附加策略后缀 */
export function appendSavedStrategyTag(
  summary: string,
  state: FanPersistedState | null | undefined,
  locale: Locale,
): string {
  const { hasFloor, hasExplicitFixed } = classifyPersistedStrategy(state);
  if (hasFloor && !hasExplicitFixed) {
    return t(
      locale,
      `${summary} · 保底下限 (高温自动提速)`,
      `${summary} · Floor (auto-ramps when hot)`,
    );
  }
  if (hasExplicitFixed && !hasFloor) {
    return t(locale, `${summary} · 固定转速`, `${summary} · Fixed`);
  }
  return summary;
}

export function formatWarningMessage(
  warning: FanWarning,
  fans: readonly FanInfo[],
  locale: Locale,
): string {
  if (locale === 'zh') return warning.message;
  if (warning.code === 'MACS_FAN_CONTROL_RUNNING') {
    if (warning.message.includes('检测到 Macs Fan Control')) {
      return 'Macs Fan Control is running in the background and may override manual SMC speeds';
    }
    return warning.message;
  }
  if (warning.code === 'FAN_CLAMPED' && warning.fanIndex !== undefined) {
    const fan = fans.find((f) => f.index === warning.fanIndex);
    if (fan !== undefined) {
      return `Fan ${String(fan.index)} target clamped to ${String(Math.round(fan.targetRpm))} RPM (allowed ${String(Math.round(fan.minRpm))}-${String(Math.round(fan.maxRpm))})`;
    }
  }
  if (warning.code === 'STATE_CORRUPT') {
    return `Persisted state file is corrupted or unreadable (${warning.message})`;
  }
  return warning.message;
}
