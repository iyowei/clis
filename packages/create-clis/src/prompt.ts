/**
 * 交互收集: 无旗标 (或未给全) 时逐问五个变量, readline 直问直答 (不依赖交互库)。
 * 风格与默认值提示参照 sweep-node-modules-cli/src/init.ts: 问句后以方括号挂默认值, 校验不过
 * 打印原因后重问该问, EOF / Ctrl+C 折算取消。
 *
 * 交互 IO 经 PromptIO 注入 (测试用脚本化实现, 不打真 TTY); 真实 readline 适配在 createPromptIO。
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
 * 交互收集五变量 (项目名 → scope → bin 名 → owner → 仓库地址), 返回与旗标路径同源的 Vocabulary。
 *
 * 旗标 (seed) 已给出的变量先整体校验 (非法即报错, 不进交互), 合法的直接采用、不再提问;
 * 其余逐问, 空答取默认。seed.yes 为真时等同旗标路径: 全默认、零交互。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   seed = { name: 'my-tool', git: true, install: true, yes: false }
 *   env  = { gitUserName: 'iyowei' }
 *   answers = ['', '', '', '']   *(scope / bin 名 / owner / 仓库地址 四问全回车)*
 *
 * 步骤 1：seed 校验 (name 合法, 直接采用; 非法则早退 error)
 *
 * 步骤 2：逐问取答 (空答取默认)
 *   scope   = ''          → '' (裸包名)
 *   binName = ''          → deriveBinName('my-tool') = 'my-tool'
 *   owner   = ''          → env.gitUserName = 'iyowei'
 *   repoUrl = ''          → 'https://github.com/iyowei/my-tool'
 *
 * Output（数据契约）
 *   { state: 'collected', vocabulary: { name: 'my-tool', scope: '', binName: 'my-tool',
 *     owner: 'iyowei', repoUrl: 'https://github.com/iyowei/my-tool' } }
 * ```
 */
export async function askAll(
  io: PromptIO,
  env: Environment,
  seed: CliOptions = { git: true, install: true, yes: false },
): Promise<AskOutcome> {
  if (seed.yes) return collected(resolveVocabulary(seed, env));

  const seedName = provided(seed.name);
  const seedScope = provided(seed.scope);
  const seedBin = provided(seed.bin);
  const seedOwner = provided(seed.owner);
  const seedRepo = provided(seed.repo);

  // 旗标值先整体校验, 不留到问答末尾才暴露
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

  io.print('create-clis: 依次回答以下问题 (方括号内为默认值, 回车采用)');

  let name = seedName;
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
}

/**
 * 真实 readline 适配 (薄壳)。
 * 形态与 sweep-node-modules-cli/src/init.ts 的 createReadlineIO 同源: 单 interface 长存 + 行缓冲,
 * 管道一次性投喂多行时先到的行入队、后续问题依次取走 (每问新开 interface 会丢行, 且 EOF 已发生
 * 后永久挂起); stdin 引用随等待区间 ref / unref, 使 TTY 场景收集完成后进程能自然退出。
 * 外部副作用：读写 process.stdin / process.stdout。
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
  };
}
