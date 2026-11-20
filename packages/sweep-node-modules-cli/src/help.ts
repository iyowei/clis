/**
 * 帮助页文案与 Apple HIG 级终端排版渲染 (零外部依赖)。
 * 命令面以 packages/sweep-node-modules-cli/docs/designs/cli-surface.md 为唯一事实来源;
 * 新增子命令或旗标时须与规格、语料 `cli-help` 同批更新 (见 behavior-contract.md BC-30)。
 */
import { resolveConfigPath } from '@iyowei/sweep-node-modules';

import { sanitizeLine } from './render.ts';

type ColorToken = readonly [rgb: string, c256: string];

interface HelpPalette {
  primary: ColorToken;
  secondary: ColorToken;
  tertiary: ColorToken;
  separator: ColorToken;
  blue: ColorToken;
  cyan: ColorToken;
  green: ColorToken;
  red: ColorToken;
}

const WHITE: ColorToken = ['255;255;255', '255'];

/** Apple System Colors (macOS Sequoia Dark / Light 语义色阶) */
const DARK_PALETTE: HelpPalette = {
  primary: ['245;245;247', '255'],
  secondary: ['161;161;166', '248'],
  tertiary: ['110;110;115', '242'],
  separator: ['56;56;58', '238'],
  blue: ['10;132;255', '39'],
  cyan: ['100;210;255', '81'],
  green: ['48;209;88', '42'],
  red: ['255;69;58', '203'],
};

const LIGHT_PALETTE: HelpPalette = {
  primary: ['29;29;31', '234'],
  secondary: ['110;110;115', '242'],
  tertiary: ['142;142;147', '246'],
  separator: ['210;210;215', '252'],
  blue: ['0;122;255', '27'],
  cyan: ['0;102;204', '26'],
  green: ['40;167;69', '34'],
  red: ['215;0;21', '160'],
};

// Apple Terminal.app 仅支持 256 色, 不列入 24-bit TrueColor 白名单
const TRUECOLOR_TERMS = ['iterm', 'vscode', 'ghostty', 'warp', 'wezterm'];

function supportsTrueColor(): boolean {
  if (process.env.WT_SESSION) return true;
  const ct = (process.env.COLORTERM ?? '').toLowerCase();
  if (ct.includes('truecolor') || ct.includes('24bit')) return true;
  const termProg = (process.env.TERM_PROGRAM ?? '').toLowerCase();
  return TRUECOLOR_TERMS.some((term) => termProg.includes(term));
}

function isLightTerminal(): boolean {
  const fgbg = process.env.COLORFGBG;
  if (!fgbg) return false;
  const parts = fgbg.split(';');
  const bg = Number(parts[parts.length - 1]);
  return Number.isFinite(bg) && bg >= 7 && bg !== 8;
}

/** 创建轻量样式器: color=false 恒返回纯文本 (严格守 OF-10 降级恒等式) */
function createStyler(color: boolean) {
  const theme = isLightTerminal() ? LIGHT_PALETTE : DARK_PALETTE;
  const trueColor = color && supportsTrueColor();
  const fg = (tok: ColorToken, text: string, bold = false): string => {
    if (!color) return text;
    const b = bold ? '1;' : '';
    return trueColor
      ? `\u001b[${b}38;2;${tok[0]}m${text}\u001b[0m`
      : `\u001b[${b}38;5;${tok[1]}m${text}\u001b[0m`;
  };
  const badge = (text: string): string => {
    const label = ` ${text} `;
    if (!color) return label;
    return trueColor
      ? `\u001b[1;38;2;${WHITE[0]};48;2;${theme.blue[0]}m${label}\u001b[0m`
      : `\u001b[1;38;5;${WHITE[1]};48;5;${theme.blue[1]}m${label}\u001b[0m`;
  };
  return {
    badge,
    title: (t: string) => fg(theme.primary, t, true),
    primary: (t: string) => fg(theme.primary, t, false),
    muted: (t: string) => fg(theme.secondary, t, false),
    dim: (t: string) => fg(theme.tertiary, t, false),
    rule: (t: string) => fg(theme.separator, t, false),
    section: (t: string) => fg(theme.blue, t, true),
    token: (t: string) => fg(theme.cyan, t, false),
    green: (t: string) => fg(theme.green, t, true),
    red: (t: string) => fg(theme.red, t, true),
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
  { name: 'init', desc: '交互式向导, 生成配置文件' },
  { name: 'config', desc: '查看实际生效的配置 (来源 / 路径 / 状态)' },
  {
    name: 'update',
    desc: '自动识别安装器升级到最新版 (--check 仅检查)',
  },
];

/** 核心清理与筛选选项 */
const ACTION_OPTIONS: readonly OptionRow[] = [
  { flag: '--yes', desc: '执行删除 (默认仅预览, 零副作用)' },
  { flag: '--force', desc: '连同疑似安装树一并删除 (默认跳过)' },
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
    desc: '指定配置文件路径 (优先于 SWEEP_NM_CONFIG)',
  },
];

/** 通用元选项 */
const META_OPTIONS: readonly OptionRow[] = [
  { flag: '-V, --version', desc: '显示当前版本号' },
  { flag: '-h, --help', desc: '显示本帮助' },
];

/** 常用示例 */
const EXAMPLES: readonly ExampleRow[] = [
  { cmd: 'sweep-nm', desc: '预览所有工作区的 node_modules' },
  { cmd: 'sweep-nm', flag: '--yes', desc: '确认清单后执行删除' },
  {
    cmd: 'sweep-nm',
    flag: '--exclude',
    arg: 'my-kits',
    desc: '临时排除指定目录',
  },
];

const LEFT_COL = 20;
const EXAMPLE_COL = 28;
const RULE_WIDTH = 76;

/** 平台默认配置路径 (帮助里的「默认配置」; 屏蔽环境变量, 只答平台默认) */
function defaultConfigPath(): string {
  return resolveConfigPath({ env: {} }).path;
}

/** 渲染子命令 / 选项两列对齐行 (按纯文本计算填充, 保证去色与非 TTY 逐字节等价) */
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
  return `    ${styledLeft}${pad}${s.muted(row.desc)}`;
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
  const styledParts = [s.primary(row.cmd)];
  if (row.flag !== undefined) styledParts.push(s.token(row.flag));
  if (row.arg !== undefined) styledParts.push(s.dim(row.arg));
  return `    ${styledParts.join(' ')}${pad}${s.muted(row.desc)}`;
}

/** 帮助页: Apple HIG 分层排版 (命令与选项独立分区, 80 列内零截断, 降级无 ANSI 逐字等价) */
export function helpText(color: boolean): string {
  const s = createStyler(color);
  // 该路径源自 os.homedir() (外部数据), 与 config 报告面同坐标经同一净化 (OF-14)
  const configPath = sanitizeLine(defaultConfigPath());

  const commandRows = SUBCOMMANDS.map((row) => {
    const pad = ' '.repeat(Math.max(2, LEFT_COL - row.name.length));
    return `    ${s.title(row.name)}${pad}${s.muted(row.desc)}`;
  });

  const actionRows = ACTION_OPTIONS.map((row) => formatOptionRow(row, s));
  const metaRows = META_OPTIONS.map((row) => formatOptionRow(row, s));
  const exampleRows = EXAMPLES.map((row) => formatExampleRow(row, s));

  return [
    '',
    ` ${s.badge('SWEEP-NM')}  ${s.title('工作区 node_modules 清理')}`,
    `  ${s.muted('扫描多工作区根目录下的 node_modules, 先预览体积, 确认后批量清理。')}`,
    `  ${s.rule('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section('用法')}`,
    `    ${s.title('sweep-nm')} ${s.dim('[选项]')}`,
    `    ${s.title('sweep-nm')} ${s.dim('<子命令> [选项]')}`,
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
    `    ${s.primary('默认配置')}  ${s.token(configPath)}`,
    `              ${s.dim('仅平台默认; 用了 --config / SWEEP_NM_CONFIG 请跑 sweep-nm config')}`,
    `    ${s.primary('名单口径')}  ${s.muted('--exclude / --include 按目录名精确匹配 (区分大小写, 任一级命中)')}`,
    `              ${s.muted('同时命中 exclude 优先; 省略 exclude 启用内置安装树默认名单')}`,
    `    ${s.primary('删除安全')}  ${s.muted('--force 仅放行疑似安装树, 不放宽安全闸; 根及祖先链须为真实路径')}`,
    `              ${s.muted('命中 /tmp、/var 软链时 --yes 整批拒绝, 改如 /private/tmp/x 即放行')}`,
    `    ${s.primary('输出降级')}  ${s.muted('设置 NO_COLOR、TERM=dumb 或非 TTY 时自动降级为无颜色纯文本')}`,
    '',
    `  ${s.section('退出码')}`,
    `    ${s.green('0')}         ${s.muted('成功 (预览、空结果、config、update、--version、--help)')}`,
    `    ${s.red('1')}         ${s.muted('失败 (删除失败 / 跳过 / 拒绝中止 / 无配置 --yes / 配置或参数错误)')}`,
    '',
  ].join('\n');
}
