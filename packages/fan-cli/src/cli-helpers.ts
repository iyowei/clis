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
  SETTLE_TOLERANCE_RPM,
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

function isInterruptedPoll(error: unknown, interrupted: boolean): boolean {
  if (interrupted) return true;
  return (
    isFanError(error) &&
    error.code === 'SMC_COMMAND_FAILED' &&
    /SIGINT|KeyboardInterrupt|退出码 130/i.test(error.message)
  );
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
      let report: FanStatusReport;
      try {
        report = controller.status({ fanIndex });
      } catch (error) {
        if (isInterruptedPoll(error, stopped)) break;
        throw error;
      }
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
const AUTO_PLATEAU_LIMIT = 12;
const AUTO_PLATEAU_DELTA_RPM = 20;
const MANUAL_PLATEAU_LIMIT = 12;
const MANUAL_PLATEAU_DELTA_RPM = 10;
const MANUAL_PLATEAU_MS = 3_500;
const EXTERNAL_AUTO_WARNING_ZH =
  '手动转速已被切回自动温控 (请检查合盖状态或其他温控软件)';

function hasExternalOverride(
  initial: FanStatusReport,
  current: FanStatusReport,
): boolean {
  return initial.fans.some((initFan) => {
    if (initFan.mode !== 'manual') return false;
    const curFan = current.fans.find((f) => f.index === initFan.index);
    if (curFan === undefined) return false;
    if (curFan.mode === 'auto') return true;
    return curFan.targetRpm < initFan.targetRpm - SETTLE_TOLERANCE_RPM;
  });
}

function withExternalAutoWarning(report: FanStatusReport): FanStatusReport {
  if (report.warnings.some((w) => w.code === 'EXTERNAL_AUTO_OVERRIDE')) {
    return report;
  }
  return {
    ...report,
    warnings: [
      ...report.warnings,
      {
        code: 'EXTERNAL_AUTO_OVERRIDE',
        message: EXTERNAL_AUTO_WARNING_ZH,
      },
    ],
  };
}

function fansNeedSettle(report: FanStatusReport): boolean {
  return report.fans.some((fan) => {
    if (fan.mode === 'manual') {
      return !isManualFanSettled(fan);
    }
    return Math.round(fan.actualRpm) > 0;
  });
}

function evalFansPlateau(
  anchorFans: readonly FanInfo[],
  nextFans: readonly FanInfo[],
): { stable: boolean; hasPendingManual: boolean } {
  if (nextFans.length === 0) return { stable: false, hasPendingManual: false };
  let hasPendingManual = false;
  for (const next of nextFans) {
    const anchor = anchorFans.find((p) => p.index === next.index);
    if (anchor === undefined) return { stable: false, hasPendingManual: false };
    if (next.mode === 'manual') {
      if (isManualFanSettled(next)) continue;
      hasPendingManual = true;
      if (
        Math.round(next.actualRpm) <= 0 ||
        Math.abs(next.actualRpm - next.targetRpm) > SETTLE_TOLERANCE_RPM ||
        Math.abs(next.actualRpm - anchor.actualRpm) > MANUAL_PLATEAU_DELTA_RPM
      ) {
        return { stable: false, hasPendingManual: true };
      }
      continue;
    }
    if (Math.abs(next.actualRpm - anchor.actualRpm) > AUTO_PLATEAU_DELTA_RPM) {
      return { stable: false, hasPendingManual };
    }
  }
  return { stable: true, hasPendingManual };
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
  manualPlateauMs?: number;
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
    manualPlateauMs = MANUAL_PLATEAU_MS,
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
  let cursorHidden = false;
  const restoreCursor = () => {
    if (cursorHidden) {
      cursorHidden = false;
      writeRaw('\u001B[?25h');
    }
  };
  const onSigint = () => {
    interrupted = true;
  };
  process.on('SIGINT', onSigint);
  process.once('exit', restoreCursor);
  if (color) {
    cursorHidden = true;
    writeRaw('\u001B[?25l');
  }

  let plateauTicks = 0;
  let plateauAnchor = current.fans;
  let plateauSince = Date.now();
  let finalTitle = title;
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
      let latest: FanStatusReport;
      try {
        latest = controller.status({ fanIndex });
      } catch (error) {
        if (isInterruptedPoll(error, interrupted)) break;
        throw error;
      }
      current = {
        ...initialReport,
        fans: latest.fans,
        macsFanControlRunning: latest.macsFanControlRunning,
        warnings: mergeReportWarnings(initialReport, latest),
      };
      if (hasExternalOverride(initialReport, current)) {
        current = withExternalAutoWarning(current);
        finalTitle = t(locale, '已切回自动温控', 'Reverted to Auto Thermal');
        break;
      }
      if (!fansNeedSettle(current)) break;

      const plateau = evalFansPlateau(plateauAnchor, current.fans);
      if (plateau.stable) {
        plateauTicks += 1;
        const hitTickLimit = plateau.hasPendingManual
          ? plateauTicks >= MANUAL_PLATEAU_LIMIT &&
            Date.now() - plateauSince >= manualPlateauMs
          : plateauTicks >= AUTO_PLATEAU_LIMIT;
        if (hitTickLimit) break;
      } else {
        plateauAnchor = current.fans;
        plateauTicks = 0;
        plateauSince = Date.now();
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
      title: finalTitle,
      locale,
    });
    writeRaw(`\u001B[${String(prevLines)}A\r\u001B[0J${finalFrame}\n`);
  } finally {
    restoreCursor();
    process.off('exit', restoreCursor);
    process.off('SIGINT', onSigint);
  }
}
