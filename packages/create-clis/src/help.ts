/**
 * create-clis 帮助页文案与 Apple HIG 级终端排版渲染 (零外部依赖, 中英双语均严守 80 列行宽)。
 */
import type { Locale } from '@iyowei/cli-i18n';

type ColorToken = readonly [rgb: string, c256: string];

interface HelpPalette {
  primary: ColorToken;
  secondary: ColorToken;
  tertiary: ColorToken;
  separator: ColorToken;
  blue: ColorToken;
  cyan: ColorToken;
}

const WHITE: ColorToken = ['255;255;255', '255'];

const DARK_PALETTE: HelpPalette = {
  primary: ['245;245;247', '255'],
  secondary: ['161;161;166', '248'],
  tertiary: ['110;110;115', '242'],
  separator: ['56;56;58', '238'],
  blue: ['10;132;255', '39'],
  cyan: ['100;210;255', '81'],
};

const LIGHT_PALETTE: HelpPalette = {
  primary: ['29;29;31', '234'],
  secondary: ['110;110;115', '242'],
  tertiary: ['142;142;147', '246'],
  separator: ['210;210;215', '252'],
  blue: ['0;122;255', '27'],
  cyan: ['0;102;204', '26'],
};

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

/** 判定 stdout 是否允许着色 (尊重 NO_COLOR / TERM=dumb / 非 TTY) */
export function stdoutSupportsColor(): boolean {
  return (
    process.stdout.isTTY === true &&
    !process.env.NO_COLOR &&
    process.env.TERM?.toLowerCase() !== 'dumb'
  );
}

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
    title: (s: string) => fg(theme.primary, s, true),
    primary: (s: string) => fg(theme.primary, s, false),
    muted: (s: string) => fg(theme.secondary, s, false),
    dim: (s: string) => fg(theme.tertiary, s, false),
    rule: (s: string) => fg(theme.separator, s, false),
    section: (s: string) => fg(theme.blue, s, true),
    token: (s: string) => fg(theme.cyan, s, false),
  };
}

interface OptionRow {
  flag: string;
  arg?: string;
  desc: string;
}

const VARIABLE_OPTIONS_ZH: readonly OptionRow[] = [
  {
    flag: '--name',
    arg: '<名>',
    desc: '项目名 (kebab-case; 缺省取目录 basename)',
  },
  {
    flag: '--scope',
    arg: '<@scope>',
    desc: 'npm scope (缺省无 scope, 裸包名)',
  },
  { flag: '--bin', arg: '<名>', desc: '主命令名 (缺省由项目名派生短形态)' },
  {
    flag: '--owner',
    arg: '<名>',
    desc: '仓库所有者 (缺省取 git 全局 user.name)',
  },
  {
    flag: '--repo',
    arg: '<url>',
    desc: '仓库地址 (缺省 https://github.com/<owner>/<name>)',
  },
];

const VARIABLE_OPTIONS_EN: readonly OptionRow[] = [
  {
    flag: '--name',
    arg: '<name>',
    desc: 'Project name (kebab-case; defaults to dir basename)',
  },
  {
    flag: '--scope',
    arg: '<@scope>',
    desc: 'npm scope (defaults to unscoped package name)',
  },
  {
    flag: '--bin',
    arg: '<name>',
    desc: 'Primary CLI binary name (derived from project name)',
  },
  {
    flag: '--owner',
    arg: '<name>',
    desc: 'Repository owner (defaults to git global user.name)',
  },
  {
    flag: '--repo',
    arg: '<url>',
    desc: 'Repository URL (https://github.com/<owner>/<name>)',
  },
];

const CONTROL_OPTIONS_ZH: readonly OptionRow[] = [
  {
    flag: '--tier',
    arg: '<档>',
    desc: '装备档位: core | standard | full (缺省 standard)',
  },
  { flag: '--no-git', desc: '跳过 git init (默认执行)' },
  { flag: '--no-install', desc: '跳过依赖安装 (默认执行)' },
  {
    flag: '--yes',
    desc: '全部取默认值, 零交互 (需 [目录]/--name 与合规 owner)',
  },
  {
    flag: '--lang',
    arg: '<语言>',
    desc: '单次覆盖显示语言 (system | en | zh)',
  },
];

const CONTROL_OPTIONS_EN: readonly OptionRow[] = [
  {
    flag: '--tier',
    arg: '<tier>',
    desc: 'Tier: core | standard | full (default: standard)',
  },
  { flag: '--no-git', desc: 'Skip git init (runs by default)' },
  { flag: '--no-install', desc: 'Skip dependency install (runs by default)' },
  {
    flag: '--yes',
    desc: 'Use all defaults non-interactively (needs dir/--name)',
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

const LEFT_COL = 20;
const RULE_WIDTH = 76;
const GITHUB_URL =
  'https://github.com/iyowei/clis/tree/main/packages/create-clis';

function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

function formatOptionRow(
  row: OptionRow,
  s: ReturnType<typeof createStyler>,
): string {
  const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
  const pad = ' '.repeat(Math.max(2, LEFT_COL - displayWidth(plain)));
  const styledLeft =
    row.arg === undefined
      ? s.token(row.flag)
      : `${s.token(row.flag)} ${s.dim(row.arg)}`;
  return `    ${styledLeft}${pad}${s.muted(row.desc)}`;
}

/** 渲染 create-clis Apple HIG 分层帮助页 (支持中英双语) */
export function formatHelpText(color: boolean, locale: Locale = 'zh'): string {
  const s = createStyler(color);

  if (locale === 'en') {
    const varRows = VARIABLE_OPTIONS_EN.map((row) => formatOptionRow(row, s));
    const ctrlRows = CONTROL_OPTIONS_EN.map((row) => formatOptionRow(row, s));
    const metaRows = META_OPTIONS_EN.map((row) => formatOptionRow(row, s));

    return [
      '',
      `  ${s.badge('CREATE-CLIS')}  ${s.title('CLI Monorepo Scaffolder')}`,
      `  ${s.muted('Scaffold a standalone dual-package CLI monorepo with green CI out of the box.')}`,
      `  ${s.rule('─'.repeat(RULE_WIDTH))}`,
      '',
      `  ${s.section('Usage')}`,
      `    ${s.title('create-clis')} ${s.dim('[dir] [options]')}`,
      `    ${s.title('create-clis')} ${s.dim('<command> [options]')}`,
      '',
      `  ${s.section('Commands')}`,
      `    ${s.title('lang')}${' '.repeat(LEFT_COL - 'lang'.length)}${s.muted('Show or save display language (system | en | zh)')}`,
      `    ${s.title('update')}${' '.repeat(LEFT_COL - 'update'.length)}${s.muted('Upgrade CLI via detected installer (--check only)')}`,
      '',
      `  ${s.section('Template Variables')}`,
      ...varRows,
      '',
      `  ${s.section('Scaffold Options')}`,
      ...ctrlRows,
      '',
      ...metaRows,
      '',
      `  ${s.section('Notes')}`,
      `    ${s.primary('Target Dir')}    ${s.muted('Defaults to ./<name>; rejects non-empty directories')}`,
      `    ${s.primary('Zero-Prompt')}   ${s.muted('--yes requires --owner when git user.name is unset/invalid')}`,
      `    ${s.primary('npm create')}    ${s.muted('Pass flags after -- (e.g. npm create clis -- --tier core)')}`,
      `    ${s.primary('End of Opts')}   ${s.muted('Tokens after -- are treated literally as target directory')}`,
      '',
      `  ${s.section('Docs & Source')}`,
      `    ${s.token(GITHUB_URL)}`,
      '',
    ].join('\n');
  }

  const varRows = VARIABLE_OPTIONS_ZH.map((row) => formatOptionRow(row, s));
  const ctrlRows = CONTROL_OPTIONS_ZH.map((row) => formatOptionRow(row, s));
  const metaRows = META_OPTIONS_ZH.map((row) => formatOptionRow(row, s));

  return [
    '',
    `  ${s.badge('CREATE-CLIS')}  ${s.title('clis 集合仓脚手架')}`,
    `  ${s.muted('从 clis 集合仓骨架快照生成独立的新双包集合仓, 带能力档位与全绿 CI。')}`,
    `  ${s.rule('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section('用法')}`,
    `    ${s.title('create-clis')} ${s.dim('[目录] [选项]')}`,
    `    ${s.title('create-clis')} ${s.dim('<子命令> [选项]')}`,
    '',
    `  ${s.section('子命令')}`,
    `    ${s.title('lang')}${' '.repeat(LEFT_COL - 'lang'.length)}${s.muted('查看或设置显示语言 (system | en | zh, 默认 system)')}`,
    `    ${s.title('update')}${' '.repeat(LEFT_COL - 'update'.length)}${s.muted('自动识别安装器升级到最新版 (--check 仅检查)')}`,
    '',
    `  ${s.section('模板变量')}`,
    ...varRows,
    '',
    `  ${s.section('生成选项')}`,
    ...ctrlRows,
    '',
    ...metaRows,
    '',
    `  ${s.section('说明')}`,
    `    ${s.primary('目标目录')}  ${s.muted('缺省为当前目录下以项目名命名的子目录; 非空目录直接拒绝 (不覆盖)')}`,
    `    ${s.primary('零交互态')}  ${s.muted('git user.name 未配置或含空格/非 ASCII 时, --yes 须传 --owner')}`,
    `    ${s.primary('调用约定')}  ${s.muted('npm create 传参置于 -- 后 (例: npm create clis -- --tier core)')}`,
    `    ${s.primary('选项终止')}  ${s.muted('-- 后参数均作目标目录 (可逃逸 - 开头或名为 update 的目录)')}`,
    '',
    `  ${s.section('文档与源码')}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
