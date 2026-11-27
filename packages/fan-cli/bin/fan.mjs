#!/usr/bin/env node
/**
 * CLI 启动器 (bin 入口, `@iyowei/fan-cli`):
 * 承接 npm 分发 `dist/cli.js` / 仓内开发回退 `src/cli.ts` / 单测导出函数三类入口,
 * 按绝对 PATH 安全挑选运行时 (Bun 优先, 其次 Node >= 22.18), 并执行产物 SHA-256 自证与 bunfig 隔离。
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

const isFileAt = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

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
const WIN32_PATH_RE = /^(?:[A-Za-z]:[/\\]|\\\\)/;

const fileUrlToFsPath = (url) => {
  const isWinUrl =
    typeof url === 'string' &&
    (/^file:\/\/\/[A-Za-z]:/.test(url) ||
      (url.startsWith('file://') && !url.startsWith('file:///')));
  return fileURLToPath(url, { windows: isWinUrl });
};

const normalizeEntryPath = (p, platform = process.platform) => {
  let normalized = resolve(p);
  if (platform !== 'win32' && p.startsWith('/')) {
    normalized = posix.resolve(p);
  } else if (WIN32_PATH_RE.test(p)) {
    normalized = win32.resolve(p);
  }
  if (platform === process.platform) {
    try {
      normalized = realpath(normalized);
    } catch {
      // 保留规范绝对路径
    }
  }
  return platform === 'win32' ? normalized.toLowerCase() : normalized;
};

export const isEntry = (
  entryArg = process.argv[1],
  selfUrl = import.meta.url,
  platform = process.platform,
) => {
  if (typeof entryArg !== 'string' || entryArg === '') return false;
  const self = fileUrlToFsPath(selfUrl);
  return (
    normalizeEntryPath(entryArg, platform) ===
    normalizeEntryPath(self, platform)
  );
};

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
        process.stderr.write(`fan: 启动运行时失败 (${error.message})\n`);
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
  const built = join(distDir, CLI_FILE);
  const source = join(root, 'src', 'cli.ts');
  const hasBuilt = existsSync(built);
  const hasSource = existsSync(source);

  if (!hasBuilt && !hasSource) {
    process.stderr.write(
      `fan: 缺少可执行入口 (dist/${CLI_FILE} 与 src/cli.ts 均不存在)。\n` +
        '  处置: 重装本包 (@iyowei/fan-cli); 本仓开发态请先执行 bun run build。\n',
    );
    process.exit(1);
  }

  const problem = hasBuilt ? artifactProblem(distDir) : null;
  if (problem !== null) {
    const advice = hasSource
      ? '用源码入口跑 (bun packages/fan-cli/src/cli.ts 或 node packages/fan-cli/src/cli.ts), 或重新构建 (bun run build)'
      : '重装本包换一份完好分发 (@iyowei/fan-cli)';
    process.stderr.write(
      `fan: ${problem}, 已拒绝执行该产物 (无法证明它与构建清单同源)。\n` +
        `  处置: ${advice}。\n`,
    );
    process.exit(1);
  }

  const entry = hasBuilt ? built : source;
  const isolatedBunfig = join(root, 'bin', 'bunfig.toml');
  const ensureIsolatedBunfig = () => {
    if (existsSync(isolatedBunfig)) return;
    process.stderr.write(
      'fan: 缺少启动器隔离配置 (bin/bunfig.toml), 为防工作目录 bunfig.toml 劫持已拒绝执行。\n',
    );
    process.exit(1);
  };

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
    `fan: 未找到可用的 bun 或 node (>= ${MIN_NODE_MAJOR}.${MIN_NODE_MINOR}.0; 当前 node 为 ${process.versions.node ?? '未知'})\n`,
  );
  process.exit(1);
};

if (isEntry()) {
  await main();
}
