/**
 * CLI 端到端测试共享夹具: 收拢 6 个 cli.*.e2e.test.ts 的重复底座
 * (CLI 入口路径 / 双运行时探测 / runCli 环境隔离与超时 / writeConfig / 工作区生命周期管理)。
 */
import { spawnSync } from 'node:child_process';
import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  type Workspace,
  type WorkspaceSpec,
  makeWorkspace,
} from '@iyowei/sweep-node-modules/testing';

/** CLI 源码入口绝对路径 (双运行时 bun / node 直跑) */
export const CLI = fileURLToPath(new URL('./cli.ts', import.meta.url));

/** 双载体参数化列表 */
export const RUNNERS = ['bun', 'node'] as const;

/** 统一子进程超时 (毫秒) */
export const CLI_TIMEOUT_MS = 10_000;

/** 探测各运行时是否可用 (统一带超时守卫, 避免探测挂死) */
export const RUNNER_AVAILABILITY: ReadonlyArray<{
  runner: (typeof RUNNERS)[number];
  available: boolean;
}> = RUNNERS.map((runner) => ({
  runner,
  available:
    spawnSync(runner, ['-v'], { timeout: CLI_TIMEOUT_MS }).status === 0,
}));

export interface RunCliOptions {
  cwd?: string;
  /** 额外环境变量 (默认注入 NO_COLOR 以稳定降级纯文本断言; 降级用例传 noColor: false) */
  env?: Record<string, string>;
  noColor?: boolean;
  timeoutMs?: number;
}

/**
 * 跑一次 CLI: 宿主变量不得泄漏进用例 (SWEEP_NM_CONFIG 一律先清, 需要时经 options.env 显式传入),
 * 缺省固定 NO_COLOR=1 稳定断言面, 统一带超时守卫。
 */
export function runCli(
  runner: string,
  args: string[],
  options: RunCliOptions = {},
) {
  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
  };
  delete env.SWEEP_NM_CONFIG;
  if (options.env?.HOME !== undefined) {
    // Windows 下 os.homedir() 读 USERPROFILE、默认配置读 APPDATA: 隔离 HOME 时一并收口
    env.USERPROFILE = options.env.HOME;
    env.APPDATA = join(options.env.HOME, 'AppData', 'Roaming');
  }
  Object.assign(env, options.env);
  if (options.noColor === false) {
    delete env.NO_COLOR;
  } else {
    env.NO_COLOR = '1';
  }
  return spawnSync(runner, [CLI, ...args], {
    encoding: 'utf8',
    cwd: options.cwd,
    env,
    timeout: options.timeoutMs ?? CLI_TIMEOUT_MS,
  });
}

/** 写配置文件 (缺省 exclude / include 显式写空数组 = 用户接管, 内置默认名单不参与) */
export function writeConfig(
  workspace: Workspace,
  roots: string[],
  exclude: string[] = [],
  include: string[] = [],
): string {
  const file = join(workspace.root, 'sweep-config.json');
  writeFileSync(file, JSON.stringify({ roots, exclude, include }));
  return file;
}

/**
 * 工作区生命周期管理钩子: 每份 e2e 文件独立实例化, afterEach 调用 cleanup 即可统一清理并复位数组。
 */
export function createWorkspaceTracker(): {
  make(spec: WorkspaceSpec): Promise<Workspace>;
  cleanup(): Promise<void>;
} {
  const workspaces: Workspace[] = [];
  return {
    async make(spec: WorkspaceSpec): Promise<Workspace> {
      const workspace = await makeWorkspace(spec);
      workspaces.push(workspace);
      return workspace;
    },
    async cleanup(): Promise<void> {
      try {
        await Promise.all(workspaces.map((workspace) => workspace.cleanup()));
      } finally {
        workspaces.length = 0;
      }
    },
  };
}
