/**
 * 全仓 CLI 真实打包与多包管理器装包冒烟 (Linux / Windows / macOS 通用):
 * 1) 动态枚举 workspaces 内全部带 `bin` 的 CLI 包 (零硬编码包名);
 * 2) 先核验构建产物存在, 再经 `npm pack --ignore-scripts` 生成真实 `.tgz`;
 * 3) 在完全隔离的临时目录分别执行:
 *    - `npm install --global --prefix` 装包, 验证生成的全局 bin shim (POSIX 软链 / Windows `.cmd` + `.ps1`);
 *    - `bun add --cwd` 装包, 验证 `node_modules/.bin/` 可执行入口;
 * 4) 在含恶意损坏 `bunfig.toml` + `preload` 劫持文件的 `cwd` 中, 分别用:
 *    - 默认 Bun+Node `PATH`
 *    - 纯 Node (`>= 22.18.0`, `PATH` 完全剥离 `bun`)
 *    实跑装好的 shim (`--version` / `-V` / `--help` / `-h` / 非法参数退非零), 证明跨平台「装得上且用得了」。
 *
 * 用法: bun scripts/smoke-install.ts
 * 退出码: 0 全部 CLI 通过; 1 存在失败或前置产物缺失。
 */
import { type SpawnSyncReturns, spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  resolveNpmCommand,
  resolveWin32BatchInvocation,
} from './lib/release-verify.ts';
import {
  type CliPackageTarget,
  buildNpmProcessEnv,
  preparePoisonedCwd,
  preparePureNodeEnv,
  resolveBunLocalShim,
  resolveCliPackages,
  resolveNpmGlobalShim,
  resolveNpmInstalledPackageDir,
} from './lib/smoke-install-paths.ts';
import { makeTmpRoot } from './lib/tmp-root.ts';

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const PACK_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const RUN_TIMEOUT_MS = 30_000;

function runInstalledShim(
  executable: string,
  args: readonly string[],
  cwd: string,
  env: NodeJS.ProcessEnv,
  platform: NodeJS.Platform = process.platform,
): SpawnSyncReturns<string> {
  if (platform === 'win32') {
    const inv = resolveWin32BatchInvocation(executable, args, env);
    return spawnSync(inv.command, inv.args, {
      cwd,
      encoding: 'utf8',
      env,
      timeout: RUN_TIMEOUT_MS,
      windowsVerbatimArguments: inv.windowsVerbatimArguments,
    });
  }
  return spawnSync(executable, [...args], {
    cwd,
    encoding: 'utf8',
    env,
    timeout: RUN_TIMEOUT_MS,
  });
}

function formatExecFailure(
  label: string,
  res: SpawnSyncReturns<string>,
): string {
  const errMsg = res.error ? ` error=${res.error.message}` : '';
  return (
    `${label} 失败: status=${String(res.status)}${errMsg}\n` +
    `stdout: ${JSON.stringify(res.stdout)}\n` +
    `stderr: ${JSON.stringify(res.stderr)}`
  );
}

function assertShimContract(options: {
  executable: string;
  pkgName: string;
  version: string;
  binName: string;
  modeLabel: string;
  dirtyCwd: string;
  env: NodeJS.ProcessEnv;
}): void {
  const { executable, pkgName, version, binName, modeLabel, dirtyCwd, env } =
    options;
  for (const flag of ['--version', '-V']) {
    const res = runInstalledShim(executable, [flag], dirtyCwd, env);
    if (res.status !== 0 || (res.stdout ?? '').trim() !== version) {
      throw new Error(
        formatExecFailure(
          `${pkgName} (${binName}, ${modeLabel}, ${flag} 期望输出 ${version})`,
          res,
        ),
      );
    }
    if ((res.stderr ?? '').includes('PRELOAD_HIJACKED')) {
      throw new Error(`${pkgName} (${modeLabel}) 未隔离工作目录 bunfig.toml`);
    }
  }

  for (const flag of ['--help', '-h']) {
    const res = runInstalledShim(executable, [flag], dirtyCwd, env);
    if (res.status !== 0 || (res.stdout ?? '').trim().length === 0) {
      throw new Error(
        formatExecFailure(
          `${pkgName} (${binName}, ${modeLabel}, ${flag})`,
          res,
        ),
      );
    }
  }

  const bad = runInstalledShim(
    executable,
    ['--definitely-invalid-smoke'],
    dirtyCwd,
    env,
  );
  if (bad.status === 0 || bad.error !== undefined) {
    throw new Error(
      formatExecFailure(
        `${pkgName} (${binName}, ${modeLabel}, 非法参数应退非零)`,
        bad,
      ),
    );
  }
}

function packTargetTarball(
  target: CliPackageTarget,
  packDir: string,
  cacheDir: string,
  root: string,
): string {
  mkdirSync(packDir, { recursive: true });
  const pkgRoot = join(root, target.pkg.dir);
  const inv = resolveNpmCommand([
    'pack',
    '--ignore-scripts',
    '--json',
    '--no-update-notifier',
    '--pack-destination',
    packDir,
    '--cache',
    cacheDir,
  ]);
  const res = spawnSync(inv.command, inv.args, {
    cwd: pkgRoot,
    encoding: 'utf8',
    timeout: PACK_TIMEOUT_MS,
    env: buildNpmProcessEnv(process.env),
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(formatExecFailure(`${target.pkg.name} npm pack`, res));
  }
  const parsed: unknown = JSON.parse(res.stdout ?? '[]');
  if (
    Array.isArray(parsed) &&
    parsed.length > 0 &&
    typeof (parsed[0] as { filename?: unknown }).filename === 'string'
  ) {
    const candidate = join(
      packDir,
      (parsed[0] as { filename: string }).filename,
    );
    if (existsSync(candidate)) return candidate;
  }
  const fallback = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  if (fallback === undefined) {
    throw new Error(`${target.pkg.name}: npm pack 未生成 .tgz 文件`);
  }
  return join(packDir, fallback);
}

function installViaNpmGlobal(
  target: CliPackageTarget,
  tgzPath: string,
  npmPrefix: string,
  cacheDir: string,
): void {
  mkdirSync(npmPrefix, { recursive: true });
  const offlineFlag = target.hasRuntimeDeps ? '--prefer-offline' : '--offline';
  const inv = resolveNpmCommand([
    'install',
    '--global',
    '--prefix',
    npmPrefix,
    '--omit=dev',
    offlineFlag,
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--cache',
    cacheDir,
    tgzPath,
  ]);
  const res = spawnSync(inv.command, inv.args, {
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    env: buildNpmProcessEnv(process.env),
    windowsVerbatimArguments: inv.windowsVerbatimArguments,
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(
      formatExecFailure(`${target.pkg.name} npm install --global`, res),
    );
  }
}

function installViaBunAdd(
  target: CliPackageTarget,
  tgzPath: string,
  bunHostDir: string,
): void {
  mkdirSync(bunHostDir, { recursive: true });
  writeFileSync(
    join(bunHostDir, 'package.json'),
    `${JSON.stringify({ name: 'smoke-install-bun-host', private: true }, null, 2)}\n`,
  );
  const args = ['add', '--cwd', bunHostDir];
  if (!target.hasRuntimeDeps) args.push('--offline');
  args.push(tgzPath);
  const res = spawnSync('bun', args, {
    encoding: 'utf8',
    timeout: INSTALL_TIMEOUT_MS,
    env: process.env,
  });
  if (res.error !== undefined || res.status !== 0) {
    throw new Error(formatExecFailure(`${target.pkg.name} bun add`, res));
  }
}

function verifyInstalledLayout(
  installedPkgDir: string,
  target: CliPackageTarget,
): void {
  if (!existsSync(join(installedPkgDir, 'package.json'))) {
    throw new Error(
      `${target.pkg.name}: 装包后缺少 package.json (${installedPkgDir})`,
    );
  }
  for (const bin of target.bins) {
    if (!existsSync(join(installedPkgDir, bin.relPath))) {
      throw new Error(
        `${target.pkg.name}: 装包后缺少 bin 入口 ${bin.relPath} (${installedPkgDir})`,
      );
    }
  }
}

function verifyOneCli(options: {
  target: CliPackageTarget;
  sandboxDir: string;
  cacheDir: string;
  dirtyCwd: string;
  nodeOnlyEnv: NodeJS.ProcessEnv;
  root: string;
}): void {
  const { target, sandboxDir, cacheDir, dirtyCwd, nodeOnlyEnv, root } = options;
  const pkgSlug = target.pkg.name.replace(/[^A-Za-z0-9_-]/g, '-');
  const pkgWork = join(sandboxDir, pkgSlug);
  const packDir = join(pkgWork, 'pack');
  const npmPrefix = join(pkgWork, 'npm-prefix');
  const bunHostDir = join(pkgWork, 'bun-host');

  for (const bin of target.bins) {
    const srcEntry = join(root, target.pkg.dir, bin.relPath);
    if (!existsSync(srcEntry)) {
      throw new Error(`${target.pkg.name}: 缺少源码入口 ${srcEntry}`);
    }
  }
  if (!existsSync(join(root, target.pkg.dir, 'dist'))) {
    throw new Error(
      `${target.pkg.name}: 缺少 dist 构建目录, 请先执行 bun run build`,
    );
  }

  process.stdout.write(
    `\n[smoke:install] ${target.pkg.name}@${target.version}\n`,
  );
  const tgzPath = packTargetTarball(target, packDir, cacheDir, root);

  installViaNpmGlobal(target, tgzPath, npmPrefix, cacheDir);
  verifyInstalledLayout(
    resolveNpmInstalledPackageDir(npmPrefix, target.pkg.name),
    target,
  );

  installViaBunAdd(target, tgzPath, bunHostDir);

  for (const bin of target.bins) {
    const npmShim = resolveNpmGlobalShim(npmPrefix, bin.name);
    if (!existsSync(npmShim.executable)) {
      throw new Error(
        `${target.pkg.name}: npm 装包未生成可执行 shim (${npmShim.executable})`,
      );
    }
    for (const companion of npmShim.companionFiles) {
      if (!existsSync(companion)) {
        throw new Error(
          `${target.pkg.name}: npm 装包未生成配套 shim (${companion})`,
        );
      }
    }

    assertShimContract({
      executable: npmShim.executable,
      pkgName: target.pkg.name,
      version: target.version,
      binName: bin.name,
      modeLabel: 'npm + bun/node',
      dirtyCwd,
      env: process.env,
    });
    assertShimContract({
      executable: npmShim.executable,
      pkgName: target.pkg.name,
      version: target.version,
      binName: bin.name,
      modeLabel: 'npm + node-only',
      dirtyCwd,
      env: nodeOnlyEnv,
    });

    const bunShim = resolveBunLocalShim(bunHostDir, bin.name);
    if (!existsSync(bunShim)) {
      throw new Error(
        `${target.pkg.name}: bun add 未生成 bin shim (${bunShim})`,
      );
    }
    if (bunShim.endsWith('.bunx')) {
      const bunxRes = spawnSync('bun', [bunShim, '--version'], {
        cwd: dirtyCwd,
        encoding: 'utf8',
        timeout: RUN_TIMEOUT_MS,
      });
      if (
        bunxRes.status !== 0 ||
        (bunxRes.stdout ?? '').trim() !== target.version
      ) {
        throw new Error(
          formatExecFailure(`${target.pkg.name} (bun .bunx shim)`, bunxRes),
        );
      }
    } else {
      assertShimContract({
        executable: bunShim,
        pkgName: target.pkg.name,
        version: target.version,
        binName: bin.name,
        modeLabel: 'bun',
        dirtyCwd,
        env: process.env,
      });
    }
  }
}

export function runInstallSmoke(root: string = REPO_ROOT): number {
  const targets = resolveCliPackages(root);
  if (targets.length === 0) {
    process.stderr.write('smoke:install: 工作区未发现任何带 bin 的 CLI 包\n');
    return 1;
  }

  const sandboxDir = makeTmpRoot('smoke-install-');
  const cacheDir = join(sandboxDir, 'npm-cache');
  mkdirSync(cacheDir, { recursive: true });
  try {
    const nodeOnlyEnv = preparePureNodeEnv(sandboxDir);
    const dirtyCwd = preparePoisonedCwd(sandboxDir);
    for (const target of targets) {
      verifyOneCli({
        target,
        sandboxDir,
        cacheDir,
        dirtyCwd,
        nodeOnlyEnv,
        root,
      });
    }
    process.stdout.write(
      `\n全仓 CLI 装包与双运行时 shim 冒烟全部通过 ✓ (共 ${targets.length} 个 CLI 包)\n`,
    );
    return 0;
  } catch (error) {
    process.stderr.write(
      `\nsmoke:install 失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return 1;
  } finally {
    rmSync(sandboxDir, {
      recursive: true,
      force: true,
      maxRetries: 5,
      retryDelay: 100,
    });
  }
}

if (
  process.argv[1] !== undefined &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
) {
  process.exitCode = runInstallSmoke();
}
