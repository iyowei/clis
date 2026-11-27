/**
 * `@iyowei/fan-cli` 帮助页文案与单轴线左对齐排版渲染 (零外部依赖, 中英双语 Apple HIG 排版)。
 *
 * 排版红线 (全仓所有 CLI 强制遵循):
 * 每个语种独立调用 `computeHelpDescColumn` 按东亚显示列宽 (`CJK=2, ASCII=1`) 计算全页唯一的右栏列线 `descCol`,
 * 所有两栏分区 (子命令 / 选项 / 示例 / 环境与持久化 / 退出码) 共用同一 `descCol`, 彻底杜绝右栏参差不齐与 80+ 列溢出。
 */
import {
  type Locale,
  alignHelpRow,
  computeHelpDescColumn,
  t,
} from '@iyowei/cli-i18n';

import { BAR_BLOCK, displayWidth, paint } from './render.ts';

export { displayWidth };

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
  tail?: readonly (readonly ['flag' | 'arg', string])[];
  desc: string;
}

interface NoteRow {
  label: string;
  desc: string;
  tone?: 'green' | 'red';
}

interface HelpCatalog {
  subtitle: string;
  summary: string;
  usageArgs: readonly [string, string];
  sections: {
    usage: string;
    subcommands: string;
    options: string;
    examples: string;
    notes: string;
    exitCodes: string;
    docs: string;
  };
  subcommands: readonly CommandRow[];
  options: readonly OptionRow[];
  metaOptions: readonly OptionRow[];
  examples: readonly ExampleRow[];
  envNotes: readonly NoteRow[];
  exitCodes: readonly NoteRow[];
}

const GITHUB_URL = 'https://github.com/iyowei/clis/tree/main/packages/fan-cli';

const CATALOG_ZH: HelpCatalog = {
  subtitle: 'macOS 风扇查看与手动控制器',
  summary:
    '直接读写 AppleSMC 风扇键 (FNum/F*Ac/F*Tg/F*md), 合盖/睡眠自动停转, 开盖与重启自动恢复。',
  usageArgs: ['[选项]', '<子命令> [参数] [选项]'],
  sections: {
    usage: '用法',
    subcommands: '子命令',
    options: '选项',
    examples: '示例',
    notes: '环境与持久化',
    exitCodes: '退出码',
    docs: '文档与源码',
  },
  subcommands: [
    { name: 'status', desc: '查看风扇当前转速、范围与控制模式 (默认动作)' },
    {
      name: 'set <speed>',
      desc: '设定目标转速 (如 4000) 或区间百分比 (如 60%, 默认记住)',
    },
    { name: 'max', desc: '切换手动模式并拉满至最高转速 (默认记住)' },
    { name: 'min', desc: '切换手动模式并降至最低转速 (默认记住)' },
    { name: 'auto', desc: '恢复系统自动温控模式 (默认记住并覆盖手动配置)' },
    { name: 'apply', desc: '立即按已记住的持久化配置恢复全部风扇转速' },
    {
      name: 'persist [action]',
      desc: '管理开机/唤醒恢复守护 (status | install | uninstall)',
    },
    {
      name: 'lang [lang]',
      desc: '查看或设置界面语言 (system | en | zh, 默认 system)',
    },
    { name: 'update', desc: '自动识别安装器升级到最新版 (--check 仅检查)' },
  ],
  options: [
    {
      flag: '--fan',
      arg: '<index>',
      desc: '仅作用于指定编号的风扇 (例如 0 或 1)',
    },
    {
      flag: '--once, --no-save',
      desc: '仅本次生效, 不写入持久化配置 (守护稍后也不会覆写)',
    },
    { flag: '--json', desc: '以 JSON 格式输出结果 (便于脚本集成)' },
    {
      flag: '-w, --watch',
      arg: '[sec]',
      desc: '持续轮询刷新转速 (仅用于 status, 默认 1 秒)',
    },
    {
      flag: '--lang',
      arg: '<lang>',
      desc: '单次覆盖显示语言 (system | en | zh)',
    },
  ],
  metaOptions: [
    { flag: '-V, --version', desc: '显示当前版本号' },
    { flag: '-h, --help', desc: '显示本帮助' },
  ],
  examples: [
    { cmd: 'fan', desc: '查看所有风扇当前转速与模式' },
    {
      cmd: 'fan status',
      tail: [
        ['flag', '-w'],
        ['arg', '1'],
      ],
      desc: '每秒刷新实时转速变化',
    },
    {
      cmd: 'fan set',
      tail: [['arg', '4000']],
      desc: '设为 4000 RPM 并记住该配置',
    },
    {
      cmd: 'fan set',
      tail: [['arg', '60%']],
      desc: '设为 60% 区间转速并记住该配置',
    },
    {
      cmd: 'fan set',
      tail: [
        ['flag', '--fan'],
        ['arg', '0 60%'],
      ],
      desc: '仅将 0 号风扇设为 60% 并记住',
    },
    {
      cmd: 'fan set',
      tail: [
        ['arg', '50%'],
        ['flag', '--once'],
      ],
      desc: '临时设为 50%, 不改写已记住配置',
    },
    { cmd: 'fan max', desc: '激活全速运转并记住' },
    { cmd: 'fan auto', desc: '恢复系统自动温控并清除手动持久化' },
    {
      cmd: 'fan lang',
      tail: [['arg', 'en']],
      desc: '将 fan 界面语言固定设为英文',
    },
  ],
  envNotes: [
    {
      label: '自动记住',
      desc: 'set/max/min/auto 默认保存至 state.json; 传 --once 仅本次生效',
    },
    {
      label: '守护联动',
      desc: 'set/max/min 自动同步后台守护: 无外接屏合盖或睡眠切回 auto, 开盖/重启恢复',
    },
    {
      label: '提权边界',
      desc: '仅写入、apply 与守护安装经 /usr/bin/sudo 提权; 查询无需 sudo',
    },
    {
      label: '语言偏好',
      desc: '默认跟随系统语言; fan lang <system|en|zh> 独立保存至 ~/.config/fan/lang.json',
    },
    {
      label: '输出降级',
      desc: '设置 NO_COLOR、TERM=dumb 或非 TTY 时自动输出无 ANSI 纯文本',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: '成功 (含 status/set/max/min/auto/apply/persist/lang/update/-V/-h)',
    },
    {
      label: '1',
      tone: 'red',
      desc: '失败 (参数非法、平台不支持、SMC/守护失败或提权被拒)',
    },
  ],
};

const CATALOG_EN: HelpCatalog = {
  subtitle: 'macOS AppleSMC Fan Controller',
  summary:
    'Read and tune Mac fan speeds via AppleSMC; pauses on sleep, restores on wake.',
  usageArgs: ['[options]', '<command> [args] [options]'],
  sections: {
    usage: 'Usage',
    subcommands: 'Commands',
    options: 'Options',
    examples: 'Examples',
    notes: 'Persistence & Safety',
    exitCodes: 'Exit Codes',
    docs: 'Docs & Source',
  },
  subcommands: [
    {
      name: 'status',
      desc: 'Show live fan speeds, ranges, and mode (default)',
    },
    {
      name: 'set <speed>',
      desc: 'Set target RPM (4000) or percentage (60%, saved)',
    },
    { name: 'max', desc: 'Switch to manual full speed and save preset' },
    { name: 'min', desc: 'Switch to manual minimum speed and save preset' },
    { name: 'auto', desc: 'Restore macOS automatic thermal control' },
    { name: 'apply', desc: 'Re-apply saved preset across all fans' },
    {
      name: 'persist [action]',
      desc: 'Manage launchd daemon (status | install | uninstall)',
    },
    {
      name: 'lang [lang]',
      desc: 'Show or save display language (system | en | zh)',
    },
    {
      name: 'update',
      desc: 'Upgrade CLI via detected installer (--check only)',
    },
  ],
  options: [
    {
      flag: '--fan',
      arg: '<index>',
      desc: 'Target a single fan by index (e.g. 0 or 1)',
    },
    {
      flag: '--once, --no-save',
      desc: 'Apply once without updating saved preset',
    },
    { flag: '--json', desc: 'Emit structured JSON for scripting' },
    {
      flag: '-w, --watch',
      arg: '[sec]',
      desc: 'Stream live speeds continuously (default 1s)',
    },
    {
      flag: '--lang',
      arg: '<lang>',
      desc: 'Override language for this run (system | en | zh)',
    },
  ],
  metaOptions: [
    { flag: '-V, --version', desc: 'Print current version' },
    { flag: '-h, --help', desc: 'Show this help message' },
  ],
  examples: [
    { cmd: 'fan', desc: 'Show current speed and mode for all fans' },
    {
      cmd: 'fan status',
      tail: [
        ['flag', '-w'],
        ['arg', '1'],
      ],
      desc: 'Stream live RPM telemetry every second',
    },
    {
      cmd: 'fan set',
      tail: [['arg', '60%']],
      desc: 'Set fans to 60% of range and save preset',
    },
    {
      cmd: 'fan set',
      tail: [
        ['flag', '--fan'],
        ['arg', '0 4000'],
      ],
      desc: 'Set Fan 0 to 4000 RPM and save',
    },
    {
      cmd: 'fan set',
      tail: [
        ['arg', '50%'],
        ['flag', '--once'],
      ],
      desc: 'Set 50% temporarily without saving',
    },
    { cmd: 'fan max', desc: 'Run all fans at 100% full speed' },
    { cmd: 'fan auto', desc: 'Return control to macOS thermal management' },
    {
      cmd: 'fan lang',
      tail: [['arg', 'en']],
      desc: 'Pin display language to English',
    },
  ],
  envNotes: [
    {
      label: 'Presets',
      desc: 'set/max/min/auto save to state.json; --once skips save',
    },
    {
      label: 'Sleep Sync',
      desc: 'Releases on lid close/sleep; restores on wake & boot',
    },
    {
      label: 'Privileges',
      desc: 'Only writes, apply, and daemon setup prompt for sudo',
    },
    {
      label: 'Language',
      desc: 'Follows OS language; saved in ~/.config/fan/lang.json',
    },
    {
      label: 'Plain Text',
      desc: 'Strips ANSI when NO_COLOR, TERM=dumb, or non-TTY',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: 'Success (all commands, --version, and --help)',
    },
    {
      label: '1',
      tone: 'red',
      desc: 'Error (bad args, unsupported OS, SMC, or sudo error)',
    },
  ],
};

const RULE_WIDTH = 76;

function examplePlainParts(row: ExampleRow): string[] {
  return [row.cmd, ...(row.tail ?? []).map(([, value]) => value)];
}

function computeDescColumn(cat: HelpCatalog): number {
  return computeHelpDescColumn([
    ...cat.subcommands.map((r) => r.name),
    ...cat.options.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...cat.metaOptions.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...cat.examples.map((r) => examplePlainParts(r).join(' ')),
    ...cat.envNotes.map((r) => r.label),
    ...cat.exitCodes.map((r) => r.label),
  ]);
}

export const HELP_DESC_COL = computeDescColumn(CATALOG_ZH);

export function helpText(color: boolean, locale: Locale = 'zh'): string {
  const cat = t(locale, CATALOG_ZH, CATALOG_EN);
  const descCol = computeDescColumn(cat);
  const s = {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    section: (text: string) => paint(text, '1;34', color),
    bold: (text: string) => paint(text, '1', color),
    dim: (text: string) => paint(text, '2', color),
    token: (text: string) => paint(text, '36', color),
    green: (text: string) => paint(text, '1;32', color),
    red: (text: string) => paint(text, '1;31', color),
  };

  const alignRow = (styledLeft: string, plainLeft: string, desc: string) =>
    alignHelpRow(styledLeft, plainLeft, desc, descCol);

  const styleCommandName = (name: string): string => {
    const sp = name.indexOf(' ');
    if (sp === -1) return s.bold(name);
    return `${s.bold(name.slice(0, sp))} ${s.dim(name.slice(sp + 1))}`;
  };

  const commandRows = cat.subcommands.map((row) =>
    alignRow(styleCommandName(row.name), row.name, s.dim(row.desc)),
  );

  const formatOpt = (row: OptionRow) => {
    const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
    const styled =
      row.arg === undefined
        ? s.token(row.flag)
        : `${s.token(row.flag)} ${s.dim(row.arg)}`;
    return alignRow(styled, plain, s.dim(row.desc));
  };

  const formatEx = (row: ExampleRow) => {
    const plain = examplePlainParts(row).join(' ');
    const styled = [s.bold(row.cmd)];
    for (const [kind, value] of row.tail ?? []) {
      styled.push(kind === 'flag' ? s.token(value) : s.dim(value));
    }
    return alignRow(styled.join(' '), plain, s.dim(row.desc));
  };

  const styleNoteLabel = (row: NoteRow) => {
    if (row.tone === 'green') return s.green(row.label);
    if (row.tone === 'red') return s.red(row.label);
    return s.bold(row.label);
  };

  const formatNote = (row: NoteRow) =>
    alignRow(styleNoteLabel(row), row.label, s.dim(row.desc));

  return [
    '',
    `  ${s.badge('FAN')}  ${s.bold(cat.subtitle)}`,
    `  ${s.dim(cat.summary)}`,
    `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.section(cat.sections.usage)}`,
    `    ${s.bold('fan')} ${s.dim(cat.usageArgs[0])}`,
    `    ${s.bold('fan')} ${s.dim(cat.usageArgs[1])}`,
    '',
    `  ${s.section(cat.sections.subcommands)}`,
    ...commandRows,
    '',
    `  ${s.section(cat.sections.options)}`,
    ...cat.options.map(formatOpt),
    '',
    ...cat.metaOptions.map(formatOpt),
    '',
    `  ${s.section(cat.sections.examples)}`,
    ...cat.examples.map(formatEx),
    '',
    `  ${s.section(cat.sections.notes)}`,
    ...cat.envNotes.map(formatNote),
    '',
    `  ${s.section(cat.sections.exitCodes)}`,
    ...cat.exitCodes.map(formatNote),
    '',
    `  ${s.section(cat.sections.docs)}`,
    `    ${s.token(GITHUB_URL)}`,
    '',
  ].join('\n');
}
