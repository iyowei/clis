#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node >= 22.18) 后启动真实入口。
 *
 * 安全防线与进程模型:
 * 1. 运行时解析防劫持: win32 与 POSIX 均按 PATH 解析绝对路径并跳过空/相对条目
 *    (win32 严判盘符或 UNC 绝对路径, 拦截 Git Bash 注入的 `/usr/bin` 盘根相对路径),
 *    绝不从当前被扫目录解析同名 bun/node;
 * 2. Bun 工作目录配置隔离: 选中 Bun 时强制附加 --config=<pkg>/bin/bunfig.toml 与
 *    --no-env-file (隔离配置缺失即报错拒绝, 不静默退回无隔离态), 并透传 CLIS_BUN_ISOLATED=1;
 * 3. 产物自证: 执行 dist/cli.js 前必先与 dist/manifest.json 校验 SHA-256;
 * 4. 零多余派生 + 信号收口: 当前进程已是隔离 Bun 或满足 >= 22.18 的纯 Node 时直接同进程
 *    import 入口 (保留原始 argv[1]); 需跨运行时切换时以异步 spawn 派发, 运行期父进程忽略
 *    SIGINT 防杀父留孤儿, 子进程退出后解挂并透传信号或退出码。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_FILE = 'cli.js';
const MANIFEST_FILE = 'manifest.json';
const WIN32_EXEC_EXTS = ['.com', '.exe'];
const WIN32_ABS_DIR_RE = /^(?:[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/;
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

/** 校验 Node.js 版本是否满足 >= 22.18.0 下限 */
export const isSupportedNodeVersion = (rawVersion) => {
  if (typeof rawVersion !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)/.exec(rawVersion.trim());
  if (match === null) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  );
};

/** 判定解析出的运行时是否为 Bun */
const isBunRuntime = (runtime) => {
  const name = basename(runtime).toLowerCase();
  return name === 'bun' || name === 'bun.exe' || name === 'bun.com';
};

/** 探测命令是否可执行 (Bun 看退出码 0, Node 另校验 >= 22.18.0) */
const available = (command) => {
  const res = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return false;
  if (isBunRuntime(command)) return true;
  return isSupportedNodeVersion(res.stdout);
};

/** 路径处是否为普通文件 */
const isFileAt = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** 在 PATH 中解析命令的全部候选绝对路径 (win32 语义), 严格拦截空、相对与盘根相对条目 */
export const resolveWin32Executables = (name, pathEnv, fileProbe) => {
  const found = [];
  for (const raw of pathEnv.split(';')) {
    const trimmed = raw.trim();
    const unquoted =
      trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).trim()
        : trimmed;
    if (unquoted === '' || !WIN32_ABS_DIR_RE.test(unquoted)) continue;
    for (const ext of WIN32_EXEC_EXTS) {
      const candidate = win32.join(unquoted, name + ext);
      if (fileProbe(candidate)) found.push(candidate);
    }
  }
  return found;
};

/** 在 PATH 中解析命令的全部候选绝对路径 (POSIX 语义), 跳过空与相对条目 */
export const resolvePosixExecutables = (name, pathEnv, fileProbe) => {
  const found = [];
  for (const dir of pathEnv.split(':')) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = posix.join(dir, name);
    if (fileProbe(candidate)) found.push(candidate);
  }
  return found;
};

/** 挑选运行时: 缺省 Bun 优先、其次 Node (>= 22.18); 皆无则 null */
export const pickRuntime = ({
  platform = process.platform,
  pathEnv = process.env.PATH ?? process.env.Path ?? '',
  fileProbe = isFileAt,
  probe = available,
  names = ['bun', 'node'],
} = {}) => {
  for (const name of names) {
    const candidates =
      platform === 'win32'
        ? resolveWin32Executables(name, pathEnv, fileProbe)
        : resolvePosixExecutables(name, pathEnv, fileProbe);
    for (const candidate of candidates) {
      if (probe(candidate)) return candidate;
    }
  }
  return null;
};

/** 产物自证: 核对 dist/cli.js 与 dist/manifest.json 的摘要是否同源 */
const artifactProblem = (distDir) => {
  const manifestPath = join(distDir, MANIFEST_FILE);
  if (!existsSync(manifestPath)) return `缺少产物清单 (dist/${MANIFEST_FILE})`;
  let manifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  } catch {
    return `产物清单 (dist/${MANIFEST_FILE}) 损坏, 不是合法 JSON`;
  }
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
  if (recorded !== actual) {
    return `产物 (dist/${CLI_FILE}) 的摘要与清单记录不符`;
  }
  return null;
};

/** 本文件是否作为入口被直接执行 (双端 realpath.native 展开 win32 8.3 短路径 + 大小写归一) */
const isEntry = () => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (norm(entry) === norm(self)) return true;
  try {
    const realpath = realpathSync.native ?? realpathSync;
    const realSelf = realpath(self);
    return norm(realpath(entry)) === norm(realSelf);
  } catch {
    return false;
  }
};

/** 跨运行时异步派生子进程: 运行期父进程忽略 SIGINT 防孤儿, 退出后卸载监听并透传信号或退出码 */
const runChild = (command, args, extraEnv) =>
  new Promise((resolve) => {
    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    const cleanup = () => {
      process.off('SIGINT', ignoreSigint);
    };
    child.on('error', (error) => {
      cleanup();
      process.stderr.write(`sweep-nm: 启动运行时失败 (${error.message})\n`);
      process.exit(1);
    });
    child.on('exit', (code, signal) => {
      cleanup();
      if (signal) {
        try {
          process.kill(process.pid, signal);
        } catch {
          process.exit(1);
        }
        resolve();
        return;
      }
      process.exit(code ?? 1);
    });
  });

const main = async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const built = join(distDir, CLI_FILE);
  const source = join(root, 'src', 'cli.ts');
  const hasBuilt = existsSync(built);
  const hasSource = existsSync(source);

  if (!hasBuilt && !hasSource) {
    process.stderr.write(
      `sweep-nm: 缺少可执行入口 (dist/${CLI_FILE} 与 src/cli.ts 均不存在)。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g @iyowei/sweep-node-modules-cli); 本仓开发态请先执行 bun run build。\n',
    );
    process.exit(1);
  }

  const problem = hasBuilt ? artifactProblem(distDir) : null;
  if (problem !== null) {
    const advice = hasSource
      ? '用源码入口跑 (bun packages/sweep-node-modules-cli/src/cli.ts 或 node packages/sweep-node-modules-cli/src/cli.ts), 或重新构建 (bun run build)'
      : '重装本包换一份完好分发 (npm install -g @iyowei/sweep-node-modules-cli); 重装无效则说明该版本包有缺陷, 需发布者重新构建后再发';
    process.stderr.write(
      `sweep-nm: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
        `  处置: ${advice}。\n`,
    );
    process.exit(1);
  }

  const entry = hasBuilt ? built : source;
  const isolatedBunfig = join(root, 'bin', 'bunfig.toml');
  const ensureIsolatedBunfig = () => {
    if (existsSync(isolatedBunfig)) return;
    process.stderr.write(
      'sweep-nm: 缺少启动器隔离配置 (bin/bunfig.toml), 为防工作目录 bunfig.toml 劫持已拒绝执行。\n',
    );
    process.exit(1);
  };

  // 由本地壳以 --config/--no-env-file 拉起并透传 CLIS_BUN_ISOLATED=1 的 Bun 进程: 同进程直接 import
  if (
    typeof process.versions.bun === 'string' &&
    process.env.CLIS_BUN_ISOLATED === '1'
  ) {
    ensureIsolatedBunfig();
    await import(pathToFileURL(entry).href);
    return;
  }

  const isCurrentNodeSupported =
    typeof process.versions.bun !== 'string' &&
    isSupportedNodeVersion(process.versions.node);

  // 当前进程已是合格 Node 时仅探 Bun: 命中切 Bun, 未命中直接同进程 import (零额外派生)
  const runtime = pickRuntime(
    isCurrentNodeSupported ? { names: ['bun'] } : undefined,
  );
  if (runtime !== null && isBunRuntime(runtime)) {
    ensureIsolatedBunfig();
    await runChild(
      runtime,
      [
        `--config=${isolatedBunfig}`,
        '--no-env-file',
        entry,
        ...process.argv.slice(2),
      ],
      { CLIS_BUN_ISOLATED: '1' },
    );
    return;
  }

  if (isCurrentNodeSupported) {
    await import(pathToFileURL(entry).href);
    return;
  }

  if (runtime !== null) {
    await runChild(runtime, [entry, ...process.argv.slice(2)]);
    return;
  }

  process.stderr.write(
    `sweep-nm: 未找到可用的 bun 或 node (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0; 当前 node 为 ${process.versions.node ?? '未知'})\n`,
  );
  process.exit(1);
};

if (isEntry()) {
  await main();
}
