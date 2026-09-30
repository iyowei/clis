/**
 * 文档示例闸门单测: 采集 / 判据 / 分类各纯函数逐一断言; 集成面用临时 mini 根验证
 * 「片段块判跳过」与「CLI 档旗标缺失抓得住」。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  checkCliExamples,
  checkTsExamples,
  classifyBlock,
  extractCommandTokens,
  extractShellCommands,
  extractTsBlocks,
  isSelfContained,
  parseTscErrors,
} from './lint-doc-examples.ts';

const roots: string[] = [];
function makeRoot(files: Record<string, string>): string {
  const root = mkdtempSync(join(homedir(), 'tmp', 'doc-examples-'));
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
  test('只收 shell 块内以 sweep-nm 起首的非注释行, 前缀精确', () => {
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
});

describe('extractCommandTokens', () => {
  test('旗标去 = 值; 第一个位置参数当子命令; 旗标的值不采集', () => {
    expect(extractCommandTokens('sweep-nm --yes --force')).toEqual([
      '--yes',
      '--force',
    ]);
    expect(
      extractCommandTokens('sweep-nm --exclude my-kits --exclude url'),
    ).toEqual(['--exclude']);
    expect(extractCommandTokens('sweep-nm config')).toEqual(['config']);
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
  test('片段块 (引用块外上下文) 判跳过而非断裂', () => {
    const root = makeRoot({
      'tsconfig.json': '{"compilerOptions":{"noEmit":true}}',
      'docs/a.md': "```ts\nimport { nope } from 'nowhere-pkg';\nnope();\n```\n",
    });
    const { real, fragments } = checkTsExamples(root);
    expect(real).toEqual([]);
    expect(fragments).toHaveLength(1);
  }, 120000);
});

describe('checkCliExamples 集成', () => {
  test('文档写了 --help 里没有的旗标即抓出; 文档漏登记不误报', () => {
    const root = makeRoot({
      'packages/sweep-node-modules-cli/src/cli.ts':
        "console.log(['sweep-nm --yes  执行删除', 'sweep-nm config  查看配置'].join('\\n'));\n",
      'README.md': [
        '```shell',
        'sweep-nm --yes',
        'sweep-nm --nope',
        'sweep-nm config',
        '```',
      ].join('\n'),
    });
    const missing = checkCliExamples(root);
    expect(missing).toHaveLength(1);
    expect(missing[0]).toContain('--nope');
  }, 60000);
});
