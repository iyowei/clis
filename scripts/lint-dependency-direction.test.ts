/**
 * 依赖方向闸门单测: 覆盖合法分层、CLI↔CLI 禁令、库→CLI 禁令、环依赖与公开库深度限制。
 */
import { afterAll, describe, expect, test } from 'bun:test';

import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from './lib/tmp-root.ts';
import { checkDependencyDirection } from './lint-dependency-direction.ts';

const roots: string[] = [];
function makeRoot(files: Record<string, unknown>): string {
  const root = makeTmpRoot('dep-dir-');
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

describe('checkDependencyDirection', () => {
  test('合法单向分层 (CLI → 公开库 / 私有库, 公开库深度 ≤ 2) 全绿', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/core/package.json': { name: '@x/core' },
      'packages/mid/package.json': {
        name: '@x/mid',
        dependencies: { '@x/core': '1.0.0' },
      },
      'packages/top/package.json': {
        name: '@x/top',
        dependencies: { '@x/mid': '1.0.0' },
      },
      'packages/internal/package.json': {
        name: '@x/internal',
        private: true,
        dependencies: { '@x/core': '1.0.0' },
      },
      'packages/tool-cli/package.json': {
        name: '@x/tool-cli',
        bin: { tool: 'bin/tool.mjs' },
        devDependencies: { '@x/top': '1.0.0', '@x/internal': '1.0.0' },
      },
    });
    expect(checkDependencyDirection(root)).toEqual([]);
  });

  test('CLI 依赖另一个 CLI (含 devDependencies) 亮红灯', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/a-cli/package.json': {
        name: '@x/a-cli',
        bin: { a: 'bin/a.mjs' },
        devDependencies: { '@x/b-cli': '1.0.0' },
      },
      'packages/b-cli/package.json': {
        name: '@x/b-cli',
        bin: { b: 'bin/b.mjs' },
      },
    });
    const violations = checkDependencyDirection(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('CLI ↔ CLI');
  });

  test('公开库或私有库反向依赖 CLI 亮红灯', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/lib/package.json': {
        name: '@x/lib',
        dependencies: { '@x/app-cli': '1.0.0' },
      },
      'packages/priv/package.json': {
        name: '@x/priv',
        private: true,
        devDependencies: { '@x/app-cli': '1.0.0' },
      },
      'packages/app-cli/package.json': {
        name: '@x/app-cli',
        bin: { app: 'bin/app.mjs' },
      },
    });
    const violations = checkDependencyDirection(root);
    expect(violations).toHaveLength(2);
    expect(violations.every((v) => v.includes('反向依赖 CLI'))).toBe(true);
  });

  test('循环依赖亮红灯', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/a/package.json': {
        name: '@x/a',
        dependencies: { '@x/b': '1.0.0' },
      },
      'packages/b/package.json': {
        name: '@x/b',
        dependencies: { '@x/a': '1.0.0' },
      },
    });
    const violations = checkDependencyDirection(root);
    expect(violations.some((v) => v.includes('循环依赖'))).toBe(true);
  });

  test('公开库链深度超过 2 亮红灯', () => {
    const root = makeRoot({
      'package.json': { workspaces: ['packages/*'] },
      'packages/l0/package.json': { name: '@x/l0' },
      'packages/l1/package.json': {
        name: '@x/l1',
        dependencies: { '@x/l0': '1.0.0' },
      },
      'packages/l2/package.json': {
        name: '@x/l2',
        dependencies: { '@x/l1': '1.0.0' },
      },
      'packages/l3/package.json': {
        name: '@x/l3',
        dependencies: { '@x/l2': '1.0.0' },
      },
    });
    const violations = checkDependencyDirection(root);
    expect(violations).toHaveLength(1);
    expect(violations[0]).toContain('超过最大深度 2');
  });
});
