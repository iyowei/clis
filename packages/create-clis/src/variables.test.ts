/**
 * 变量收集与旗标单测: 纯函数全谱 (kebab-case / bin 可用性校验、旗标解析、五变量派生与兜底)
 * 与交互收集 (askAll)。
 *
 * 交互经脚本化 IO 驱动 (PromptIO 注入), 不打真 TTY; git 全局 user.name 经 Environment 注入,
 * 不读真实 git 配置。
 */
import { describe, expect, test } from 'bun:test';

import { basename, resolve } from 'node:path';

import { type Vocabulary } from './render.ts';
import {
  type CliOptions,
  type Environment,
  deriveBinName,
  normalizeRepoUrl,
  parseFlags,
  resolveVocabulary,
  validateBinName,
  validateName,
  validateOwner,
  validateRepoUrl,
  validateScope,
} from './variables.ts';

/** git 全局 user.name 的测试环境 */
const ENV: Environment = { gitUserName: 'iyowei' };

/** 三开关的最简 options: 用例只点名自己关心的字段 */
function options(partial: Partial<CliOptions> = {}): CliOptions {
  return { git: true, install: true, yes: false, ...partial };
}

/** 从「成功 | { error }」联合取错误文案 (无 error 字段即断言失败) */
function errorText(result: unknown): string {
  expect(typeof (result as { error?: unknown }).error).toBe('string');
  return (result as { error: string }).error;
}

/** 从联合取成功词汇表 */
function vocabularyOf(result: unknown): Vocabulary {
  expect(result).not.toHaveProperty('error');
  return result as Vocabulary;
}

describe('validateName (kebab-case)', () => {
  test('合法形态通过', () => {
    for (const name of ['a', 'my-tool', 'tool2', 'x-1-y', '3d-model']) {
      expect(validateName(name), name).toBeNull();
    }
  });

  test('非法形态各自给出原因', () => {
    for (const name of [
      '',
      'MyTool',
      'my_tool',
      'my tool',
      'my.tool',
      '-foo',
      'foo-',
      'foo--bar',
      '@me/foo',
      '工具',
    ]) {
      expect(validateName(name), name).not.toBeNull();
    }
  });
});

describe('validateBinName (命令行可用)', () => {
  test('可用命令名通过', () => {
    for (const bin of ['mt', 'my-tool', 'my_tool', 'tool.2', 'x', 'MyTool']) {
      expect(validateBinName(bin), bin).toBeNull();
    }
  });

  test('不可用形态各自给出原因', () => {
    for (const bin of [
      '',
      'my bin',
      'my/tool',
      'my\\tool',
      '-mt',
      '.mt',
      'mt-',
      'mt;rm',
      'mt|x',
      '工具',
    ]) {
      expect(validateBinName(bin), bin).not.toBeNull();
    }
  });
});

describe('validateScope / validateOwner / validateRepoUrl', () => {
  test('scope: 空串 (裸包名) 合法, 非空须 @ 开头的小写名', () => {
    expect(validateScope('')).toBeNull();
    expect(validateScope('@me')).toBeNull();
    expect(validateScope('@my-scope.2')).toBeNull();
    expect(validateScope('me')).not.toBeNull();
    expect(validateScope('@ME')).not.toBeNull();
    expect(validateScope('@me/foo')).not.toBeNull();
  });

  test('owner: 只接受 URL 段可用字符', () => {
    expect(validateOwner('iyowei')).toBeNull();
    expect(validateOwner('Iyo-2')).toBeNull();
    expect(validateOwner('')).not.toBeNull();
    expect(validateOwner('Iyo Wei')).not.toBeNull();
    expect(validateOwner('王小明')).not.toBeNull();
  });

  test('repo: 需 scheme://host/path (路径段供裸 slug 解析)', () => {
    expect(validateRepoUrl('https://github.com/me/my-tool')).toBeNull();
    expect(validateRepoUrl('https://github.com/me/my-tool.git')).toBeNull();
    expect(validateRepoUrl('https://github.com/me/my-tool.git/')).toBeNull();
    expect(validateRepoUrl('git@github.com:me/x')).not.toBeNull();
    expect(validateRepoUrl('https://github.com')).not.toBeNull();
    expect(validateRepoUrl('https://github.com///')).not.toBeNull();
    expect(validateRepoUrl('https://github.com/.git/')).not.toBeNull();
    expect(validateRepoUrl('')).not.toBeNull();
  });
});

describe('deriveBinName (短形态派生)', () => {
  test('三段及以上取首段 + 其余段首字母 (锚点 sweep-node-modules → sweep-nm); 一 / 两段原样保留', () => {
    expect(deriveBinName('sweep-node-modules')).toBe('sweep-nm');
    expect(deriveBinName('data-kit-tools')).toBe('data-kt');
    expect(deriveBinName('cli')).toBe('cli');
    expect(deriveBinName('my-tool')).toBe('my-tool');
  });
});

describe('parseFlags', () => {
  test('无参数: 三开关取默认 (git / install 开, yes 关)', () => {
    expect(parseFlags([])).toEqual({ git: true, install: true, yes: false });
  });

  test('--name 取值与 --flag=value 形态', () => {
    expect(parseFlags(['--name', 'my-tool'])).toEqual({
      name: 'my-tool',
      git: true,
      install: true,
      yes: false,
    });
    expect(parseFlags(['--name=my-tool', '--tier=full'])).toEqual({
      name: 'my-tool',
      tier: 'full',
      git: true,
      install: true,
      yes: false,
    });
  });

  test('位置参数为目标目录, 无 --name 时目录名写入 suggestedName', () => {
    expect(parseFlags(['./pkgs/my-tool'])).toEqual({
      dir: './pkgs/my-tool',
      suggestedName: 'my-tool',
      git: true,
      install: true,
      yes: false,
    });
  });

  test('位置参数为 . / .. 时 suggestedName 回退到解析后的目录名 (不拿字面量 . 当项目名)', () => {
    // 背景: basename('.') 是 '.', 直接当项目名会被 kebab-case 校验拒绝且报错费解
    // (`create-clis . --yes` 的实测场景); 回退值取 resolve 后的 basename (当前 / 上级目录名)
    const cwdName = basename(resolve('.'));
    const parentName = basename(resolve('..'));
    expect(
      cwdName.length,
      '用例前提: 测试进程 cwd 不是文件系统根',
    ).toBeGreaterThan(0);
    expect(parseFlags(['.'])).toMatchObject({
      dir: '.',
      suggestedName: cwdName,
    });
    expect(parseFlags(['..'])).toMatchObject({
      dir: '..',
      suggestedName: parentName,
    });
    // 显式 --name 优先于该回退由后续既有用例 (--name 优先于位置参数的 basename) 背书
  });

  test('-h / --help / -V / --version 与 -- 分隔符顺序解析 (CREATE-P1-2)', () => {
    expect(parseFlags(['-h'])).toMatchObject({ help: true });
    expect(parseFlags(['--help'])).toMatchObject({ help: true });
    expect(parseFlags(['-V'])).toMatchObject({ version: true });
    expect(parseFlags(['--version'])).toMatchObject({ version: true });
    expect(errorText(parseFlags(['--help=1']))).toContain('--help');
    expect(errorText(parseFlags(['--version=1']))).toContain('--version');

    // `--` 之后的 token 一律作为位置参数, 支持创建名为 update 或以 `-` 开头的目录
    expect(parseFlags(['--', 'update'])).toEqual({
      dir: 'update',
      suggestedName: 'update',
      git: true,
      install: true,
      yes: false,
    });
    expect(parseFlags(['--', '-h'])).toEqual({
      dir: '-h',
      suggestedName: '-h',
      git: true,
      install: true,
      yes: false,
    });

    // 非首位的裸 update (未以 -- 逃逸且未显式传 --name update) 拒绝并提示子命令用法, 防误建 ./update/
    expect(errorText(parseFlags(['--yes', 'update']))).toContain(
      'update 子命令须位于首个参数',
    );
    expect(parseFlags(['--yes', 'update', '--name', 'update'])).toEqual({
      dir: 'update',
      name: 'update',
      git: true,
      install: true,
      yes: true,
    });
  });

  test('--name 优先于位置参数的 basename', () => {
    expect(parseFlags(['./pkgs/x', '--name', 'my-tool'])).toMatchObject({
      dir: './pkgs/x',
      name: 'my-tool',
    });
  });

  test('开关旗标与值旗标齐备', () => {
    expect(
      parseFlags([
        '--scope',
        '@me',
        '--bin',
        'mt',
        '--owner',
        'me',
        '--repo',
        'https://github.com/me/my-tool',
        '--no-git',
        '--no-install',
        '--yes',
      ]),
    ).toEqual({
      scope: '@me',
      bin: 'mt',
      owner: 'me',
      repo: 'https://github.com/me/my-tool',
      git: false,
      install: false,
      yes: true,
    });
  });

  test('--tier 只认三档', () => {
    expect(parseFlags(['--tier', 'core'])).toMatchObject({ tier: 'core' });
    expect(parseFlags(['--tier', 'standard'])).toMatchObject({
      tier: 'standard',
    });
    expect(errorText(parseFlags(['--tier', 'bogus']))).toContain('--tier');
  });

  test('未知旗标 / 缺值 / 布尔旗标带值 / 多余位置参数均报错', () => {
    expect(errorText(parseFlags(['--bogus']))).toContain('未知旗标');
    expect(errorText(parseFlags(['--name']))).toContain('--name');
    expect(errorText(parseFlags(['--name', '--scope', '@me']))).toContain(
      '--name',
    );
    expect(errorText(parseFlags(['--no-git=1']))).toContain('--no-git');
    expect(errorText(parseFlags(['a', 'b']))).toContain('位置参数');
  });

  test('重复旗标后者胜', () => {
    expect(parseFlags(['--name', 'a', '--name', 'b'])).toMatchObject({
      name: 'b',
    });
  });
});

describe('resolveVocabulary', () => {
  test('五变量齐备时原样采用, 不再派生', () => {
    const vocabulary = vocabularyOf(
      resolveVocabulary(
        options({
          name: 'my-tool',
          scope: '@me',
          bin: 'mt',
          owner: 'me',
          repo: 'https://github.com/me/my-tool',
        }),
        ENV,
      ),
    );
    expect(vocabulary).toEqual({
      name: 'my-tool',
      scope: '@me',
      binName: 'mt',
      owner: 'me',
      repoUrl: 'https://github.com/me/my-tool',
    });
    // author 不在此处派生 (render 侧缺省回退 owner)
    expect(vocabulary.author).toBeUndefined();
  });

  test('缺省派生: 裸 scope / bin 短形态 / owner 取 git / repo 合成', () => {
    const vocabulary = vocabularyOf(
      resolveVocabulary(options({ name: 'sweep-node-modules' }), ENV),
    );
    expect(vocabulary).toEqual({
      name: 'sweep-node-modules',
      scope: '',
      binName: 'sweep-nm',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/sweep-node-modules',
    });
  });

  test('缺 name 报错', () => {
    expect(errorText(resolveVocabulary(options(), ENV))).toContain('项目名');
  });

  test('非法 name 报错', () => {
    expect(
      errorText(resolveVocabulary(options({ name: 'Bad Name' }), ENV)),
    ).toContain('kebab-case');
  });

  test('--bin 不可用时报错 (命令行可用性校验)', () => {
    expect(
      errorText(
        resolveVocabulary(options({ name: 'my-tool', bin: 'my bin' }), ENV),
      ),
    ).toContain('bin');
  });

  test('scope 非空时必须是 @ 开头的 npm scope 形态', () => {
    expect(
      errorText(
        resolveVocabulary(options({ name: 'my-tool', scope: 'me' }), ENV),
      ),
    ).toContain('scope');
    expect(
      vocabularyOf(
        resolveVocabulary(options({ name: 'my-tool', scope: '@me' }), ENV),
      ).scope,
    ).toBe('@me');
  });

  test('owner > git 全局 user.name; 两者都不可用时报错', () => {
    expect(
      vocabularyOf(
        resolveVocabulary(options({ name: 'my-tool', owner: 'acme' }), {
          gitUserName: 'iyowei',
        }),
      ).owner,
    ).toBe('acme');
    expect(
      errorText(
        resolveVocabulary(options({ name: 'my-tool' }), { gitUserName: null }),
      ),
    ).toContain('owner');
    expect(
      errorText(
        resolveVocabulary(options({ name: 'my-tool' }), {
          gitUserName: 'Iyo Wei',
        }),
      ),
    ).toContain('owner');
  });

  test('--repo 覆盖合成值并归一化剥除尾斜杠与 .git 后缀; 非法地址报错', () => {
    expect(
      vocabularyOf(
        resolveVocabulary(
          options({ name: 'my-tool', repo: 'https://gitlab.com/me/x' }),
          ENV,
        ),
      ).repoUrl,
    ).toBe('https://gitlab.com/me/x');
    for (const raw of [
      'https://github.com/acme/my-tool/',
      'https://github.com/acme/my-tool///',
      'https://github.com/acme/my-tool.git',
      'https://github.com/acme/my-tool.GIT/',
      'https://github.com/acme/my-tool/.git/',
    ]) {
      expect(normalizeRepoUrl(raw), raw).toBe(
        'https://github.com/acme/my-tool',
      );
      expect(
        vocabularyOf(
          resolveVocabulary(options({ name: 'my-tool', repo: raw }), ENV),
        ).repoUrl,
        raw,
      ).toBe('https://github.com/acme/my-tool');
    }
    expect(
      errorText(
        resolveVocabulary(
          options({ name: 'my-tool', repo: 'github.com/me/x' }),
          ENV,
        ),
      ),
    ).toContain('仓库地址');
    expect(
      errorText(
        resolveVocabulary(
          options({ name: 'my-tool', repo: 'https://github.com/.git/' }),
          ENV,
        ),
      ),
    ).toContain('仓库地址');
  });

  test('空串旗标视同未提供 (取默认)', () => {
    expect(
      resolveVocabulary(
        options({ name: 'my-tool', scope: '', bin: '', owner: '', repo: '' }),
        ENV,
      ),
    ).toEqual({
      name: 'my-tool',
      scope: '',
      binName: 'my-tool',
      owner: 'iyowei',
      repoUrl: 'https://github.com/iyowei/my-tool',
    });
  });
});
