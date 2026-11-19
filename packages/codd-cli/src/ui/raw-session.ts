/**
 * 终端 Raw-Mode 交互会话统一守卫:
 * - 统一 StringDecoder('utf8') 防跨 chunk 中文/Emoji 截断乱码
 * - 统一 60ms resize 防抖、try/catch 保护 setRawMode
 * - 交互期挂载 SIGTERM / SIGHUP 信号恢复终端回显与默认光标后再退出
 * - 统一将 Ctrl+C (\u0003) 与 Ctrl+D (\u0004) 纳入取消路径
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
