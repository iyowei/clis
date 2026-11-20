/**
 * codd CLI 薄壳入口 (@iyowei/codd-cli):
 * 支持交互式向导 (codd wizard)、模板导出 (codd init / --init-schema) 与清单生成 (codd [deploy.json])。
 * 全部核心公式推导、校验与模板渲染能力均来自 @iyowei/codd。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stderr, stdin, stdout } from 'node:process';

import { runSelfUpdate } from '@iyowei/cli-updater';
import {
  type DeployManifest,
  copyTemplateFile,
  generateBundle,
  readPackageVersion,
  resolveTemplateRoot,
} from '@iyowei/codd';

import { parseCliArgs } from './args.ts';
import {
  isPromptCancelledError,
  palette,
  printAlert,
  printFormulaCard,
  printHeader,
  printKV,
  printSummaryCard,
} from './ui/index.ts';
import { runWizard } from './wizard.ts';

const printUsage = (): void => {
  printHeader(
    'MongoDB 部署配置生成器',
    '根据你的服务器硬件自动推导缓存、压缩与安全参数, 一键导出可直接上线的 MongoDB 9.0 安装包。',
  );
  console.log('');
  printKV([
    [
      'codd wizard',
      '打开交互式向导, 一步步引导生成配置与安装包 (新手推荐, 等效于 -i / --wizard)',
    ],
    [
      'codd init',
      '在当前目录导出 deploy.schema.json、deploy-2c2g.json 参考清单与安全 .gitignore (等效于 --init-schema)',
    ],
    [
      'codd update',
      '自动识别当前安装器 (bun/npm/pnpm/yarn/volta) 升级到最新版 (--check 仅检查)',
    ],
    [
      'codd [配置文件.json]',
      '按指定 JSON 清单生成 (如 codd deploy-prod.json; 不传默认读 ./deploy.json)',
    ],
    [
      '-c, --config <文件路径>',
      '指定要读取的 JSON 配置文件路径 (与直接传文件名等效)',
    ],
    ['-o, --out <输出目录>', '指定安装包的导出位置 (默认 ./dist)'],
    [
      '--rotate',
      '只更换业务库与备份账号的密码 (数据库运行时可执行 make init 生效)',
    ],
    [
      '--rotate-all',
      '更换包括管理员 root 在内的全部密码和密钥 (仅限全新部署前使用)',
    ],
    [
      '--new-fingerprint',
      '生成全新的实例唯一指纹 (同台服务器再装一套新库时使用)',
    ],
    ['--dry-run', '只检查配置并预览计算出的参数, 不写入任何文件'],
    ['--init-schema', '与 codd init 等效, 导出 JSON Schema 与 2C2G 参考模板'],
    [
      '--',
      '终止选项解析, 其后参数均按配置文件路径处理 (如 codd -- -staging.json)',
    ],
    ['-v, --version', '打印当前 codd 版本号'],
    ['-h, --help', '打印本帮助说明'],
  ]);
  console.log('');
};

const exportSchemaAndSample = (workDir: string): void => {
  const schemaTplDir = join(resolveTemplateRoot(), 'schema');
  const dstSchema = join(workDir, 'deploy.schema.json');
  const dstSample = join(workDir, 'deploy-2c2g.json');
  copyTemplateFile(schemaTplDir, 'deploy.schema.json', dstSchema);
  let sampleCreated = false;
  if (!existsSync(dstSample)) {
    copyTemplateFile(schemaTplDir, 'deploy-2c2g.json', dstSample);
    sampleCreated = true;
  }

  const gitignorePath = join(workDir, '.gitignore');
  let gitignoreCreated = false;
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      'dist/\n.codd-state/\ndeploy*.json\n!deploy-2c2g.json\n!deploy.schema.json\n',
      'utf8',
    );
    gitignoreCreated = true;
  }

  printHeader(
    '配置模板已导出',
    '已在当前目录准备 JSON Schema 与 2C2G 参考清单。',
  );
  console.log('');
  printAlert('ok', `已写入 ${dstSchema}`);
  if (sampleCreated) {
    printAlert(
      'ok',
      `已创建参考配置 ${dstSample} (可复制为 deploy.json 后运行 codd deploy.json)`,
    );
  } else {
    printAlert('warn', `${dstSample} 已存在, 已跳过覆盖`);
  }
  if (gitignoreCreated) {
    printAlert(
      'ok',
      `已创建 ${gitignorePath} (自动忽略 dist/、.codd-state/ 与本地 deploy*.json)`,
    );
  } else {
    printAlert(
      'warn',
      `${gitignorePath} 已存在, 已跳过写入 (请确认已忽略 dist/ 与 .codd-state/)`,
    );
  }
  console.log('');
};

const main = async (): Promise<number> => {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.version) {
      stdout.write(`${readPackageVersion(import.meta.url)}\n`);
      return 0;
    }
    if (opts.help) {
      printUsage();
      return 0;
    }
    if (opts.update) {
      return await runSelfUpdate({
        binName: 'codd',
        entryMetaUrl: import.meta.url,
        argv: opts.updateArgs ?? [],
      });
    }

    const workDir = resolve(process.cwd());
    if (opts.initSchema) {
      exportSchemaAndSample(workDir);
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
        opts.dryRun ? 'MongoDB 配置校验与参数预览' : 'MongoDB 部署包生成',
        opts.dryRun
          ? '已读取配置文件并完成干跑校验与参数测算 (不会写出任何磁盘文件)。'
          : '已读取配置文件并自动为你测算参数与生成唯一实例指纹。',
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

    for (const w of res.warnings) {
      console.log('');
      printAlert('warn', w);
    }

    const summaryTitle = opts.dryRun
      ? '配置校验与参数预览 (Dry Run · 未写入磁盘)'
      : '安装包已准备就绪';
    const credRow: [string, string] = opts.dryRun
      ? [
          '计划凭证文件 (未落盘)',
          `${res.credentialsFile} (正式生成时按 0600 写出)`,
        ]
      : [
          '账号密码与连接串',
          `${res.credentialsFile} (仅本机可读 0600, 请勿上传服务器)`,
        ];
    const stateRow: [string, string] = opts.dryRun
      ? ['计划状态锁文件 (未落盘)', res.stateFile]
      : ['本机状态锁文件', res.stateFile];

    printSummaryCard(
      summaryTitle,
      `${res.deployId} · 指纹 ${res.fingerprint}`,
      [
        ['唯一实例指纹', `${res.fingerprint} (已自动嵌入目录、卷与网络防重名)`],
        credRow,
        stateRow,
        ...res.bundleDirs.map(
          (d, i) =>
            [
              res.bundleDirs.length > 1
                ? `节点安装包 ${i + 1}`
                : '生成的安装包目录',
              d,
            ] as [string, string],
        ),
        ...res.backupDirs.map(
          (b, i) =>
            [
              res.backupDirs.length > 1
                ? `服务器备份路径 ${i + 1}`
                : '服务器备份文件夹',
              b,
            ] as [string, string],
        ),
      ],
    );

    console.log('');
    console.log(
      `  ${palette.title(opts.dryRun ? '预览结论:' : '接下来只需按顺序执行:')}`,
    );
    for (let idx = 0; idx < res.nextSteps.length; idx += 1) {
      console.log(
        `    ${palette.blue(`${idx + 1}.`, true)}  ${palette.mono(res.nextSteps[idx]!)}`,
      );
    }
    if (!opts.dryRun) {
      console.log(
        `    ${palette.blue(`${res.nextSteps.length + 1}.`, true)}  ${palette.muted(`查看自动生成的数据库账号密码与连接地址: cat "${res.credentialsFile}"`)}`,
      );
    }
    console.log('');
    return 0;
  } catch (err) {
    if (isPromptCancelledError(err)) {
      stderr.write('\n');
      printAlert('err', err.message || '已取消配置向导');
      stderr.write('\n');
      return 130;
    }
    const msg = err instanceof Error ? err.message : String(err);
    stderr.write('\n');
    printAlert('err', msg);
    stderr.write('\n');
    return 1;
  }
};

process.exitCode = await main();
