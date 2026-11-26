#!/usr/bin/env node
/**
 * CLI 启动器 (bin 入口): 承接三类入口形态 (npm 分发 `dist/cli.js` / 仓内开发回退 `src/cli.ts` /
 * 单测直导导出函数), 挑选运行时 (Bun 优先, 其次 Node >= 22.18) 后启动真实入口。
 *
 * 安全防线与进程模型:
 * 1. 防 cwd 劫持: win32 与 POSIX 均只从 PATH 绝对路径解析可执行文件 (win32 严判盘符或 UNC 绝对路径并仅认
 *    `.com`/`.exe`, 拦截 Git Bash 注入的 `/usr/bin` 盘根相对路径), 绝不从当前工作目录解析同名 bun/node;
 * 2. Bun 工作目录配置隔离: 选中 Bun 时强制附加 `--config=<pkg>/bin/bunfig.toml` 与 `--no-env-file`
 *    (隔离配置缺失即报错拒绝, 不静默退回无隔离态), 并透传 `CLIS_BUN_ISOLATED=1`;
 * 3. 产物自证: `dist/cli.js` 存在时先与 `dist/manifest.json` 校验 `schemaVersion === 1` 与 SHA-256,
 *    不符即拒执行 (即便 `src/cli.ts` 同在亦不静默绕过);
 * 4. 零多余派生 + 信号收口: 当前已是隔离 Bun 或合格 Node (且无 Bun 可切) 时直接同进程 `import` 入口;
 *    跨运行时切换以异步 `spawn` 派发, 运行期父进程忽略 SIGINT 防孤儿, 子进程退出后解挂并透传信号或退出码。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, resolve, win32 } from 'node:path';
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

/** 在 PATH 中解析命令的全部候选绝对路径 (win32 语义), 严格拦截空、相对与盘根相对条目并去重 */
export const resolveWin32Executables = (name, pathEnv, fileProbe) => {
  const found = [];
  const seen = new Set();
  for (const raw of pathEnv.split(';')) {
    const trimmed = raw.trim();
    const unquoted =
      trimmed.length > 1 && trimmed.startsWith('"') && trimmed.endsWith('"')
        ? trimmed.slice(1, -1).trim()
        : trimmed;
    if (unquoted === '' || !WIN32_ABS_DIR_RE.test(unquoted)) continue;
    for (const ext of WIN32_EXEC_EXTS) {
      const candidate = win32.join(unquoted, name + ext);
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

/** 在 PATH 中解析命令的全部候选绝对路径 (POSIX 语义), 跳过空与相对条目并去重 */
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

const defaultPathEnv = (platform) => {
  if (process.env.PATH !== undefined && process.env.PATH !== '') {
    return process.env.PATH;
  }
  if (platform === 'win32' && process.env.Path !== undefined) {
    return process.env.Path;
  }
  return '';
};

/** 挑选运行时: 缺省 Bun 优先、其次 Node (>= 22.18); 皆无则 null */
export const pickRuntime = ({
  platform = process.platform,
  pathEnv = defaultPathEnv(platform),
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

/** 本文件是否作为入口被直接执行 (双端 resolve + realpath.native 归一 + win32 大小写折叠) */
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

/** 跨运行时异步派生子进程: 运行期父进程忽略 SIGINT 防孤儿, settled 防重入, close 后透传信号或退出码 */
const runChild = (command, args, extraEnv) =>
  new Promise((resolveExit) => {
    const ignoreSigint = () => {};
    process.on('SIGINT', ignoreSigint);
    const child = spawn(command, args, {
      stdio: 'inherit',
      env: extraEnv ? { ...process.env, ...extraEnv } : process.env,
    });
    let settled = false;
    const finish = (cb) => {
      if (settled) return;
      settled = true;
      process.off('SIGINT', ignoreSigint);
      cb();
      resolveExit();
    };
    child.once('error', (error) => {
      finish(() => {
        process.stderr.write(`sweep: 启动运行时失败 (${error.message})\n`);
        process.exit(1);
      });
    });
    child.once('close', (code, signal) => {
      finish(() => {
        if (signal) {
          try {
            process.kill(process.pid, signal);
          } catch {
            process.exit(1);
          }
          return;
        }
        process.exit(code ?? 1);
      });
    });
  });

/**
 * 启动器主流程: 入口定位与产物自证 -> 运行时分流 (隔离 Bun / 合格 Node / 旧 Node 探 PATH) -> 执行真实入口。
 *
 * ### 数据流转示例
 * ```text
 * Case A (npm 分发态, Node 22 启动且 PATH 存在 Bun):
 *   Input  : process.versions.node = '22.18.0', dist/cli.js + dist/manifest.json 存在
 *   步骤 1 : artifactProblem(distDir) 校验 manifest schemaVersion=1 且 cliSha256 == sha256(dist/cli.js) -> null (通过)
 *   步骤 2 : 非 Bun 进程且当前 Node 合格 -> pickRuntime({ names: ['bun'] }) 仅从 PATH 绝对目录命中 /opt/homebrew/bin/bun
 *   步骤 3 : ensureIsolatedBunfig() 确认 bin/bunfig.toml 存在 -> runChild 派生隔离态 Bun (CLIS_BUN_ISOLATED=1)
 *   Output : 子进程以隔离态 Bun 加载 dist/cli.js, 父进程透传退出码或信号
 *
 * Case B (仓内开发态, 无 dist/cli.js, 隔离态 Bun 或纯合格 Node):
 *   Input  : hasBuilt = false, hasSource = true, entry = src/cli.ts
 *   步骤 1 : 跳过 artifactProblem -> 若已在 CLIS_BUN_ISOLATED=1 或合格 Node 且 PATH 无 Bun
 *   步骤 2 : 零额外派生, 直接 await import(pathToFileURL(entry).href)
 *   Output : 同进程执行 src/cli.ts
 * ```
 */
const main = async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const built = join(distDir, CLI_FILE);
  const source = join(root, 'src', 'cli.ts');
  const hasBuilt = existsSync(built);
  const hasSource = existsSync(source);

  if (!hasBuilt && !hasSource) {
    process.stderr.write(
      `sweep: 缺少可执行入口 (dist/${CLI_FILE} 与 src/cli.ts 均不存在)。\n` +
        '  处置: 重装本包换一份完好分发 (npm install -g @iyowei/sweep-cli); 本仓开发态请先执行 bun run build。\n',
    );
    process.exit(1);
  }

  const problem = hasBuilt ? artifactProblem(distDir) : null;
  if (problem !== null) {
    const advice = hasSource
      ? '用源码入口跑 (bun packages/sweep-cli/src/cli.ts 或 node packages/sweep-cli/src/cli.ts), 或重新构建 (bun run build)'
      : '重装本包换一份完好分发 (npm install -g @iyowei/sweep-cli); 重装无效则说明该版本包有缺陷, 需发布者重新构建后再发';
    process.stderr.write(
      `sweep: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
        `  处置: ${advice}。\n`,
    );
    process.exit(1);
  }

  const entry = hasBuilt ? built : source;
  const isolatedBunfig = join(root, 'bin', 'bunfig.toml');
  const ensureIsolatedBunfig = () => {
    if (existsSync(isolatedBunfig)) return;
    process.stderr.write(
      'sweep: 缺少启动器隔离配置 (bin/bunfig.toml), 为防工作目录 bunfig.toml 劫持已拒绝执行。\n',
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
    await runChild(
      process.execPath,
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

  const isCurrentNodeSupported = isSupportedNodeVersion(process.versions.node);

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
    `sweep: 未找到可用的 bun 或 node (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0; 当前 node 为 ${process.versions.node ?? '未知'})\n`,
  );
  process.exit(1);
};

if (isEntry()) {
  await main();
}
