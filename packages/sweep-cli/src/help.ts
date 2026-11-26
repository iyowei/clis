/**
 * 帮助页文案与分层排版渲染 (零外部依赖, 中英双语均严守 80 列行宽与 OF-10 降级恒等式):
 * 红线: 命令面以 `cli-surface.md` 为唯一事实来源; 新增子命令或旗标须与语料 `cli-help` 同批更新 (BC-30)。
 */
import type { Locale } from '@iyowei/cli-i18n';
import { resolveConfigPath } from '@iyowei/sweep';

import { BAR_BLOCK, paint, sanitizeLine } from './render.ts';

function createStyler(color: boolean) {
  return {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    bold: (s: string) => paint(s, '1', color),
    dim: (s: string) => paint(s, '2', color),
    section: (s: string) => paint(s, '1;34', color),
    token: (s: string) => paint(s, '36', color),
    green: (s: string) => paint(s, '1;32', color),
    red: (s: string) => paint(s, '1;31', color),
  };
}

interface CommandRow {
  name: string;
  desc: string;
}

interface OptionRow {
  flag: string;
  arg?: string;
  desc: string;
}

interface ExampleRow {
  cmd: string;
  flag?: string;
  arg?: string;
  desc: string;
}

const SUBCOMMANDS_ZH: readonly CommandRow[] = [
  {
    name: 'init',
    desc: '交互式向导生成 v2 配置 (支持 --default 写入最佳实践)',
  },
  { name: 'migrate', desc: '无损迁移旧版配置到 v2 (写前自动备份原配置)' },
  { name: 'config', desc: '查看实际生效的配置 (来源 / 路径 / 状态)' },
  { name: 'lang', desc: '查看或设置显示语言 (system | en | zh, 默认 system)' },
  { name: 'update', desc: '自动识别安装器升级到最新版 (--check 仅检查)' },
];

const SUBCOMMANDS_EN: readonly CommandRow[] = [
  { name: 'init', desc: 'Interactive v2 setup wizard (--default for preset)' },
  { name: 'migrate', desc: 'Losslessly migrate v1 config with auto-backup' },
  { name: 'config', desc: 'Show active config path, source, and file state' },
  { name: 'lang', desc: 'Show or save display language (system | en | zh)' },
  { name: 'update', desc: 'Upgrade CLI via detected installer (--check only)' },
];

const ACTION_OPTIONS_ZH: readonly OptionRow[] = [
  { flag: '--yes', desc: '执行清理 (默认仅预览, 零副作用)' },
  { flag: '--force', desc: '连同疑似安装树一并清理 (默认跳过)' },
  { flag: '--default', desc: '配合 init 直接写入完整最佳实践默认配置' },
  {
    flag: '--exclude',
    arg: '<name>',
    desc: '按目录名临时追加排除 (可重复, 与配置合并)',
  },
  {
    flag: '--include',
    arg: '<name>',
    desc: '仅清理命中目录名的项目 (可重复, 与配置合并)',
  },
  {
    flag: '--config',
    arg: '<path>',
    desc: '指定配置文件路径 (优先于 SWEEP_CONFIG)',
  },
  {
    flag: '--lang',
    arg: '<lang>',
    desc: '单次覆盖显示语言 (system | en | zh)',
  },
];

const ACTION_OPTIONS_EN: readonly OptionRow[] = [
  { flag: '--yes', desc: 'Execute cleanup (default: dry-run preview only)' },
  {
    flag: '--force',
    desc: 'Include suspect install trees (skipped by default)',
  },
  { flag: '--default', desc: 'Write best-practice v2 config with sweep init' },
  {
    flag: '--exclude',
    arg: '<name>',
    desc: 'Exclude directory name for this run (repeatable)',
  },
  {
    flag: '--include',
    arg: '<name>',
    desc: 'Only match projects containing name (repeatable)',
  },
  {
    flag: '--config',
    arg: '<path>',
    desc: 'Specify config file path (overrides SWEEP_CONFIG)',
  },
  {
    flag: '--lang',
    arg: '<lang>',
    desc: 'Override language for this run (system | en | zh)',
  },
];

const META_OPTIONS_ZH: readonly OptionRow[] = [
  { flag: '-V, --version', desc: '显示当前版本号' },
  { flag: '-h, --help', desc: '显示本帮助' },
];

const META_OPTIONS_EN: readonly OptionRow[] = [
  { flag: '-V, --version', desc: 'Print current version' },
  { flag: '-h, --help', desc: 'Show this help message' },
];

const EXAMPLES_ZH: readonly ExampleRow[] = [
  { cmd: 'sweep', desc: '预览工作区内可清理的构建产物与缓存' },
  {
    cmd: 'sweep',
    flag: '--yes',
    desc: '确认清单后执行清理 (按配置走回收站或删除)',
  },
  {
    cmd: 'sweep init',
    flag: '--default',
    desc: '一键写入完整最佳实践 v2 配置',
  },
  {
    cmd: 'sweep',
    flag: '--exclude',
    arg: 'my-kits',
    desc: '临时排除指定目录',
  },
];

const EXAMPLES_EN: readonly ExampleRow[] = [
  { cmd: 'sweep', desc: 'Preview cleanable build artifacts & caches' },
  { cmd: 'sweep', flag: '--yes', desc: 'Clean matched items via trash/delete' },
  {
    cmd: 'sweep init',
    flag: '--default',
    desc: 'Write best-practice v2 config in one step',
  },
  {
    cmd: 'sweep',
    flag: '--exclude',
    arg: 'my-kits',
    desc: 'Exclude a directory name for this run',
  },
];

const LEFT_COL = 20;
const EXAMPLE_COL = 28;
const RULE_WIDTH = 76;
const GITHUB_URL =
  'https://github.com/iyowei/clis/tree/main/packages/sweep-cli';

function defaultConfigPath(): string {
  return resolveConfigPath({ env: {} }).path;
}

function formatOptionRow(
  row: OptionRow,
  s: ReturnType<typeof createStyler>,
): string {
  const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
  const pad = ' '.repeat(Math.max(2, LEFT_COL - plain.length));
  const styledLeft =
    row.arg === undefined
      ? s.token(row.flag)
      : `${s.token(row.flag)} ${s.dim(row.arg)}`;
  return `    ${styledLeft}${pad}${s.dim(row.desc)}`;
}

function formatExampleRow(
  row: ExampleRow,
  s: ReturnType<typeof createStyler>,
): string {
  const plainParts = [row.cmd, row.flag, row.arg].filter(
    (part): part is string => part !== undefined,
  );
  const plain = plainParts.join(' ');
  const pad = ' '.repeat(Math.max(2, EXAMPLE_COL - plain.length));
  const styledParts = [s.bold(row.cmd)];
  if (row.flag !== undefined) styledParts.push(s.token(row.flag));
  if (row.arg !== undefined) styledParts.push(s.dim(row.arg));
  return `    ${styledParts.join(' ')}${pad}${s.dim(row.desc)}`;
}

/** 帮助页: 分层布局 + 主视图同源标准 SGR 单色系 (80 列内防截断, 降级无 ANSI 逐字等价) */
export function helpText(color: boolean, locale: Locale = 'zh'): string {
  const s = createStyler(color);
  const configPath = sanitizeLine(defaultConfigPath());

  if (locale === 'en') {
    const commandRows = SUBCOMMANDS_EN.map((row) => {
      const pad = ' '.repeat(Math.max(2, LEFT_COL - row.name.length));
      return `    ${s.bold(row.name)}${pad}${s.dim(row.desc)}`;
    });
    const actionRows = ACTION_OPTIONS_EN.map((row) => formatOptionRow(row, s));
    const metaRows = META_OPTIONS_EN.map((row) => formatOptionRow(row, s));
    const exampleRows = EXAMPLES_EN.map((row) => formatExampleRow(row, s));

    return [
      '',
      `  ${s.badge('SWEEP')}  ${s.bold('Multi-Stack Workspace Cleaner')}`,
      `  ${s.dim('Scan build artifacts, dependency caches, and OS junk; preview before cleaning.')}`,
      `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
      '',
      `  ${s.section('Usage')}`,
      `    ${s.bold('sweep')} ${s.dim('[options]')}`,
      `    ${s.bold('sweep')} ${s.dim('<command> [options]')}`,
      '',
      `  ${s.section('Commands')}`,
      ...commandRows,
      '',
      `  ${s.section('Options')}`,
      ...actionRows,
      '',
      ...metaRows,
      '',
      `  ${s.section('Examples')}`,
      ...exampleRows,
      '',
      `  ${s.section('Config & Safety')}`,
      `    ${s.bold('Default Config')}  ${s.token(configPath)}`,
      `                    ${s.dim("Run 'sweep config' when using --config or SWEEP_CONFIG")}`,
      `    ${s.bold('Project Anchor')}  ${s.dim('node / rust / python / java / cpp verify project anchors')}`,
      `                    ${s.dim('Custom rules default to trash; never falls back to rm')}`,
      `    ${s.bold('Name Matching')}   ${s.dim('--exclude / --include match exact dir names (case-sensitive)')}`,
      `                    ${s.dim('Exclude wins on conflict; 32 safety guardrails by default')}`,
      `    ${s.bold('Real Anchors')}    ${s.dim('--force only includes suspect trees; roots must be real dirs')}`,
      `                    ${s.dim('Symlinked roots (/tmp, /var) reject --yes; use /private/tmp')}`,
      `    ${s.bold('Plain Output')}    ${s.dim('Auto-disables ANSI when NO_COLOR, TERM=dumb, or non-TTY')}`,
      '',
      `  ${s.section('Exit Codes')}`,
      `    ${s.green('0')}         ${s.dim('Success (preview, empty, init/migrate/config/lang/update, -V/-h)')}`,
      `    ${s.red('1')}         ${s.dim('Failure (failed/skipped/rejected, missing config, or bad args)')}`,
      '',
      `  ${s.section('Docs & Source')}`,
      `    ${s.token(GITHUB_URL)}`,
      '',
    ].join('\n');
  }

  const commandRows = SUBCOMMANDS_ZH.map((row) => {
    const pad = ' '.repeat(Math.max(2, LEFT_COL - row.name.length));
    return `    ${s.bold(row.name)}${pad}${s.dim(row.desc)}`;
  });
  const actionRows = ACTION_OPTIONS_ZH.map((row) => formatOptionRow(row, s));
  const metaRows = META_OPTIONS_ZH.map((row) => formatOptionRow(row, s));
  const exampleRows = EXAMPLES_ZH.map((row) => formatExampleRow(row, s));

  return [
    '',
    `  ${s.badge('SWEEP')}  ${s.bold('工作区多技术栈清理器')}`,
    `  ${s.dim('跨工作区扫描构建产物、依赖缓存、系统垃圾与自定义规则, 先预览后清理。')}`,
    `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section('用法')}`,
    `    ${s.bold('sweep')} ${s.dim('[选项]')}`,
    `    ${s.bold('sweep')} ${s.dim('<子命令> [选项]')}`,
    '',
    `  ${s.section('子命令')}`,
    ...commandRows,
    '',
    `  ${s.section('选项')}`,
    ...actionRows,
    '',
    ...metaRows,
    '',
    `  ${s.section('示例')}`,
    ...exampleRows,
    '',
    `  ${s.section('配置与安全')}`,
    `    ${s.bold('默认配置')}  ${s.token(configPath)}`,
    `              ${s.dim('仅平台默认; 用了 --config / SWEEP_CONFIG 请跑 sweep config')}`,
    `    ${s.bold('预设锚定')}  ${s.dim('node / rust / python / java / cpp 均校验项目锚点防误删')}`,
    `              ${s.dim('rules 默认进回收站; 回收站失败严禁静默降级永久删除')}`,
    `    ${s.bold('名单口径')}  ${s.dim('--exclude / --include 按目录名精确匹配 (区分大小写, 任一级命中)')}`,
    `              ${s.dim('同时命中 exclude 优先; 省略 exclude 启用三端默认安全护栏')}`,
    `    ${s.bold('删除安全')}  ${s.dim('--force 仅放行疑似安装树, 不放宽安全闸; 根及祖先链须为真实路径')}`,
    `              ${s.dim('命中 /tmp、/var 软链时 --yes 整批拒绝, 改如 /private/tmp/x 即放行')}`,
    `    ${s.bold('输出降级')}  ${s.dim('设置 NO_COLOR、TERM=dumb 或非 TTY 时自动降级为无颜色纯文本')}`,
    '',
    `  ${s.section('退出码')}`,
    `    ${s.green('0')}         ${s.dim('成功 (预览、空结果、init/migrate/config/lang/update、-V/-h)')}`,
    `    ${s.red('1')}         ${s.dim('失败 (清理/回收站失败 / 跳过 / 拒绝 / 无配置非 TTY / 参数或配置错)')}`,
    '',
    `  ${s.section('文档与源码')}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
