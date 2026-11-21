/**
 * 交互式终端 IO 适配 (`readline/promises` 封装): 上游供 `init.ts` 与 `migrate-cli.ts` 共用,
 * 将终端交互与纯向导逻辑物理隔离以便单测注入桩 IO。
 * 红线: 单 interface 长存 + 自管行缓冲 (支持管道多行投喂); 仅等待输入期 `ref` stdin, 结束后 `unref` 防进程挂起。
 */
import { type Interface, createInterface } from 'node:readline/promises';

import { paint } from './render.ts';

/** 交互 IO: ask 返回 null 表示取消 (Ctrl+C / EOF) */
export interface InitIO {
  /** 提问并等待一行答案; 返回 null 即取消 (hint 非空时以压暗的 [hint] 附在问句后) */
  ask(question: string, hint?: string): Promise<string | null>;
  /** 是 / 否确认; 空答取 defaultYes */
  confirm(question: string, defaultYes: boolean): Promise<boolean>;
  /** 输出一行普通信息 */
  print(line: string): void;
  /** 可选: 结束会话时释放底层资源 (如关闭 readline interface 并解挂 SIGINT 监听) */
  close?(): void;
  /** 着色开关 (非 TTY / NO_COLOR 为 false): 与清单同一降级契约 */
  color: boolean;
}

/**
 * stdin 的进程引用管理: 等待一行期间保持 ref, 等待结束 (一行到手 / 流关闭) 即 unref,
 * 使 TTY 场景向导完成后进程能自然退出。
 */
function setStdinRef(shouldRef: boolean): void {
  const fn = shouldRef ? process.stdin.ref : process.stdin.unref;
  if (typeof fn === 'function') fn.call(process.stdin);
}

/**
 * 真实 readline 适配 (薄壳, 由 e2e 覆盖):
 * 单 interface 长存 + 自管行缓冲 (管道批量投喂时先入队, 流关闭后仍按序消费完剩余缓冲行再返 null);
 * Ctrl+C 立即清空缓冲并取消 (ask 返 null, confirm 返 false)。
 */
export function createReadlineIO(color: boolean): InitIO {
  const buffered: string[] = [];
  let rl: Interface | null = null;
  let ended = false;
  let aborted = false;
  let pending: ((line: string | null) => void) | null = null;

  const onSigint = (): void => {
    aborted = true;
    buffered.length = 0;
    if (process.stdout.isTTY === true) process.stdout.write('\n');
    rl?.close();
  };

  function ensure(): Interface {
    if (rl !== null) return rl;

    const created = createInterface({
      input: process.stdin,
      output: process.stdout,
    });
    created.on('line', (line) => {
      if (pending === null) {
        buffered.push(line);
        return;
      }
      const resolve = pending;
      pending = null;
      setStdinRef(false);
      resolve(line);
    });
    created.on('close', () => {
      ended = true;
      if (pending === null) return;
      const resolve = pending;
      pending = null;
      setStdinRef(false);
      resolve(null);
    });
    created.on('SIGINT', onSigint);
    rl = created;
    return created;
  }

  function readLine(prompt: string): Promise<string | null> {
    if (aborted) return Promise.resolve(null);
    if (ended) {
      const bufferedLine = buffered.shift();
      if (bufferedLine === undefined) return Promise.resolve(null);
      process.stdout.write(`${prompt}\n`);
      return Promise.resolve(bufferedLine);
    }

    const created = ensure();
    created.setPrompt(prompt);
    created.prompt();

    const ready = buffered.shift();
    if (ready !== undefined) {
      process.stdout.write('\n');
      return Promise.resolve(ready);
    }

    setStdinRef(true);
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  return {
    color,
    ask(question, hint) {
      const prompt =
        hint === undefined
          ? `  ${question} `
          : `  ${question} [${paint(hint, '2', color)}] `;
      return readLine(prompt);
    },
    async confirm(question, defaultYes) {
      const mark = paint(defaultYes ? '(Y/n)' : '(y/N)', '2', color);
      const answer = await readLine(`  ${question} ${mark} `);
      if (answer === null) return false;
      const normalized = answer.trim().toLowerCase();
      if (normalized === '') return defaultYes;
      return normalized === 'y' || normalized === 'yes';
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    close() {
      if (rl === null) return;
      const current = rl;
      rl = null;
      current.off('SIGINT', onSigint);
      current.close();
      setStdinRef(false);
    },
  };
}
