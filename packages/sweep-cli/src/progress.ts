/**
 * TTY 实时进度指示器 (走 stderr): 上游由 `cli.ts` 挂载到 `@iyowei/sweep` 的 `onProgress` 回调,
 * 下游复用 `render.ts` 的 `paint` (色盘: `36` 青点阵 + `1` 粗白阶段 + `2` 压暗计数/耗时)。
 * 红线: `enabled=false` (非 TTY / `TERM=dumb`) 恒 0 字节输出; 单行按终端列宽截断防软折行残影;
 * 告警插队前 `suspend()` 擦行暂停帧刷新, `stop()` 幂等清行不留残影。
 */
import {
  type SweepPhase,
  type SweepProgressEvent,
  formatBytes,
} from '@iyowei/sweep';

import { paint } from './render.ts';

/** 顺滑 Braille 点阵旋转帧 (80ms/帧) */
const FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'] as const;
const FRAME_INTERVAL_MS = 80;
const CLEAR_LINE = '\r\u001b[2K';

export interface TimerHandle {
  unref?: () => void;
}

export interface SweepProgressOptions {
  /** 是否启用动态进度 (调用方按 stderr.isTTY && TERM !== 'dumb' 判定; false 时恒零输出) */
  enabled: boolean;
  /** 是否允许着色 (按 NO_COLOR / stderr.isTTY 判定; false 时输出无色旋转进度) */
  color: boolean;
  /** 本次扫描根数量 (初始首帧立即展示) */
  rootCount: number;
  /** 写入通道 (默认 process.stderr.write, 供单测注入) */
  write?: (chunk: string) => void;
  /** 读取终端列宽 (默认 process.stderr.columns || 80, 防软折行留残影) */
  columns?: () => number;
  /** 时钟源 (默认 Date.now, 供单测确定性断言) */
  now?: () => number;
  /** 定时器源 (默认全局 setInterval / clearInterval, 供单测注入) */
  setTimer?: (fn: () => void, ms: number) => TimerHandle;
  clearTimer?: (handle: TimerHandle) => void;
}

export interface SweepProgress {
  /** 启动指示器并立即同步渲染第 0 帧 (消除回车后的空白等待感) */
  start(): void;
  /** 消费编排器进度事件并刷新状态文本 */
  update(event: SweepProgressEvent): void;
  /** 告警等输出插队前暂停帧刷新定时器并擦除当前进度行 (总耗时计时不中断) */
  suspend(): void;
  /** 告警输出完毕后恢复当前进度行渲染 */
  resume(): void;
  /** 彻底停止并擦除进度行 (幂等, 结束后零残影) */
  stop(): void;
}

interface ProgressState {
  phase: SweepPhase;
  hits: number;
  measured: number;
  measuredBytes: number;
  skipped: number;
  removed: number;
  failed: number;
}

/** 计算单字符显示列宽 (CJK 与常见全角按 2 列, 其余按 1 列) */
function charDisplayWidth(ch: string): number {
  const code = ch.codePointAt(0) ?? 0;
  const wide =
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xff00 && code <= 0xff60);
  return wide ? 2 : 1;
}

/** 按终端显示列宽安全截断纯文本 (防单行超宽触发软折行导致 \r\x1b[2K 擦不净) */
function clipLine(text: string, maxCols: number): string {
  if (maxCols <= 1) return '';
  let width = 0;
  let out = '';
  for (const ch of text) {
    const cw = charDisplayWidth(ch);
    if (width + cw > maxCols) {
      return out.length > 0 ? `${out.slice(0, -1)}…` : '';
    }
    out += ch;
    width += cw;
  }
  return out;
}

/** 格式化已用耗时 (>= 100ms 起显示一位小数秒, 短于 100ms 省略防闪烁) */
function formatElapsed(elapsedMs: number): string {
  if (elapsedMs < 100) return '';
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

/** 按当前阶段与实时计数构造 (动作词, 辅助细节) */
function describeState(
  state: ProgressState,
  rootCount: number,
  elapsedMs: number,
): { action: string; detail: string } {
  const elapsed = formatElapsed(elapsedMs);
  const parts: string[] = [];
  let action = '扫描中';

  switch (state.phase) {
    case 'scan':
      action = '扫描中';
      parts.push(
        state.hits > 0 ? `已发现 ${state.hits} 处` : `${rootCount} 个根`,
      );
      break;
    case 'measure':
      action = '统计体积';
      if (state.measured > 0) {
        parts.push(
          `${state.measured}/${Math.max(state.hits, state.measured)} 处`,
        );
        if (state.measuredBytes > 0) {
          parts.push(formatBytes(state.measuredBytes));
        }
      } else {
        parts.push(`共 ${state.hits} 处`);
      }
      break;
    case 'classify':
    case 'device':
    case 'plan':
      action = '整理清单';
      parts.push(`${state.hits} 处`);
      break;
    case 'validate':
      action = '安全复核';
      parts.push(`${Math.max(0, state.hits - state.skipped)} 处`);
      break;
    case 'remove': {
      action = '正在清理';
      const total = Math.max(
        state.hits - state.skipped,
        state.removed + state.failed,
      );
      parts.push(`${state.removed + state.failed}/${total} 处`);
      if (state.failed > 0) parts.push(`失败 ${state.failed}`);
      break;
    }
  }

  if (elapsed !== '') parts.push(elapsed);
  return { action, detail: parts.join(' · ') };
}

/**
 * 创建 TTY 实时进度指示器 (`enabled=false` 时全部方法返回无副作用空操作):
 * 维护阶段与实时计数 (`hits` / `measured` / `measuredBytes` / `skipped` / `removed` / `failed`),
 * 每 80ms 旋转点阵帧 (`timer.unref?.()` 防阻塞退出), 并在 `update` 收到事件时即时重绘当前行。
 *
 * ### 数据流转示例
 * ```text
 * Input  : createSweepProgress({ enabled: true, color: false, rootCount: 2 })
 * 步骤 1 : start() -> 立即写 stderr "\r\x1b[2K  ⠋ 扫描中 · 2 个根", 启动 80ms 定时器
 * 步骤 2 : update({ kind: 'hit' }) -> "扫描中 · 已发现 1 处"; update(phase='measure') + measured(50MB) -> "统计体积 · 1/1 处 · 50 MB"
 * 步骤 3 : warning 插队前 suspend() 停定时器并写 "\r\x1b[2K" 擦行 -> 输出告警 -> resume() 重绘并重启定时器
 * 步骤 4 : stop() -> 停定时器并擦除当前行 (幂等, 退出后 stderr 零残影)
 * Output : SweepProgress 控制句柄 { start, update, suspend, resume, stop }
 * ```
 */
export function createSweepProgress(
  options: SweepProgressOptions,
): SweepProgress {
  if (!options.enabled) {
    return {
      start() {},
      update() {},
      suspend() {},
      resume() {},
      stop() {},
    };
  }

  const write =
    options.write ?? ((chunk: string) => process.stderr.write(chunk));
  const columns = options.columns ?? (() => process.stderr.columns || 80);
  const now = options.now ?? (() => Date.now());
  const setTimer =
    options.setTimer ??
    ((fn: () => void, ms: number): TimerHandle => setInterval(fn, ms));
  const clearTimer =
    options.clearTimer ??
    ((handle: TimerHandle) => {
      clearInterval(handle as ReturnType<typeof setInterval>);
    });

  const state: ProgressState = {
    phase: 'scan',
    hits: 0,
    measured: 0,
    measuredBytes: 0,
    skipped: 0,
    removed: 0,
    failed: 0,
  };

  let active = false;
  let suspended = false;
  let visible = false;
  let frameIndex = 0;
  let startedAt = 0;
  let timer: TimerHandle | undefined;

  const renderFrame = (): void => {
    if (!active || suspended) return;
    const frame = FRAMES[frameIndex % FRAMES.length]!;
    const { action, detail } = describeState(
      state,
      options.rootCount,
      now() - startedAt,
    );
    const maxCols = Math.max(12, columns() - 1);
    const prefixPlain = `  ${frame} `;
    const bodyPlain = detail === '' ? action : `${action} · ${detail}`;
    const fittedBody = clipLine(bodyPlain, maxCols - 4);
    const splitIdx = fittedBody.indexOf(' · ');
    const styledBody =
      splitIdx === -1
        ? paint(fittedBody, '1', options.color)
        : `${paint(fittedBody.slice(0, splitIdx), '1', options.color)}${paint(fittedBody.slice(splitIdx), '2', options.color)}`;
    const styledFrame = paint(frame, '36', options.color);
    const line =
      prefixPlain.length <= maxCols
        ? `  ${styledFrame} ${styledBody}`
        : styledBody;
    write(`${CLEAR_LINE}${line}`);
    visible = true;
  };

  const clearIfVisible = (): void => {
    if (!visible) return;
    write(CLEAR_LINE);
    visible = false;
  };

  const startTimer = (): void => {
    if (timer !== undefined) return;
    timer = setTimer(() => {
      frameIndex = (frameIndex + 1) % FRAMES.length;
      renderFrame();
    }, FRAME_INTERVAL_MS);
    timer.unref?.();
  };

  const stopTimer = (): void => {
    if (timer === undefined) return;
    clearTimer(timer);
    timer = undefined;
  };

  return {
    start() {
      if (active) return;
      active = true;
      suspended = false;
      startedAt = now();
      frameIndex = 0;
      renderFrame();
      startTimer();
    },
    update(event: SweepProgressEvent) {
      if (!active) return;
      switch (event.kind) {
        case 'phase':
          if (event.status === 'start') state.phase = event.phase;
          break;
        case 'hit':
          state.hits += 1;
          break;
        case 'measured':
          state.measured += 1;
          state.measuredBytes += event.bytes;
          break;
        case 'unmeasured':
          state.measured += 1;
          break;
        case 'skipped':
          state.skipped += 1;
          break;
        case 'removed':
          state.removed += 1;
          break;
        case 'failed':
          state.failed += 1;
          break;
        case 'plan-done':
        case 'done':
        case 'aborted':
        case 'warning':
          return;
      }
      renderFrame();
    },
    suspend() {
      if (!active || suspended) return;
      suspended = true;
      stopTimer();
      clearIfVisible();
    },
    resume() {
      if (!active || !suspended) return;
      suspended = false;
      renderFrame();
      startTimer();
    },
    stop() {
      if (!active) return;
      active = false;
      suspended = false;
      stopTimer();
      clearIfVisible();
    },
  };
}
