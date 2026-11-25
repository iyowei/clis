/**
 * codd CLI 薄壳入口 (`@iyowei/codd-cli`, 支持中英双语、操作系统语言自动探测与独立 `lang` 偏好持久化):
 * 退出码契约: `0` 成功 (含 help/version/init/dry-run/lang/update), `1` 错误, `130` 交互取消。
 */
import { existsSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';

import {
  resolveCliLocale,
  runLangCommand,
  stripLangArgs,
} from '@iyowei/cli-i18n';
import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type DeployManifest,
  generateBundle,
  readPackageVersion,
} from '@iyowei/codd';

import { parseCliArgs } from './args.ts';
import {
  exportSchemaAndSample,
  printBundleOutcome,
  printUsage,
} from './cli-views.ts';
import { ct, localizeCoddError, setCoddLocale } from './i18n.ts';
import { hasColor, hasStderrColor } from './ui/ansi.ts';
import {
  isPromptCancelledError,
  printAlert,
  printFormulaCard,
  printHeader,
} from './ui/index.ts';
import { runWizard } from './wizard.ts';

const main = async (): Promise<number> => {
  const rawArgv = process.argv.slice(2);
  const baseLocale = resolveCliLocale({ toolName: 'codd' }).locale;
  const peeked = stripLangArgs(rawArgv, {
    fallbackLocale: baseLocale,
    valueFlags: new Set(['-c', '--config', '-o', '--out']),
  });
  const preLocale =
    peeked.lang !== undefined
      ? resolveCliLocale({ toolName: 'codd', flag: peeked.lang }).locale
      : baseLocale;
  setCoddLocale(preLocale);

  try {
    const opts = parseCliArgs(rawArgv, preLocale);
    const locale = resolveCliLocale({
      toolName: 'codd',
      flag: opts.lang,
    }).locale;
    setCoddLocale(locale);

    if (opts.langSubcommand) {
      const stripped = stripLangArgs(opts.langArgs ?? [], {
        fallbackLocale: locale,
      });
      if (stripped.error !== undefined) {
        stderr.write('\n');
        printAlert('err', stripped.error);
        stderr.write('\n');
        return 1;
      }
      return runLangCommand({
        toolName: 'codd',
        binName: 'codd',
        argv: stripped.argv,
        flag: stripped.lang,
        color: { stdout: hasColor(), stderr: hasStderrColor() },
      });
    }

    if (opts.version) {
      stdout.write(`${readPackageVersion(import.meta.url)}\n`);
      return 0;
    }
    if (opts.help) {
      printUsage(locale);
      return 0;
    }
    if (opts.update) {
      return await runSelfUpdate({
        binName: 'codd',
        toolName: 'codd',
        entryMetaUrl: import.meta.url,
        argv: opts.updateArgs ?? [],
      });
    }

    const workDir = resolve(process.cwd());
    if (opts.initSchema) {
      exportSchemaAndSample(workDir, import.meta.url);
      return 0;
    }

    const defaultCfg = join(workDir, 'deploy.json');
    let manifest: DeployManifest | undefined;
    const usingWizard =
      opts.wizard ||
      (!opts.manifestPath &&
        !existsSync(defaultCfg) &&
        stdin.isTTY &&
        stdout.isTTY);

    if (usingWizard) {
      manifest = await runWizard(workDir, opts.manifestPath, opts.dryRun);
    } else {
      printHeader(
        opts.dryRun
          ? ct(
              'MongoDB 配置校验与参数预览',
              'Dry-Run Configuration & Sizing Preview',
            )
          : ct('MongoDB 部署包生成', 'MongoDB Deployment Bundle'),
        opts.dryRun
          ? ct(
              '已读取配置文件并完成干跑校验与参数测算 (不会写出任何磁盘文件)。',
              'Validated manifest and computed hardware sizing (no files written to disk).',
            )
          : ct(
              '已读取配置文件并自动为你测算参数与生成唯一实例指纹。',
              'Loaded manifest, computed sizing parameters, and bound collision-free fingerprint.',
            ),
      );
    }

    const res = generateBundle({
      workDir,
      manifest,
      manifestPath: opts.manifestPath,
      outDir: opts.outDir,
      rotate: opts.rotate,
      newFingerprint: opts.newFingerprint,
      dryRun: opts.dryRun,
    });

    if (!usingWizard) {
      printFormulaCard(res.sizing.hardwareSummary, res.sizing.steps);
    }

    printBundleOutcome(res, opts.dryRun, locale);
    return 0;
  } catch (err) {
    if (isPromptCancelledError(err)) {
      stderr.write('\n');
      printAlert(
        'err',
        err.message || ct('已取消配置向导', 'Wizard cancelled'),
      );
      stderr.write('\n');
      return 130;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write('\n');
    printAlert('err', localizeCoddError(msg));
    stderr.write('\n');
    return 1;
  }
};

process.exitCode = await main();
