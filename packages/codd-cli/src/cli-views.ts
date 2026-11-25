/**
 * codd CLI 帮助页、`codd init` 模板导出与部署包结果面板渲染视图 (中英双语)。
 */
import { existsSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { type Locale } from '@iyowei/cli-i18n';
import {
  type GenerateResult,
  copyTemplateFile,
  resolveTemplateRoot,
} from '@iyowei/codd';

import { ct, localizeCoddWarning } from './i18n.ts';
import { displayWidth, getBoxWidth } from './ui/ansi.ts';
import {
  palette,
  printAlert,
  printHeader,
  printSummaryCard,
  wrapMultiline,
} from './ui/index.ts';

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

export const printUsage = (locale: Locale): void => {
  if (locale === 'en') {
    const EN_COL = 22;
    printHeader(
      'MongoDB 9.0 Provisioning Generator',
      'Derives WiredTiger cache, compression, and security parameters from your server specs and emits ready-to-ship Podman or Helm bundles.',
    );

    printHelpSection('Usage');
    console.log(
      `    ${palette.title('codd')} ${palette.dim('[manifest.json] [options]')}`,
    );
    console.log(
      `    ${palette.title('codd')} ${palette.dim('<command> [options]')}`,
    );

    printHelpSection('Commands');
    printHelpRows(
      [
        ['wizard', 'Interactive 4-step setup wizard (-i, --wizard)'],
        ['init', 'Export schema, 2C2G starter manifest & .gitignore'],
        ['lang', 'Show or save display language (system | en | zh)'],
        ['update', 'Upgrade CLI via detected installer (--check only)'],
      ],
      EN_COL,
      'title',
    );

    printHelpSection('Options');
    printHelpRows(
      [
        [
          '-c, --config',
          'JSON manifest file path (default: ./deploy.json)',
          '<path>',
        ],
        ['-o, --out', 'Bundle output directory (default: ./dist)', '<dir>'],
        ['--rotate', 'Rotate app and backup user passwords'],
        ['--rotate-all', 'Rotate all credentials & keyFile including root'],
        [
          '--new-fingerprint',
          'Mint a fresh fingerprint for side-by-side deploys',
        ],
        ['--dry-run', 'Validate manifest and preview sizing (no writes)'],
        ['--init-schema', 'Alias for codd init (export schema & starter)'],
        [
          '--lang',
          'Override language for this run (system | en | zh)',
          '<lang>',
        ],
        ['--', 'Stop flag parsing; treat next token as file path'],
      ],
      EN_COL,
    );
    console.log('');
    printHelpRows(
      [
        ['-V, -v, --version', 'Print current codd version'],
        ['-h, --help', 'Show this help message'],
      ],
      EN_COL,
    );

    printHelpSection('Examples');
    printHelpRows(
      [
        ['codd wizard', 'Open interactive provisioning wizard'],
        ['codd init', 'Export schema & 2C2G starter manifest'],
        [
          'codd deploy-prod.json --dry-run',
          'Preview sizing without writing files',
        ],
        ['codd lang en', 'Pin display language to English'],
      ],
      34,
      'title',
    );

    printHelpSection('Exit Codes');
    console.log(
      `    ${palette.green('0', true)}       ${palette.muted('Success (--help, --version, init, --dry-run, lang, update, bundle)')}`,
    );
    console.log(
      `    ${palette.red('1', true)}       ${palette.muted('Error (bad flags, manifest/state error, update, or I/O failure)')}`,
    );
    console.log(
      `    ${palette.amber('130', true)}     ${palette.muted('Cancelled (interactive wizard interrupted via Ctrl+C or EOF)')}`,
    );
    console.log('');
    return;
  }

  const HELP_COL = 24;

  printHeader(
    'MongoDB 部署配置生成器',
    '根据你的服务器硬件自动推导缓存、压缩与安全参数, 一键导出可直接上线的 MongoDB 9.0 安装包。',
  );

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
      ['lang', '查看或设置显示语言 (system | en | zh, 默认 system)'],
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
      ['--lang', '单次覆盖显示语言 (system | en | zh)', '<语言>'],
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
    `    ${palette.green('0', true)}       ${palette.muted('成功 (含 --help、--version、init、--dry-run、lang、update 与正常生成)')}`,
  );
  console.log(
    `    ${palette.red('1', true)}       ${palette.muted('错误 (参数错误、清单校验失败、update 失败、状态文件损坏或 I/O 失败)')}`,
  );
  console.log(
    `    ${palette.amber('130', true)}     ${palette.muted('取消 (交互式向导被 Ctrl+C 或输入流关闭中断)')}`,
  );
  console.log('');
};

export const exportSchemaAndSample = (
  workDir: string,
  entryMetaUrl: string,
): void => {
  const schemaTplDir = join(
    resolveTemplateRoot(undefined, entryMetaUrl),
    'schema',
  );
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
    ct('配置模板已导出', 'Starter Templates Exported'),
    ct(
      '已在当前目录准备 JSON Schema 与 2C2G 参考清单。',
      'Prepared JSON Schema and 2C2G starter manifest in the current directory.',
    ),
  );
  console.log('');
  printAlert('ok', ct(`已写入 ${dstSchema}`, `Wrote ${dstSchema}`));
  if (sampleCreated) {
    printAlert(
      'ok',
      ct(
        `已创建参考配置 ${dstSample} (可复制为 deploy.json 后运行 codd deploy.json)`,
        `Created sample manifest ${dstSample} (copy to deploy.json and run codd deploy.json)`,
      ),
    );
  } else {
    printAlert(
      'warn',
      ct(
        `${dstSample} 已存在, 已跳过覆盖`,
        `${dstSample} already exists; skipped`,
      ),
    );
  }
  if (gitignoreCreated) {
    printAlert(
      'ok',
      ct(
        `已创建 ${gitignorePath} (自动忽略 dist/、.codd-state/ 与本地 deploy*.json)`,
        `Created ${gitignorePath} (ignores dist/, .codd-state/, and local deploy*.json)`,
      ),
    );
  } else {
    printAlert(
      'warn',
      ct(
        `${gitignorePath} 已存在, 已跳过写入 (请确认已忽略 dist/ 与 .codd-state/)`,
        `${gitignorePath} already exists; verify dist/ and .codd-state/ are ignored`,
      ),
    );
  }
  console.log('');
};

export const printBundleOutcome = (
  res: GenerateResult,
  dryRun: boolean,
  locale: Locale,
): void => {
  for (const w of res.warnings) {
    console.log('');
    printAlert('warn', localizeCoddWarning(w, locale));
  }

  const summaryTitle = dryRun
    ? ct(
        '配置校验与参数预览 (Dry Run · 未写入磁盘)',
        'Dry-Run Preview (No Files Written)',
      )
    : ct('安装包已准备就绪', 'Deployment Bundle Ready');
  const credRow: [string, string] = dryRun
    ? [
        ct('计划凭证文件 (未落盘)', 'Credentials (planned)'),
        ct(
          `${res.credentialsFile} (正式生成时按 0600 写出)`,
          `${res.credentialsFile} (written 0600 on full run)`,
        ),
      ]
    : [
        ct('账号密码与连接串', 'Credentials & URIs'),
        ct(
          `${res.credentialsFile} (仅本机可读 0600, 请勿上传服务器)`,
          `${res.credentialsFile} (mode 0600, keep local only)`,
        ),
      ];
  const stateRow: [string, string] = dryRun
    ? [ct('计划状态锁文件 (未落盘)', 'State Lock (planned)'), res.stateFile]
    : [ct('本机状态锁文件', 'Local State Lock'), res.stateFile];

  printSummaryCard(
    summaryTitle,
    ct(
      `${res.deployId} · 指纹 ${res.fingerprint}`,
      `${res.deployId} · fp ${res.fingerprint}`,
    ),
    [
      [
        ct('唯一实例指纹', 'Instance Fingerprint'),
        ct(
          `${res.fingerprint} (已自动嵌入目录、卷与网络防重名)`,
          `${res.fingerprint} (isolates dirs, volumes, & networks)`,
        ),
      ],
      credRow,
      stateRow,
      ...res.bundleDirs.map(
        (d, i) =>
          [
            res.bundleDirs.length > 1
              ? ct(`节点安装包 ${i + 1}`, `Node Bundle ${i + 1}`)
              : ct('生成的安装包目录', 'Bundle Directory'),
            d,
          ] as [string, string],
      ),
      ...res.backupDirs.map(
        (b, i) =>
          [
            res.backupDirs.length > 1
              ? ct(`服务器备份路径 ${i + 1}`, `Server Backup ${i + 1}`)
              : ct('服务器备份文件夹', 'Server Backup Dir'),
            b,
          ] as [string, string],
      ),
    ],
  );

  console.log('');
  console.log(
    `  ${palette.title(
      dryRun
        ? ct('预览结论:', 'Preview Summary:')
        : ct('接下来只需按顺序执行:', 'Next steps:'),
    )}`,
  );
  for (let idx = 0; idx < res.nextSteps.length; idx += 1) {
    const stepText =
      locale === 'en'
        ? res.nextSteps[idx]!.replace(
            /^干跑通过: 移除 --dry-run 后将在 /,
            'Dry-run passed: remove --dry-run to generate bundle in ',
          )
        : res.nextSteps[idx]!;
    console.log(
      `    ${palette.blue(`${idx + 1}.`, true)}  ${palette.mono(stepText)}`,
    );
  }
  if (!dryRun) {
    console.log(
      `    ${palette.blue(`${res.nextSteps.length + 1}.`, true)}  ${palette.muted(
        ct(
          `查看自动生成的数据库账号密码与连接地址: cat "${res.credentialsFile}"`,
          `Inspect generated credentials & connection URIs: cat "${res.credentialsFile}"`,
        ),
      )}`,
    );
  }
  console.log('');
};
