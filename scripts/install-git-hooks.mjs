#!/usr/bin/env node
/**
 * 装 git 钩子 (package.json 的 prepare 入口).
 *
 * 守卫: 只在「本包自身的 git 仓库」执行 `lefthook install`.
 *
 * 为什么需要守卫: prepare 在本包被作为依赖安装时也会在宿主环境执行 (git 依赖的克隆态、
 * vendor / 本地路径依赖形态), 而 `lefthook install` 以「当前目录所在的 git 仓库」为目标;
 * 一旦包目录落在宿主仓库树内 (vendor 进宿主仓库、或经 install-links 落进 node_modules),
 * 安装动作就会把钩子写进宿主仓库的 .git/hooks (消费者仓库被写 VCS 配置, 与消费者本意无关).
 * 判定用「cwd 所在 git 根 === 包根」: 是本包仓库才装, 否则整支跳过.
 *
 * 各形态的判定结果:
 *   - 仓库检出态 (本包开发): 两者相同 → 装;
 *   - git 依赖的临时克隆态: 两者相同 → 装 (落在一次性克隆目录, 无副作用);
 *   - vendor / 解包进宿主仓库的子目录: git 根是宿主 → 跳过;
 *   - 经 npm install-links 落进宿主 node_modules: git 根是宿主 → 跳过;
 *   - 不在任何 git 仓库内 (tarball 解包目录等): git 根不可得 → 跳过.
 *
 * 安装期取用 lefthook 的顺序: PATH 上的 lefthook → lefthook.yml 的 `lefthook:` 配置值
 * (经 bunx 取 pin 版; 与执行期钩子模板同源, 单一事实来源). lefthook 不列为依赖, 以免宿主
 * 安装本包时连带装 lefthook 并触发它的 postinstall 往宿主仓库写钩子.
 * 执行期由 lefthook.yml 的 `lefthook:` + `assert_lefthook_installed` 保证「兜底可取且失败响亮」
 * (官方模板探测链不含 bunx, 且默认静默放行 —— 见 ADR 0005 决策第 1 条).
 *
 * 任何失败都不阻断安装: 装钩子是便利动作, 不是安装的必要条件 (与原 `|| true` 形态一致).
 */
import { spawnSync } from 'node:child_process';
import { readFileSync, realpathSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 包根: 本脚本位于 <pkg>/scripts/ 下, 上溯一级 */
const PKG_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const IS_WINDOWS = process.platform === 'win32';

/** 统一 spawn 封装: Windows 上 .cmd/.bat 需经 shell 解析 */
const run = (cmd, args, options = {}) =>
  spawnSync(cmd, args, { shell: IS_WINDOWS, ...options });

/** 命令是否可用 (以 `--version` 探测, 不存在时 status 为 null) */
const hasCommand = (cmd) =>
  run(cmd, ['--version'], { stdio: 'ignore' }).status === 0;

/** 取真实路径用于比较 (路径不可解析时回退原值) */
const realpathOr = (value) => {
  try {
    return realpathSync(value);
  } catch {
    return value;
  }
};

/** 包根所在 git 仓库的根 (不在仓库内或 git 不可用时为 null) */
const gitToplevel = () => {
  const out = run('git', ['rev-parse', '--show-toplevel'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
  });
  return out.status === 0 ? out.stdout.trim() : null;
};

/**
 * 从 lefthook.yml 读执行期的 lefthook 命令 (按空白切分为 argv; 取不到或为空时 null).
 * 单一事实来源: 钩子模板里的兜底命令与安装期取用同出一处, 避免两处各写一个 pin 版本.
 */
const configuredLefthook = () => {
  try {
    const text = readFileSync(join(PKG_ROOT, 'lefthook.yml'), 'utf8');
    const matched = /^lefthook:[ \t]*(\S.*)$/m.exec(text);
    return matched ? matched[1].trim().split(/\s+/) : null;
  } catch {
    return null;
  }
};

const main = () => {
  // CI 下不装: 既不本地跑门禁, 也无交互终端 (与原 prepare 的 CI 短路一致)
  if (process.env.CI) return;

  const toplevel = gitToplevel();
  if (toplevel === null || realpathOr(toplevel) !== realpathOr(PKG_ROOT)) {
    // 被作为依赖安装且落点不在本包自己的仓库 → 目标是宿主仓库, 不碰
    return;
  }

  // 取用顺序: PATH 上的 lefthook (最快, 开发机常见) → lefthook.yml 的配置命令 (经 bunx 取 pin 版)
  let argv = null;
  if (hasCommand('lefthook')) {
    argv = ['lefthook'];
  } else {
    const configured = configuredLefthook();
    if (configured !== null && hasCommand(configured[0])) argv = configured;
  }

  if (argv === null) {
    console.error(
      '[prepare] 未找到 lefthook, 已跳过钩子安装; 稍后可手动补装 (如 brew install lefthook) 再跑 lefthook install',
    );
    return;
  }

  const result = run(argv[0], [...argv.slice(1), 'install'], {
    cwd: PKG_ROOT,
    stdio: 'inherit',
  });
  if (result.status !== 0) {
    console.error(
      '[prepare] lefthook 装钩子未成功, 已跳过; 稍后可手动补跑 lefthook install',
    );
  }
};

try {
  main();
} catch {
  // 装钩子失败不阻断依赖安装 (与原 `|| true` 形态一致); 具体原因交给手动补跑时暴露
  console.error(
    '[prepare] 装钩子跳过 (执行期异常); 稍后可手动补跑 lefthook install',
  );
}
