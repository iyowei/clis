/**
 * 自更新 TTY 实时进度指示器 (走 stderr, 非 TTY / TERM=dumb 下完全静默 0 字节输出)。
 *
 * 与 sweep-nm 主视图进度指示器共用同一套标准 ANSI SGR 视觉语言 (`36` 青点阵 + `1` 粗白动作 + `2` 压暗细节/耗时),
 * 用于接管「检查远端版本」与「静默执行包管理器升级」两段等待期, 结束后彻底擦除不留残影。
 */
import { displayWidth, formatElapsedMs, paint } from './ui.ts';

const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_INTERVAL_MS = 80;
const ESC = String.fromCharCode(0x1b);
const CLEAR_LINE = `\r${ESC}[2K`;

export interface SpinnerTimerHandle {
  unref?: () => void;
}

export interface UpdateSpinnerOptions {
  /** 是否启用动态进度 (调用方按 stderr.isTTY && TERM !== 'dumb' 判定; false 时恒零输出) */
  enabled: boolean;
  /** 是否允许着色 (尊重 NO_COLOR / stderr.isTTY; false 时输出无色旋转进度) */
  color: boolean;
  /** 写入通道 (默认 process.stderr.write, 供单测注入) */
  write?: (chunk: string) => void;
  /** 终端列宽读取器 (默认 process.stderr.columns || 80, 防超宽软折行残影) */
  columns?: () => number;
  /** 时钟源 (默认 Date.now, 供单测确定性断言) */
  now?: () => number;
  /** 定时器源 (默认全局 setInterval / clearInterval, 供单测注入) */
  setTimer?: (fn: () => void, ms: number) => SpinnerTimerHandle;
  clearTimer?: (handle: SpinnerTimerHandle) => void;
}

export interface UpdateSpinner {
  /** 启动并立即同步渲染第 0 帧 (消除回车后的空白等待感) */
  start(action: string, detail?: string): void;
  /** 在不重置帧序的前提下切换阶段文案 */
  update(action: string, detail?: string): void;
  /** 彻底停止并擦除进度行 (幂等, 结束后零残影) */
  stop(): void;
}

/** 按终端显示列宽安全截断纯文本 (防单行超宽触发软折行导致 \r\x1b[2K 擦不净) */
function clipToWidth(text: string, maxCols: number): string {
  if (maxCols <= 1) return '';
  let width = 0;
  let out = '';
  for (const ch of text) {
    const cw = displayWidth(ch);
    if (width + cw > maxCols) {
      return out.length > 0 ? `${out.slice(0, -1)}…` : '';
    }
    out += ch;
    width += cw;
  }
  return out;
}

/** 创建自更新 TTY 旋转进度指示器 (enabled=false 时全部方法为无副作用空操作) */
export function createUpdateSpinner(
  options: UpdateSpinnerOptions,
): UpdateSpinner {
  if (!options.enabled) {
    return {
      start() {},
      update() {},
      stop() {},
    };
  }

  const write =
    options.write ?? ((chunk: string) => process.stderr.write(chunk));
  const columns = options.columns ?? (() => process.stderr.columns || 80);
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): SpinnerTimerHandle => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: SpinnerTimerHandle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  let active = false;
  let visible = false;
  let frameIndex = 0;
  let startedAt = 0;
  let currentAction = '';
  let currentDetail = '';
  let timer: SpinnerTimerHandle | undefined;

  const renderFrame = (): void => {
    if (!active) return;
    const frame = FRAMES[frameIndex % FRAMES.length]!;
    const elapsed = formatElapsedMs(now() - startedAt);
    const parts: string[] = [];
    if (currentDetail !== '') parts.push(currentDetail);
    if (elapsed !== '') parts.push(elapsed);
    const bodyPlain =
      parts.length === 0
        ? currentAction
        : `${currentAction} · ${parts.join(' · ')}`;

    const maxCols = Math.max(12, columns() - 1);
    const fitted = clipToWidth(bodyPlain, maxCols - 4);
    const splitIdx = fitted.indexOf(' · ');
    const styledBody =
      splitIdx === -1
        ? paint(fitted, '1', options.color)
        : `${paint(fitted.slice(0, splitIdx), '1', options.color)}${paint(fitted.slice(splitIdx), '2', options.color)}`;
    const styledFrame = paint(frame, '36', options.color);
    write(`${CLEAR_LINE}  ${styledFrame} ${styledBody}`);
    visible = true;
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  const clearLine = (): void => {
    if (!visible) return;
    write(CLEAR_LINE);
    visible = false;
  };

  return {
    start(action: string, detail = '') {
      currentAction = action;
      currentDetail = detail;
      startedAt = now();
      if (!active) {
        active = true;
        frameIndex = 0;
        renderFrame();
        timer = setTimer(() => {
          frameIndex = (frameIndex + 1) % FRAMES.length;
          renderFrame();
        }, FRAME_INTERVAL_MS);
        timer.unref?.();
      } else {
        renderFrame();
      }
    },
    update(action: string, detail = '') {
      if (!active) return;
      currentAction = action;
      currentDetail = detail;
      renderFrame();
    },
    stop() {
      if (!active) return;
      active = false;
      stopTimer();
      clearLine();
    },
  };
}
