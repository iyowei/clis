/**
 * 交互收集: 无旗标 (或未给全) 时经 readline 逐问五个变量 (不依赖第三方交互库)。
 * 上游由 `cli.ts` 调用, 复用 `variables.ts` 的校验与派生口径, 最终输出与零交互同源的 `Vocabulary`。
 * 交互 IO 经 `PromptIO` 注入 (测试用脚本化实现, 不打真 TTY); 真实 readline 适配见 `createPromptIO`。
 * 校验不过打印原因后重问该问, EOF / Ctrl+C 折算取消并在 finally 释放底层 IO。
 */
import { type Interface, createInterface } from 'node:readline/promises';

import { type Vocabulary } from './render.ts';
import {
  type CliOptions,
  type Environment,
  deriveBinName,
  provided,
  resolveVocabulary,
  validateBinName,
  validateName,
  validateOwner,
  validateRepoUrl,
  validateScope,
} from './variables.ts';

/** 交互 IO: ask 返回 null 表示取消 (Ctrl+C / EOF) */
export interface PromptIO {
  /** 提问并等待一行答案; hint 非空时以 [hint] 附在问句后 (默认值提示) */
  ask(question: string, hint?: string): Promise<string | null>;
  /** 输出一行普通信息 (校验失败原因等) */
  print(line: string): void;
  /** 释放底层交互资源 (如 readline.Interface), 问答结束后归还 TTY */
  close?: () => void;
}

/** 交互收集的三态出口: 收齐 / 用户取消 / 旗标值非法 */
export type AskOutcome =
  | { state: 'collected'; vocabulary: Vocabulary }
  | { state: 'cancelled' }
  | { state: 'error'; error: string };

/** 把 resolveVocabulary 的联合结果折算成 AskOutcome */
function collected(result: Vocabulary | { error: string }): AskOutcome {
  return 'error' in result
    ? { state: 'error', error: result.error }
    : { state: 'collected', vocabulary: result };
}

/**
 * 反复提问直到通过校验: 空答取 fallback (undefined 表示必填), 校验不过打印原因后重问该问。
 * 返回 null 即取消 (调用方折算为 cancelled)。
 */
async function askValidated(
  io: PromptIO,
  question: string,
  hint: string,
  fallback: string | undefined,
  validate: (value: string) => string | null,
): Promise<string | null> {
  for (;;) {
    const answer = await io.ask(question, hint);
    if (answer === null) return null;
    const trimmed = answer.trim();
    const value = trimmed.length > 0 ? trimmed : fallback;
    if (value === undefined) {
      io.print(`  ✗ ${question} 必填, 不能留空`);
      continue;
    }
    const error = validate(value);
    if (error === null) return value;
    io.print(`  ✗ ${error}`);
  }
}

/**
 * 交互收集五变量 (项目名 -> scope -> bin 名 -> owner -> 仓库地址), 返回与旗标路径同源的 `Vocabulary`。
 *
 * 显式旗标 (seed) 先整体校验 (非法即早退 `error`, 不进交互), 合法项直接采用、不再提问;
 * 目录推导的 `seed.suggestedName` 合法时同样直接采用, 非法时仅丢弃默认并照常提问项目名;
 * `seed.yes` 为真时直接走 `resolveVocabulary` 全默认、零交互。
 *
 * ### 数据流转示例
 * ```text
 * Input:  seed = { name: 'my-tool', git: true, install: true, yes: false }
 *         env  = { gitUserName: 'iyowei' }, answers = ['', '', '', ''] (四问全回车)
 * Step 1: 显式 seed 字段先过校验 -> name = 'my-tool' 合法直接采用
 * Step 2: 逐问取答 (空答取默认) -> scope='', bin='my-tool', owner='iyowei', repo='https://github.com/iyowei/my-tool'
 * Step 3: 汇入 resolveVocabulary 统一出词表, finally 调用 io.close?.()
 * Output: { state: 'collected', vocabulary: { name: 'my-tool', scope: '', binName: 'my-tool',
 *           owner: 'iyowei', repoUrl: 'https://github.com/iyowei/my-tool' } }
 * ```
 */
export async function askAll(
  io: PromptIO,
  env: Environment,
  seed: CliOptions = { git: true, install: true, yes: false },
): Promise<AskOutcome> {
  try {
    if (seed.yes) return collected(resolveVocabulary(seed, env));

    const seedName = provided(seed.name);
    const rawSuggested = provided(seed.suggestedName);
    const seedScope = provided(seed.scope);
    const seedBin = provided(seed.bin);
    const seedOwner = provided(seed.owner);
    const seedRepo = provided(seed.repo);

    // 显式旗标值先整体校验, 不留到问答末尾才暴露; 由目录推导的 suggestedName 非法时仅放弃默认照常提问
    const seededChecks: readonly (readonly [
      string | undefined,
      (value: string) => string | null,
    ])[] = [
      [seedName, validateName],
      [seedScope, validateScope],
      [seedBin, validateBinName],
      [seedOwner, validateOwner],
      [seedRepo, validateRepoUrl],
    ];
    for (const [value, validate] of seededChecks) {
      if (value === undefined) continue;
      const error = validate(value);
      if (error !== null) return { state: 'error', error };
    }

    const usableSuggested =
      rawSuggested !== undefined && validateName(rawSuggested) === null
        ? rawSuggested
        : undefined;

    io.print('create-clis: 依次回答以下问题 (方括号内为默认值, 回车采用)');

    let name = seedName ?? usableSuggested;
    if (name === undefined) {
      const answer = await askValidated(
        io,
        '项目名',
        '必填, kebab-case, 如 my-tool',
        undefined,
        validateName,
      );
      if (answer === null) return { state: 'cancelled' };
      name = answer;
    }

    let scope = seedScope;
    if (scope === undefined) {
      const answer = await askValidated(
        io,
        'scope',
        '回车跳过 (裸包名; 带 scope 时以 @ 开头, 如 @me)',
        '',
        validateScope,
      );
      if (answer === null) return { state: 'cancelled' };
      scope = answer;
    }

    let bin = seedBin;
    if (bin === undefined) {
      const fallback = deriveBinName(name);
      const answer = await askValidated(
        io,
        'bin 名',
        `默认: ${fallback}`,
        fallback,
        validateBinName,
      );
      if (answer === null) return { state: 'cancelled' };
      bin = answer;
    }

    let owner = seedOwner;
    if (owner === undefined) {
      // git user.name 是展示名 (可能含空格), 不能作 owner 时按无默认处理并明示原因
      const gitDefault =
        env.gitUserName !== null && validateOwner(env.gitUserName) === null
          ? env.gitUserName
          : undefined;
      const answer = await askValidated(
        io,
        'owner',
        gitDefault === undefined
          ? '必填 (读不到可用的 git 全局 user.name)'
          : `默认: ${gitDefault}`,
        gitDefault,
        validateOwner,
      );
      if (answer === null) return { state: 'cancelled' };
      owner = answer;
    }

    let repo = seedRepo;
    if (repo === undefined) {
      const fallback = `https://github.com/${owner}/${name}`;
      const answer = await askValidated(
        io,
        '仓库地址',
        `默认: ${fallback}`,
        fallback,
        validateRepoUrl,
      );
      if (answer === null) return { state: 'cancelled' };
      repo = answer;
    }

    return collected(
      resolveVocabulary({ ...seed, name, scope, bin, owner, repo }, env),
    );
  } finally {
    io.close?.();
  }
}

/**
 * 真实 readline 适配 (薄壳): 单 interface 长存 + 行缓冲, 管道一次投喂多行时先到的行入队、
 * 后续问题依次取走; stdin 引用随等待区间 ref / unref, 使收集完成后进程能自然退出。
 * 外部副作用: 读写 process.stdin / process.stdout。
 */
export function createPromptIO(): PromptIO {
  /** 已到达但尚无问题认领的行 (先于问题到达的答案) */
  const buffered: string[] = [];
  let rl: Interface | null = null;
  let ended = false;
  /** 当前等待中的问题; 调用方串行提问, 同一时刻至多一个 */
  let pending: ((line: string | null) => void) | null = null;

  /** 等待一行期间保持 ref, 结束即释放; bun 的 stdin 在流结束后无 ref / unref (eof 实测), 按存在性调用 */
  function setStdinRef(shouldRef: boolean): void {
    const fn = shouldRef ? process.stdin.ref : process.stdin.unref;
    if (typeof fn === 'function') fn.call(process.stdin);
  }

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
      setStdinRef(false); // 与 line 路径对称: 等待因流关闭而结束, 同样释放引用
      resolve(null);
    });
    created.on('SIGINT', () => created.close());
    rl = created;
    return created;
  }

  /**
   * 取一行: 先回显提示, 缓冲命中立即取, 否则挂起等待; 会话已结束且缓冲已空时返回 null。
   * 缓冲里已到达的行优先于「会话已结束」交付 (EOF 可能先于问题被处理); 该分支下提示改由
   * stdout 直写 —— 已关闭的 interface 再 prompt 会被官方实现拒绝 (ERR_USE_AFTER_CLOSE)。
   */
  function readLine(prompt: string): Promise<string | null> {
    if (ended) {
      const bufferedLine = buffered.shift();
      if (bufferedLine === undefined) return Promise.resolve(null);
      process.stdout.write(prompt);
      return Promise.resolve(bufferedLine);
    }

    const created = ensure();
    created.setPrompt(prompt);
    created.prompt();

    const ready = buffered.shift();
    if (ready !== undefined) return Promise.resolve(ready);

    setStdinRef(true);
    return new Promise((resolve) => {
      pending = resolve;
    });
  }

  return {
    ask(question, hint) {
      // 缩进 2 与生成器的叙述行 / 其余交互行同一左缘 (与 init.ts 同款视觉)
      const prompt =
        hint === undefined ? `  ${question} ` : `  ${question} [${hint}] `;
      return readLine(prompt);
    },
    print(line) {
      process.stdout.write(`${line}\n`);
    },
    close() {
      ended = true;
      buffered.length = 0;
      if (rl !== null) {
        const current = rl;
        rl = null;
        current.close();
      }
      setStdinRef(false);
    },
  };
}
