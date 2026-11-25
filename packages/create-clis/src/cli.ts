/**
 * create-clis CLI 进程入口 (支持中英双语、操作系统语言自动探测与独立 `lang` 偏好持久化)。
 */
import { existsSync } from 'node:fs';
import { resolve } from 'node:path';

import {
  type Locale,
  resolveCliLocale,
  runLangCommand,
  stripLangArgs,
  t,
} from '@iyowei/cli-i18n';
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

function buildHooks(options: CliOptions): GenerateHooks {
  const hooks: GenerateHooks = {};
  if (options.git) hooks.gitInit = createGitInitHook();
  if (options.install) hooks.install = createInstallHook();
  return hooks;
}

function nextSteps(
  targetDir: string,
  installed: boolean,
  tier: Tier,
  projectName: string,
  locale: Locale,
): string {
  if (locale === 'en') {
    const lines = ['', 'Next steps:', `  cd ${targetDir}`];
    if (!installed) lines.push('  bun install         # install dependencies');
    lines.push('  bun run ci          # verify all checks pass');
    if (tier === 'full') {
      lines.push(
        "  # 'full' tier includes a minimal greet protocol & corpus (bun run ci & fuzz:diff green);",
      );
      lines.push(
        `  # update packages/${projectName}/docs/protocol/ when replacing sample code`,
      );
    }
    lines.push(
      '  Start reading from docs/README.md to customize your repository.',
    );
    return lines.join('\n');
  }

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

function localizeGenerateError(error: unknown, locale: Locale): string {
  const msg = error instanceof Error ? error.message : String(error);
  if (locale === 'zh') return msg;
  if (error instanceof TargetRejectedError) {
    return msg
      .replace(
        /^目标目录已存在且非空:\s*/,
        'Target directory already exists and is not empty: ',
      )
      .replace(
        /^目标路径已存在且不是目录:\s*/,
        'Target path already exists and is not a directory: ',
      );
  }
  return msg;
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const baseLocale = resolveCliLocale({ toolName: 'create-clis' }).locale;

  if (argv[0] === 'lang') {
    const stripped = stripLangArgs(argv.slice(1), {
      fallbackLocale: baseLocale,
    });
    if (stripped.error !== undefined) {
      process.stderr.write(`${stripped.error}\n`);
      return 1;
    }
    return runLangCommand({
      toolName: 'create-clis',
      binName: 'create-clis',
      argv: stripped.argv,
      flag: stripped.lang,
    });
  }

  if (argv[0] === 'update') {
    try {
      return await runSelfUpdate({
        binName: 'create-clis',
        toolName: 'create-clis',
        entryMetaUrl: import.meta.url,
        argv: argv.slice(1),
      });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(
        t(baseLocale, `更新失败: ${message}\n`, `Update failed: ${message}\n`),
      );
      return 1;
    }
  }

  const peeked = stripLangArgs(argv, {
    fallbackLocale: baseLocale,
    valueFlags: new Set([
      '--name',
      '--scope',
      '--bin',
      '--owner',
      '--repo',
      '--tier',
    ]),
  });
  const preLocale =
    peeked.lang !== undefined
      ? resolveCliLocale({ toolName: 'create-clis', flag: peeked.lang }).locale
      : baseLocale;

  const parsed = parseFlags(argv, preLocale);
  if ('error' in parsed) {
    process.stderr.write(
      t(
        preLocale,
        `参数错误: ${parsed.error}\n`,
        `Invalid argument: ${parsed.error}\n`,
      ),
    );
    return 1;
  }

  const locale = resolveCliLocale({
    toolName: 'create-clis',
    flag: parsed.lang,
  }).locale;

  if (parsed.version) {
    process.stdout.write(`${readPackageMeta(import.meta.url).version}\n`);
    return 0;
  }
  if (parsed.help) {
    process.stdout.write(`${formatHelpText(stdoutSupportsColor(), locale)}\n`);
    return 0;
  }

  if (parsed.dir !== undefined) {
    const precheckDir = resolve(process.cwd(), parsed.dir);
    try {
      assertTargetAvailable(precheckDir);
    } catch (error) {
      const message = localizeGenerateError(error, locale);
      process.stderr.write(
        t(locale, `生成失败: ${message}\n`, `Scaffold failed: ${message}\n`),
      );
      return 1;
    }
  }

  const env: Environment = { gitUserName: readGitUserName() };
  const outcome = await askAll(createPromptIO(), env, parsed, locale);
  if (outcome.state === 'cancelled') {
    process.stdout.write(t(locale, '已取消\n', 'Cancelled\n'));
    return 1;
  }
  if (outcome.state === 'error') {
    process.stderr.write(`${outcome.error}\n`);
    return 1;
  }

  const vocabulary = outcome.vocabulary;
  const targetDir = resolve(process.cwd(), parsed.dir ?? vocabulary.name);
  const tier = parsed.tier ?? DEFAULT_TIER;

  process.stdout.write(
    t(
      locale,
      `create-clis: 生成 ${vocabulary.name} → ${targetDir}\n`,
      `create-clis: Scaffolding ${vocabulary.name} → ${targetDir}\n`,
    ),
  );
  try {
    const { executed } = await generateProject({
      templateDir:
        provided(process.env.CREATE_CLIS_TEMPLATE_DIR) ?? defaultTemplateDir(),
      targetDir,
      vocabulary,
      tier,
      original: ORIGINAL,
      hooks: buildHooks(parsed),
    });
    if (executed.length > 0) {
      process.stdout.write(
        t(
          locale,
          `收尾已执行: ${executed.join(', ')}\n`,
          `Completed hooks: ${executed.join(', ')}\n`,
        ),
      );
    }
    process.stdout.write(
      t(
        locale,
        `已生成: ${targetDir} (档位: ${tier})\n`,
        `Generated: ${targetDir} (tier: ${tier})\n`,
      ),
    );
    process.stdout.write(
      `${nextSteps(targetDir, parsed.install, tier, vocabulary.name, locale)}\n`,
    );
    return 0;
  } catch (error) {
    const message = localizeGenerateError(error, locale);
    process.stderr.write(
      t(locale, `生成失败: ${message}\n`, `Scaffold failed: ${message}\n`),
    );
    if (!(error instanceof TargetRejectedError) && existsSync(targetDir)) {
      process.stderr.write(
        t(
          locale,
          `半成品目录已保留: ${targetDir} (未自动清理, 可自行查看或删除)\n`,
          `Partial directory preserved: ${targetDir} (inspect or remove manually)\n`,
        ),
      );
    }
    return 1;
  }
}

process.exitCode = await main();
