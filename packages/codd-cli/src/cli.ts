/**
 * codd CLI 薄壳入口 (`@iyowei/codd-cli`): 编排 `args.ts`、`wizard.ts`、`ui/` 与 `@iyowei/codd`。
 * 支持交互式向导 (`codd wizard`, 且无参无 `deploy.json` 时 TTY 自动进入)、模板导出 (`codd init`)、
 * 自更新 (`codd update`) 与清单生成 (`codd [deploy.json]`)。
 * 退出码契约: `0` 成功 (含 help/version/init/dry-run), `1` 配置或运行错误, `130` 交互取消。
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
import { displayWidth, getBoxWidth } from './ui/ansi.ts';
import {
  isPromptCancelledError,
  palette,
  printAlert,
  printFormulaCard,
  printHeader,
  printSummaryCard,
  wrapMultiline,
} from './ui/index.ts';
import { runWizard } from './wizard.ts';

const printHelpSection = (title: string): void => {
  console.log('');
  console.log(`  ${palette.blue(title, true)}`);
};

const printHelpRows = (
  rows: ReadonlyArray<readonly [string, string, string?]>,
  colWidth: number,
  leftStyle: 'title' | 'mono' = 'mono',
): void => {
  const maxWidth = Math.max(44, getBoxWidth());
  const descWidth = Math.max(20, maxWidth - colWidth - 4);
  for (const [token, desc, arg] of rows) {
    const plainLeft = arg === undefined ? token : `${token} ${arg}`;
    const pad = ' '.repeat(Math.max(2, colWidth - displayWidth(plainLeft)));
    const styledToken =
      leftStyle === 'title' ? palette.title(token) : palette.mono(token);
    const styledLeft =
      arg === undefined ? styledToken : `${styledToken} ${palette.dim(arg)}`;
    const wrapped = wrapMultiline(desc, descWidth);
    console.log(`    ${styledLeft}${pad}${palette.muted(wrapped[0] ?? '')}`);
    const contIndent = ' '.repeat(
      4 + Math.max(colWidth, displayWidth(plainLeft) + 2),
    );
    for (let i = 1; i < wrapped.length; i += 1) {
      console.log(`${contIndent}${palette.muted(wrapped[i]!)}`);
    }
  }
};

const printUsage = (): void => {
  printHeader(
    'MongoDB 部署配置生成器',
    '根据你的服务器硬件自动推导缓存、压缩与安全参数, 一键导出可直接上线的 MongoDB 9.0 安装包。',
  );

  const HELP_COL = 22;

  printHelpSection('用法');
  console.log(
    `    ${palette.title('codd')} ${palette.dim('[配置文件.json] [选项]')}`,
  );
  console.log(`    ${palette.title('codd')} ${palette.dim('<子命令> [选项]')}`);

  printHelpSection('子命令');
  printHelpRows(
    [
      ['wizard', '启动 4 步交互式向导生成安装包 (同 -i / --wizard)'],
      ['init', '导出 deploy.schema.json、参考清单与 .gitignore'],
      ['update', '自动识别安装器升级到最新版 (--check 仅检查)'],
    ],
    HELP_COL,
    'title',
  );

  printHelpSection('选项');
  printHelpRows(
    [
      ['-c, --config', '指定 JSON 配置文件路径 (默认 ./deploy.json)', '<路径>'],
      ['-o, --out', '指定安装包的导出位置 (默认 ./dist)', '<目录>'],
      ['--rotate', '轮换业务库与备份账号密码 (线上 make init 生效)'],
      ['--rotate-all', '轮换含 root 在内的全部密码与密钥 (全新部署前)'],
      ['--new-fingerprint', '生成全新的实例唯一指纹 (同机并行部署新一套库)'],
      ['--dry-run', '只检查配置并预览参数配比, 不写入任何磁盘文件'],
      ['--init-schema', '与 codd init 等效, 导出 Schema 与参考模板'],
      ['--', '终止选项解析, 其后按清单路径处理 (如 -- -a.json)'],
    ],
    HELP_COL,
  );
  console.log('');
  printHelpRows(
    [
      ['-V, -v, --version', '打印当前 codd 版本号'],
      ['-h, --help', '打印本帮助说明'],
    ],
    HELP_COL,
  );

  printHelpSection('示例');
  printHelpRows(
    [
      ['codd wizard', '打开交互式配置向导'],
      ['codd init', '导出 Schema 与 2C2G 参考清单'],
      ['codd deploy-prod.json --dry-run', '预览参数配比与公式, 不写入文件'],
    ],
    34,
    'title',
  );

  printHelpSection('退出码');
  console.log(
    `    ${palette.green('0', true)}       ${palette.muted('成功 (含 --help、--version、init、--dry-run 与正常生成)')}`,
  );
  console.log(
    `    ${palette.red('1', true)}       ${palette.muted('错误 (参数错误、清单校验失败、状态文件损坏或 I/O 失败)')}`,
  );
  console.log(
    `    ${palette.amber('130', true)}     ${palette.muted('取消 (交互式向导被 Ctrl+C 或输入流关闭中断)')}`,
  );
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

/**
 * CLI 主路由: 依次分流 `--version` -> `--help` -> `update` -> `init` -> 向导或清单生成 (`generateBundle`),
 * 打印参数配比/汇总卡片并映射进程退出码 (`0` / `1` / `130`)。
 */
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
