/**
 * codd CLI 入口: 支持交互式向导 (codd wizard) 与指定清单生成 (codd [deploy.json])。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { stdin, stdout } from 'node:process';

import {
  copyTemplateFile,
  readPackageVersion,
  resolveTemplateRoot,
} from './assets.ts';
import { generateBundle } from './generate.ts';
import { ConfigError, type DeployManifest, type RotateMode } from './types.ts';
import { palette } from './ui/ansi.ts';
import {
  printAlert,
  printFormulaCard,
  printHeader,
  printKV,
  printSummaryCard,
} from './ui/widgets.ts';
import { runWizard } from './wizard.ts';

interface CliFlags {
  manifestPath?: string;
  outDir?: string;
  rotate: RotateMode;
  newFingerprint: boolean;
  dryRun: boolean;
  wizard: boolean;
  initSchema: boolean;
  help: boolean;
  version: boolean;
}

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
    [
      '--init-schema',
      '将 deploy.schema.json 与参考模板 deploy-2c2g.json 导出到当前目录',
    ],
    ['-v, --version', '打印当前 codd 版本号'],
    ['-h, --help', '打印本帮助说明'],
  ]);
  console.log('');
};

const parseCliArgs = (argv: string[]): CliFlags => {
  const flags: CliFlags = {
    rotate: 'none',
    newFingerprint: false,
    dryRun: false,
    wizard: false,
    initSchema: false,
    help: false,
    version: false,
  };

  let i = 0;
  while (i < argv.length) {
    const arg = argv[i]!;
    if (arg === '--') {
      i += 1;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      flags.help = true;
    } else if (arg === '--version' || arg === '-v') {
      flags.version = true;
    } else if (arg === 'wizard' || arg === '--wizard' || arg === '-i') {
      flags.wizard = true;
    } else if (arg === 'init' || arg === '--init-schema') {
      flags.initSchema = true;
    } else if ((arg === '--config' || arg === '-c') && argv[i + 1]) {
      flags.manifestPath = argv[i + 1];
      i += 2;
      continue;
    } else if (arg.startsWith('--config=')) {
      flags.manifestPath = arg.slice('--config='.length);
    } else if ((arg === '--out' || arg === '-o') && argv[i + 1]) {
      flags.outDir = argv[i + 1];
      i += 2;
      continue;
    } else if (arg.startsWith('--out=')) {
      flags.outDir = arg.slice('--out='.length);
    } else if (arg === '--rotate') {
      flags.rotate = flags.rotate === 'all' ? 'all' : 'apps';
    } else if (arg === '--rotate-all') {
      flags.rotate = 'all';
    } else if (arg === '--new-fingerprint') {
      flags.newFingerprint = true;
    } else if (arg === '--dry-run') {
      flags.dryRun = true;
    } else if (!arg.startsWith('-') && !flags.manifestPath) {
      flags.manifestPath = arg;
    } else {
      throw new ConfigError(
        `不认识的参数「${arg}」, 请运行 codd --help 查看全部可用选项`,
      );
    }
    i += 1;
  }
  return flags;
};

const exportSchemaAndSample = (workDir: string): void => {
  const schemaTplDir = join(resolveTemplateRoot(), 'schema');
  const dstSchema = join(workDir, 'deploy.schema.json');
  const dstSample = join(workDir, 'deploy-2c2g.json');
  copyTemplateFile(schemaTplDir, 'deploy.schema.json', dstSchema);
  if (!existsSync(dstSample)) {
    copyTemplateFile(schemaTplDir, 'deploy-2c2g.json', dstSample);
  }
  const gitignorePath = join(workDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(
      gitignorePath,
      'dist/\n.codd-state/\ndeploy*.json\n!deploy-2c2g.json\n!deploy.schema.json\n',
      'utf8',
    );
  }
  printHeader(
    '配置模板已导出',
    '已在当前目录生成 JSON Schema 与 2C2G 参考清单。',
  );
  console.log('');
  printAlert('ok', `已写入 ${dstSchema}`);
  printAlert(
    'ok',
    `参考配置 ${dstSample} (可复制为 deploy.json 后运行 codd deploy.json)`,
  );
  console.log('');
};

const main = async (): Promise<number> => {
  try {
    const opts = parseCliArgs(process.argv.slice(2));
    if (opts.version) {
      stdout.write(`${readPackageVersion()}\n`);
      return 0;
    }
    if (opts.help) {
      printUsage();
      return 0;
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
        'MongoDB 部署包生成',
        '已读取配置文件并自动为你测算参数与生成唯一实例指纹。',
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

    printSummaryCard(
      '安装包已准备就绪',
      `${res.deployId} · 指纹 ${res.fingerprint}`,
      [
        ['唯一实例指纹', `${res.fingerprint} (已自动嵌入目录、卷与网络防重名)`],
        [
          '账号密码与连接串',
          `${res.credentialsFile} (仅本机可读 0600, 请勿上传服务器)`,
        ],
        ['本机状态锁文件', res.stateFile],
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
    console.log(`  ${palette.title('接下来只需按顺序执行:')}`);
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
    const msg = err instanceof Error ? err.message : String(err);
    console.log('');
    printAlert('err', msg);
    console.log('');
    return 1;
  }
};

process.exitCode = await main();
