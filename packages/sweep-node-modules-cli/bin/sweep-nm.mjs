#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口。
 * 与 bin/sweep-nm (sh) / bin/sweep-nm.cmd (cmd) 职责同逻辑 (挑选运行时: Bun 优先, Node 回退),
 * 差异在宿主与本文件多加的入口选择 (优先跑编译产物 dist/cli.js, 无产物则回退源码 src/cli.ts;
 * 包内只有产物, 开发态通常无产物):
 * 本文件同时承担 Unix 与 Windows 的 npm shim 目标 (shebang 必须是 node, 否则
 * npm 的 cmd-shim 会按 shebang 解释器生成 Windows 上不存在的调用)。
 *
 * 运行时解析防劫持 (安全审计项 runtime-resolution:bare-name-cwd-precedence-windows):
 * Windows 上裸名执行会先搜当前工作目录 (CreateProcessW 的搜索序里「parent 的当前目录」居第 2 位;
 * 本文件走的 Node spawn 亦然 —— libuv 的 search_path 以 NeedCurrentDirectoryForExePathW 门控
 * 先试 cwd 再扫 PATH), 而本工具的调用现场恰是「在被扫目录里执行」, 目录内放一个同名
 * bun.exe / bun.com 即可顶替真实运行时进入执行链。故 win32 下先按 PATH 解析出绝对路径
 * (空条目与相对条目都会把解析引回当前目录, 一并跳过) 再探测与执行, 解析面与执行面都不再
 * 触发任何搜索序; POSIX 侧同法收紧 (空与相对条目在 POSIX 下同样意为当前目录), 并保持
 * execvp「首候选不可执行时继续搜索」的语义 (逐候选探测)。
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
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

/** 产物与清单的文件名 (与 scripts/release-artifact.ts 的 CLI_FILE / MANIFEST_FILE 同值) */
const CLI_FILE = 'cli.js';
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
 * 「当前目录」从解析面整个摘掉 —— 空条目 (Windows 上表示当前目录) 与相对条目 (同样按当前
 * 目录解析) 一律跳过, 只认绝对目录; 条目两侧的引号按 libuv 同款剥掉 (Windows PATH 允许
 * 引号包裹含空格的目录)。注入 pathEnv / fileProbe 供测试在非 win32 宿主上覆盖本函数。
 */
export const resolveWin32Executable = (name, pathEnv, fileProbe) => {
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
 * 条目 (两者在 POSIX 下都按当前目录解析, 属本工具要摘掉的解析面; 与 win32 分支同一理由,
 * 见文件头「运行时解析防劫持」)。返回数组而非首命中: 同名文件可能不可执行, execvp 在
 * 该情形会继续搜索, 候选交由调用方逐个探测以保持同一语义。注入 pathEnv / fileProbe 供
 * 测试在任意宿主上覆盖本函数。
 */
export const resolvePosixExecutables = (name, pathEnv, fileProbe) => {
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
 * 首个解析命中, POSIX 按 PATH 顺序逐个候选探测 (保持 execvp 的继续搜索语义); 各参数
 * 显式传入供测试注入, 生产调用不传。
 */
export const pickRuntime = ({
  platform = process.platform,
  pathEnv = process.env.PATH ?? '',
  fileProbe = isFileAt,
  probe = available,
} = {}) => {
  for (const name of ['bun', 'node']) {
    if (platform === 'win32') {
      const resolved = resolveWin32Executable(name, pathEnv, fileProbe);
      if (resolved !== null && probe(resolved)) return resolved;
      continue;
    }
    for (const candidate of resolvePosixExecutables(name, pathEnv, fileProbe)) {
      if (probe(candidate)) return candidate;
    }
  }
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

/**
 * 本文件是否作为入口被直接执行。
 * 经 realpath 比对而非字面路径: npm 在 Unix 上以符号链接 (或经 shim) 落 bin, 此时 argv[1] 是
 * 链接路径而 import.meta.url 是解析后的真实路径。main 守卫只为让测试 import 本模块取函数时
 * 不触发主流程, 判定失配的后果是入口静默不跑, 故除字面相等外只在 realpath 成功时采信。
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
};

if (isEntry()) main();
