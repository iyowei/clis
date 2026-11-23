#!/usr/bin/env node
/**
 * 装 git 钩子 (根 package.json 的 prepare 入口; 仅在本包自身 git 仓库执行 `lefthook install`)。
 *
 * 关键约束:
 * - 守卫判据: 以 `PKG_ROOT` 为 cwd 查 `git rev-parse --show-toplevel`, 仅当结果与 `PKG_ROOT`
 *   真实路径一致时才装钩子, 防止本包以 vendor / 本地路径依赖装入宿主仓库时误写宿主 `.git/hooks`;
 * - 各形态判定: 仓库检出态 / git 依赖临时克隆态 -> 装; vendor / install-links 落宿主树 / 非 git 目录 -> 跳过;
 * - 取用顺序: PATH 上的 `lefthook` -> `lefthook.yml` 的 `lefthook:` 配置命令 (经 bunx 取 pin 版,
 *   与执行期模板同源; lefthook 不列为依赖, 避免其 postinstall 污染宿主仓库);
 * - 容错: CI 跳过; 任何失败仅打印提示不阻断安装 (与 prepare 的 `|| exit 0` 兜底一致)。
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

const realpathNative = realpathSync.native ?? realpathSync;

/** 取真实路径用于比较 (优先 realpathSync.native 展开 Windows 8.3 短路径; 路径不可解析时回退原值) */
const realpathOr = (value) => {
  try {
    return realpathNative(value);
  } catch {
    return value;
  }
};

/** 清洗宿主 GIT_* 环境变量: 防止外层 git 钩子或子模块环境把 rev-parse 改道到别的仓库 */
const cleanGitEnv = () => {
  const env = {};
  for (const [key, value] of Object.entries(process.env)) {
    if (!key.startsWith('GIT_') && value !== undefined) env[key] = value;
  }
  return env;
};

/** 包根所在 git 仓库的根 (不在仓库内或 git 不可用时为 null) */
const gitToplevel = () => {
  const out = run('git', ['rev-parse', '--show-toplevel'], {
    cwd: PKG_ROOT,
    encoding: 'utf8',
    env: cleanGitEnv(),
  });
  return out.status === 0 ? out.stdout.trim() : null;
};

/**
 * 从 lefthook.yml 读执行期的 lefthook 命令 (按空白切分为 argv; 取不到或为空时 null)。
 * 单一事实来源: 钩子模板里的兜底命令与安装期取用同出一处, 避免两处各写一个 pin 版本。
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
  // 装钩子失败不阻断依赖安装 (与 prepare 的 `|| exit 0` 兜底一致); 具体原因交给手动补跑时暴露
  console.error(
    '[prepare] 装钩子跳过 (执行期异常); 稍后可手动补跑 lefthook install',
  );
}
