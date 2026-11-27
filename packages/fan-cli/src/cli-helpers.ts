/**
 * `@iyowei/fan-cli` 实时轮询、物理转速爬升原地追踪与双语错误转换辅助。
 */
import { type Locale, t } from '@iyowei/cli-i18n';
import { renderShimmerText } from '@iyowei/cli-updater';
import {
  type FanController,
  type FanInfo,
  type FanStatusReport,
  isFanError,
} from '@iyowei/fan';

import {
  displayWidth,
  isManualFanSettled,
  paint,
  renderReport,
  renderWatchLine,
} from './render.ts';

function formatTime(): string {
  const now = new Date();
  const hh = String(now.getHours()).padStart(2, '0');
  const mm = String(now.getMinutes()).padStart(2, '0');
  const ss = String(now.getSeconds()).padStart(2, '0');
  return `${hh}:${mm}:${ss}`;
}

export async function runWatchLoop(options: {
  controller: FanController;
  fanIndex: number | undefined;
  intervalSec: number;
  color: boolean;
  locale: Locale;
  out: (line: string) => void;
}): Promise<number> {
  const { controller, fanIndex, intervalSec, color, locale, out } = options;
  const intervalMs = Math.max(200, Math.round(intervalSec * 1000));
  let stopped = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let wake: (() => void) | undefined;
  const onSigint = () => {
    stopped = true;
    if (timer !== undefined) {
      clearTimeout(timer);
      timer = undefined;
    }
    wake?.();
  };
  process.on('SIGINT', onSigint);
  try {
    while (!stopped) {
      const report = controller.status({ fanIndex });
      out(renderWatchLine(report, formatTime(), color, locale));
      if (stopped) break;
      await new Promise<void>((resolve) => {
        wake = resolve;
        timer = setTimeout(() => {
          timer = undefined;
          wake = undefined;
          resolve();
        }, intervalMs);
      });
    }
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    process.off('SIGINT', onSigint);
  }
  return 0;
}

export function getActionTitle(
  command: string,
  locale: Locale,
  opts?: { fixed?: boolean; once?: boolean },
): string {
  const isFixedOrOnce = opts?.fixed === true || opts?.once === true;
  switch (command) {
    case 'set':
      return isFixedOrOnce
        ? t(locale, '已设定手动转速', 'Manual Speed Set')
        : t(locale, '已设定转速下限', 'Speed Floor Set');
    case 'max':
      return t(locale, '已开启全速模式', 'Full Speed Enabled');
    case 'min':
      return isFixedOrOnce
        ? t(locale, '已设定最低转速', 'Minimum Speed Set')
        : t(locale, '已设定最低转速下限', 'Minimum Floor Set');
    case 'auto':
      return t(locale, '已恢复系统自动温控', 'Automatic Thermal Control');
    case 'apply':
      return t(locale, '已应用持久化配置', 'Saved Preset Applied');
    default:
      return t(locale, '风扇状态', 'Fan Status');
  }
}

export function getPersistTitle(
  action: 'status' | 'install' | 'uninstall',
  locale: Locale,
): string {
  switch (action) {
    case 'install':
      return t(locale, '已安装持久化守护服务', 'Persistence Daemon Installed');
    case 'uninstall':
      return t(locale, '已卸载持久化守护服务', 'Persistence Daemon Removed');
    default:
      return t(locale, '持久化守护状态', 'Persistence Daemon');
  }
}

export function localizeFanError(
  error: unknown,
  locale: Locale,
  platform: NodeJS.Platform = process.platform,
): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (locale === 'zh' || !isFanError(error)) return msg;
  switch (error.code) {
    case 'UNSUPPORTED_PLATFORM': {
      const m = /\((?:当前平台|当前):\s*([^)]+)\)/.exec(msg);
      const current = m !== null ? m[1] : platform;
      return `macOS AppleSMC fan control is only supported on macOS (current: ${current})`;
    }
    case 'PERMISSION_DENIED':
      return 'Administrator privileges required (sudo authentication cancelled or denied)';
    case 'INVALID_FAN_INDEX': {
      const m = /(\d+).*\(可用范围:\s*([^)]+)\)/.exec(msg);
      if (m !== null) {
        return `Invalid fan index ${m[1]} (available: ${m[2]})`;
      }
      return msg.replace('无效的风扇编号', 'Invalid fan index');
    }
    case 'INVALID_SPEED': {
      const rangeMatch =
        /目标转速\s+(\d+)\s+RPM\s+超出允许范围\s+(\d+-\d+)/.exec(msg);
      if (rangeMatch !== null) {
        return `Target speed ${rangeMatch[1]} RPM is outside allowed range ${rangeMatch[2]} RPM`;
      }
      return `Invalid speed specification (${msg})`;
    }
    case 'SMC_UNAVAILABLE':
      return msg === '未检测到受控风扇'
        ? 'No controllable fans detected via AppleSMC'
        : `AppleSMC unavailable: ${msg}`;
    case 'SMC_COMMAND_FAILED':
      return `AppleSMC command failed: ${msg}`;
    case 'DAEMON_FAILED':
      return `LaunchDaemon operation failed: ${msg}`;
    case 'STATE_CORRUPT':
      return `Corrupted fan state file: ${msg}`;
  }
}

const ANSI_CSI_RE = new RegExp(`${String.fromCharCode(27)}\\[[0-9;]*m`, 'g');

function visualLineCount(frame: string, columns?: number): number {
  const lines = frame.split('\n');
  if (columns === undefined || columns <= 0) return lines.length;
  let total = 0;
  for (const line of lines) {
    const plain = line.replace(ANSI_CSI_RE, '');
    total += Math.max(1, Math.ceil(displayWidth(plain) / columns));
  }
  return total;
}

function mergeReportWarnings(
  initial: FanStatusReport,
  latest: FanStatusReport,
): FanStatusReport['warnings'] {
  const seen = new Set(
    initial.warnings.map((w) => `${w.code}:${w.fanIndex ?? ''}`),
  );
  const merged = [...initial.warnings];
  for (const w of latest.warnings) {
    const key = `${w.code}:${w.fanIndex ?? ''}`;
    if (!seen.has(key)) {
      seen.add(key);
      merged.push(w);
    }
  }
  return merged;
}

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
const AUTO_PLATEAU_LIMIT = 8;
const AUTO_PLATEAU_DELTA_RPM = 30;

function fansNeedSettle(report: FanStatusReport): boolean {
  return report.fans.some((fan) => {
    if (fan.mode === 'manual') {
      return !isManualFanSettled(fan);
    }
    return Math.round(fan.actualRpm) > 0;
  });
}

function isAutoPlateau(
  prevFans: readonly FanInfo[],
  nextFans: readonly FanInfo[],
): boolean {
  if (nextFans.length === 0 || nextFans.some((f) => f.mode !== 'auto')) {
    return false;
  }
  return nextFans.every((next) => {
    const prev = prevFans.find((p) => p.index === next.index);
    return (
      prev !== undefined &&
      Math.abs(next.actualRpm - prev.actualRpm) <= AUTO_PLATEAU_DELTA_RPM
    );
  });
}

export async function renderWithLiveSettle(options: {
  initialReport: FanStatusReport;
  controller: FanController;
  fanIndex: number | undefined;
  color: boolean;
  locale: Locale;
  title: string;
  writeRaw: (chunk: string) => void;
  intervalMs: number;
  maxMs: number | undefined;
  columns?: number;
}): Promise<void> {
  const {
    initialReport,
    controller,
    fanIndex,
    color,
    locale,
    title,
    writeRaw,
    intervalMs,
    maxMs,
    columns,
  } = options;

  let current: FanStatusReport = initialReport;
  if (!fansNeedSettle(current) || (maxMs !== undefined && maxMs <= 0)) {
    writeRaw(
      `${renderReport(current, { color, json: false, title, locale })}\n`,
    );
    return;
  }

  let tick = 0;
  const hasAutoSpinning = () =>
    current.fans.some((f) => f.mode === 'auto' && Math.round(f.actualRpm) > 0);
  const spinHint = () => {
    const glyph = SPINNER_FRAMES[tick % SPINNER_FRAMES.length]!;
    const activeMsg = hasAutoSpinning()
      ? t(locale, '正在等待风扇降速停转…', 'Waiting for fans to spin down…')
      : t(
          locale,
          '物理风扇正在响应目标转速…',
          'Waiting for fans to reach target speed…',
        );
    const skipHint = t(locale, '(Ctrl+C 跳过等待)', '(Ctrl+C to skip)');
    return `${paint(glyph, '36', color)} ${renderShimmerText(activeMsg, tick, color)} ${paint(skipHint, '2', color)}`;
  };

  let frame = renderReport(current, {
    color,
    json: false,
    title,
    locale,
    extraHint: spinHint(),
    extraHintPrestyled: true,
    settlingAuto: true,
  });
  writeRaw(`${frame}\n`);

  let interrupted = false;
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  if (color) writeRaw('\u001B[?25l');

  let autoPlateauTicks = 0;
  const deadline = maxMs === undefined ? undefined : Date.now() + maxMs;
  try {
    while (
      !interrupted &&
      (deadline === undefined || Date.now() < deadline) &&
      fansNeedSettle(current)
    ) {
      await new Promise((resolve) => setTimeout(resolve, intervalMs));
      if (interrupted) break;
      tick += 1;
      const prevFans = current.fans;
      const latest = controller.status({ fanIndex });
      current = {
        ...initialReport,
        fans: latest.fans,
        macsFanControlRunning: latest.macsFanControlRunning,
        warnings: mergeReportWarnings(initialReport, latest),
      };
      if (!fansNeedSettle(current)) break;

      if (isAutoPlateau(prevFans, current.fans)) {
        autoPlateauTicks += 1;
        if (autoPlateauTicks >= AUTO_PLATEAU_LIMIT) break;
      } else {
        autoPlateauTicks = 0;
      }

      const prevLines = visualLineCount(frame, columns);
      frame = renderReport(current, {
        color,
        json: false,
        title,
        locale,
        extraHint: spinHint(),
        extraHintPrestyled: true,
        settlingAuto: true,
      });
      writeRaw(`\u001B[${String(prevLines)}A\r\u001B[0J${frame}\n`);
    }
    const prevLines = visualLineCount(frame, columns);
    const finalFrame = renderReport(current, {
      color,
      json: false,
      title,
      locale,
    });
    writeRaw(`\u001B[${String(prevLines)}A\r\u001B[0J${finalFrame}\n`);
  } finally {
    if (color) writeRaw('\u001B[?25h');
    process.off('SIGINT', onSigint);
  }
}
