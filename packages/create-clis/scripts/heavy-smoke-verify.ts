/**
 * 重量级冒烟断言辅助: 载体还原、档位裁剪验证、双运行时版本校验与 core+scope 结构校验。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

/** 验收载体还原 (.gitignore / .npmrc 存在且载体名消失) */
export const verifyCarrierRestored = (target: string): boolean => {
  for (const real of ['.gitignore', '.npmrc']) {
    if (!existsSync(join(target, real))) {
      process.stderr.write(
        `heavy-smoke: 生成物缺 ${real} (载体还原步骤回归? 见 generate.ts 的 restoreCarrierNames)\n`,
      );
      return false;
    }
  }
  for (const carrier of ['_gitignore', '_npmrc']) {
    if (existsSync(join(target, carrier))) {
      process.stderr.write(`heavy-smoke: 生成物残留载体文件 ${carrier}\n`);
      return false;
    }
  }
  return true;
};

/** 验收裁剪档 (standard / core) 的 ci.ts 已摘除 --conformance 入口 (防仅跑 build 却假绿) */
export const verifyConformancePruned = (
  target: string,
  tierLabel: string,
  extraForbidden: readonly string[] = [],
): boolean => {
  const help = spawnSync('bun', ['scripts/ci.ts', '--help'], {
    cwd: target,
    encoding: 'utf8',
  });
  if (help.status !== 0) {
    process.stderr.write(
      `heavy-smoke: ${tierLabel} 档 scripts/ci.ts --help 失败: ${help.stderr ?? ''}\n`,
    );
    return false;
  }
  for (const forbidden of [
    '--conformance',
    'lint:coverage',
    'lint:mutants',
    'fuzz',
    'conformance:portable',
    'conformance:bun',
    'conformance:node',
    ...extraForbidden,
  ]) {
    if ((help.stdout ?? '').includes(forbidden)) {
      process.stderr.write(
        `heavy-smoke: ${tierLabel} 档 ci --help 仍残留已摘除项 ${forbidden}\n`,
      );
      return false;
    }
  }
  const conf = spawnSync('bun', ['scripts/ci.ts', '--conformance'], {
    cwd: target,
    encoding: 'utf8',
  });
  if (conf.status !== 2) {
    process.stderr.write(
      `heavy-smoke: ${tierLabel} 档 scripts/ci.ts --conformance 应以退出码 2 拒绝, 实得 ${String(conf.status)}\n`,
    );
    return false;
  }
  return true;
};

/** 验收生成物示例 CLI 打包产物在 bun / node 下均支持 --version 与 -V */
export const verifyGeneratedCliVersion = (
  target: string,
  projectName: string,
): boolean => {
  const binEntry = join(
    target,
    'packages',
    `${projectName}-cli`,
    'bin',
    `${projectName}.mjs`,
  );
  for (const runtime of ['bun', 'node']) {
    for (const flag of ['--version', '-V']) {
      const res = spawnSync(runtime, [binEntry, flag], {
        cwd: target,
        encoding: 'utf8',
      });
      if (res.status !== 0 || (res.stdout ?? '').trim() !== '0.0.0') {
        process.stderr.write(
          `heavy-smoke: 生成物 CLI (${runtime} ${flag}) 版本断言失败: status=${String(res.status)} stdout=${JSON.stringify(res.stdout)} stderr=${JSON.stringify(res.stderr)}\n`,
        );
        return false;
      }
    }
  }
  return true;
};

/** 验收 core 档 + --scope 生成物结构与中性构建脚本 */
export const verifyCoreScopedProject = (
  target: string,
  coreProjectName: string,
  coreScope: string,
): boolean => {
  if (!verifyCarrierRestored(target)) return false;

  for (const removed of [
    'scripts/transcription',
    'docs/transcription',
    `packages/${coreProjectName}/docs`,
    'docs/designs/tech-debt.md',
    'scripts/lint-dependency-direction.ts',
  ]) {
    if (existsSync(join(target, removed))) {
      process.stderr.write(
        `heavy-smoke: core 档不应保留 ${removed} (档位裁剪回归)\n`,
      );
      return false;
    }
  }

  const apiPkgPath = join(target, 'packages', coreProjectName, 'package.json');
  const cliPkgPath = join(
    target,
    'packages',
    `${coreProjectName}-cli`,
    'package.json',
  );
  const apiPkg = JSON.parse(readFileSync(apiPkgPath, 'utf8')) as {
    name?: string;
  };
  const cliPkg = JSON.parse(readFileSync(cliPkgPath, 'utf8')) as {
    name?: string;
    dependencies?: Record<string, string>;
    devDependencies?: Record<string, string>;
  };
  const expectedApi = `${coreScope}/${coreProjectName}`;
  const expectedCli = `${coreScope}/${coreProjectName}-cli`;
  if (apiPkg.name !== expectedApi || cliPkg.name !== expectedCli) {
    process.stderr.write(
      `heavy-smoke: core+scope 包名不符 (期望 ${expectedApi} / ${expectedCli}, 实得 ${String(apiPkg.name)} / ${String(cliPkg.name)})\n`,
    );
    return false;
  }
  const hasApiDep =
    cliPkg.dependencies?.[expectedApi] !== undefined ||
    cliPkg.devDependencies?.[expectedApi] !== undefined;
  if (!hasApiDep) {
    process.stderr.write(
      `heavy-smoke: core+scope CLI 包未声明对 ${expectedApi} 的包依赖\n`,
    );
    return false;
  }

  const buildScript = readFileSync(
    join(target, 'packages', coreProjectName, 'scripts', 'build.ts'),
    'utf8',
  );
  if (
    !buildScript.includes(
      'const INTERNAL_DTS_FILES: readonly string[] = [];',
    ) ||
    !buildScript.includes("'--no-install'")
  ) {
    process.stderr.write(
      'heavy-smoke: 生成物 API 包 scripts/build.ts 未保持干净中性骨架\n',
    );
    return false;
  }

  const launcherTest = join(
    target,
    'packages',
    `${coreProjectName}-cli`,
    'src',
    'launcher.runtime-resolution.test.ts',
  );
  if (!existsSync(launcherTest)) {
    process.stderr.write(
      'heavy-smoke: core 档生成物缺少 CLI 启动器自证单测 launcher.runtime-resolution.test.ts\n',
    );
    return false;
  }

  return verifyConformancePruned(target, 'core', ['lint:deps']);
};
