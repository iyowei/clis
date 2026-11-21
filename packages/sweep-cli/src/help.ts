/**
 * 帮助页文案与分层排版渲染 (零外部依赖): 上游供 `cli.ts` 处理 `-h`/`--help` 调用,
 * 下游复用 `render.ts` 的 `BAR_BLOCK` / `paint` / `sanitizeLine` 与 `@iyowei/sweep` 路径解析。
 * 红线: 命令面以 `cli-surface.md` 为唯一事实来源; 新增子命令或旗标须与语料 `cli-help` 同批更新 (BC-30)。
 */
import { resolveConfigPath } from '@iyowei/sweep';

import { BAR_BLOCK, paint, sanitizeLine } from './render.ts';

function createStyler(color: boolean) {
  return {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    bold: (t: string) => paint(t, '1', color),
    dim: (t: string) => paint(t, '2', color),
    section: (t: string) => paint(t, '2', color),
    token: (t: string) => paint(t, '36', color),
    green: (t: string) => paint(t, '1;32', color),
    red: (t: string) => paint(t, '1;31', color),
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

/** 子命令清单 (与清理选项彻底分层) */
const SUBCOMMANDS: readonly CommandRow[] = [
  {
    name: 'init',
    desc: '交互式向导生成 v2 配置 (支持 --default 写入最佳实践)',
  },
  { name: 'migrate', desc: '无损迁移旧版配置到 v2 (写前自动备份原配置)' },
  { name: 'config', desc: '查看实际生效的配置 (来源 / 路径 / 状态)' },
  {
    name: 'update',
    desc: '自动识别安装器升级到最新版 (--check 仅检查)',
  },
];

/** 核心清理与筛选选项 */
const ACTION_OPTIONS: readonly OptionRow[] = [
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
];

/** 通用元选项 */
const META_OPTIONS: readonly OptionRow[] = [
  { flag: '-V, --version', desc: '显示当前版本号' },
  { flag: '-h, --help', desc: '显示本帮助' },
];

/** 常用示例 */
const EXAMPLES: readonly ExampleRow[] = [
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

const LEFT_COL = 20;
const EXAMPLE_COL = 28;
const RULE_WIDTH = 76;

/** 刻意传入空 env 忽略 SWEEP_CONFIG, 帮助页只展示当前平台默认配置路径 */
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
  return `    ${styledLeft}${pad}${row.desc}`;
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
export function helpText(color: boolean): string {
  const s = createStyler(color);
  const configPath = sanitizeLine(defaultConfigPath());

  const commandRows = SUBCOMMANDS.map((row) => {
    const pad = ' '.repeat(Math.max(2, LEFT_COL - row.name.length));
    return `    ${s.bold(row.name)}${pad}${row.desc}`;
  });

  const actionRows = ACTION_OPTIONS.map((row) => formatOptionRow(row, s));
  const metaRows = META_OPTIONS.map((row) => formatOptionRow(row, s));
  const exampleRows = EXAMPLES.map((row) => formatExampleRow(row, s));

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
    `    ${s.bold('预设锚定')}  node / rust / python / java / cpp 均校验项目锚点防误删`,
    `              ${s.dim('rules 默认进回收站; 回收站失败严禁静默降级永久删除')}`,
    `    ${s.bold('名单口径')}  --exclude / --include 按目录名精确匹配 (区分大小写, 任一级命中)`,
    `              ${s.dim('同时命中 exclude 优先; 省略 exclude 启用三端默认安全护栏')}`,
    `    ${s.bold('删除安全')}  --force 仅放行疑似安装树, 不放宽安全闸; 根及祖先链须为真实路径`,
    `              ${s.dim('命中 /tmp、/var 软链时 --yes 整批拒绝, 改如 /private/tmp/x 即放行')}`,
    `    ${s.bold('输出降级')}  设置 NO_COLOR、TERM=dumb 或非 TTY 时自动降级为无颜色纯文本`,
    '',
    `  ${s.section('退出码')}`,
    `    ${s.green('0')}         成功 (预览、空结果、init/migrate/config/update、-V/-h)`,
    `    ${s.red('1')}         失败 (清理/回收站失败 / 跳过 / 拒绝 / 无配置非 TTY / 参数或配置错)`,
    '',
  ].join('\n');
}
