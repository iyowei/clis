/**
 * create-clis 入口: 旗标解析 → 变量收集 (交互 / 零交互三态) → 生成主流程 (generate.ts) →
 * next steps 打印。
 *
 * 契约以 docs/designs/scaffold-contract.md 为权威: 旗标清单、目录缺省 (项目名命名的子目录)、
 * 失败处理 (打印原因 + 非零退出码; 半成品目录如实指出, 不悄悄清理)。
 * 本文件是进程壳: 收集与生成的全部逻辑在 prompt.ts / generate.ts, 测试面见 cli.e2e.test.ts。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type GenerateHooks,
  createGitInitHook,
  createInstallHook,
  generateProject,
} from './generate.ts';
import { askAll, createPromptIO } from './prompt.ts';
import { ORIGINAL, defaultTemplateDir } from './template-snapshot.ts';
import {
  type CliOptions,
  DEFAULT_TIER,
  type Environment,
  parseFlags,
  provided,
  readGitUserName,
} from './variables.ts';

const HELP_TEXT = [
  'create-clis: 从 clis 集合仓骨架快照生成独立的新集合仓',
  '',
  '用法: create-clis [目录] [选项]',
  '',
  '目录缺省为当前目录下以项目名命名的子目录; 目标目录已存在且非空时直接拒绝 (不覆盖)。',
  '',
  '选项:',
  '  --name <名>       项目名 (kebab-case; 缺省取目录 basename)',
  '  --scope <@scope>  npm scope (缺省裸包名)',
  '  --bin <名>        主命令名 (缺省由项目名派生短形态)',
  '  --owner <名>      仓库所有者 (缺省取 git 全局 user.name)',
  '  --repo <url>      仓库地址 (缺省 https://github.com/<owner>/<name>)',
  '  --tier <档>       装备档位: core | standard | full (缺省 standard)',
  '  --no-git          跳过 git init (默认执行)',
  '  --no-install      跳过依赖安装 (默认执行)',
  '  --yes             全部取默认值, 零交互',
  '  --help            本帮助',
  '',
  '经 npm create 调用时旗标写在 -- 之后 (npm create clis -- --tier core), 该 -- 由 npm 剥离。',
].join('\n');

/** 由旗标构造收尾 hooks: 未提供的动作即不执行 (--no-git / --no-install 的折算点) */
function buildHooks(options: CliOptions): GenerateHooks {
  const hooks: GenerateHooks = {};
  if (options.git) hooks.gitInit = createGitInitHook();
  if (options.install) hooks.install = createInstallHook();
  return hooks;
}

/** next steps 文案: 进入目录 → 装依赖 (仅未装时) → ci 验证 → 从定位文档读起 */
function nextSteps(targetDir: string, installed: boolean): string {
  const lines = ['', '下一步:', `  cd ${targetDir}`];
  if (!installed) lines.push('  bun install         # 安装依赖');
  lines.push('  bun run ci          # 验证全绿');
  lines.push(
    '  然后从 docs/designs/collection-positioning.md 读起, 开始改造。',
  );
  return lines.join('\n');
}

/**
 * 入口主流程; 返回进程退出码 (0 成功, 1 任一失败路径)。
 *
 * 注: `--help` 在 parseFlags 之前拦截 (解析器视 `--help` 为未知旗标)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   argv = ['.', '--tier', 'core', '--no-git', '--no-install']
 *   env  = { gitUserName: 'iyowei' }   *(git 全局 user.name 的读取结果)*
 *
 * 步骤 1：旗标解析与变量收集 (三态之一)
 *   parseFlags → { dir: '.', tier: 'core', git: false, install: false, yes: false }
 *   askAll 交互收齐 → { state: 'collected', vocabulary: { name: ..., ... } }
 *   *(cancelled / error 两态在此分流: 取消打印后退 1, 旗标非法打印原因后退 1)*
 *
 * 步骤 2：生成
 *   targetDir = resolve(cwd, '.')  *(目录缺省时取 vocabulary.name)*
 *   generateProject 成功 → { executed: [] }  *(--no-git --no-install: 无收尾动作)*
 *
 * Output（数据契约）
 *   return 0  *(stdout 已打印 "已生成: <dir>" 与 next steps)*
 * ```
 */
async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  if (argv.includes('--help')) {
    process.stdout.write(`${HELP_TEXT}\n`);
    return 0;
  }

  const parsed = parseFlags(argv);
  if ('error' in parsed) {
    process.stderr.write(`参数错误: ${parsed.error}\n`);
    return 1;
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
    process.stdout.write(`${nextSteps(targetDir, parsed.install)}\n`);
    return 0;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`生成失败: ${message}\n`);
    if (existsSync(targetDir)) {
      process.stderr.write(
        `半成品目录已保留: ${targetDir} (未自动清理, 可自行查看或删除)\n`,
      );
    }
    return 1;
  }
}

process.exitCode = await main();
