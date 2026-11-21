#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node >= 22.18.0) 后启动真实入口 (只认构建产物)。
 *
 * 安全与进程模型防线:
 * 1. 运行时解析防劫持: win32 严格按盘符/UNC 绝对路径正则过滤 PATH (拦截 /usr/bin 盘根相对路径与 cwd 劫持),
 *    返回全部候选数组逐一 probe; POSIX 仅按 `/` 开头绝对 PATH 解析;
 * 2. Bun 工作目录配置隔离: 选中 Bun 时强制附加 --config=<pkg>/bin/bunfig.toml 与
 *    --no-env-file (缺失隔离配置即拒绝); 经壳启动器透传 CLIS_BUN_ISOLATED=1 且当前已是 Bun 时同进程 import;
 * 3. 纯 Node 同进程零套娃: 无可用 Bun 且当前 Node >= 22.18.0 时直接同进程 import, 跨运行时切换时异步 spawn
 *    并隔离父进程 SIGINT 防孤儿进程, 信号终止按 POSIX 语义自杀回传;
 * 4. 产物自证: 执行 dist/create-clis.js 前必先与 dist/manifest.json 校验 SHA-256。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_FILE = 'create-clis.js';
const MANIFEST_FILE = 'manifest.json';
const WIN32_EXEC_EXTS = ['.com', '.exe'];
const WIN32_ABS_DIR_RE = /^(?:[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/;
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;

/** 校验 Node.js 版本是否满足 >= 22.18.0 下限 */
export const isSupportedNodeVersion = (rawVersion) => {
  if (typeof rawVersion !== 'string') return false;
  const match = /^v?(\d+)\.(\d+)/.exec(rawVersion.trim());
  if (!match) return false;
  const major = Number(match[1]);
  const minor = Number(match[2]);
  return (
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  );
};

const isBunRuntime = (runtime) => {
  const name = basename(runtime).toLowerCase();
  return name === 'bun' || name === 'bun.exe' || name === 'bun.com';
};

const available = (command) => {
  const res = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return false;
  if (isBunRuntime(command)) return true;
  return isSupportedNodeVersion(res.stdout);
};

const isFileAt = (filePath) => {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
};

export const resolveWin32Executables = (name, pathEnv, fileProbe) => {
  const found = [];
  const seen = new Set();
  for (const raw of pathEnv.split(';')) {
    const trimmed = raw.trim();
    const dir =
      trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).trim()
        : trimmed;
    if (dir === '' || !WIN32_ABS_DIR_RE.test(dir)) continue;
    for (const ext of WIN32_EXEC_EXTS) {
      const candidate = win32.join(dir, name + ext);
      const key = candidate.toLowerCase();
      if (seen.has(key)) continue;
      if (fileProbe(candidate)) {
        seen.add(key);
        found.push(candidate);
      }
    }
  }
  return found;
};

export const resolvePosixExecutables = (name, pathEnv, fileProbe) => {
  const found = [];
  const seen = new Set();
  for (const dir of pathEnv.split(':')) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = posix.join(dir, name);
    if (seen.has(candidate)) continue;
    if (fileProbe(candidate)) {
      seen.add(candidate);
      found.push(candidate);
    }
  }
  return found;
};

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

const realpath = realpathSync.native ?? realpathSync;

const normalizeEntryPath = (p, platform = process.platform) => {
  let normalized = resolve(p);
  try {
    normalized = realpath(normalized);
  } catch {
    // realpath 不可用时保留规范绝对路径做字面比对
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export const isEntry = (
  entryArg = process.argv[1],
  selfUrl = import.meta.url,
  platform = process.platform,
) => {
  if (typeof entryArg !== 'string' || entryArg === '') return false;
  const self = fileURLToPath(selfUrl);
  return (
    normalizeEntryPath(entryArg, platform) ===
    normalizeEntryPath(self, platform)
  );
};

/** 跨运行时异步派生并隔离父进程 SIGINT, settled 防重入, 防止 Ctrl+C 先杀父进程留下孤儿进程 */
const runChild = (command, args, extraEnv) =>
  new Promise((resolveExit) => {
    const onSigint = () => {};
    process.on('SIGINT', onSigint);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let settled = false;
    const finish = (result) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', onSigint);
      resolveExit(result);
    };
    child.once('error', (error) => {
      process.stderr.write(`create-clis: 启动运行时失败 (${error.message})\n`);
      finish({ status: 1, signal: null });
    });
    child.once('close', (code, signal) => {
      finish({ status: code, signal });
    });
  });

const finishChild = (result) => {
  if (result.signal) {
    try {
      process.kill(process.pid, result.signal);
    } catch {
      process.exit(1);
    }
    return;
  }
  process.exit(result.status ?? 1);
};

const main = async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const entry = join(distDir, CLI_FILE);
  const isolatedBunfig = join(root, 'bin', 'bunfig.toml');

  if (!existsSync(entry)) {
    process.stderr.write(
      `create-clis: 缺少产物 (dist/${CLI_FILE} 不存在), 本入口只认构建产物, 无源码回退。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g create-clis);' +
        ' 本仓开发态请先跑构建 (bun run build)。\n',
    );
    process.exit(1);
  }
  const problem = artifactProblem(distDir);
  if (problem !== null) {
    process.stderr.write(
      `create-clis: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g create-clis);' +
        ' 重装无效则说明该版本包有缺陷, 需发布者重新构建后再发。\n',
    );
    process.exit(1);
  }

  const ensureIsolatedBunfig = () => {
    if (existsSync(isolatedBunfig)) return;
    process.stderr.write(
      'create-clis: 缺少启动器隔离配置 (bin/bunfig.toml), 为防工作目录 bunfig.toml 劫持已拒绝执行。\n',
    );
    process.exit(1);
  };

  // 当前已是 Bun: 隔离态直接同进程 import, 非隔离态直接用 process.execPath 重派隔离态 Bun (不扫 PATH)
  if (typeof process.versions.bun === 'string') {
    ensureIsolatedBunfig();
    if (process.env.CLIS_BUN_ISOLATED === '1') {
      await import(pathToFileURL(entry).href);
      return;
    }
    const result = await runChild(
      process.execPath,
      [
        `--config=${isolatedBunfig}`,
        '--no-env-file',
        entry,
        ...process.argv.slice(2),
      ],
      { CLIS_BUN_ISOLATED: '1' },
    );
    finishChild(result);
    return;
  }

  const bunRuntime = pickRuntime({ names: ['bun'] });
  if (bunRuntime !== null) {
    ensureIsolatedBunfig();
    const result = await runChild(
      bunRuntime,
      [
        `--config=${isolatedBunfig}`,
        '--no-env-file',
        entry,
        ...process.argv.slice(2),
      ],
      { CLIS_BUN_ISOLATED: '1' },
    );
    finishChild(result);
    return;
  }

  // 无 Bun 时: 若当前 Node 满足 >= 22.18.0 则同进程加载产物 (消除 3 进程套娃并保留原始 argv)
  if (isSupportedNodeVersion(process.versions.node)) {
    await import(pathToFileURL(entry).href);
    return;
  }

  const nodeRuntime = pickRuntime({ names: ['node'] });
  if (nodeRuntime !== null) {
    const result = await runChild(nodeRuntime, [
      entry,
      ...process.argv.slice(2),
    ]);
    finishChild(result);
    return;
  }

  process.stderr.write(
    `create-clis: 未找到可用的 bun 或 node (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0; 当前 node 为 ${process.versions.node ?? '未知'})\n`,
  );
  process.exit(1);
};

if (isEntry()) {
  await main();
}
