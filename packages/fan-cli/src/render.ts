/**
 * `@iyowei/fan-cli` 终端仪表渲染构件 (纯函数, 零 IO, 支持中英双语 Apple HIG 精确等宽栅格):
 * - 中文栅格: 64 列面板 (`total = 66` 列, 状态列 `13` 列);
 * - 英文栅格: 67 列面板 (`total = 69` 列, 状态列 `16` 列, `Starting` 与 `2818 RPM` 同为 8 列零跳动);
 * - `color=false` 时零 ANSI 且与着色版逐字等价。
 */
import { type Locale, t } from '@iyowei/cli-i18n';
import {
  type FanInfo,
  type FanPersistedState,
  type FanStatusReport,
  type PersistDaemonStatus,
  computePercent,
} from '@iyowei/fan';

import {
  BAR_BLOCK,
  NEUTRAL_BLOCK,
  appendSavedStrategyTag,
  displayWidth,
  formatWarningMessage,
  headerLines,
  neutralLine,
  okNoteLine,
  padEndDisplay,
  paint,
  renderGaugeBar,
  renderStrategyNoteLine,
  warnNoteLine,
} from './render-primitives.ts';

export {
  BAR_BLOCK,
  NEUTRAL_BLOCK,
  displayWidth,
  headerLines,
  neutralLine,
  paint,
};

const GAUGE_CELLS = 12;
const MODE_COL_WIDTH_ZH = 13;
const MODE_COL_WIDTH_EN = 16;
/** 手动模式稳态展示容差 (RPM): 在 <= 35 RPM 传感器正常微波动内显示「手动 / Manual」 */
export const SETTLE_TOLERANCE_RPM = 35;

function rawPercentTenths(fan: FanInfo): number {
  const span = fan.maxRpm - fan.minRpm;
  if (span <= 0) return 0;
  return Math.round(((fan.actualRpm - fan.minRpm) / span) * 1000);
}

/**
 * 通用手动到位判定 (零硬编码特定档位分支):
 * 每个受控风扇的展示百分比十分位 (`Math.round(fan.percent * 10)`) 必须严格等于其目标转速对应的
 * 目标百分比十分位 (`targetTenths`); 在 `0.0%` (`minRpm`) 处同时要求未夹逼原始十分位亦为 `0`,
 * 防止从 `0 RPM` 静止态因下限夹逼到 `0.0%` 而误判已起转到位。
 * 无论升速 (`35.9% -> 36.0%`、`89.9% -> 90.0%`、`99.7% -> 100.0%`) 还是降速 (`36.1% -> 36.0%`),
 * 均须所有受控风扇精确收敛到各自目标十分位后才退出。
 */
export function isManualFanSettled(fan: FanInfo): boolean {
  if (fan.maxRpm <= fan.minRpm) return true;
  if (fan.targetRpm > 0 && Math.round(fan.actualRpm) === 0) return false;
  const targetTenths = Math.round(
    computePercent(fan.targetRpm, fan.minRpm, fan.maxRpm) * 10,
  );
  const actualTenths = Math.round(fan.percent * 10);
  if (actualTenths !== targetTenths) {
    return false;
  }
  return targetTenths === 0
    ? Math.abs(fan.actualRpm - fan.targetRpm) <= SETTLE_TOLERANCE_RPM
    : true;
}

function manualModeLabel(
  fan: FanInfo,
  locale: Locale,
  settling = false,
): { text: string; sgr: string } {
  const rpmNum = Math.round(fan.actualRpm);
  const targetStr = `${String(Math.round(fan.targetRpm)).padStart(4)} RPM`;
  const targetTenths = Math.round(
    computePercent(fan.targetRpm, fan.minRpm, fan.maxRpm) * 10,
  );
  const rawTenths = rawPercentTenths(fan);
  const settled = isManualFanSettled(fan);
  const diff = fan.targetRpm - fan.actualRpm;
  const isRamping =
    !settled &&
    (settling ? rawTenths < targetTenths : diff > SETTLE_TOLERANCE_RPM);
  const isSlowing =
    !settled &&
    (settling ? rawTenths > targetTenths : diff < -SETTLE_TOLERANCE_RPM);

  if (locale === 'en') {
    // 4 类英文标签统一精确对齐 16 列 (`Target  ` / `Ramping ` / `Slowing ` / `Manual  ` + `XXXX RPM`)
    if (rpmNum === 0 && fan.targetRpm > 0) {
      return { text: `Target  ${targetStr}`, sgr: '33' };
    }
    if (isRamping) {
      return { text: `Ramping ${targetStr}`, sgr: '33' };
    }
    if (isSlowing) {
      return { text: `Slowing ${targetStr}`, sgr: '36' };
    }
    return { text: `Manual  ${targetStr}`, sgr: '36' };
  }
  if (rpmNum === 0 && fan.targetRpm > 0) {
    return { text: `目标 ${targetStr}`, sgr: '33' };
  }
  if (isRamping) {
    return { text: `提速 ${targetStr}`, sgr: '33' };
  }
  if (isSlowing) {
    return { text: `降速 ${targetStr}`, sgr: '36' };
  }
  return { text: `手动 ${targetStr}`, sgr: '36' };
}

function formatActualRpm(fan: FanInfo, color: boolean, locale: Locale): string {
  const rpmNum = Math.round(fan.actualRpm);
  if (rpmNum === 0 && fan.mode === 'manual' && fan.targetRpm > 0) {
    return locale === 'en'
      ? paint('Starting', '33', color)
      : `  ${paint('起转中', '33', color)}`;
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
  locale: Locale = 'zh',
): string {
  const modeColWidth = locale === 'en' ? MODE_COL_WIDTH_EN : MODE_COL_WIDTH_ZH;
  const label = paint(`Fan ${String(fan.index)}`, '1', color);
  const rpmNum = Math.round(fan.actualRpm);
  const actual = formatActualRpm(fan, color, locale);

  const bar = renderGaugeBar(fan.percent, GAUGE_CELLS, color);
  const pctRaw = `${fan.percent.toFixed(1).padStart(5)}%`;
  const pct = rpmNum === 0 ? paint(pctRaw, '2', color) : pctRaw;

  let modeStyled: string;
  if (fan.mode === 'manual') {
    const { text: plain, sgr } = manualModeLabel(fan, locale, settlingAuto);
    const pad = ' '.repeat(Math.max(0, modeColWidth - displayWidth(plain)));
    modeStyled = `${paint(plain, sgr, color)}${pad}`;
  } else {
    const decelerating = settlingAuto && rpmNum > 0;
    const plain = decelerating
      ? t(locale, '自动 (降速中)', 'Spinning down')
      : t(locale, '自动温控', 'Auto Thermal');
    const pad = ' '.repeat(Math.max(0, modeColWidth - displayWidth(plain)));
    modeStyled = `${paint(plain, decelerating ? '33' : '32', color)}${pad}`;
  }

  const rangeRaw =
    `${String(Math.round(fan.minRpm))}-${String(Math.round(fan.maxRpm))}`.padStart(
      9,
    );
  const range = paint(rangeRaw, '2', color);

  return `  ${label}  ${actual}  ${bar} ${pct}   ${modeStyled}   ${range}`;
}

function formatSingleEntry(
  entry: FanPersistedState['fans'][string],
  locale: Locale,
): string {
  if (entry.mode === 'auto') return t(locale, '自动', 'Auto');
  return entry.kind === 'percent'
    ? `${String(entry.value)}%`
    : `${String(Math.round(entry.value))} RPM`;
}

export function formatPersistedSummary(
  state: FanPersistedState | null | undefined,
  locale: Locale = 'zh',
): string | null {
  if (state === null || state === undefined) return null;
  const entries = Object.entries(state.fans).sort(([a], [b]) =>
    a.localeCompare(b, 'en', { numeric: true }),
  );
  if (entries.length === 0) return null;
  const labels = entries.map(([, entry]) => formatSingleEntry(entry, locale));
  const allSame = labels.every((lbl) => lbl === labels[0]);
  if (allSame) {
    const autoToken = t(locale, '自动', 'Auto');
    return labels[0] === autoToken
      ? t(locale, '系统自动温控', 'Auto Thermal')
      : labels[0]!;
  }
  return entries
    .map(([idx, entry]) => `Fan ${idx}: ${formatSingleEntry(entry, locale)}`)
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
    extraHintPrestyled?: boolean;
    settlingAuto?: boolean;
    locale?: Locale;
  },
): string {
  if (options.json) {
    return JSON.stringify(report, null, 2);
  }
  const locale = options.locale ?? 'zh';
  const defaultTitle = t(locale, '风扇状态', 'Fan Status');
  const lines: string[] = [
    '',
    ...headerLines(
      options.title ?? defaultTitle,
      'AppleSMC',
      options.color,
      locale,
    ),
  ];
  for (const fan of report.fans) {
    lines.push(
      formatFanLine(fan, options.color, options.settlingAuto === true, locale),
    );
  }

  const footers: string[] = [];
  if (report.didPersist === true) {
    const summary = formatPersistedSummary(report.persisted, locale);
    if (isAllAutoPersisted(report.persisted)) {
      footers.push(
        okNoteLine(
          t(
            locale,
            '已保存为系统自动温控',
            'Saved as automatic thermal control',
          ),
          options.color,
        ),
      );
    } else {
      footers.push(
        okNoteLine(
          summary !== null
            ? t(
                locale,
                `已记住预设 (${summary}) · 合盖停转 / 唤醒恢复`,
                `Saved preset (${summary}) · Stops on lid close, restores on wake`,
              )
            : t(
                locale,
                '已记住预设 · 合盖停转 / 唤醒恢复',
                'Saved preset · Stops on lid close, restores on wake',
              ),
          options.color,
        ),
      );
      const strategyLine = renderStrategyNoteLine(
        report.persisted,
        locale,
        options.color,
      );
      if (strategyLine !== null) {
        footers.push(strategyLine);
      }
    }
  } else if (report.didPersist === false) {
    const hasManualOnce = report.fans.some((f) => f.mode === 'manual');
    footers.push(
      neutralLine(
        hasManualOnce
          ? t(
              locale,
              '仅本次生效 (--once) · 固定转速不随高温提速, 未改预设',
              'Applied once (--once) · Fixed speed, preset unchanged',
            )
          : t(
              locale,
              '仅本次生效 (--once), 未修改已存预设',
              'Applied once (--once) · Saved preset unchanged',
            ),
        options.color,
      ),
    );
  } else {
    const summary = formatPersistedSummary(report.persisted, locale);
    if (summary !== null) {
      const tagged = appendSavedStrategyTag(summary, report.persisted, locale);
      footers.push(
        neutralLine(
          t(locale, `已存预设  ${tagged}`, `Saved preset  ${tagged}`),
          options.color,
        ),
      );
    }
  }

  if (report.daemonAction === 'installed') {
    footers.push(
      okNoteLine(
        t(
          locale,
          '已自动启用后台守护 (com.iyowei.fan)',
          'Enabled background daemon (com.iyowei.fan)',
        ),
        options.color,
      ),
    );
  } else if (report.daemonAction === 'updated') {
    footers.push(
      okNoteLine(
        t(
          locale,
          '已同步更新后台守护 (com.iyowei.fan)',
          'Synced background daemon (com.iyowei.fan)',
        ),
        options.color,
      ),
    );
  }

  for (const warning of report.warnings) {
    footers.push(
      warnNoteLine(
        formatWarningMessage(warning, report.fans, locale),
        options.color,
      ),
    );
  }
  if (options.extraHint !== undefined) {
    footers.push(
      options.extraHintPrestyled === true
        ? `  ${paint(NEUTRAL_BLOCK, '2', options.color)} ${options.extraHint}`
        : neutralLine(options.extraHint, options.color),
    );
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
  options: {
    color: boolean;
    json: boolean;
    title?: string;
    locale?: Locale;
  },
): string {
  if (options.json) {
    return JSON.stringify(status, null, 2);
  }
  const locale = options.locale ?? 'zh';
  const stateSummary =
    status.stateError !== undefined
      ? t(locale, '状态文件损坏/不可读', 'Corrupted / unreadable')
      : (formatPersistedSummary(status.state, locale) ??
        t(locale, '暂无已存预设', 'None'));
  const dot = status.running
    ? paint('●', '32', options.color)
    : paint('○', '2', options.color);
  const stateLabel =
    locale === 'en'
      ? `${dot} ${status.installed ? 'Installed' : 'Not installed'} · ${status.running ? 'Running' : 'Stopped'} (${status.label})`
      : `${dot} ${status.installed ? '已安装' : '未安装'} · ${status.running ? '运行中' : '未运行'} (${status.label})`;

  const rows: readonly [string, string, boolean?][] =
    locale === 'en'
      ? [
          ['Status', stateLabel, true],
          ['Saved Preset', stateSummary],
          [
            'Power Policy',
            'Floor auto-boost · Auto on lid/sleep · Wake restore',
          ],
          ['State File', status.statePath],
          ['Daemon Script', status.daemonScriptPath],
          ['Launchd Plist', status.plistPath],
          ['Log File', status.logPath],
        ]
      : [
          ['运行状态', stateLabel, true],
          ['已存预设', stateSummary],
          ['守护策略', '保底下限高温提速 · 合盖/睡眠停转 · 唤醒恢复'],
          ['状态文件', status.statePath],
          ['守护脚本', status.daemonScriptPath],
          ['服务配置', status.plistPath],
          ['运行日志', status.logPath],
        ];

  const keyCol = locale === 'en' ? 15 : 11;
  const lines: string[] = [
    '',
    ...headerLines(
      options.title ?? t(locale, '持久化守护状态', 'Persistence Daemon'),
      'LaunchDaemon',
      options.color,
      locale,
    ),
    ...rows.map(([label, value, preStyled]) => {
      const paddedKey = padEndDisplay(label, keyCol);
      const valStyled = preStyled ? value : paint(value, '2', options.color);
      return `  ${paint(paddedKey, '1', options.color)}${valStyled}`;
    }),
  ];
  const persistFooters: string[] = [];
  if (status.stateError !== undefined) {
    persistFooters.push(
      warnNoteLine(
        t(
          locale,
          `状态文件异常: ${status.stateError}`,
          `State file error: ${status.stateError}`,
        ),
        options.color,
      ),
    );
  }
  if (!status.installed) {
    persistFooters.push(
      neutralLine(
        t(
          locale,
          '尚未安装守护服务, 运行 fan persist install 即可启用',
          "Daemon is not installed · Run 'fan persist install' to enable",
        ),
        options.color,
      ),
    );
  }
  if (persistFooters.length > 0) {
    lines.push('', ...persistFooters);
  }
  lines.push('');
  return lines.join('\n');
}

/** 渲染 `--watch` 单行实时采样输出 */
export function renderWatchLine(
  report: FanStatusReport,
  timestamp: string,
  color: boolean,
  locale: Locale = 'zh',
): string {
  const parts = report.fans.map((f) => {
    const rpm = `${String(Math.round(f.actualRpm)).padStart(4)} RPM`;
    const bar = renderGaugeBar(f.percent, 8, color);
    const pct = `${String(Math.round(f.percent)).padStart(3)}%`;
    const tag =
      f.mode === 'manual'
        ? paint(
            `${t(locale, '手动', 'Manual')} ${String(Math.round(f.targetRpm))}`,
            '36',
            color,
          )
        : paint(t(locale, '自动', 'Auto'), '32', color);
    return `${paint(`F${String(f.index)}`, '1', color)} ${rpm} ${bar} ${pct} (${tag})`;
  });
  const ts = paint(timestamp, '2', color);
  return `  ${ts}   ${parts.join('   ·   ')}`;
}
