#!/usr/bin/env node
/**
 * npm 安装场景的启动器: 挑选运行时 (Bun 优先, 其次 Node) 后启动真实入口 (只认构建产物)。
 *
 * 安全防线:
 * 1. 运行时解析防劫持: win32 与 POSIX 均按 PATH 解析绝对路径并跳过空/相对条目;
 * 2. Bun 工作目录配置隔离: 选中 Bun 时强制附加 --config=<pkg>/bin/bunfig.toml 与
 *    --no-env-file (缺失隔离配置即拒绝, 绝不静默退回无隔离态);
 * 3. 产物自证: 执行 dist/create-clis.js 前必先与 dist/manifest.json 校验 SHA-256。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { basename, dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_FILE = 'create-clis.js';
const MANIFEST_FILE = 'manifest.json';
const WIN32_EXEC_EXTS = ['.com', '.exe'];

const available = (command) =>
  spawnSync(command, ['--version'], { stdio: 'ignore' }).status === 0;

const isFileAt = (path) => {
  try {
    return statSync(path).isFile();
  } catch {
    return false;
  }
};

const isBunRuntime = (runtime) => {
  const name = basename(runtime).toLowerCase();
  return name === 'bun' || name === 'bun.exe' || name === 'bun.com';
};

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

export const resolvePosixExecutables = (name, pathEnv, fileProbe) => {
  const found = [];
  for (const dir of pathEnv.split(':')) {
    if (dir === '' || !dir.startsWith('/')) continue;
    const candidate = posix.join(dir, name);
    if (fileProbe(candidate)) found.push(candidate);
  }
  return found;
};

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

const isEntry = () => {
  const entry = process.argv[1];
  if (typeof entry !== 'string' || entry === '') return false;
  const self = fileURLToPath(import.meta.url);
  const norm = (value) =>
    process.platform === 'win32' ? value.toLowerCase() : value;
  if (norm(entry) === norm(self)) return true;
  try {
    const realSelf = realpathSync(self);
    return norm(realpathSync(entry)) === norm(realSelf);
  } catch {
    return false;
  }
};

const main = () => {
  const root = dirname(dirname(fileURLToPath(import.meta.url)));
  const distDir = join(root, 'dist');
  const entry = join(distDir, CLI_FILE);
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
  const runtime = pickRuntime();

  if (runtime === null) {
    process.stderr.write('create-clis: 未找到 bun 或 node, 请至少安装其一\n');
    process.exit(1);
  }

  let spawnArgs = [entry, ...process.argv.slice(2)];
  if (isBunRuntime(runtime)) {
    const isolatedBunfig = join(root, 'bin', 'bunfig.toml');
    if (!existsSync(isolatedBunfig)) {
      process.stderr.write(
        'create-clis: 缺少启动器隔离配置 (bin/bunfig.toml), 为防工作目录 bunfig.toml 劫持已拒绝执行。\n',
      );
      process.exit(1);
    }
    spawnArgs = [`--config=${isolatedBunfig}`, '--no-env-file', ...spawnArgs];
  }

  const result = spawnSync(runtime, spawnArgs, { stdio: 'inherit' });
  if (result.error) {
    process.stderr.write(
      `create-clis: 启动运行时失败 (${result.error.message})\n`,
    );
    process.exit(1);
  }
  if (result.signal) {
    process.kill(process.pid, result.signal);
  }
  process.exit(result.status ?? 1);
};

if (isEntry()) main();
