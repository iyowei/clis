/**
 * 重量级冒烟 (发布层): 直接校验已经过 build + verify:release 的包内不可变资产与产物,
 * 经 bin 启动器跑构建产物生成默认 standard 档项目 → 依赖安装 → 跑通生成物完整 bun run ci。
 *
 * 不可变原则: 本脚本位于 prepublishOnly 的 verify:release 之后, 严禁覆写包内 assets/,
 * 只读取并验证即将随包发出的同一份 dist/ 与 assets/。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync, statSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import {
  ASSET_MANIFEST_FILE,
  DEFAULT_TEMPLATE_DIR,
  PACKAGE_ROOT,
} from './build-template.ts';

const PROJECT_NAME = 'clis-smoke';
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000;
const CI_TIMEOUT_MS = 15 * 60 * 1000;

const run = (
  command: string,
  args: string[],
  cwd: string,
  timeout: number,
): boolean => {
  const result = spawnSync(command, args, { cwd, stdio: 'inherit', timeout });
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
      '  处置: 按上方输出定位 (生成物 ci 的失败项就是病灶); 确认后手动删除该目录。\n',
  );
  return 1;
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
  const target = join(workDir, PROJECT_NAME);

  // 2. 生成默认 standard 档项目 (经 bin 启动器: 同步验收运行时解析、bunfig 隔离与产物自证)
  process.stdout.write(
    `\n=== heavy-smoke: 生成 ${PROJECT_NAME} (standard 默认档) → ${target} ===\n`,
  );
  const generated = run(
    'node',
    [
      join(PACKAGE_ROOT, 'bin', 'create-clis.mjs'),
      target,
      '--name',
      PROJECT_NAME,
      '--owner',
      'clis-smoke',
      '--repo',
      `https://github.com/clis-smoke/${PROJECT_NAME}`,
      '--tier',
      'standard',
      '--yes',
      '--no-git',
    ],
    PACKAGE_ROOT,
    GENERATE_TIMEOUT_MS,
  );
  if (!generated) return fail(workDir, '生成步 (含依赖安装)');

  // 3. 载体还原与启动器执行位断言
  for (const real of ['.gitignore', '.npmrc']) {
    if (!existsSync(join(target, real))) {
      process.stderr.write(
        `heavy-smoke: 生成物缺 ${real} (载体还原步骤回归? 见 generate.ts 的 restoreCarrierNames)\n`,
      );
      return fail(workDir, '生成物载体还原断言');
    }
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

  // 4. 生成物自证: 跑它自己的完整闸门链
  process.stdout.write('\n=== heavy-smoke: 生成物 bun run ci ===\n');
  if (!run('bun', ['run', 'ci'], target, CI_TIMEOUT_MS)) {
    return fail(workDir, '生成物 ci 步');
  }

  rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(
    `\n重量级冒烟通过 ✓ (生成物 ${PROJECT_NAME} standard 档 bun run ci 全绿; 临时现场已清理)\n`,
  );
  return 0;
};

if (import.meta.main) process.exitCode = main();
