/**
 * `@iyowei/fan-cli` 终端仪表渲染构件 (纯函数, 零 IO):
 * 采用紧凑徽标页眉 + 64 列等宽对齐转速进度条 + 单行克制回执; `color=false` 时零 ANSI 且与着色版逐字等价。
 */
import {
  type FanInfo,
  type FanPersistedState,
  type FanStatusReport,
  type PersistDaemonStatus,
  computePercent,
} from '@iyowei/fan';

export const BAR_BLOCK = '▍';
export const NEUTRAL_BLOCK = '░';
const BANNER = 'FAN';
const PANEL_WIDTH = 64;
const GAUGE_CELLS = 12;
const MODE_COL_WIDTH = 13;
const GAUGE_FILLED_CHAR = '◼';
const GAUGE_EMPTY_CHAR = '▪';
/** 手动模式稳态展示容差 (RPM): 在 <= 35 RPM 传感器正常微波动内显示「手动」而非「提速/降速」 */
export const SETTLE_TOLERANCE_RPM = 35;

/**
 * 判定手动模式风扇的实际转速是否已精确到达目标值:
 * - 100% 满速目标要求实际显示百分比真正达到 `100.0%` (绝不在 99.7% 提前退出);
 * - 0% 最低速目标要求 `0.0%` 且误差 `<= 5 RPM`;
 * - 其余中间档位要求百分比误差 `<= 0.1%` 或转速误差 `<= 5 RPM`。
 */
export function isManualFanSettled(fan: FanInfo): boolean {
  const targetPct = computePercent(fan.targetRpm, fan.minRpm, fan.maxRpm);
  if (targetPct >= 100) {
    return fan.percent >= 100;
  }
  if (targetPct <= 0) {
    return fan.percent <= 0 && Math.abs(fan.actualRpm - fan.targetRpm) <= 5;
  }
  return (
    Math.abs(fan.percent - targetPct) <= 0.1 ||
    Math.abs(fan.actualRpm - fan.targetRpm) <= 5
  );
}

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
  const t = Math.max(0, Math.min(1, ratio));
  for (let i = 0; i < GRADIENT_STOPS.length - 1; i += 1) {
    const [t0, c0] = GRADIENT_STOPS[i]!;
    const [t1, c1] = GRADIENT_STOPS[i + 1]!;
    if (t <= t1) {
      const local = t1 === t0 ? 0 : (t - t0) / (t1 - t0);
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

function padEndDisplay(text: string, targetWidth: number): string {
  return text + ' '.repeat(Math.max(0, targetWidth - displayWidth(text)));
}

/** 渲染顶部品牌胶囊页眉 (以负空间留白代替横贯分割线, 减少视觉线条干扰) */
export function headerLines(
  title: string,
  rightTag: string,
  color: boolean,
): string[] {
  const badgePlain = `${BAR_BLOCK} ${BANNER} `;
  const leftPlain = `${badgePlain}  ${title}`;
  const gap = Math.max(
    2,
    PANEL_WIDTH - displayWidth(leftPlain) - displayWidth(rightTag),
  );
  const head = `  ${paint(badgePlain, '1;7', color)}  ${paint(title, '1', color)}${' '.repeat(gap)}${paint(rightTag, '2', color)}`;
  return [head, ''];
}

export function neutralLine(text: string, color: boolean): string {
  return `  ${paint(`${NEUTRAL_BLOCK} ${text}`, '2', color)}`;
}

function okNoteLine(text: string, color: boolean): string {
  return `  ${paint('✓', '32', color)} ${paint(text, '2', color)}`;
}

function warnNoteLine(text: string, color: boolean): string {
  return `  ${paint('!', '33', color)} ${paint(text, '33', color)}`;
}

function renderGaugeBar(
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

function manualModeLabel(fan: FanInfo): { text: string; sgr: string } {
  const rpmNum = Math.round(fan.actualRpm);
  const targetStr = `${String(Math.round(fan.targetRpm)).padStart(4)} RPM`;
  if (rpmNum === 0 && fan.targetRpm > 0) {
    return { text: `目标 ${targetStr}`, sgr: '33' };
  }
  const diff = fan.targetRpm - fan.actualRpm;
  if (diff > SETTLE_TOLERANCE_RPM) {
    return { text: `提速 ${targetStr}`, sgr: '33' };
  }
  if (diff < -SETTLE_TOLERANCE_RPM) {
    return { text: `降速 ${targetStr}`, sgr: '36' };
  }
  return { text: `手动 ${targetStr}`, sgr: '36' };
}

function formatActualRpm(fan: FanInfo, color: boolean): string {
  const rpmNum = Math.round(fan.actualRpm);
  if (rpmNum === 0 && fan.mode === 'manual' && fan.targetRpm > 0) {
    return `  ${paint('起转中', '33', color)}`;
  }
  if (rpmNum === 0) {
    return paint('   0 RPM', '2', color);
  }
  return `${paint(String(rpmNum).padStart(4), '1', color)}${paint(' RPM', '2', color)}`;
}

function formatFanLine(
  fan: FanInfo,
  color: boolean,
  settlingAuto = false,
): string {
  const label = paint(`Fan ${String(fan.index)}`, '1', color);
  const rpmNum = Math.round(fan.actualRpm);
  const actual = formatActualRpm(fan, color);

  const bar = renderGaugeBar(fan.percent, GAUGE_CELLS, color);
  const pctRaw = `${fan.percent.toFixed(1).padStart(5)}%`;
  const pct = rpmNum === 0 ? paint(pctRaw, '2', color) : pctRaw;

  let modeStyled: string;
  if (fan.mode === 'manual') {
    const { text: plain, sgr } = manualModeLabel(fan);
    const pad = ' '.repeat(Math.max(0, MODE_COL_WIDTH - displayWidth(plain)));
    modeStyled = `${paint(plain, sgr, color)}${pad}`;
  } else {
    const decelerating = settlingAuto && rpmNum > 0;
    const plain = decelerating ? '自动 (降速中)' : '自动温控';
    const pad = ' '.repeat(Math.max(0, MODE_COL_WIDTH - displayWidth(plain)));
    modeStyled = `${paint(plain, decelerating ? '33' : '32', color)}${pad}`;
  }

  const rangeRaw =
    `${String(Math.round(fan.minRpm))}-${String(Math.round(fan.maxRpm))}`.padStart(
      9,
    );
  const range = paint(rangeRaw, '2', color);

  return `  ${label}  ${actual}  ${bar} ${pct}   ${modeStyled}   ${range}`;
}

function formatSingleEntry(entry: FanPersistedState['fans'][string]): string {
  if (entry.mode === 'auto') return '自动';
  return entry.kind === 'percent'
    ? `${String(entry.value)}%`
    : `${String(Math.round(entry.value))} RPM`;
}

export function formatPersistedSummary(
  state: FanPersistedState | null | undefined,
): string | null {
  if (state === null || state === undefined) return null;
  const entries = Object.entries(state.fans).sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  if (entries.length === 0) return null;
  const labels = entries.map(([, entry]) => formatSingleEntry(entry));
  const allSame = labels.every((lbl) => lbl === labels[0]);
  if (allSame) {
    return labels[0] === '自动' ? '系统自动温控' : labels[0]!;
  }
  return entries
    .map(([idx, entry]) => `Fan ${idx}: ${formatSingleEntry(entry)}`)
    .join(' · ');
}

function isAllAutoPersisted(
  state: FanPersistedState | null | undefined,
): boolean {
  if (state === null || state === undefined) return false;
  const values = Object.values(state.fans);
  return values.length > 0 && values.every((v) => v.mode === 'auto');
}

/** 渲染完整状态或控制结果 (人类可读仪表盘或 JSON) */
export function renderReport(
  report: FanStatusReport,
  options: {
    color: boolean;
    json: boolean;
    title?: string;
    extraHint?: string;
    settlingAuto?: boolean;
  },
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  const lines: string[] = [
    '',
    ...headerLines(options.title ?? '风扇状态', 'AppleSMC', options.color),
  ];
  for (const fan of report.fans) {
    lines.push(
      formatFanLine(fan, options.color, options.settlingAuto === true),
    );
  }

  const footers: string[] = [];
  if (report.didPersist === true) {
    const summary = formatPersistedSummary(report.persisted);
    if (isAllAutoPersisted(report.persisted)) {
      footers.push(okNoteLine('已保存为系统自动温控', options.color));
    } else {
      footers.push(
        okNoteLine(
          summary !== null
            ? `已记住预设 (${summary}) · 合盖停转 / 唤醒恢复`
            : '已记住预设 · 合盖停转 / 唤醒恢复',
          options.color,
        ),
      );
    }
  } else if (report.didPersist === false) {
    footers.push(
      neutralLine('仅本次生效 (--once), 未修改已存预设', options.color),
    );
  } else {
    const summary = formatPersistedSummary(report.persisted);
    if (summary !== null) {
      footers.push(neutralLine(`已存预设  ${summary}`, options.color));
    }
  }

  if (report.daemonAction === 'installed') {
    footers.push(
      okNoteLine('已自动启用后台守护 (com.iyowei.fan)', options.color),
    );
  } else if (report.daemonAction === 'updated') {
    footers.push(
      okNoteLine('已同步更新后台守护 (com.iyowei.fan)', options.color),
    );
  }

  for (const warning of report.warnings) {
    footers.push(warnNoteLine(warning.message, options.color));
  }
  if (options.extraHint !== undefined) {
    footers.push(neutralLine(options.extraHint, options.color));
  }

  if (footers.length > 0) {
    lines.push('', ...footers);
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染 `fan persist` 守护状态面板 */
export function renderPersistStatus(
  status: PersistDaemonStatus,
  options: { color: boolean; json: boolean; title?: string },
): string {
  if (options.json) {
    return JSON.stringify(status, null, 2);
  }
  const stateSummary = formatPersistedSummary(status.state) ?? '暂无已存预设';
  const dot = status.running
    ? paint('●', '32', options.color)
    : paint('○', '2', options.color);
  const stateLabel = `${dot} ${status.installed ? '已安装' : '未安装'} · ${status.running ? '运行中' : '未运行'} (${status.label})`;

  const rows: readonly [string, string, boolean?][] = [
    ['运行状态', stateLabel, true],
    ['已存预设', stateSummary],
    ['守护策略', '合盖/睡眠自动停转 · 开盖/唤醒与重启恢复'],
    ['状态文件', status.statePath],
    ['守护脚本', status.daemonScriptPath],
    ['服务配置', status.plistPath],
    ['运行日志', status.logPath],
  ];

  const keyCol = 11;
  const lines: string[] = [
    '',
    ...headerLines(
      options.title ?? '持久化守护状态',
      'LaunchDaemon',
      options.color,
    ),
    ...rows.map(([label, value, preStyled]) => {
      const paddedKey = padEndDisplay(label, keyCol);
      const valStyled = preStyled ? value : paint(value, '2', options.color);
      return `  ${paint(paddedKey, '1', options.color)}${valStyled}`;
    }),
  ];
  if (!status.installed) {
    lines.push(
      '',
      neutralLine(
        '尚未安装守护服务, 运行 fan persist install 即可启用',
        options.color,
      ),
    );
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染 `--watch` 单行实时采样输出 */
export function renderWatchLine(
  report: FanStatusReport,
  timestamp: string,
  color: boolean,
): string {
  const parts = report.fans.map((f) => {
    const rpm = `${String(Math.round(f.actualRpm)).padStart(4)} RPM`;
    const bar = renderGaugeBar(f.percent, 8, color);
    const pct = `${String(Math.round(f.percent)).padStart(3)}%`;
    const tag =
      f.mode === 'manual'
        ? paint(`手动 ${String(Math.round(f.targetRpm))}`, '36', color)
        : paint('自动', '32', color);
    return `${paint(`F${String(f.index)}`, '1', color)} ${rpm} ${bar} ${pct} (${tag})`;
  });
  const ts = paint(timestamp, '2', color);
  return `  ${ts}   ${parts.join('   ·   ')}`;
}
