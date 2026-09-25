#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
 * 与 bin/sweep-nm (sh) / bin/sweep-nm.cmd (cmd) 职责同逻辑 (挑选运行时: Bun 优先, Node 回退),
 * 差异在宿主与本文件多加的入口选择 (优先跑编译产物 dist/cli.js, 无产物则回退源码 src/cli.ts;
 * 包内只有产物, 开发态通常无产物):
 * 本文件同时承担 Unix 与 Windows 的 npm shim 目标 (shebang 必须是 node, 否则
 * npm 的 cmd-shim 会按 shebang 解释器生成 Windows 上不存在的调用)。
 *
 * 产物自证 (审计项「发行面 dist/cli.js 与源码和提交无身份绑定」的运行时防线): 决定跑
 * dist/cli.js 之前必须与随附的 dist/manifest.json 对账 (形状版本受支持, 且清单记的 cliSha256
 * 必须等于实测摘要), 清单缺失 / 损坏 / 版本不支持 / 摘要不符一律拒收产物并给出指引, 不静默回退
 * 源码 (静默回退会把产物漂移藏起来, 包内也没有源码可回退); 拒收指引按宿主分流 (仓库检出态给
 * 源码入口与重构建, 包态给重装本包)。工作树脏净不进本判定 (开发态常脏), 那是发布闸门
 * scripts/verify-release.ts 的职责; 清单字段契约见 scripts/release-artifact.ts (包内无法
 * 跨语言复用该模块, 两边口径由 src/npm-launcher.smoke.test.ts 的集成用例钉住)。
 *
 * 退出码原样透传; 两个运行时都缺席时给出可操作提示并非零退出。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 产物与清单的文件名 (与 scripts/release-artifact.ts 的 CLI_FILE / MANIFEST_FILE 同值) */
const CLI_FILE = 'cli.js';
const MANIFEST_FILE = 'manifest.json';

/** 探测命令是否可执行 (以 --version 的实际退出码为准, 不依赖 shell 内建) */
const available = (command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

/** 挑选运行时: Bun 优先, 其次 Node; 皆无则 null (由调用处报错退出) */
const pickRuntime = () => {
  if (available('bun')) return 'bun';
  if (available('node')) return 'node';
  return null;
};

/**
 * 产物自证: 核对 dist/cli.js 与 dist/manifest.json 的摘要是否同源。
 * 通过返回 null, 否则返回人话原因; 原因串全是本文件固定措辞, 不回显清单内容 (清单是外部
 * 文件, 其文本不受控, 不落进输出面)。
 */
const artifactProblem = (distDir) => {
  const manifestPath = join(distDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return `缺少产物清单 (dist/${MANIFEST_FILE})`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return `产物清单 (dist/${MANIFEST_FILE}) 损坏, 不是合法 JSON`;
  }
  // 形状版本先对: 异版本的字段语义无保证, 宁可拒收 (字面量 1 与 scripts/release-artifact.ts 的
  // MANIFEST_SCHEMA_VERSION 同值, 改动须两处同步; 启动器随包分发, 包内无法 import 该模块)
  if (manifest?.schemaVersion !== 1) {
    return `产物清单 (dist/${MANIFEST_FILE}) 的 schemaVersion 不是受支持的版本 (期望 1)`;
  }
  const recorded = manifest?.cliSha256;
  if (typeof recorded !== 'string') {
    return `产物清单 (dist/${MANIFEST_FILE}) 缺少 cliSha256 字段`;
  }
  let actual;
  try {
    actual = createHash('sha256')
      .update(readFileSync(join(distDir, CLI_FILE)))
      .digest('hex');
  } catch {
    return `产物 (dist/${CLI_FILE}) 读不出来, 摘要算不出`;
  }
  if (recorded !== actual)
    return `产物 (dist/${CLI_FILE}) 的摘要与清单记录不符`;
  return null;
};

const root = dirname(dirname(fileURLToPath(import.meta.url)));
const distDir = join(root, 'dist');
const built = join(distDir, CLI_FILE);
const hasBuilt = existsSync(built);
// 有产物就得先自证 (与随附清单对账); 不通过即拒收, 退出码与「无运行时」同一档: 1
const problem = hasBuilt ? artifactProblem(distDir) : null;
if (problem !== null) {
  // 处置指引按宿主分流: 仓库检出态 (有源码) 可走源码入口或重构建; 包态 (无源码) 只能重装本包
  const advice = existsSync(join(root, 'src', 'cli.ts'))
    ? '用源码入口跑 (bun src/cli.ts 或 node src/cli.ts), 或重新构建 (bun run build)'
    : '重装本包换一份完好分发 (npm install -g @iyowei/sweep-node-modules); 重装无效则说明该版本包有缺陷, 需发布者重新构建后再发';
  process.stderr.write(
    `sweep-nm: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
      `  处置: ${advice}。\n`,
  );
  process.exit(1);
}
// npm 包内是编译产物 (node 拒绝对 node_modules 内的 TS 做类型剥离, 见 package.json 的 build 脚本);
// 仓库开发态无 dist, 回退直跑源码 (bun / node 皆可)
const entry = hasBuilt ? built : join(root, 'src', 'cli.ts');
const runtime = pickRuntime();

if (runtime === null) {
  process.stderr.write('sweep-nm: 未找到 bun 或 node, 请至少安装其一\n');
  process.exit(1);
}

const { status } = spawnSync(runtime, [entry, ...process.argv.slice(2)], {
  stdio: 'inherit',
});

process.exit(status ?? 1);
