#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
 * 与 bin/create-clis (sh) / bin/create-clis.cmd (cmd) 职责同逻辑 (挑选运行时: Bun 优先, Node
 * 回退), 差异在本文件是 npm 的 bin 目标: 本文件同时承担 Unix 与 Windows 的 npm shim 目标
 * (shebang 必须是 node, 否则 npm 的 cmd-shim 会按 shebang 解释器生成 Windows 上不存在的调用)。
 *
 * 只认产物 (与既有 CLI 包启动器的一处刻意差异): 生成器无源码回退: 入口恒为
 * dist/create-clis.js, 产物缺失即报错退出。生成器随包发售的是产物 + 模板资产 (assets/),
 * 二者缺一不可; 「开发态回退直跑 src/cli.ts」会把发行面缺陷藏起来 (源码在包内并不存在),
 * 仓库开发态请先跑构建 (bun run build)。
 *
 * 运行时解析防劫持 (与 @iyowei/sweep-node-modules-cli 启动器同款处理): Windows 上裸名执行会
 * 先搜当前工作目录 (CreateProcessW 的搜索序里「parent 的当前目录」居第 2 位; 本文件走的 Node
 * spawn 亦然: libuv 的 search_path 以 NeedCurrentDirectoryForExePathW 门控先试 cwd 再扫
 * PATH), 而生成器的调用现场恰是「在用户自己的目录里跑」, 目录内放一个同名 bun.exe / bun.com
 * 即可顶替真实运行时进入执行链。故 win32 下先按 PATH 解析出绝对路径 (空条目与相对条目都会把
 * 解析引回当前目录, 一并跳过) 再探测与执行, 解析面与执行面都不再触发任何搜索序; POSIX 侧同法
 * 收紧 (空与相对条目在 POSIX 下同样意为当前目录), 并保持 execvp「首候选不可执行时继续搜索」的
 * 语义 (逐候选探测)。该逻辑与 sweep-nm 启动器逐行同源, 那边的覆盖率由
 * packages/sweep-node-modules-cli/src/launcher.runtime-resolution.test.ts 钉住; 本包未复制该
 * 测试: 测试要 import 本文件就得带类型投影 (bin/create-clis.d.mts), 而 files 白名单整目录收
 * bin/, 投影会多出一份发行面文件 (白名单契约是 bin 三件)。
 *
 * 产物自证 (发行面 dist/create-clis.js 与源码和提交无身份绑定的运行时防线): 决定跑
 * dist/create-clis.js 之前必须与随附的 dist/manifest.json 对账 (形状版本受支持, 且清单记的
 * cliSha256 必须等于实测摘要), 清单缺失 / 损坏 / 版本不支持 / 摘要不符一律拒收产物并给出指引,
 * 不静默执行 (静默执行会把产物漂移藏起来)。工作树脏净不进本判定 (开发态常脏), 那是发布闸门
 * scripts/verify-release.ts 的职责; 清单字段契约见 scripts/release-artifact.ts (包内无法
 * 跨语言复用该模块, 两边口径由 scripts/write-dist-manifest.test.ts 的钉住用例与两侧注释对齐)。
 *
 * 退出码原样透传; 两个运行时都缺席时给出可操作提示并非零退出。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 产物与清单的文件名 (与 scripts/release-artifact.ts 的 CLI_FILE / MANIFEST_FILE 同值) */
const CLI_FILE = 'create-clis.js';
const MANIFEST_FILE = 'manifest.json';

/**
 * win32 的候选可执行扩展名, 顺序与 Node 实际走的 libuv 搜索一致 (.com 先于 .exe)。
 * 不展开 PATHEXT: .bat / .cmd 无法被 Node 无 shell 直接执行, 展开只会把不可执行的命中当成功;
 * 保持该面与 libuv 等价也意味着本次收紧不改动 win32 上「哪些安装形态能命中」的既有行为。
 */
const WIN32_EXEC_EXTS = ['.com', '.exe'];

/** 探测命令是否可执行 (以 --version 的实际退出码为准, 不依赖 shell 内建) */
const available = (command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

/** 路径处是否为普通文件 (探针读不到即 false, 不抛; 目录名撞上候选名时不得当选) */
const isFileAt = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/**
 * 在 PATH 中解析命令的绝对路径 (win32 语义), 找不到返回 null。
 * 只供 win32 分支调用: CreateProcessW 与 libuv 的裸名搜索序都会先搜当前目录, 本函数把
 * 「当前目录」从解析面整个摘掉: 空条目 (Windows 上表示当前目录) 与相对条目 (同样按当前
 * 目录解析) 一律跳过, 只认绝对目录; 条目两侧的引号按 libuv 同款剥掉 (Windows PATH 允许
 * 引号包裹含空格的目录)。
 */
const resolveWin32Executable = (name, pathEnv, fileProbe) => {
  for (const raw of pathEnv.split(';')) {
    const dir =
      raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    if (dir === '' || !win32.isAbsolute(dir)) continue;
    for (const ext of WIN32_EXEC_EXTS) {
      const candidate = win32.join(dir, name + ext);
      if (fileProbe(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * 在 PATH 中解析命令的全部候选绝对路径 (POSIX 语义, 保持 PATH 顺序), 跳过空条目与相对
 * 条目 (两者在 POSIX 下都按当前目录解析, 属本工具要摘掉的解析面; 与 win32 分支同一理由)。
 * 返回数组而非首命中: 同名文件可能不可执行, execvp 在该情形会继续搜索, 候选交由调用方逐个
 * 探测以保持同一语义。
 */
const resolvePosixExecutables = (name, pathEnv, fileProbe) => {
  const found = [];
  for (const dir of pathEnv.split(':')) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = posix.join(dir, name);
    if (fileProbe(candidate)) found.push(candidate);
  }
  return found;
};

/**
 * 挑选运行时: Bun 优先, 其次 Node; 皆无则 null (由调用处报错退出)。
 * 两个平台都先按 PATH 解析绝对路径再探测 (理由见文件头「运行时解析防劫持」): win32 取
 * 首个解析命中, POSIX 按 PATH 顺序逐个候选探测 (保持 execvp 的继续搜索语义)。
 */
const pickRuntime = () => {
  const platform = process.platform;
  const pathEnv = process.env.PATH ?? '';
  for (const name of ['bun', 'node']) {
    if (platform === 'win32') {
      const resolved = resolveWin32Executable(name, pathEnv, isFileAt);
      if (resolved !== null && available(resolved)) return resolved;
      continue;
    }
    for (const candidate of resolvePosixExecutables(name, pathEnv, isFileAt)) {
      if (available(candidate)) return candidate;
    }
  }
  return null;
};

/**
 * 产物自证: 核对 dist/create-clis.js 与 dist/manifest.json 的摘要是否同源。
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

/**
 * 本文件是否作为入口被直接执行。
 * 经 realpath 比对而非字面路径: npm 在 Unix 上以符号链接 (或经 shim) 落 bin, 此时 argv[1] 是
 * 链接路径而 import.meta.url 是解析后的真实路径。main 守卫只为让「被 import 时不跑主流程」,
 * 判定失配的后果是入口静默不跑, 故除字面相等外只在 realpath 成功时采信。
 */
const isEntry = () => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = fileURLToPath(import.meta.url);
  if (entry === self) return true;
  try {
    return realpathSync(entry) === self;
  } catch {
    return false;
  }
};

const main = () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const entry = join(distDir, CLI_FILE);
  // 生成器只认产物 (无源码回退): 产物缺失即拒, 退出码与「无运行时」同一档: 1
  if (!existsSync(entry)) {
    process.stderr.write(
      `create-clis: 缺少产物 (dist/${CLI_FILE} 不存在), 本入口只认构建产物, 无源码回退。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g create-clis);' +
        ' 本仓开发态请先跑构建 (bun run build)。\n',
    );
    process.exit(1);
  }
  // 有产物就得先自证 (与随附清单对账); 不通过即拒收
  const problem = artifactProblem(distDir);
  if (problem !== null) {
    process.stderr.write(
      `create-clis: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g create-clis);' +
        ' 重装无效则说明该版本包有缺陷, 需发布者重新构建后再发。\n',
    );
    process.exit(1);
  }
  const runtime = pickRuntime();

  if (runtime === null) {
    process.stderr.write('create-clis: 未找到 bun 或 node, 请至少安装其一\n');
    process.exit(1);
  }

  const { status } = spawnSync(runtime, [entry, ...process.argv.slice(2)], {
    stdio: 'inherit',
  });

  process.exit(status ?? 1);
};

if (isEntry()) main();
