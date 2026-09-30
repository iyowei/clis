/**
 * 重量级冒烟 (发布层, spec「质量闭环」第 2 条): 现场重建模板资产 → 经 bin 启动器跑构建产物
 * (dist/create-clis.js) 生成一个 core 档完整项目到 ~/tmp 独占临时目录 → 依赖安装 (install hook)
 * → 在生成物里跑它自己的完整闸门链 (`bun run ci`) → 全绿才算过。
 *
 * 为什么必须真跑: 轻量冒烟 (cli.smoke.test.ts) 只断言生成物结构, 生成物「自己绿不绿」只有真装
 * 依赖并跑它的 ci 才能证明; 本脚本是发布链的一环 (package.json 的 prepublishOnly: build →
 * verify:release → heavy-smoke), 发布出去的生成器版本必须自证「它生成的项目是绿的」。
 *
 * 几条口径:
 * - 只认构建产物: 经 bin/create-clis.mjs 启动 (运行时挑选 + 产物自证对账一并被走到), 与用户经
 *   npm 安装后的入口形态一致; 产物缺失即拒绝 (先跑 build), 不做源码回退;
 * - 只认包内资产: 模板资产现场重建进包内 assets/ (与 build 的第一步同源同参), 于是本脚本可独立
 *   跑, 也意味着冒烟对象恒是「将随包发售的那份资产」;
 * - core 档: 最小装备档, 生成与 ci 都最快; 收尾走默认 (依赖安装 hook 真跑), 但 --no-git (产物
 *   ci 链不依赖 git, git init 收尾另有端到端用例覆盖);
 * - 失败即拒: 任一步非零退出即视为冒烟失败 (退出码 1), 临时现场保留并打印路径供诊断, 不静默清理。
 *
 * 用法: bun scripts/heavy-smoke.ts (prepublishOnly 内由 npm run heavy-smoke 调用)
 * 退出码: 0 全绿; 1 任一步骤失败 (原因见 stderr 与子进程输出)
 */
import { spawnSync } from 'node:child_process';
import { existsSync, rmSync } from 'node:fs';
import { join } from 'node:path';

import { makeTmpRoot } from '../../../scripts/lib/tmp-root.ts';
import { ORIGINAL } from '../src/template-snapshot.ts';
import {
  DEFAULT_TEMPLATE_DIR,
  PACKAGE_ROOT,
  buildTemplate,
} from './build-template.ts';
import { REPO_ROOT } from './template-manifest.ts';

/** 冒烟项目名 (kebab-case; 生成物根包名取 <name>-monorepo, 两包取 <name> 与 <name>-cli) */
const PROJECT_NAME = 'clis-smoke';

/** 生成步时限: 含依赖安装 (bun install 走网络, 慢机给足); 超时即判失败, 防环境异常时无限悬挂 */
const GENERATE_TIMEOUT_MS = 15 * 60 * 1000;

/** 生成物 ci 步时限 (ci.ts 全链跑一遍的宽裕上界) */
const CI_TIMEOUT_MS = 15 * 60 * 1000;

/** 跑一条子进程 (stdio 透传, 让用户看得到进度); 返回是否成功 */
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

/** 失败收口: 保留现场 (排障要拿生成物本体), 打印路径与出口 */
const fail = (workDir: string, stage: string): number => {
  process.stderr.write(
    `\n重量级冒烟未通过 (失败于${stage})。现场保留: ${workDir}\n` +
      '  处置: 按上方输出定位 (生成物 ci 的失败项就是病灶); 确认后手动删除该目录。\n',
  );
  return 1;
};

/**
 * 冒烟主流程; 返回进程退出码 (0 全绿)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   包内资产 = 94 个模板文件 (buildTemplate 现场重建)
 *   产物 = dist/create-clis.js (须先跑 build; 缺失即拒)
 *
 * 步骤 1：临时区与生成 (经 bin 启动器, 默认收尾含依赖安装)
 *   workDir = ~/tmp/create-clis-smoke-XXXXXX; target = <workDir>/clis-smoke
 *   bin/create-clis.mjs --name clis-smoke --tier core --yes --no-git <target>
 *   → 生成 94 份 → 裁剪 → 替换 → 格式化收口 → 自检 → bun install (install hook 真跑)
 *
 * 步骤 2：生成物自证 (产物自己的闸门链)
 *   cd <target> && bun run ci → build → typecheck → test → lint → format-check → 四闸门
 *
 * 步骤 3：收口
 *   全绿 → 删除 workDir, return 0; 任一步失败 → 保留 workDir, return 1
 *
 * Output（数据契约）
 *   return 0|1 (进程退出码); stdout 已打印各步进度与结论
 * ```
 */
const main = (): number => {
  // 1. 模板资产现场重建 (与 build 的第一步同源同参: 冒烟对象恒是将随包发售的那份资产)
  const { files } = buildTemplate({
    repoRoot: REPO_ROOT,
    outDir: DEFAULT_TEMPLATE_DIR,
    original: ORIGINAL,
  });
  process.stdout.write(`模板资产已重建: ${files.length} 个文件\n`);

  // 2. 只认构建产物 (与 bin 启动器同口径; 缺产物说明还没构建, 冒烟对象不存在)
  const artifact = join(PACKAGE_ROOT, 'dist', 'create-clis.js');
  if (!existsSync(artifact)) {
    process.stderr.write(
      `heavy-smoke: 缺少构建产物 (dist/create-clis.js), 先跑构建 (bun run build)\n`,
    );
    return 1;
  }

  const workDir = makeTmpRoot('create-clis-smoke-');
  const target = join(workDir, PROJECT_NAME);

  // 3. 生成 (经 bin 启动器: 运行时挑选与产物自证对账一并被走到; 默认收尾含 bun install)
  process.stdout.write(
    `\n=== heavy-smoke: 生成 ${PROJECT_NAME} (core 档) → ${target} ===\n`,
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
      'core',
      '--yes',
      '--no-git',
    ],
    PACKAGE_ROOT,
    GENERATE_TIMEOUT_MS,
  );
  if (!generated) return fail(workDir, '生成步 (含依赖安装)');

  // 4. 生成物自证: 跑它自己的完整闸门链
  process.stdout.write('\n=== heavy-smoke: 生成物 bun run ci ===\n');
  if (!run('bun', ['run', 'ci'], target, CI_TIMEOUT_MS)) {
    return fail(workDir, '生成物 ci 步');
  }

  // 5. 全绿收口: 抹掉临时现场 (绝对无痕)
  rmSync(workDir, { recursive: true, force: true });
  process.stdout.write(
    `\n重量级冒烟通过 ✓ (生成物 ${PROJECT_NAME} 的 bun run ci 全绿; 临时现场已清理)\n`,
  );
  return 0;
};

// 被测试 import 时不得跑入口 (只有直接运行才落退出码)
if (import.meta.main) process.exitCode = main();
