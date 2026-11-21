/**
 * 终端 Raw-Mode 交互会话统一守卫, 供 `ui/prompts.ts` 与 `ui/text-input.ts` 共用。
 * 职责: `StringDecoder('utf8')` 防跨 chunk 多字节乱码、`tokenizeKeyStream` 拆分 CSI/SS3/Alt/码点按键、
 * 60ms resize 防抖、`try/catch` 保护 `setRawMode`、SIGTERM/SIGHUP 退出前复位终端与默认光标,
 * 并将 Ctrl+C (`\u0003`)、Ctrl+D (`\u0004`) 及流关闭统一收敛为 `PromptCancelledError`。
 */
import { stdin, stdout } from 'node:process';
import { StringDecoder } from 'node:string_decoder';

import { restoreDefaultCursor } from './ansi.ts';

export class PromptCancelledError extends Error {
  constructor(message = '已取消配置向导') {
    super(message);
    this.name = 'PromptCancelledError';
  }
}

export const isPromptCancelledError = (
  err: unknown,
): err is PromptCancelledError =>
  err instanceof PromptCancelledError ||
  (typeof err === 'object' &&
    err !== null &&
    'name' in err &&
    (err as { name?: unknown }).name === 'PromptCancelledError');

const CSI_SEQ_RE = new RegExp(
  `^${String.fromCharCode(0x1b)}\\[[0-9:;<=>?]*[ -/]*[@-~]`,
);
const SS3_SEQ_RE = new RegExp(`^${String.fromCharCode(0x1b)}O[@-~]`);

/**
 * 将终端原始输入块 (含连发按键、SS3 方向键、带中间字节 CSI、Alt 组合键或粘贴流)
 * 拆解为独立按键事件序列。
 */
export const tokenizeKeyStream = (chunk: string): string[] => {
  const tokens: string[] = [];
  let i = 0;
  while (i < chunk.length) {
    if (chunk[i] === '\x1b') {
      const rest = chunk.slice(i);
      const csi = CSI_SEQ_RE.exec(rest);
      if (csi) {
        tokens.push(csi[0]);
        i += csi[0].length;
        continue;
      }
      const ss3 = SS3_SEQ_RE.exec(rest);
      if (ss3) {
        tokens.push(ss3[0]);
        i += ss3[0].length;
        continue;
      }
      if (i + 1 < chunk.length && chunk[i + 1] !== '\x1b') {
        const nextCp = chunk.codePointAt(i + 1)!;
        const nextCh = String.fromCodePoint(nextCp);
        tokens.push(`\x1b${nextCh}`);
        i += 1 + nextCh.length;
        continue;
      }
      tokens.push('\x1b');
      i += 1;
      continue;
    }
    if (chunk[i] === '\r' && chunk[i + 1] === '\n') {
      tokens.push('\r');
      i += 2;
      continue;
    }
    const cp = chunk.codePointAt(i)!;
    const ch = String.fromCodePoint(cp);
    tokens.push(ch);
    i += ch.length;
  }
  return tokens;
};

const safeSetRawMode = (enabled: boolean): void => {
  try {
    if (stdin.isTTY && typeof stdin.setRawMode === 'function') {
      stdin.setRawMode(enabled);
    }
  } catch {
    // PTY 已断开或不支持 raw mode 时忽略异常, 保证后续清理继续
  }
};

export interface RawSessionControls<T> {
  finish: (value: T, afterCleanup?: () => void) => void;
  cancel: (message?: string, afterCleanup?: () => void) => void;
}

export interface RawSessionHandlers<T> {
  onKeys: (keys: string[], controls: RawSessionControls<T>) => void;
  onResize: () => void;
  onBeforeClose?: () => void;
  onAfterCancel?: () => void;
}

const RESIZE_DEBOUNCE_MS = 60;

/**
 * 开启受保护的终端 Raw-Mode 会话并在结束后确保恢复终端状态与默认光标。
 * 同一 chunk 中若 `Ctrl+C`/`Ctrl+D` 前仍有按键, 会先派发前置按键 (若其已结算则直接返回), 再触发取消。
 *
 * ### 数据流转示例
 * ```text
 * Input:  handlers = { onKeys, onResize, onBeforeClose, onAfterCancel }
 * Step 1: 开启 raw mode 并挂 data / end / close / resize / SIGTERM / SIGHUP 监听
 * Step 2: stdin chunk -> StringDecoder('utf8') -> tokenizeKeyStream -> 检测 \u0003/\u0004 截断或派发 onKeys(keys, controls)
 * Step 3: 命中 controls.finish(val) 或 controls.cancel(msg) -> 幂等 cleanup (解绑 + 退出 raw mode + 恢复光标) -> 执行回调
 * Output: Promise<T> (正常结算 resolve(val); 取消或流关闭 reject(PromptCancelledError))
 * ```
 */
export const withRawModeSession = async <T>(
  handlers: RawSessionHandlers<T>,
): Promise<T> =>
  await new Promise<T>((resolve, reject) => {
    const decoder = new StringDecoder('utf8');
    let settled = false;
    let resizeTimer: ReturnType<typeof setTimeout> | null = null;

    const cleanup = (): void => {
      if (resizeTimer !== null) {
        clearTimeout(resizeTimer);
        resizeTimer = null;
      }
      stdin.off('data', onData);
      stdin.off('end', onClose);
      stdin.off('close', onClose);
      stdout.off('resize', onResize);
      process.off('SIGTERM', onSigTerm);
      process.off('SIGHUP', onSigHup);
      safeSetRawMode(false);
      stdin.pause();
      restoreDefaultCursor();
    };

    const controls: RawSessionControls<T> = {
      finish: (value, afterCleanup) => {
        if (settled) return;
        settled = true;
        cleanup();
        afterCleanup?.();
        resolve(value);
      },
      cancel: (message = '已取消配置向导', afterCleanup) => {
        if (settled) return;
        settled = true;
        cleanup();
        afterCleanup?.();
        reject(new PromptCancelledError(message));
      },
    };

    const terminateOnSignal = (sig: 'SIGTERM' | 'SIGHUP', code: number) => {
      if (settled) return;
      settled = true;
      cleanup();
      try {
        process.kill(process.pid, sig);
      } catch {
        process.exit(code);
      }
    };
    const onSigTerm = (): void => terminateOnSignal('SIGTERM', 143);
    const onSigHup = (): void => terminateOnSignal('SIGHUP', 129);

    const onResize = (): void => {
      if (settled) return;
      if (resizeTimer !== null) clearTimeout(resizeTimer);
      resizeTimer = setTimeout(() => {
        resizeTimer = null;
        if (!settled) handlers.onResize();
      }, RESIZE_DEBOUNCE_MS);
    };

    const onClose = (): void => {
      if (settled) return;
      settled = true;
      decoder.end();
      handlers.onBeforeClose?.();
      cleanup();
      reject(new PromptCancelledError('输入流已关闭, 已取消配置向导'));
    };

    const onData = (buf: Buffer): void => {
      if (settled) return;
      const text = decoder.write(buf);
      if (!text) return;
      const keys = tokenizeKeyStream(text);
      const cancelIdx = keys.findIndex((k) => k === '\u0003' || k === '\u0004');
      if (cancelIdx !== -1) {
        const before = keys.slice(0, cancelIdx);
        if (before.length > 0) {
          handlers.onKeys(before, controls);
          if (settled) return;
        }
        controls.cancel('已取消配置向导', handlers.onAfterCancel);
        return;
      }
      handlers.onKeys(keys, controls);
    };

    safeSetRawMode(true);
    stdin.resume();
    stdin.on('data', onData);
    stdin.once('end', onClose);
    stdin.once('close', onClose);
    stdout.on('resize', onResize);
    process.once('SIGTERM', onSigTerm);
    process.once('SIGHUP', onSigHup);
  });
