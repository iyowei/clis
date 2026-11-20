/**
 * generate.ts 收尾 hooks 与二道自检边界单测 (CREATE-P0-4 / CREATE-P0-6)。
 * 独立分文件以守 max-lines 门禁并精准注入子进程 spawner, 不依赖宿主是否安装 git / bun。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import {
  type HookSpawnResult,
  type HookSpawner,
  buildBatchInvocation,
  cleanInstallEnv,
  createGitInitHook,
  createInstallHook,
  generateProject,
  resolveHookCommand,
} from './generate.ts';
import { ORIGINAL } from './template-snapshot.ts';

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) {
    rmSync(root, { recursive: true, force: true });
  }
});

function fakeResult(patch: Partial<HookSpawnResult>): HookSpawnResult {
  return {
    stderr: '',
    status: 0,
    signal: null,
    ...patch,
  };
}

describe('cleanInstallEnv 与 resolveHookCommand (CREATE-P0-4)', () => {
  test('cleanInstallEnv 剥离 npm_execpath 与 npm_lifecycle_* (大小写不敏感), 保留其余变量', () => {
    const cleaned = cleanInstallEnv({
      PATH: '/usr/bin',
      HOME: '/tmp/home',
      npm_execpath: '/usr/lib/npm-cli.js',
      NPM_EXECPATH: '/dup',
      npm_lifecycle_event: 'create',
      npm_lifecycle_script: 'create-clis',
      KEEP_ME: 'yes',
    });

    expect(cleaned.PATH).toBe('/usr/bin');
    expect(cleaned.KEEP_ME).toBe('yes');
    expect(cleaned.npm_execpath).toBeUndefined();
    expect(cleaned.NPM_EXECPATH).toBeUndefined();
    expect(cleaned.npm_lifecycle_event).toBeUndefined();
    expect(cleaned.npm_lifecycle_script).toBeUndefined();
  });

  test('resolveHookCommand 在 win32 按绝对 PATH 解析 .exe / .com / .cmd 且拦截相对/盘根路径', () => {
    expect(resolveHookCommand('bun', { platform: 'darwin' })).toEqual({
      command: 'bun',
      isBatch: false,
    });

    expect(
      resolveHookCommand('bun', {
        platform: 'win32',
        pathEnv: '.;/usr/bin;C:\\tools',
        fileProbe: (candidate) => candidate === 'C:\\tools\\bun.exe',
      }),
    ).toEqual({ command: 'C:\\tools\\bun.exe', isBatch: false });

    expect(
      resolveHookCommand('bun', {
        platform: 'win32',
        pathEnv: '"C:\\Program Files\\bun"',
        fileProbe: (candidate) =>
          candidate === 'C:\\Program Files\\bun\\bun.cmd',
      }),
    ).toEqual({ command: 'C:\\Program Files\\bun\\bun.cmd', isBatch: true });

    expect(
      resolveHookCommand('bun', {
        platform: 'win32',
        pathEnv: ';/usr/bin;relative',
        fileProbe: () => true,
      }),
    ).toEqual({ command: 'bun', isBatch: false });
  });
});

describe('buildBatchInvocation Windows .cmd 安全转义', () => {
  test('含括号与空格的标准安装路径双引号包裹且绝不在引号内插入 ^', () => {
    const inv = buildBatchInvocation(
      'C:\\Program Files (x86)\\Git\\cmd\\git.cmd',
      ['init', '--quiet'],
      { ComSpec: 'C:\\Windows\\System32\\cmd.exe' },
    );
    expect(inv).toEqual({
      command: 'C:\\Windows\\System32\\cmd.exe',
      args: [
        '/d',
        '/s',
        '/c',
        '""C:\\Program Files (x86)\\Git\\cmd\\git.cmd" init --quiet"',
      ],
      windowsVerbatimArguments: true,
    });
  });

  test('含 & 元字符路径由双引号保护, 不插入 ^ 破坏字面路径', () => {
    const inv = buildBatchInvocation('C:\\Tools & Utils\\bun.cmd', ['install']);
    expect(inv).toEqual({
      command: 'cmd.exe',
      args: ['/d', '/s', '/c', '""C:\\Tools & Utils\\bun.cmd" install"'],
      windowsVerbatimArguments: true,
    });
  });

  test('含 %VAR% / !VAR! 时拆分引号: 路径用 ^ 转义, 参数用 ^^^ 转义防双层展开', () => {
    const inv = buildBatchInvocation(
      'C:\\dir\\%VAR%\\!BANG!\\git.cmd',
      ['commit', '-m', 'a%VAR%!BANG!'],
      {},
    );
    expect(inv.args[3]).toBe(
      '""C:\\dir\\\\"^%"VAR"^%"\\\\"^!"BANG"^!"\\git.cmd" commit -m "a"^^^%"VAR"^^^%^^^!"BANG"^^^!"',
    );
  });

  test('常规段末尾反斜杠倍增防闭合引号被吞', () => {
    const inv = buildBatchInvocation('C:\\tools\\git.cmd', [
      'C:\\dir with space\\',
      'C:\\two slashes\\\\',
      '',
    ]);
    expect(inv.args[3]).toBe(
      '""C:\\tools\\git.cmd" "C:\\dir with space\\\\" "C:\\two slashes\\\\\\\\" """',
    );
  });

  test('空或纯空白 ComSpec / COMSPEC 回退到 cmd.exe', () => {
    expect(
      buildBatchInvocation('C:\\tools\\bun.cmd', ['install'], {
        ComSpec: '',
        COMSPEC: '   ',
      }).command,
    ).toBe('cmd.exe');

    expect(
      buildBatchInvocation('C:\\tools\\bun.cmd', ['install'], {
        ComSpec: '  ',
        COMSPEC: '  C:\\Windows\\System32\\cmd.exe  ',
      }).command,
    ).toBe('C:\\Windows\\System32\\cmd.exe');
  });

  test('路径或参数含双引号、换行、回车、空字节或空路径时直接拒收抛错', () => {
    for (const badPath of [
      '',
      'C:\\a"b\\git.cmd',
      'C:\\a\nb\\git.cmd',
      'C:\\a\rb\\git.cmd',
      'C:\\a\0b\\git.cmd',
    ]) {
      expect(() => buildBatchInvocation(badPath, ['init'])).toThrow();
    }
    for (const badArg of [
      'hello"world',
      'line1\nline2',
      'line1\rline2',
      'null\0byte',
    ]) {
      expect(() => buildBatchInvocation('C:\\git.cmd', [badArg])).toThrow();
    }
  });
});

describe('createGitInitHook 加固 (CREATE-P0-4)', () => {
  test('清洗 GIT_* 环境变量, 防止宿主 git hook 污染目标目录', () => {
    const prevGitDir = process.env.GIT_DIR;
    const prevWorkTree = process.env.GIT_WORK_TREE;
    process.env.GIT_DIR = '/host/.git';
    process.env.GIT_WORK_TREE = '/host';
    try {
      let seenEnv: Record<string, string> = {};
      const spawner: HookSpawner = (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return fakeResult({ status: 0 });
      };
      createGitInitHook(spawner)('/tmp/new-proj');
      expect(seenEnv.GIT_DIR).toBeUndefined();
      expect(seenEnv.GIT_WORK_TREE).toBeUndefined();
    } finally {
      if (prevGitDir === undefined) delete process.env.GIT_DIR;
      else process.env.GIT_DIR = prevGitDir;
      if (prevWorkTree === undefined) delete process.env.GIT_WORK_TREE;
      else process.env.GIT_WORK_TREE = prevWorkTree;
    }
  });

  test('未装 git (ENOENT) 或 stderr 为 null 时不空指针崩溃并给出清晰指引', () => {
    const enoent = Object.assign(new Error('spawn git ENOENT'), {
      code: 'ENOENT',
    });
    const missingGit: HookSpawner = () =>
      fakeResult({
        status: null,
        stderr: null as unknown as string,
        error: enoent,
      });
    expect(() => createGitInitHook(missingGit)('/tmp/new-proj')).toThrow(
      /--no-git/,
    );

    const nullStderrFail: HookSpawner = () =>
      fakeResult({
        status: 128,
        stderr: null as unknown as string,
      });
    expect(() => createGitInitHook(nullStderrFail)('/tmp/new-proj')).toThrow(
      /退出码 128/,
    );
  });
});

describe('createInstallHook 加固 (CREATE-P0-4)', () => {
  test('剥离 npm_execpath / npm_lifecycle_* 并对未装 bun (ENOENT) 给安装或 --no-install 指引', () => {
    const prevExec = process.env.npm_execpath;
    const prevEvent = process.env.npm_lifecycle_event;
    process.env.npm_execpath = '/fake/npm-cli.js';
    process.env.npm_lifecycle_event = 'create';
    try {
      let seenEnv: Record<string, string> = {};
      const spawner: HookSpawner = (_cmd, _args, opts) => {
        seenEnv = opts.env;
        return fakeResult({ status: 0 });
      };
      createInstallHook(spawner)('/tmp/new-proj');
      expect(seenEnv.npm_execpath).toBeUndefined();
      expect(seenEnv.npm_lifecycle_event).toBeUndefined();
    } finally {
      if (prevExec === undefined) delete process.env.npm_execpath;
      else process.env.npm_execpath = prevExec;
      if (prevEvent === undefined) delete process.env.npm_lifecycle_event;
      else process.env.npm_lifecycle_event = prevEvent;
    }

    const enoent = Object.assign(new Error('spawn bun ENOENT'), {
      code: 'ENOENT',
    });
    const missingBun: HookSpawner = () =>
      fakeResult({ status: null, error: enoent });
    expect(() => createInstallHook(missingBun)('/tmp/new-proj')).toThrow(
      /--no-install/,
    );
  });
});

describe('generateProject 独立 {{SCOPE}} 替换与全量占位零残留 (CREATE-P0-6)', () => {
  test('模板中的孤立 {{SCOPE}} 被准确替换且零残留通过二道自检', async () => {
    const root = makeTmpRoot('create-clis-scope-gen-');
    createdRoots.push(root);
    const tpl = join(root, 'tpl');
    const target = join(root, 'out');
    mkdirSync(tpl, { recursive: true });
    writeFileSync(join(tpl, '.prettierrc'), '{"singleQuote": true}\n');
    writeFileSync(join(tpl, 'README.md'), 'Scope: {{SCOPE}}\nName: {{NAME}}\n');

    await expect(
      generateProject({
        templateDir: tpl,
        targetDir: target,
        vocabulary: {
          name: 'demo-app',
          scope: '@demo',
          binName: 'demo-app',
          owner: 'me',
          repoUrl: 'https://github.com/me/demo-app',
        },
        tier: 'full',
        original: ORIGINAL,
      }),
    ).resolves.toEqual({ executed: [] });
  });
});
