/**
 * create-clis CLI 进程入口: `update` 自更新前置分流 -> 旗标解析 -> 目标目录前置校验 ->
 * 变量收集 (交互 / 零交互三态) -> `generateProject` -> next steps 打印。
 *
 * 上游由 bin 启动, 下游编排 `variables.ts` / `prompt.ts` / `generate.ts` / `help.ts`。
 * 契约以 docs/designs/scaffold-contract.md 为权威: 缺省落当前目录 `<name>/`,
 * 目标已存在且非空直接拒绝 (不覆盖), 写入后失败保留半成品目录并如实提示。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import { readPackageMeta, runSelfUpdate } from '@iyowei/cli-updater';

import {
  type GenerateHooks,
  TargetRejectedError,
  assertTargetAvailable,
  createGitInitHook,
  createInstallHook,
  generateProject,
} from './generate.ts';
import { formatHelpText, stdoutSupportsColor } from './help.ts';
import { askAll, createPromptIO } from './prompt.ts';
import { ORIGINAL, defaultTemplateDir } from './template-snapshot.ts';
import { type Tier } from './tier.ts';
import {
  type CliOptions,
  DEFAULT_TIER,
  type Environment,
  parseFlags,
  provided,
  readGitUserName,
} from './variables.ts';

/** 由旗标构造收尾 hooks: 未提供的动作即不执行 (--no-git / --no-install 的折算点) */
function buildHooks(options: CliOptions): GenerateHooks {
  const hooks: GenerateHooks = {};
  if (options.git) hooks.gitInit = createGitInitHook();
  if (options.install) hooks.install = createInstallHook();
  return hooks;
}

/**
 * next steps 文案: 进入目录 → 装依赖 (仅未装时) → ci 验证 → (full 档协议同步提示) → 从
 * 文档总索引读起。
 * 落点取生成物的 `docs/README.md` (实存的总索引): 本仓的定位文档 (collection-positioning.md)
 * 是 exclude 面, 生成物里没有它, 指过去用户读不到。
 * full 档已内置最小 greet 协议、覆盖表、金样本语料、变异体与模糊测试目标, 开箱跑 `bun run ci`
 * 与 `bun run fuzz:diff` 100% 全绿; 提示用户在替换业务代码时同步更新协议目录即可。
 */
function nextSteps(
  targetDir: string,
  installed: boolean,
  tier: Tier,
  projectName: string,
): string {
  const lines = ['', '下一步:', `  cd ${targetDir}`];
  if (!installed) lines.push('  bun install         # 安装依赖');
  lines.push('  bun run ci          # 验证全绿');
  if (tier === 'full') {
    lines.push(
      '  # full 档已内置最小 greet 协议与语料, 开箱 bun run ci 与 bun run fuzz:diff 全绿;',
    );
    lines.push(
      `  # 替换业务代码时同步更新 packages/${projectName}/docs/protocol/ 即可`,
    );
  }
  lines.push('  然后从 docs/README.md (文档总索引) 读起, 开始改造。');
  return lines.join('\n');
}

/**
 * 入口主流程; 返回进程退出码 (0 成功, 1 任一失败路径)。
 *
 * 路由顺序: `argv[0] === 'update'` 走自更新子命令 (可用 `create-clis -- update` 逃逸为目录名);
 * 其余交由 `parseFlags` 顺序解析 `-V`/`-h`/`--` 与旗标, 显式目录在问答前先做可用性校验。
 *
 * ### 数据流转示例
 * ```text
 * Input:  argv = ['.', '--tier', 'core', '--no-git', '--no-install']
 *         env  = { gitUserName: 'iyowei' }
 * Step 1: argv[0] !== 'update' -> parseFlags -> { dir: '.', suggestedName: '<cwd>', tier: 'core', git: false, install: false, yes: false }
 * Step 2: assertTargetAvailable(resolve(cwd, '.')) 前置检查非空目录, 避免答完题才报错
 * Step 3: askAll 交互收齐 -> { state: 'collected', vocabulary } (cancelled / error 在此早退 1)
 * Step 4: generateProject(...) -> { executed: [] } (--no-git --no-install 无收尾动作)
 * Output: return 0 (stdout 输出生成路径与 next steps)
 * ```
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv[0] === 'update') {
    try {
      return await runSelfUpdate({
        binName: 'create-clis',
        entryMetaUrl: import.meta.url,
        argv: argv.slice(1),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`更新失败: ${message}\n`);
      return 1;
    }
  }

  const parsed = parseFlags(argv);
  if ('error' in parsed) {
    process.stderr.write(`参数错误: ${parsed.error}\n`);
    return 1;
  }
  if (parsed.version) {
    process.stdout.write(`${readPackageMeta(import.meta.url).version}\n`);
    return 0;
  }
  if (parsed.help) {
    process.stdout.write(`${formatHelpText(stdoutSupportsColor())}\n`);
    return 0;
  }

  if (parsed.dir !== undefined) {
    // 前置校验目标目录可用性: 目录已存在且非空时直接拒绝, 避免先答完五题再报错
    const precheckDir = resolve(process.cwd(), parsed.dir);
    try {
      assertTargetAvailable(precheckDir);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`生成失败: ${message}\n`);
      return 1;
    }
  }

  const env: Environment = { gitUserName: readGitUserName() };
  const outcome = await askAll(createPromptIO(), env, parsed);
  if (outcome.state === 'cancelled') {
    process.stdout.write('已取消\n');
    return 1;
  }
  if (outcome.state === 'error') {
    process.stderr.write(`${outcome.error}\n`);
    return 1;
  }

  const vocabulary = outcome.vocabulary;
  const targetDir = resolve(process.cwd(), parsed.dir ?? vocabulary.name);
  const tier = parsed.tier ?? DEFAULT_TIER;

  process.stdout.write(`create-clis: 生成 ${vocabulary.name} → ${targetDir}\n`);
  try {
    const { executed } = await generateProject({
      // 模板源: 环境变量是内部注入点 (e2e / 内部复用), 缺省取包内 assets/template
      templateDir:
        provided(process.env.CREATE_CLIS_TEMPLATE_DIR) ?? defaultTemplateDir(),
      targetDir,
      vocabulary,
      tier,
      original: ORIGINAL,
      hooks: buildHooks(parsed),
    });
    if (executed.length > 0) {
      process.stdout.write(`收尾已执行: ${executed.join(', ')}\n`);
    }
    process.stdout.write(`已生成: ${targetDir} (档位: ${tier})\n`);
    process.stdout.write(
      `${nextSteps(targetDir, parsed.install, tier, vocabulary.name)}\n`,
    );
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`生成失败: ${message}\n`);
    // 目标拒绝发生在写入之前 (目标目录是用户自己的, 未被动过), 只有写入后的失败才有半成品;
    // 不得把拒绝路径的既有目录谎报为半成品 (如实指出原则)
    if (!(error instanceof TargetRejectedError) && existsSync(targetDir)) {
      process.stderr.write(
        `半成品目录已保留: ${targetDir} (未自动清理, 可自行查看或删除)\n`,
      );
    }
    return 1;
  }
}

process.exitCode = await main();
