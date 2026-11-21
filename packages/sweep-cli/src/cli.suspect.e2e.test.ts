/**
 * cli 端到端契约 (安装树面): 默认排除名单 / 疑似安装树的预览标记与删除跳过 / `--force` 放行。
 * 与 cli.e2e.test.ts 同款双载体参数化; 按主题独立成文件 (那份已触 lint 的 max-lines 上限,
 * 且本组用例共用同一 fixture 形态与写法, 自成一册比继续堆叠更清楚)。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import type { Workspace } from '@iyowei/sweep/testing';

import {
  RUNNER_AVAILABILITY,
  createWorkspaceTracker,
  runCli,
  writeConfig,
} from './cli.e2e.fixtures.ts';

const { make, cleanup } = createWorkspaceTracker();
afterEach(cleanup);

/** 只写 roots 与 node 预设的 v2 配置 (省略 exclude 字段 → 继承 32 项内置默认安全护栏) */
function writeRootsOnlyConfig(workspace: Workspace): string {
  const file = join(workspace.root, 'sweep-roots-only.json');
  writeFileSync(
    file,
    JSON.stringify({
      version: 2,
      roots: [workspace.root],
      presets: { node: {} },
    }),
  );
  return file;
}

/** 安装树面的用例组, 逐 runner 注册 */
function defineSuspectCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 安装树面 (默认排除 / 疑似跳过 / --force)`, () => {
    test.skipIf(!available)(
      '默认排除名单: 配置未写 exclude 字段时, 安装树目录不进清单',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'app' }, { dir: '.npm/_npx/abc123' }],
        });
        const config = writeRootsOnlyConfig(workspace);

        const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

        expect(result.status).toBe(0);
        expect(result.stdout).toContain('app');
        expect(result.stdout).not.toContain('abc123');
        // 默认名单项零命中不告警: 名单依平台与用户环境而异 (如 Linux 上没有 Library), 不是拼写错误
        expect(result.stderr).not.toContain('排除名未命中');
      },
    );

    test.skipIf(!available)(
      '疑似安装树 (预览): 路径保留 node_modules 后缀并标注理由, 末行之下给跳过计数',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'app' }, { dir: 'pkg/lib' }],
        });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, [], { env: { SWEEP_CONFIG: config } });

        expect(result.status).toBe(0);
        // 剥离后缀会把安装树显示成项目 (/pkg/lib), 保留后缀是唯一的类别线索
        expect(result.stdout).toContain(
          join(workspace.root, 'pkg', 'lib', 'node_modules'),
        );
        expect(result.stdout).toContain('疑似安装树: 父目录为 lib');
        expect(result.stdout).toContain(
          '疑似安装树 1 处默认跳过 (加 --force 一并清理)',
        );
        // 预览零副作用: 两处目标都还在
        expect(
          existsSync(join(workspace.root, 'pkg', 'lib', 'node_modules')),
        ).toBe(true);
        expect(existsSync(join(workspace.root, 'app', 'node_modules'))).toBe(
          true,
        );
      },
    );

    test.skipIf(!available)(
      '疑似安装树默认不进删除批: 报告说明跳过, 目标留存, 退出码 1',
      async () => {
        const workspace = await make({
          projects: [{ dir: 'app' }, { dir: 'pkg/lib' }],
        });
        const config = writeConfig(workspace, [workspace.root]);

        const result = runCli(runner, ['--yes'], {
          env: { SWEEP_CONFIG: config },
        });

        expect(result.status).toBe(1);
        // 行尾既标类别也标动作结果; 末行之下给整份清单的跳过计数与放行通道
        expect(result.stdout).toContain(
          '疑似安装树: 父目录为 lib, 形如版本管理器的 node 安装树',
        );
        expect(result.stdout).toContain('已跳过 (加 --force 一并清理)');
        expect(result.stdout).toContain('疑似安装树 1 处默认跳过');
        expect(
          existsSync(join(workspace.root, 'pkg', 'lib', 'node_modules')),
        ).toBe(true);
        expect(existsSync(join(workspace.root, 'app', 'node_modules'))).toBe(
          false,
        );
      },
    );

    test.skipIf(!available)('--force 放行: 疑似安装树进入删除批', async () => {
      const workspace = await make({
        projects: [{ dir: 'app' }, { dir: 'pkg/lib' }],
      });
      const config = writeConfig(workspace, [workspace.root]);

      const result = runCli(runner, ['--yes', '--force'], {
        env: { SWEEP_CONFIG: config },
      });

      expect(result.status).toBe(0);
      expect(result.stdout).not.toContain('默认跳过');
      expect(
        existsSync(join(workspace.root, 'pkg', 'lib', 'node_modules')),
      ).toBe(false);
      expect(existsSync(join(workspace.root, 'app', 'node_modules'))).toBe(
        false,
      );
    });
  });
}

for (const { runner, available } of RUNNER_AVAILABILITY) {
  defineSuspectCases(runner, available);
}
