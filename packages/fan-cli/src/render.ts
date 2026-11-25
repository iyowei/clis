/**
 * `@iyowei/fan-cli` 终端渲染构件 (纯函数, 零 IO):
 * 遵循与 `sweep` / `codd` 同源的 `▍ FAN` 顶栏与单色系 SGR 着色; `color=false` 时零 ANSI 字符。
 */
import type {
  FanInfo,
  FanPersistedState,
  FanStatusReport,
  PersistDaemonStatus,
} from '@iyowei/fan';

export const BAR_BLOCK = '▍';
export const NEUTRAL_BLOCK = '░';
const BANNER = 'FAN';

export function paint(text: string, sgr: string, color: boolean): string {
  return color ? `\u001B[${sgr}m${text}\u001B[0m` : text;
}

export function bannerLine(suffix: string, color: boolean): string {
  return paint(`${BAR_BLOCK} ${BANNER}  ${suffix}`, '1;7', color);
}

export function neutralLine(text: string, color: boolean): string {
  return `  ${paint(`${NEUTRAL_BLOCK} ${text}`, '2', color)}`;
}

function formatFanLine(fan: FanInfo, color: boolean): string {
  const label = paint(`Fan ${String(fan.index)}`, '1', color);
  const actual = `${String(Math.round(fan.actualRpm)).padStart(4)} RPM`;
  const target = `${String(Math.round(fan.targetRpm)).padStart(4)} RPM`;
  const range =
    `${String(Math.round(fan.minRpm))}-${String(Math.round(fan.maxRpm))}`.padEnd(
      9,
    );
  const modeTag =
    fan.mode === 'manual'
      ? paint('manual', '36', color)
      : paint('auto  ', '32', color);
  const pct = `${fan.percent.toFixed(1).padStart(5)}%`;
  return `  ${label}  actual=${actual}  target=${target}  range=${range}  mode=${modeTag}  (${pct})`;
}

export function formatPersistedSummary(
  state: FanPersistedState | null | undefined,
): string | null {
  if (state === null || state === undefined) return null;
  const entries = Object.entries(state.fans).sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  if (entries.length === 0) return null;
  return entries
    .map(([idx, entry]) => {
      if (entry.mode === 'auto') return `Fan ${idx}=auto`;
      return entry.kind === 'percent'
        ? `Fan ${idx}=${String(entry.value)}%`
        : `Fan ${idx}=${String(Math.round(entry.value))} RPM`;
    })
    .join(', ');
}

/** 渲染完整状态或控制结果 (文本或 JSON) */
export function renderReport(
  report: FanStatusReport,
  options: {
    color: boolean;
    json: boolean;
    title?: string;
    extraHint?: string;
  },
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  const lines: string[] = [
    bannerLine(options.title ?? '风扇状态', options.color),
  ];
  for (const fan of report.fans) {
    lines.push(formatFanLine(fan, options.color));
  }
  if (report.didPersist === true) {
    const summary = formatPersistedSummary(report.persisted);
    lines.push(
      neutralLine(
        summary !== null
          ? `已记住配置 (${summary}), 开机与唤醒将自动恢复 (临时调试请加 --once)`
          : '已更新持久化配置, 开机与唤醒将自动恢复',
        options.color,
      ),
    );
  } else if (report.didPersist === false) {
    lines.push(
      neutralLine('仅本次生效 (--once), 未改写持久化配置', options.color),
    );
  } else {
    const summary = formatPersistedSummary(report.persisted);
    if (summary !== null) {
      lines.push(neutralLine(`持久化配置: ${summary}`, options.color));
    }
  }
  for (const warning of report.warnings) {
    lines.push(neutralLine(warning.message, options.color));
  }
  if (options.extraHint !== undefined) {
    lines.push(neutralLine(options.extraHint, options.color));
  }
  return lines.join('\n');
}

/** 渲染 `fan persist` 守护状态输出 */
export function renderPersistStatus(
  status: PersistDaemonStatus,
  options: { color: boolean; json: boolean; title?: string },
): string {
  if (options.json) {
    return JSON.stringify(status, null, 2);
  }
  const stateSummary = formatPersistedSummary(status.state) ?? '暂无已保存配置';
  const rows: readonly [string, string][] = [
    [
      '守护服务',
      `${status.label} (${status.installed ? '已安装' : '未安装'} / ${status.running ? '运行中' : '未运行'})`,
    ],
    ['恢复时机', '开机 (RunAtLoad) 与睡眠唤醒 (kIOMessageSystemHasPoweredOn)'],
    ['已记目标', stateSummary],
    ['配置文件', status.statePath],
    ['守护脚本', status.daemonScriptPath],
    ['描述文件', status.plistPath],
    ['日志文件', status.logPath],
  ];
  const lines: string[] = [
    bannerLine(options.title ?? '持久化守护状态', options.color),
    ...rows.map(
      ([label, value]) => `  ${paint(label, '1', options.color)}  ${value}`,
    ),
  ];
  if (!status.installed) {
    lines.push(
      neutralLine(
        '尚未安装开机/唤醒恢复守护, 运行 fan persist install 即可启用',
        options.color,
      ),
    );
  }
  return lines.join('\n');
}

/** 渲染 `--watch` 单行实时采样输出 */
export function renderWatchLine(
  report: FanStatusReport,
  timestamp: string,
  color: boolean,
): string {
  const parts = report.fans.map(
    (f) =>
      `F${String(f.index)}: ${String(Math.round(f.actualRpm))}/${String(Math.round(f.targetRpm))} RPM (${f.mode})`,
  );
  const ts = paint(`[${timestamp}]`, '2', color);
  return `${ts} ${parts.join(' | ')}`;
}
