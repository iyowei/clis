/**
 * 非交互 / 管道模式共享行队列读取器:
 * 单次监听输入流并缓冲全部预读行, 避免多题向导反复 createInterface 丢弃剩余缓冲区行导致第 2 题 EOF (退出 130)。
 */
import { stdin, stdout } from 'node:process';
import type { Readable, Writable } from 'node:stream';
import { StringDecoder } from 'node:string_decoder';

export interface LineQueueReader {
  question: (promptText?: string) => Promise<string | null>;
  close: () => void;
}

export const createLineQueueReader = (
  input: Readable = stdin,
  output: Writable = stdout,
): LineQueueReader => {
  const decoder = new StringDecoder('utf8');
  const queue: string[] = [];
  const waiters: Array<(line: string | null) => void> = [];
  let remainder = '';
  let ended = false;
  let closed = false;
  let attached = false;

  const flushWaitersWithLine = (line: string): void => {
    const nextWaiter = waiters.shift();
    if (nextWaiter) {
      nextWaiter(line);
    } else {
      queue.push(line);
    }
  };

  const drainTailAndEnd = (): void => {
    if (ended) return;
    const tail = `${remainder}${decoder.end()}`;
    remainder = '';
    if (tail.length > 0) {
      const cleaned = tail.endsWith('\r') ? tail.slice(0, -1) : tail;
      flushWaitersWithLine(cleaned);
    }
    ended = true;
    while (waiters.length > 0) {
      waiters.shift()!(null);
    }
  };

  const onData = (chunk: Buffer | string): void => {
    const text = typeof chunk === 'string' ? chunk : decoder.write(chunk);
    remainder += text;
    let nlIdx = remainder.indexOf('\n');
    while (nlIdx !== -1) {
      const rawLine = remainder.slice(0, nlIdx);
      const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine;
      remainder = remainder.slice(nlIdx + 1);
      flushWaitersWithLine(line);
      nlIdx = remainder.indexOf('\n');
    }
  };

  const onEnd = (): void => {
    drainTailAndEnd();
  };

  const attach = (): void => {
    if (attached || closed) return;
    attached = true;
    input.on('data', onData);
    input.once('end', onEnd);
    input.once('close', onEnd);
    input.once('error', onEnd);
    input.resume();
  };

  const detach = (): void => {
    if (!attached) return;
    attached = false;
    input.off('data', onData);
    input.off('end', onEnd);
    input.off('close', onEnd);
    input.off('error', onEnd);
    if (typeof input.pause === 'function') {
      input.pause();
    }
  };

  return {
    question: async (promptText?: string): Promise<string | null> => {
      if (promptText) output.write(promptText);
      if (queue.length > 0) {
        return queue.shift()!;
      }
      if (ended || closed) {
        return null;
      }
      attach();
      if (queue.length > 0) {
        return queue.shift()!;
      }
      if (ended || closed) {
        return null;
      }
      return await new Promise<string | null>((resolve) => {
        waiters.push(resolve);
      });
    },
    close: (): void => {
      if (closed) return;
      closed = true;
      detach();
      ended = true;
      queue.length = 0;
      remainder = '';
      while (waiters.length > 0) {
        waiters.shift()!(null);
      }
    },
  };
};

let sharedReader: LineQueueReader | null = null;

export const readNonInteractiveLine = async (
  promptText?: string,
): Promise<string | null> => {
  if (sharedReader === null) {
    sharedReader = createLineQueueReader(stdin, stdout);
  }
  return await sharedReader.question(promptText);
};

export const closeSharedLineReader = (): void => {
  if (sharedReader !== null) {
    sharedReader.close();
    sharedReader = null;
  }
};
