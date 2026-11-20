/**
 * generateProject 模块面契约 (hooks 调度与二道自检; 与 cli.e2e.test.ts 独立分文件守 max-lines 门禁)。
 */
import { afterAll, afterEach, describe, expect, test } from 'bun:test';

import { cpSync, existsSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { buildTemplate } from '../scripts/build-template.ts';
import { REPO_ROOT } from '../scripts/template-manifest.ts';
import { type GenerateHooks, generateProject } from './generate.ts';
import { type Vocabulary } from './render.ts';
import { ORIGINAL } from './template-snapshot.ts';

const TIMEOUT_MS = 120_000;
const RM_OPTS = {
  recursive: true,
  force: true,
  maxRetries: 5,
  retryDelay: 100,
};

const HOOK_VOCABULARY: Vocabulary = {
  name: 'hook-tool',
  scope: '',
  binName: 'hook-tool',
  owner: 'demouser',
  repoUrl: 'https://github.com/demouser/hook-tool',
};

const TEMPLATE_ROOT = makeTmpRoot('create-clis-gen-tpl-');
const TEMPLATE_DIR = join(TEMPLATE_ROOT, 'template');
buildTemplate({
  repoRoot: REPO_ROOT,
  outDir: TEMPLATE_DIR,
  original: ORIGINAL,
});

afterAll(() => rmSync(TEMPLATE_ROOT, RM_OPTS));

const createdRoots: string[] = [];
afterEach(() => {
  for (const root of createdRoots.splice(0)) rmSync(root, RM_OPTS);
});

function makeTarget(label: string): string {
  const root = makeTmpRoot(`create-clis-gen-${label}-`);
  createdRoots.push(root);
  return join(root, 'proj');
}

interface RunGenerateOverrides {
  hooks?: GenerateHooks;
  vocabulary?: Vocabulary;
  templateDir?: string;
}

function runGenerate(
  targetDir: string,
  overrides: RunGenerateOverrides = {},
): Promise<{ executed: string[] }> {
  return generateProject({
    templateDir: overrides.templateDir ?? TEMPLATE_DIR,
    targetDir,
    vocabulary: overrides.vocabulary ?? HOOK_VOCABULARY,
    tier: 'core',
    original: ORIGINAL,
    hooks: overrides.hooks,
  });
}

describe('generateProject hooks 调度', () => {
  test(
    'hooks 按执行序执行并如实记录; 未提供的 hook 跳过',
    async () => {
      const target = makeTarget('hooks');
      const calls: string[] = [];
      const result = await runGenerate(target, {
        hooks: {
          gitInit: () => {
            calls.push('git');
          },
          install: async () => {
            calls.push('install');
          },
        },
      });

      expect(calls).toEqual(['git', 'install']);
      expect(result.executed).toEqual(['git init', '依赖安装']);

      // 未提供的动作不执行 (--no-git / --no-install 的折算语义)
      const secondTarget = makeTarget('hooks-skip');
      const skipped = await runGenerate(secondTarget, {
        hooks: {
          install: () => {
            calls.push('install-only');
          },
        },
      });
      expect(calls).toEqual(['git', 'install', 'install-only']);
      expect(skipped.executed).toEqual(['依赖安装']);

      // 抛错即中止: 后续 hook 不执行, 半成品保留 (产物已完整生成, 失败发生在收尾面)
      const thirdTarget = makeTarget('hooks-fail');
      const failing = runGenerate(thirdTarget, {
        hooks: {
          gitInit: () => {
            throw new Error('boom');
          },
          install: () => {
            calls.push('must-not-run');
          },
        },
      });
      await expect(failing).rejects.toThrow('boom');
      expect(calls).toEqual(['git', 'install', 'install-only']);
      expect(existsSync(join(thirdTarget, 'package.json'))).toBe(true);
    },
    TIMEOUT_MS,
  );
});

describe('generateProject 二道自检', () => {
  test(
    '变量与原项目词汇取值重合 (owner 同为本仓 owner): 不误报残留',
    async () => {
      const target = makeTarget('overlap');
      const overlap: Vocabulary = {
        ...HOOK_VOCABULARY,
        owner: ORIGINAL.owner,
        repoUrl: `https://github.com/${ORIGINAL.owner}/hook-tool`,
      };
      await expect(
        runGenerate(target, { vocabulary: overlap }),
      ).resolves.toEqual({ executed: [] });
      expect(existsSync(join(target, 'package.json'))).toBe(true);
    },
    TIMEOUT_MS,
  );

  test(
    '模板残留原词汇: 抛错且保留半成品 (写入后失败)',
    async () => {
      const target = makeTarget('residual');
      // 改坏模板: 塞入生成期不替换的原词汇形态, 制造二道自检的失败输入
      const broken = join(dirname(target), 'template-broken');
      cpSync(TEMPLATE_DIR, broken, { recursive: true });
      writeFileSync(
        join(broken, 'scripts/leftover.txt'),
        'sweep-node-modules\n',
      );

      const failure = runGenerate(target, { templateDir: broken });
      await expect(failure).rejects.toThrow('二道自检未过');
      // 半成品保留: 失败发生在写入之后, 产物与触发残留的文件都在
      expect(existsSync(join(target, 'scripts/leftover.txt'))).toBe(true);
    },
    TIMEOUT_MS,
  );
});
