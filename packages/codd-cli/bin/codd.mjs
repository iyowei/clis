#!/usr/bin/env node
/**
 * npm / bun / pnpm / yarn 通用分发启动器 (@iyowei/codd-cli):
 * 1) shebang 固定为 node 以确保四大包管理器在 Unix 与 Windows 下均生成兼容 shim/软链;
 * 2) 按绝对 PATH 安全挑选运行时 (Bun 优先, Node >= 22.18 回退, 严判盘符/UNC 绝对路径防劫持);
 * 3) 对 dist/cli.js 执行 dist/manifest.json SHA-256 摘要自证, 校验独立隔离配置 bin/bunfig.toml;
 * 4) 同运行时且已隔离时直接同进程 import 执行 (零多余派生); 跨运行时走异步 spawn + SIGINT 隔离。
 */
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, resolve, win32 } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const CLI_FILE = 'cli.js';
const MANIFEST_FILE = 'manifest.json';
const WIN32_EXEC_EXTS = ['.com', '.exe'];
const WIN32_ABS_DIR_RE = /^(?:[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/;
const MIN_NODE_MAJOR = 22;
const MIN_NODE_MINOR = 18;
const BUN_ISOLATED_ENV = 'CLIS_BUN_ISOLATED';

/** 校验 Node.js 版本是否满足 >= 22.18.0 下限 */
export const isSupportedNodeVersion = (rawVersion) => {
  if (typeof rawVersion !== 'string') return false;
  const m = /^v?(\d+)\.(\d+)/.exec(rawVersion.trim());
  if (!m) return false;
  const major = Number(m[1]);
  const minor = Number(m[2]);
  return (
    major > MIN_NODE_MAJOR ||
    (major === MIN_NODE_MAJOR && minor >= MIN_NODE_MINOR)
  );
};

const isBunExecutable = (command) =>
  /(?:^|[/\\])bun(?:\.(?:exe|com))?$/i.test(command);

const available = (command) => {
  const res = spawnSync(command, ['--version'], {
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'ignore'],
  });
  if (res.status !== 0) return false;
  if (isBunExecutable(command)) return true;
  return isSupportedNodeVersion(res.stdout);
};

const isFileAt = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

/** 仅接受带盘符 (C:\...) 或 UNC (\\host\share) 绝对目录, 排除 /usr/bin 盘根相对路径劫持, 返回全部候选 */
export const resolveWin32Executables = (name, pathEnv, fileProbe) => {
  const found = [];
  const seen = new Set();
  for (const raw of pathEnv.split(';')) {
    const dir =
      raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
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
  pathEnv = platform === 'win32'
    ? (process.env.PATH ?? process.env.Path ?? '')
    : (process.env.PATH ?? ''),
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

const normalizeEntryPath = (p, platform = process.platform) => {
  let resolved = resolve(p);
  try {
    resolved = realpathSync(resolved);
  } catch {
    // realpath 不可用时保留规范绝对路径做字面比对
  }
  return platform === 'win32' ? resolved.toLowerCase() : resolved;
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

/** 跨运行时异步派生子进程: 挂起父进程 SIGINT 防 Ctrl+C 杀父留孤儿, 完整透传信号与退出码 */
const execChildRuntime = (command, args, extraEnv) =>
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
    child.once('error', (err) => {
      finish(() => {
        process.stderr.write(
          `codd: 启动运行时失败 (${command}): ${err.message}\n`,
        );
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

const main = async () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const entry = join(distDir, CLI_FILE);
  const isolatedBunfig = join(root, 'bin', 'bunfig.toml');

  if (!existsSync(entry)) {
    process.stderr.write(
      `codd: 缺少产物 (dist/${CLI_FILE} 不存在), 本入口只认构建产物。\n` +
        '  处置: 重装本包 (@iyowei/codd-cli); 本仓开发态请先跑构建 (bun run build)。\n',
    );
    process.exit(1);
  }
  const problem = artifactProblem(distDir);
  if (problem !== null) {
    process.stderr.write(
      `codd: ${problem}, 已拒绝执行该产物。\n` +
        '  处置: 重装本包换一份完好分发, 或在仓库根执行 bun run build 重建产物。\n',
    );
    process.exit(1);
  }
  if (!existsSync(isolatedBunfig)) {
    process.stderr.write(
      'codd: 缺少隔离配置文件 (bin/bunfig.toml), 已拒绝启动以防工作目录配置污染。\n' +
        '  处置: 重装本包 (@iyowei/codd-cli) 或恢复包内 bin/bunfig.toml。\n',
    );
    process.exit(1);
  }

  // 当前已是 Bun 且已处于隔离启动态 (CLIS_BUN_ISOLATED=1): 同进程直载, 零二次派生
  if (typeof process.versions.bun === 'string') {
    if (process.env[BUN_ISOLATED_ENV] === '1') {
      await import(pathToFileURL(entry).href);
      return;
    }
    await execChildRuntime(
      process.execPath,
      [
        `--config=${isolatedBunfig}`,
        '--no-env-file',
        entry,
        ...process.argv.slice(2),
      ],
      { [BUN_ISOLATED_ENV]: '1' },
    );
    return;
  }

  // 当前是 Node: 若本机满足 >= 22.18, 仅探 PATH 中 bun (免去多余 node --version 子进程)
  const currentNodeOk = isSupportedNodeVersion(process.versions.node);
  const bunRuntime = pickRuntime({ names: ['bun'] });
  if (bunRuntime !== null && isBunExecutable(bunRuntime)) {
    await execChildRuntime(
      bunRuntime,
      [
        `--config=${isolatedBunfig}`,
        '--no-env-file',
        entry,
        ...process.argv.slice(2),
      ],
      { [BUN_ISOLATED_ENV]: '1' },
    );
    return;
  }

  if (currentNodeOk) {
    await import(pathToFileURL(entry).href);
    return;
  }

  const nodeRuntime = pickRuntime({ names: ['node'] });
  if (nodeRuntime !== null) {
    await execChildRuntime(nodeRuntime, [entry, ...process.argv.slice(2)]);
    return;
  }

  process.stderr.write(
    `codd: 未找到可用的 bun 或 node (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0; 当前 node 为 ${process.versions.node ?? '未知'})\n`,
  );
  process.exit(1);
};

if (isEntry()) {
  await main();
}
