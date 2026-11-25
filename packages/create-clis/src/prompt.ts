/**
 * 交互收集 (支持中英双语提问与校验反馈): 无旗标 (或未给全) 时经 readline 逐问五个变量。
 */
import { type Interface, createInterface } from 'node:readline/promises';

import { type Locale, t } from '@iyowei/cli-i18n';

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

export interface PromptIO {
  ask(question: string, hint?: string): Promise<string | null>;
  print(line: string): void;
  close?: () => void;
}

export type AskOutcome =
  | { state: 'collected'; vocabulary: Vocabulary }
  | { state: 'cancelled' }
  | { state: 'error'; error: string };

function collected(result: Vocabulary | { error: string }): AskOutcome {
  return 'error' in result
    ? { state: 'error', error: result.error }
    : { state: 'collected', vocabulary: result };
}

async function askValidated(
  io: PromptIO,
  question: string,
  hint: string,
  fallback: string | undefined,
  validate: (value: string) => string | null,
  locale: Locale,
): Promise<string | null> {
  for (;;) {
    const answer = await io.ask(question, hint);
    if (answer === null) return null;
    const trimmed = answer.trim();
    const value = trimmed.length > 0 ? trimmed : fallback;
    if (value === undefined) {
      io.print(
        t(
          locale,
          `  ✗ ${question} 必填, 不能留空`,
          `  ✗ ${question} is required`,
        ),
      );
      continue;
    }
    const error = validate(value);
    if (error === null) return value;
    io.print(`  ✗ ${error}`);
  }
}

export async function askAll(
  io: PromptIO,
  env: Environment,
  seed: CliOptions = { git: true, install: true, yes: false },
  locale: Locale = 'zh',
): Promise<AskOutcome> {
  try {
    if (seed.yes) return collected(resolveVocabulary(seed, env, locale));

    const seedName = provided(seed.name);
    const rawSuggested = provided(seed.suggestedName);
    const seedScope = provided(seed.scope);
    const seedBin = provided(seed.bin);
    const seedOwner = provided(seed.owner);
    const seedRepo = provided(seed.repo);

    const seededChecks: readonly (readonly [
      string | undefined,
      (value: string) => string | null,
    ])[] = [
      [seedName, (v) => validateName(v, locale)],
      [seedScope, (v) => validateScope(v, locale)],
      [seedBin, (v) => validateBinName(v, locale)],
      [seedOwner, (v) => validateOwner(v, locale)],
      [seedRepo, (v) => validateRepoUrl(v, locale)],
    ];
    for (const [value, validate] of seededChecks) {
      if (value === undefined) continue;
      const error = validate(value);
      if (error !== null) return { state: 'error', error };
    }

    const usableSuggested =
      rawSuggested !== undefined && validateName(rawSuggested, locale) === null
        ? rawSuggested
        : undefined;

    io.print(
      t(
        locale,
        'create-clis: 依次回答以下问题 (方括号内为默认值, 回车采用)',
        'create-clis: Answer the prompts below (press Enter to accept defaults in brackets)',
      ),
    );

    let name = seedName ?? usableSuggested;
    if (name === undefined) {
      const answer = await askValidated(
        io,
        t(locale, '项目名', 'Project name'),
        t(
          locale,
          '必填, kebab-case, 如 my-tool',
          'required, kebab-case, e.g. my-tool',
        ),
        undefined,
        (v) => validateName(v, locale),
        locale,
      );
      if (answer === null) return { state: 'cancelled' };
      name = answer;
    }

    let scope = seedScope;
    if (scope === undefined) {
      const answer = await askValidated(
        io,
        'scope',
        t(
          locale,
          '回车跳过 (裸包名; 带 scope 时以 @ 开头, 如 @me)',
          'Enter to skip (unscoped; or @scope such as @me)',
        ),
        '',
        (v) => validateScope(v, locale),
        locale,
      );
      if (answer === null) return { state: 'cancelled' };
      scope = answer;
    }

    let bin = seedBin;
    if (bin === undefined) {
      const fallback = deriveBinName(name);
      const answer = await askValidated(
        io,
        t(locale, 'bin 名', 'Binary name'),
        t(locale, `默认: ${fallback}`, `default: ${fallback}`),
        fallback,
        (v) => validateBinName(v, locale),
        locale,
      );
      if (answer === null) return { state: 'cancelled' };
      bin = answer;
    }

    let owner = seedOwner;
    if (owner === undefined) {
      const gitDefault =
        env.gitUserName !== null &&
        validateOwner(env.gitUserName, locale) === null
          ? env.gitUserName
          : undefined;
      const answer = await askValidated(
        io,
        'owner',
        gitDefault === undefined
          ? t(
              locale,
              '必填 (读不到可用的 git 全局 user.name)',
              'required (no valid git global user.name found)',
            )
          : t(locale, `默认: ${gitDefault}`, `default: ${gitDefault}`),
        gitDefault,
        (v) => validateOwner(v, locale),
        locale,
      );
      if (answer === null) return { state: 'cancelled' };
      owner = answer;
    }

    let repo = seedRepo;
    if (repo === undefined) {
      const fallback = `https://github.com/${owner}/${name}`;
      const answer = await askValidated(
        io,
        t(locale, '仓库地址', 'Repository URL'),
        t(locale, `默认: ${fallback}`, `default: ${fallback}`),
        fallback,
        (v) => validateRepoUrl(v, locale),
        locale,
      );
      if (answer === null) return { state: 'cancelled' };
      repo = answer;
    }

    return collected(
      resolveVocabulary(
        { ...seed, name, scope, bin, owner, repo },
        env,
        locale,
      ),
    );
  } finally {
    io.close?.();
  }
}

export function createPromptIO(): PromptIO {
  const buffered: string[] = [];
  let rl: Interface | null = null;
  let ended = false;
  let pending: ((line: string | null) => void) | null = null;

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
      setStdinRef(false);
      resolve(null);
    });
    created.on('SIGINT', () => created.close());
    rl = created;
    return created;
  }

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
