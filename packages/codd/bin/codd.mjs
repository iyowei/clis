#!/usr/bin/env node
/**
 * npm / bun / pnpm / yarn 通用分发启动器:
 * 1) shebang 固定为 node 以确保四大包管理器在 Unix 与 Windows 下均生成兼容的 shim/软链;
 * 2) 按绝对 PATH 安全挑选运行时 (Bun 优先, Node >=22.18 回退, 跳过空与相对目录防当前目录劫持);
 * 3) 对构建产物 dist/cli.js 执行 dist/manifest.json SHA-256 摘要自证, 通过后透传参数启动。
 */
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync, readFileSync, realpathSync, statSync } from 'node:fs';
import { dirname, join, posix, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

const CLI_FILE = 'cli.js';
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
  if (!existsSync(entry)) {
    process.stderr.write(
      `codd: 缺少产物 (dist/${CLI_FILE} 不存在), 本入口只认构建产物。\n` +
        '  处置: 重装本包 (@iyowei/codd); 本仓开发态请先跑构建 (bun run build)。\n',
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
  const runtime = pickRuntime();
  if (runtime === null) {
    process.stderr.write('codd: 未找到 bun 或 node, 请至少安装其一\n');
    process.exit(1);
  }
  const isBunRuntime = /(?:^|[/\\])bun(?:\.(?:exe|com))?$/i.test(runtime);
  const isolatedBunfig = join(root, 'assets/template/podman/bunfig.toml');
  const runtimeArgs =
    isBunRuntime && existsSync(isolatedBunfig)
      ? [
          `--config=${isolatedBunfig}`,
          '--no-env-file',
          entry,
          ...process.argv.slice(2),
        ]
      : [entry, ...process.argv.slice(2)];
  const { status } = spawnSync(runtime, runtimeArgs, {
    stdio: 'inherit',
  });
  process.exit(status ?? 1);
};

if (isEntry()) main();
