/**
 * 重量级冒烟 (发布层): 对已经过 build + verify:release 的包内不可变资产与产物执行真实隔离装包验收:
 * 1) 用 npm pack --ignore-scripts 打包出 .tgz 到临时目录;
 * 2) 在完全脱离本仓库 node_modules 继承链的独立临时目录执行 `npm install --omit=dev <tgz>`;
 * 3) 从隔离目录的 `node_modules/.bin/create-clis` (Windows 经装好的 `bin/create-clis.mjs`) 启动:
 *    - 场景 A: 生成默认 `standard` 档项目 → 依赖安装 → 跑通生成物完整 `bun run ci`;
 *    - 场景 B: 生成 `core` 档 + `--scope @smoke` 项目 → 验收裁剪结构、scoped 坐标与中性构建脚本;
 *    - 场景 C: 生成 `full` 档项目 → 依赖安装 → 跑通生成物完整 `bun run ci` (含双运行时 conformance / fuzz / lint:mutants) 与 `bun run fuzz:diff`。
 *
 * 不可变原则: 本脚本位于 prepublishOnly 的 verify:release 之后, 严禁覆写包内 assets/ 与 dist/,
 * 只读取并验证即将随包发出的同一份 tarball 及其完整运行时依赖闭包 (含 --external prettier)。
 */
import { spawnSync } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import { resolveNpmCommand } from '../../../scripts/lib/release-verify.ts';
import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import {
  ASSET_MANIFEST_FILE,
  DEFAULT_TEMPLATE_DIR,
  PACKAGE_ROOT,
} from './build-template.ts';
import {
  verifyCarrierRestored,
  verifyConformancePruned,
  verifyCoreScopedProject,
  verifyGeneratedCliVersion,
} from './heavy-smoke-verify.ts';

const PROJECT_NAME = 'clis-smoke';
const CORE_PROJECT_NAME = 'clis-core-smoke';
const FULL_PROJECT_NAME = 'clis-full-smoke';
const CORE_SCOPE = '@smoke';
const PACK_TIMEOUT_MS = 3 * 60 * 1000;
const INSTALL_TIMEOUT_MS = 10 * 60 * 1000;
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000;
const CI_TIMEOUT_MS = 15 * 60 * 1000;

const npmEnv = (): NodeJS.ProcessEnv => ({
  ...process.env,
  NO_UPDATE_NOTIFIER: '1',
  npm_config_update_notifier: 'false',
  npm_config_fund: 'false',
  npm_config_audit: 'false',
});

const run = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
  env: NodeJS.ProcessEnv = process.env,
  windowsVerbatimArguments?: boolean,
): boolean => {
  const result = spawnSync(command, args, {
    cwd,
    stdio: 'inherit',
    timeout,
    env,
    windowsVerbatimArguments,
  });
  if (result.error !== undefined && result.error !== null) {
    process.stderr.write(
      `heavy-smoke: 子进程启动/执行失败: ${result.error.message}\n`,
    );
    return false;
  }
  return result.status === 0;
};

const fail = (workDir: string, stage: string): number => {
  process.stderr.write(
    `\n重量级冒烟未通过 (失败于${stage})。现场保留: ${workDir}\n` +
      '  处置: 按上方输出定位 (生成物 ci 或隔离装包失败项就是病灶); 确认后手动删除该目录。\n',
  );
  return 1;
};

/** 打包当前 create-clis 包到 packDir (不触发脚本, 防止在 prepublishOnly 内递归) */
const packTarball = (packDir: string, cacheDir: string): string | null => {
  mkdirSync(packDir, { recursive: true });
  const invocation = resolveNpmCommand([
    'pack',
    '--ignore-scripts',
    '--json',
    '--no-update-notifier',
    '--pack-destination',
    packDir,
    '--cache',
    cacheDir,
  ]);
  try {
    const result = spawnSync(invocation.command, invocation.args, {
      cwd: PACKAGE_ROOT,
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'inherit'],
      timeout: PACK_TIMEOUT_MS,
      env: npmEnv(),
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.error !== undefined && result.error !== null) {
      throw result.error;
    }
    if (result.status !== 0) {
      throw new Error(`退出码 ${String(result.status ?? result.signal)}`);
    }
    const raw = result.stdout ?? '';
    const parsed: unknown = JSON.parse(raw);
    if (Array.isArray(parsed) && parsed.length > 0) {
      const filename = (parsed[0] as { filename?: unknown }).filename;
      if (typeof filename === 'string' && filename.length > 0) {
        const candidate = join(packDir, filename);
        if (existsSync(candidate)) return candidate;
      }
    }
  } catch (error) {
    process.stderr.write(
      `heavy-smoke: npm pack 失败: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    return null;
  }
  const tgz = readdirSync(packDir).find((name) => name.endsWith('.tgz'));
  return tgz === undefined ? null : join(packDir, tgz);
};

/** 在独立隔离目录安装 .tgz 的生产依赖闭包 (--omit=dev) */
const installIsolatedPackage = (
  installDir: string,
  cacheDir: string,
  tgzPath: string,
): { command: string; prefixArgs: string[] } | null => {
  mkdirSync(installDir, { recursive: true });
  const hostPkg = JSON.stringify(
    { name: 'create-clis-smoke-host', private: true },
    null,
    2,
  );
  writeFileSync(join(installDir, 'package.json'), `${hostPkg}\n`);
  const invocation = resolveNpmCommand([
    'install',
    '--omit=dev',
    '--no-audit',
    '--no-fund',
    '--no-update-notifier',
    '--cache',
    cacheDir,
    tgzPath,
  ]);
  if (
    !run(
      invocation.command,
      invocation.args,
      installDir,
      INSTALL_TIMEOUT_MS,
      npmEnv(),
      invocation.windowsVerbatimArguments,
    )
  ) {
    return null;
  }

  const installedLauncher = join(
    installDir,
    'node_modules',
    'create-clis',
    'bin',
    'create-clis.mjs',
  );
  if (!existsSync(installedLauncher)) {
    process.stderr.write(
      `heavy-smoke: 隔离安装后缺少入口文件: ${installedLauncher}\n`,
    );
    return null;
  }

  const binPath = join(
    installDir,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'create-clis.cmd' : 'create-clis',
  );
  if (!existsSync(binPath)) {
    process.stderr.write(
      `heavy-smoke: 隔离安装后缺少可执行 shim 文件: ${binPath}\n`,
    );
    return null;
  }

  if (process.platform === 'win32') {
    return { command: 'node', prefixArgs: [installedLauncher] };
  }
  return { command: binPath, prefixArgs: [] };
};

/** 经隔离入口生成指定档位示例项目 (复用于 standard / core / full 三场景) */
const runGenerate = (
  cli: { command: string; prefixArgs: string[] },
  workDir: string,
  target: string,
  opts: { name: string; tier: string; scope?: string; noInstall?: boolean },
): boolean => {
  const args = [
    ...cli.prefixArgs,
    target,
    '--name',
    opts.name,
    ...(opts.scope === undefined ? [] : ['--scope', opts.scope]),
    '--owner',
    'clis-smoke',
    '--repo',
    `https://github.com/clis-smoke/${opts.name}`,
    '--tier',
    opts.tier,
    '--yes',
    '--no-git',
    ...(opts.noInstall === true ? ['--no-install'] : []),
  ];
  return run(cli.command, args, workDir, GENERATE_TIMEOUT_MS);
};

const main = (): number => {
  // 1. 校验不可变构建产物与模板资产已就位 (严禁在 verify:release 后覆写包内 assets/)
  const manifestPath = join(PACKAGE_ROOT, 'assets', ASSET_MANIFEST_FILE);
  const artifact = join(PACKAGE_ROOT, 'dist', 'create-clis.js');
  if (!existsSync(DEFAULT_TEMPLATE_DIR) || !existsSync(manifestPath)) {
    process.stderr.write(
      'heavy-smoke: 缺少已构建的模板资产 (assets/template 与 assets/manifest.json), 请先跑 bun run build\n',
    );
    return 1;
  }
  if (!existsSync(artifact)) {
    process.stderr.write(
      'heavy-smoke: 缺少构建产物 (dist/create-clis.js), 请先跑 bun run build\n',
    );
    return 1;
  }

  const workDir = makeTmpRoot('create-clis-smoke-');
  const packDir = join(workDir, 'pack');
  const installDir = join(workDir, 'install');
  const cacheDir = join(workDir, 'npm-cache');
  const target = join(workDir, PROJECT_NAME);
  const coreTarget = join(workDir, CORE_PROJECT_NAME);
  const fullTarget = join(workDir, FULL_PROJECT_NAME);

  // 2. 打包 tarball 并在独立隔离目录装包 (--omit=dev), 真实验收外部依赖闭包
  process.stdout.write(
    `\n=== heavy-smoke: npm pack + 隔离安装 (--omit=dev) → ${installDir} ===\n`,
  );
  const tgzPath = packTarball(packDir, cacheDir);
  if (tgzPath === null) return fail(workDir, 'npm pack 步');
  const cli = installIsolatedPackage(installDir, cacheDir, tgzPath);
  if (cli === null) return fail(workDir, '隔离 npm install 步');

  // 3. 场景 A: 经隔离安装的 bin 启动器生成默认 standard 档项目 (含依赖安装)
  process.stdout.write(
    `\n=== heavy-smoke: 隔离入口生成 ${PROJECT_NAME} (standard 默认档) → ${target} ===\n`,
  );
  if (
    !runGenerate(cli, workDir, target, { name: PROJECT_NAME, tier: 'standard' })
  ) {
    return fail(workDir, 'standard 档生成步 (含依赖安装)');
  }

  // 4. 载体还原与启动器执行位断言
  if (!verifyCarrierRestored(target)) {
    return fail(workDir, '生成物载体还原断言');
  }
  if (process.platform !== 'win32') {
    const launcher = join(
      target,
      'packages',
      `${PROJECT_NAME}-cli`,
      'bin',
      PROJECT_NAME,
    );
    if (existsSync(launcher)) {
      const mode = statSync(launcher).mode;
      const execBits = mode % 0o1000;
      if (Math.floor(execBits / 0o100) % 2 !== 1) {
        process.stderr.write(
          `heavy-smoke: 生成物启动器缺少可执行权限 (+x): ${launcher}\n`,
        );
        return fail(workDir, '启动器权限位断言');
      }
    }
  }

  // 5. 生成物自证: 跑它自己的完整闸门链并确认 standard 档已摘除 --conformance
  if (!verifyConformancePruned(target, 'standard')) {
    return fail(workDir, 'standard 档 conformance 摘除断言');
  }
  process.stdout.write('\n=== heavy-smoke: 生成物 bun run ci ===\n');
  if (!run('bun', ['run', 'ci'], target, CI_TIMEOUT_MS)) {
    return fail(workDir, '生成物 ci 步');
  }
  if (!verifyGeneratedCliVersion(target, PROJECT_NAME)) {
    return fail(workDir, '生成物 CLI --version / -V 双运行时断言');
  }

  // 6. 场景 B: 经隔离入口生成 core 档 + --scope 项目并验结构
  process.stdout.write(
    `\n=== heavy-smoke: 隔离入口生成 ${CORE_PROJECT_NAME} (core 档 + ${CORE_SCOPE}) → ${coreTarget} ===\n`,
  );
  if (
    !runGenerate(cli, workDir, coreTarget, {
      name: CORE_PROJECT_NAME,
      tier: 'core',
      scope: CORE_SCOPE,
      noInstall: true,
    })
  ) {
    return fail(workDir, 'core+scope 生成步');
  }
  if (!verifyCoreScopedProject(coreTarget, CORE_PROJECT_NAME, CORE_SCOPE)) {
    return fail(workDir, 'core+scope 结构断言');
  }

  // 7. 场景 C: 经隔离入口生成 full 档项目 (含依赖安装) → 跑通生成物完整 ci 与 fuzz:diff
  process.stdout.write(
    `\n=== heavy-smoke: 隔离入口生成 ${FULL_PROJECT_NAME} (full 增强档) → ${fullTarget} ===\n`,
  );
  if (
    !runGenerate(cli, workDir, fullTarget, {
      name: FULL_PROJECT_NAME,
      tier: 'full',
    })
  ) {
    return fail(workDir, 'full 档生成步 (含依赖安装)');
  }
  if (!verifyCarrierRestored(fullTarget)) {
    return fail(workDir, 'full 档载体还原断言');
  }
  process.stdout.write('\n=== heavy-smoke: full 档生成物 bun run ci ===\n');
  if (!run('bun', ['run', 'ci'], fullTarget, CI_TIMEOUT_MS)) {
    return fail(workDir, 'full 档生成物 ci 步');
  }
  if (!run('bun', ['run', 'fuzz:diff'], fullTarget, CI_TIMEOUT_MS)) {
    return fail(workDir, 'full 档生成物 fuzz:diff 步');
  }

  rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(
    `\n重量级冒烟通过 ✓ (隔离装包 + standard / full 档 bun run ci 全绿 + core+scope 校验通过; 临时现场已清理)\n`,
  );
  return 0;
};

if (import.meta.main) process.exitCode = main();
