/**
 * 交互收集 (prompt.ts 的 askAll) 单测: 五问顺序、默认值提示、非法重问、取消、显式旗标 vs
 * 目录推导 suggestedName、以及 finally 释放 TTY 资源 (io.close)。
 * 独立于 variables.test.ts 以守 max-lines 门禁。
 */
import { describe, expect, test } from 'bun:test';

import { type AskOutcome, type PromptIO, askAll } from './prompt.ts';
import { type Vocabulary } from './render.ts';
import { type CliOptions, type Environment } from './variables.ts';

/** git 全局 user.name 的测试环境 */
const ENV: Environment = { gitUserName: 'iyowei' };

/** 三开关的最简 options: 用例只点名自己关心的字段 */
function options(partial: Partial<CliOptions> = {}): CliOptions {
  return { git: true, install: true, yes: false, ...partial };
}

/** 从 askAll 结果取词汇表 (非 collected 即断言失败, 兼作类型收窄) */
function collectedOf(outcome: AskOutcome): Vocabulary {
  expect(outcome.state).toBe('collected');
  return (outcome as { vocabulary: Vocabulary }).vocabulary;
}

/** 一次提问的记录 */
interface Asked {
  question: string;
  hint: string | undefined;
}

/** 脚本化交互 IO: answers 按提问顺序消费 (null 即取消); 记录提问、打印与 close 调用次数 */
function scriptedIO(answers: (string | null)[]): {
  io: PromptIO;
  asked: Asked[];
  printed: string[];
  closedCount: () => number;
} {
  const queue = [...answers];
  const asked: Asked[] = [];
  const printed: string[] = [];
  let closed = 0;
  return {
    asked,
    printed,
    closedCount: () => closed,
    io: {
      ask(question, hint) {
        asked.push({ question, hint });
        const answer = queue.shift();
        return Promise.resolve(answer === undefined ? null : answer);
      },
      print(line) {
        printed.push(line);
      },
      close() {
        closed += 1;
      },
    },
  };
}

describe('askAll (交互收集)', () => {
  test('--yes: 零交互取全默认', async () => {
    const { io, asked } = scriptedIO([]);
    const vocabulary = collectedOf(
      await askAll(io, ENV, options({ name: 'my-tool', yes: true })),
    );
    expect(asked).toHaveLength(0);
    expect(vocabulary).toEqual({
      name: 'my-tool',
      scope: '',
      binName: 'my-tool',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    });
  });

  test('五问顺序与默认值提示', async () => {
    const { io, asked } = scriptedIO(['my-tool', '', '', '', '']);
    const vocabulary = collectedOf(await askAll(io, ENV, options()));
    expect(asked.map((item) => item.question)).toEqual([
      '项目名',
      'scope',
      'bin 名',
      'owner',
      '仓库地址',
    ]);
    expect(asked[2]?.hint).toContain('默认: my-tool');
    expect(asked[3]?.hint).toContain('默认: iyowei');
    expect(asked[4]?.hint).toContain('https://github.com/iyowei/my-tool');
    expect(vocabulary).toEqual({
      name: 'my-tool',
      scope: '',
      binName: 'my-tool',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    });
  });

  test('未给 name 时先问 name; owner 无可用 git 默认时为必填', async () => {
    const { io, asked } = scriptedIO([
      'data-kit-tools',
      '@acme',
      '',
      'acme',
      '',
    ]);
    const vocabulary = collectedOf(
      await askAll(io, { gitUserName: null }, options()),
    );
    expect(asked[3]?.hint).toContain('必填');
    expect(vocabulary).toEqual({
      name: 'data-kit-tools',
      scope: '@acme',
      binName: 'data-kt',
      owner: 'acme',
      repoUrl: 'https://github.com/acme/data-kit-tools',
    });
  });

  test('git user.name 不可用作 owner 时同样按必填处理', async () => {
    const { io, asked } = scriptedIO(['my-tool', '', '', 'me', '']);
    const vocabulary = collectedOf(
      await askAll(io, { gitUserName: 'Iyo Wei' }, options()),
    );
    expect(asked[3]?.hint).toContain('必填');
    expect(vocabulary.owner).toBe('me');
  });

  test('答案非法时打印原因并重问', async () => {
    const { io, printed } = scriptedIO(['Bad Name', 'my-tool', '', '', '', '']);
    const vocabulary = collectedOf(await askAll(io, ENV, options()));
    expect(vocabulary.name).toBe('my-tool');
    expect(printed.some((line) => line.includes('kebab-case'))).toBe(true);
  });

  test('取消 (EOF / Ctrl+C) 返回 cancelled 且不再提问', async () => {
    const { io, asked } = scriptedIO(['my-tool', null]);
    const outcome = await askAll(io, ENV, options());
    expect(outcome.state).toBe('cancelled');
    expect(asked).toHaveLength(2);
  });

  test('显式旗标值非法时不进交互直接报错', async () => {
    const { io, asked } = scriptedIO([]);
    const outcome = await askAll(io, ENV, options({ name: 'Bad Name' }));
    expect(outcome.state).toBe('error');
    expect(asked).toHaveLength(0);
  });

  test('已由旗标给出的变量不再提问', async () => {
    const { io, asked } = scriptedIO(['', '', '']);
    const vocabulary = collectedOf(
      await askAll(io, ENV, options({ name: 'my-tool', scope: '@me' })),
    );
    expect(asked.map((item) => item.question)).toEqual([
      'bin 名',
      'owner',
      '仓库地址',
    ]);
    expect(vocabulary).toEqual({
      name: 'my-tool',
      scope: '@me',
      binName: 'my-tool',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    });
  });

  test('非 kebab-case 目录推导的 suggestedName 在交互模式忽略并提问, --yes 模式仍报错 (CREATE-P0-7)', async () => {
    const interactive = scriptedIO(['my-app', '', '', '', '']);
    const collected = collectedOf(
      await askAll(
        interactive.io,
        ENV,
        options({ dir: '.', suggestedName: 'MyApp' }),
      ),
    );
    expect(interactive.asked[0]?.question).toBe('项目名');
    expect(collected.name).toBe('my-app');
    expect(interactive.closedCount()).toBe(1);

    const validSuggested = scriptedIO(['', '', '', '']);
    const adopted = collectedOf(
      await askAll(
        validSuggested.io,
        ENV,
        options({ dir: './my-app', suggestedName: 'my-app' }),
      ),
    );
    expect(validSuggested.asked[0]?.question).toBe('scope');
    expect(adopted.name).toBe('my-app');

    const nonInteractive = scriptedIO([]);
    const failed = await askAll(
      nonInteractive.io,
      ENV,
      options({ dir: '.', suggestedName: 'MyApp', yes: true }),
    );
    expect(failed.state).toBe('error');
    expect(nonInteractive.closedCount()).toBe(1);
  });

  test('askAll 在完成 / 取消 / 报错 / --yes 四种出口均经 finally 调用 io.close (CREATE-P0-7)', async () => {
    const ok = scriptedIO(['my-tool', '', '', '', '']);
    await askAll(ok.io, ENV, options());
    expect(ok.closedCount()).toBe(1);

    const cancel = scriptedIO([null]);
    await askAll(cancel.io, ENV, options());
    expect(cancel.closedCount()).toBe(1);

    const bad = scriptedIO([]);
    await askAll(bad.io, ENV, options({ name: 'BadName' }));
    expect(bad.closedCount()).toBe(1);

    const yes = scriptedIO([]);
    await askAll(yes.io, ENV, options({ name: 'my-tool', yes: true }));
    expect(yes.closedCount()).toBe(1);
  });
});
