/**
 * 工作区坐标派生单测: 临时根上验证派生规则 (CLI = 带 bin; API = CLI devDeps 引的仓内包)
 * 与两类异常路径。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from './tmp-root.ts';
import { listWorkspacePackages, resolveCliAndApi } from './workspace.ts';

const roots: string[] = [];
function makeRoot(files: Record<string, unknown>): string {
  const root = makeTmpRoot('workspace-');
  roots.push(root);
  for (const [rel, content] of Object.entries(files)) {
    const abs = join(root, rel);
    mkdirSync(dirname(abs), { recursive: true });
    writeFileSync(abs, JSON.stringify(content, null, 2));
  }
  return root;
}
afterAll(() => {
  for (const root of roots) rmSync(root, { recursive: true, force: true });
});

describe('resolveCliAndApi', () => {
  test('派生两包: cli = 带 bin 者, api = cli devDeps 引的仓内包', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/tool-cli/package.json': {
        name: '@x/tool-cli',
        bin: { tool: 'bin/tool.mjs' },
        devDependencies: { '@x/tool': '1.0.0' },
      },
      'packages/tool/package.json': { name: '@x/tool' },
    });
    const { cli, api } = resolveCliAndApi(root);
    expect(cli.name).toBe('@x/tool-cli');
    expect(cli.dir).toBe('packages/tool-cli');
    expect(api.name).toBe('@x/tool');
    expect(api.dir).toBe('packages/tool');
  });

  test('无 bin 包时报错', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/only-lib/package.json': { name: '@x/only-lib' },
    });
    expect(() => resolveCliAndApi(root)).toThrow(/未找到带 bin 的 CLI 包/);
  });

  test('cli 未依赖任何仓内包时报错', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/tool-cli/package.json': {
        name: '@x/tool-cli',
        bin: { tool: 'bin/tool.mjs' },
        devDependencies: { lodash: '4.0.0' },
      },
    });
    expect(() => resolveCliAndApi(root)).toThrow(/所依赖的仓内 API 包/);
  });

  test('不支持的 workspaces 形态显式报错', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['apps/**'] },
    });
    expect(() => listWorkspacePackages(root)).toThrow(/暂不支持派生/);
  });
});
