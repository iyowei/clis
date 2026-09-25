/**
 * cli 端到端契约 (根锚点面): 配置里的根为符号链接 (或被祖先链上的符号链接改道) 时,
 * 扫描侧照常 (BC-11 显式即授权)、删除侧整批拒绝 (BC-39)。
 * 与 cli.e2e.test.ts 同款双载体参数化; 按主题独立成文件 (那份已触 lint 的 max-lines 上限,
 * 与本组用例共用的写法同 cli.suspect.e2e.test.ts)。
 * 设计: docs/designs/deletion-guard.md「校验不变量」⑤; 契约: docs/protocol/behavior-contract.md BC-39。
 */
import { afterEach, describe, expect, test } from 'bun:test';

import { spawnSync } from 'node:child_process';
import { existsSync, writeFileSync } from 'node:fs';
import { symlink } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from './fixtures.ts';

const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));
const RUNNERS = ['bun', 'node'];

const workspaces: Workspace[] = [];
async function make(spec: WorkspaceSpec): Promise<Workspace> {
  const workspace = await makeWorkspace(spec);
  workspaces.push(workspace);
  return workspace;
}

afterEach(async () => {
  await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
  workspaces.length = 0;
});

/** 跑一次 CLI: 清宿主 SWEEP_NM_CONFIG, 固定 NO_COLOR (断言面为降级纯文本) */
function runCli(
  runner: string,
  args: string[],
  options: { env?: Record<string, string> } = {},
) {
  const base: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  delete base.SWEEP_NM_CONFIG;
  Object.assign(base, options.env ?? {}, { NO_COLOR: '1' });
  return spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    env: base,
    timeout: 10_000,
  });
}

/** 写配置 (exclude 显式写空数组 = 用户接管, 内置默认名单不参与) */
function writeConfig(workspace: Workspace, roots: string[]): string {
  const file = join(workspace.root, 'sweep-config.json');
  writeFileSync(file, JSON.stringify({ roots, exclude: [], include: [] }));
  return file;
}

/** 根锚点面的用例组, 逐 runner 注册 */
function defineAnchorCases(runner: string, available: boolean): void {
  describe(`cli e2e [${runner}] 根锚点面 (扫描照常 / 删除拒绝)`, () => {
    test.skipIf(!available)(
      '根为符号链接: 预览照常, --yes 拒于根锚点检查且零删除',
      async () => {
        const workspace = await make({ projects: [{ dir: 'real-root/app' }] });
        const link = join(workspace.root, 'link-root');
        await symlink(join(workspace.root, 'real-root'), link);
        const config = writeConfig(workspace, [link]);

        // 扫描侧 (BC-11): 显式写出符号链接根即授权, 预览照常出清单、退 0
        const preview = runCli(runner, ['--config', config]);
        expect(preview.status).toBe(0);
        expect(preview.stdout).toContain('link-root');

        // 删除侧 (BC-39): 信任锚须为真实路径形态, 整批拒绝且零删除
        const execute = runCli(runner, ['--yes', '--config', config]);
        expect(execute.status).toBe(1);
        expect(execute.stderr).toContain('整批拒绝');
        expect(execute.stderr).toContain('根锚点');
        expect(
          existsSync(join(workspace.root, 'real-root', 'app', 'node_modules')),
        ).toBe(true);
      },
    );

    test.skipIf(!available)(
      '根的祖先链被换成符号链接: 删除侧整批拒绝 (根自身经解析仍是真目录)',
      async () => {
        const workspace = await make({ projects: [{ dir: 'elsewhere/work' }] });
        // 根的上一层被换成指向别处的符号链接: 配置拼写的根经解析落在 elsewhere/work
        await symlink(
          join(workspace.root, 'elsewhere'),
          join(workspace.root, 'link-parent'),
        );
        const config = writeConfig(workspace, [
          join(workspace.root, 'link-parent', 'work'),
        ]);

        const execute = runCli(runner, ['--yes', '--config', config]);

        expect(execute.status).toBe(1);
        expect(execute.stderr).toContain('整批拒绝');
        expect(execute.stderr).toContain('根锚点');
        expect(
          existsSync(join(workspace.root, 'elsewhere', 'work', 'node_modules')),
        ).toBe(true);
      },
    );
  });
}

for (const runner of RUNNERS) {
  const available = spawnSync(runner, ['-v']).status === 0;
  defineAnchorCases(runner, available);
}
