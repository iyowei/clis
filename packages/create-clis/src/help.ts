/**
 * create-clis 帮助页文案与 Apple HIG 级终端排版渲染 (零外部依赖, 中英双语均严守 80 列行宽)。
 *
 * 排版红线 (全仓所有 CLI 强制遵循):
 * 所有两栏分区 (子命令 / 模板变量 / 生成选项 / 说明) 共用 `computeHelpDescColumn` 计算出的唯一右栏列线 `descCol`,
 * 禁止各分区单独设置列宽导致右侧说明呈锯齿状错落。
 */
import {
  type Locale,
  alignHelpRow,
  computeHelpDescColumn,
} from '@iyowei/cli-i18n';

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

const RULE_WIDTH = 76;
const GITHUB_URL =
  'https://github.com/iyowei/clis/tree/main/packages/create-clis';

function formatOptionRow(
  row: OptionRow,
  s: ReturnType<typeof createStyler>,
  descCol: number,
): string {
  const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
  const styledLeft =
    row.arg === undefined
      ? s.token(row.flag)
      : `${s.token(row.flag)} ${s.dim(row.arg)}`;
  return alignHelpRow(styledLeft, plain, s.muted(row.desc), descCol);
}

/** 渲染 create-clis Apple HIG 分层帮助页 (支持中英双语, 全页右栏单轴左对齐) */
export function formatHelpText(color: boolean, locale: Locale = 'zh'): string {
  const s = createStyler(color);
  const isEn = locale === 'en';
  const varOpts = isEn ? VARIABLE_OPTIONS_EN : VARIABLE_OPTIONS_ZH;
  const ctrlOpts = isEn ? CONTROL_OPTIONS_EN : CONTROL_OPTIONS_ZH;
  const metaOpts = isEn ? META_OPTIONS_EN : META_OPTIONS_ZH;
  const commands: ReadonlyArray<readonly [string, string]> = isEn
    ? [
        ['lang', 'Show or save display language (system | en | zh)'],
        ['update', 'Upgrade CLI via detected installer (--check only)'],
      ]
    : [
        ['lang', '查看或设置显示语言 (system | en | zh, 默认 system)'],
        ['update', '自动识别安装器升级到最新版 (--check 仅检查)'],
      ];
  const notes: ReadonlyArray<readonly [string, string]> = isEn
    ? [
        ['Target Dir', 'Defaults to ./<name>; rejects non-empty directories'],
        [
          'Zero-Prompt',
          '--yes needs --owner when git user.name is unset/invalid',
        ],
        [
          'npm create',
          'Pass flags after -- (e.g. npm create clis -- --tier core)',
        ],
        [
          'End of Opts',
          'Tokens after -- are treated literally as target directory',
        ],
      ]
    : [
        ['目标目录', '缺省为 ./<目录名> 子目录; 非空目录直接拒绝 (绝不覆盖)'],
        ['零交互态', '无合规 git user.name 时, --yes 必须同时传入 --owner'],
        ['调用约定', 'npm create 传参放 -- 后: npm create clis -- --tier core'],
        [
          '选项终止',
          '-- 后参数均作目标目录 (可逃逸 - 开头或名为 update 的目录)',
        ],
      ];

  const descCol = computeHelpDescColumn([
    ...commands.map(([name]) => name),
    ...varOpts.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...ctrlOpts.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...metaOpts.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...notes.map(([label]) => label),
  ]);

  return [
    '',
    `  ${s.badge('CREATE-CLIS')}  ${s.title(isEn ? 'CLI Monorepo Scaffolder' : 'clis 集合仓脚手架')}`,
    `  ${s.muted(isEn ? 'Scaffold a standalone dual-package CLI monorepo with green CI out of the box.' : '从 clis 集合仓骨架快照生成独立的新双包集合仓, 带能力档位与全绿 CI。')}`,
    `  ${s.rule('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section(isEn ? 'Usage' : '用法')}`,
    `    ${s.title('create-clis')} ${s.dim(isEn ? '[dir] [options]' : '[目录] [选项]')}`,
    `    ${s.title('create-clis')} ${s.dim(isEn ? '<command> [options]' : '<子命令> [选项]')}`,
    '',
    `  ${s.section(isEn ? 'Commands' : '子命令')}`,
    ...commands.map(([name, desc]) =>
      alignHelpRow(s.title(name), name, s.muted(desc), descCol),
    ),
    '',
    `  ${s.section(isEn ? 'Template Variables' : '模板变量')}`,
    ...varOpts.map((row) => formatOptionRow(row, s, descCol)),
    '',
    `  ${s.section(isEn ? 'Scaffold Options' : '生成选项')}`,
    ...ctrlOpts.map((row) => formatOptionRow(row, s, descCol)),
    '',
    ...metaOpts.map((row) => formatOptionRow(row, s, descCol)),
    '',
    `  ${s.section(isEn ? 'Notes' : '说明')}`,
    ...notes.map(([label, desc]) =>
      alignHelpRow(s.primary(label), label, s.muted(desc), descCol),
    ),
    '',
    `  ${s.section(isEn ? 'Docs & Source' : '文档与源码')}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
