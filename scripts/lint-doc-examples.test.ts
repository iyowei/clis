/**
 * 文档示例闸门单测: 采集 / 判据 / 分类各纯函数逐一断言; 集成面覆盖片段跳过、
 * 本仓包名 TS2307 拦截与多 CLI 旗标核对。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import {
  checkCliExamples,
  checkTsExamples,
  classifyBlock,
  extractCommandTokens,
  extractNamedShellCommands,
  extractShellCommands,
  extractTsBlocks,
  isSelfContained,
  parseTscErrors,
} from './lint-doc-examples.ts';

const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = makeTmpRoot('doc-examples-');
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, content);
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('extractTsBlocks', () => {
  test('取出 ```ts 块并给出内容首行行号 (1 起)', () => {
    const text = ['# 标题', '', '```ts', 'const a = 1;', '```', '尾'].join(
      '\n',
    );
    const blocks = extractTsBlocks(text, 'x.md');
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.startLine).toBe(4);
    expect(blocks[0]!.content).toBe('const a = 1;');
  });
});

describe('isSelfContained', () => {
  test('行首 import 视为自足; 片段块不算', () => {
    expect(isSelfContained("import { a } from 'x';")).toBe(true);
    expect(isSelfContained('// import 在注释里\nconst a = b;')).toBe(false);
  });
});

describe('extractShellCommands', () => {
  test('只收 shell 块内以指定命令起首的非注释行, 前缀精确', () => {
    const text = [
      '```shell',
      '# 注释跳过',
      'sweep-nm --yes',
      'sweep-nm-rs --target x',
      'bunx sweep-nm',
      '```',
      'sweep-nm 块外不算',
    ].join('\n');
    expect(extractShellCommands(text)).toEqual(['sweep-nm --yes']);
  });

  test('多命令采集支持 shell / bash 块并精准归属 binName', () => {
    const text = [
      '```bash',
      'extra --dry-run config.json',
      'create-app my-app --tier standard',
      '```',
    ].join('\n');
    expect(extractNamedShellCommands(text, ['extra', 'create-app'])).toEqual([
      { binName: 'extra', command: 'extra --dry-run config.json' },
      { binName: 'create-app', command: 'create-app my-app --tier standard' },
    ]);
  });
});

describe('extractCommandTokens', () => {
  test('旗标去 = 值; 仅首个纯标识符位置参数当子命令; 路径/文件不误判为子命令', () => {
    expect(extractCommandTokens('sweep-nm --yes --force')).toEqual([
      '--yes',
      '--force',
    ]);
    expect(
      extractCommandTokens('sweep-nm --exclude my-kits --exclude url'),
    ).toEqual(['--exclude']);
    expect(extractCommandTokens('sweep-nm config')).toEqual(['config']);
    expect(extractCommandTokens('extra ./deploy.json --dry-run')).toEqual([
      '--dry-run',
    ]);
    expect(extractCommandTokens('sweep-nm')).toEqual([]);
  });
});

describe('parseTscErrors + classifyBlock', () => {
  test('解析 block 序号与错误码, 分类干净 / 片段 / 真错', () => {
    const output = [
      "block-0.ts(3,5): error TS2304: Cannot find name 'panel'.",
      "block-1.ts(3,5): error TS2345: Argument of type 'string' is not assignable.",
      "block-1.ts(9,1): error TS2304: Cannot find name 'x'.",
    ].join('\n');
    const perBlock = parseTscErrors(output);
    expect(classifyBlock(perBlock.get(0))).toBe('fragment');
    expect(classifyBlock(perBlock.get(1))).toBe('real');
    expect(classifyBlock(perBlock.get(2))).toBe('clean');
    expect(classifyBlock(undefined)).toBe('clean');
  });
});

describe('checkTsExamples 集成', () => {
  test('非本仓虚构模块判跳过, 本仓 scope 模块找不到直接判真断裂', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/demo/package.json': JSON.stringify({ name: '@acme/demo' }),
      'tsconfig.json': '{"compilerOptions":{"noEmit":true}}',
      'docs/a.md': "```ts\nimport { nope } from 'nowhere-pkg';\nnope();\n```\n",
      'docs/b.md':
        "```ts\nimport { gone } from '@acme/renamed-pkg';\ngone();\n```\n",
    });
    const { real, fragments } = checkTsExamples(root);
    expect(fragments).toHaveLength(1);
    expect(real).toHaveLength(1);
    expect(real[0]).toContain('docs/b.md');
  }, 120000);
});

describe('checkCliExamples 集成', () => {
  test('多 CLI 并存时各自按 --help 核对旗标, 缺旗标精准报出', () => {
    const root = makeRoot({
      'package.json': JSON.stringify({ workspaces: ['packages/*'] }),
      'packages/sweep-node-modules-cli/package.json': JSON.stringify({
        name: '@iyowei/sweep-node-modules-cli',
        bin: { 'sweep-nm': 'bin/sweep-nm.mjs' },
      }),
      'packages/sweep-node-modules-cli/src/cli.ts':
        "console.log(['sweep-nm --yes  执行删除', 'sweep-nm config  查看配置'].join('\\n'));\n",
      'packages/extra-cli/package.json': JSON.stringify({
        name: '@acme/extra-cli',
        bin: { extra: 'bin/extra.mjs' },
      }),
      'packages/extra-cli/src/cli.ts':
        "console.log(['extra --dry-run  干跑', 'extra init  初始化'].join('\\n'));\n",
      'README.md': [
        '```shell',
        'sweep-nm --yes',
        'sweep-nm --nope',
        'sweep-nm config',
        'extra init',
        'extra --bogus',
        '```',
      ].join('\n'),
    });
    const missing = checkCliExamples(root);
    expect(missing).toHaveLength(2);
    expect(missing.some((line) => line.includes('--nope'))).toBe(true);
    expect(missing.some((line) => line.includes('--bogus'))).toBe(true);
  }, 60000);
});
