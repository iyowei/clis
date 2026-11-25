/**
 * `@iyowei/fan-cli` 帮助页文案与统一左对齐排版渲染 (零外部依赖)。
 * 全页所有分段使用同一基于东亚宽度的 `descCol` 列线, 消除中西文混排参差不齐的问题。
 */
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

const SUBCOMMANDS: readonly CommandRow[] = [
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
  { name: 'update', desc: '自动识别安装器升级到最新版 (--check 仅检查)' },
];

const OPTIONS: readonly OptionRow[] = [
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
];

const META_OPTIONS: readonly OptionRow[] = [
  { flag: '-V, --version', desc: '显示当前版本号' },
  { flag: '-h, --help', desc: '显示本帮助' },
];

const EXAMPLES: readonly ExampleRow[] = [
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
    cmd: 'fan persist',
    tail: [['arg', 'install']],
    desc: '安装开机与睡眠唤醒自动恢复服务',
  },
];

const ENV_NOTES: readonly NoteRow[] = [
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
    label: '工具冲突',
    desc: '若后台运行 Macs Fan Control 等软件, 它可能覆写手动设定',
  },
  {
    label: '输出降级',
    desc: '设置 NO_COLOR、TERM=dumb 或非 TTY 时自动输出无 ANSI 纯文本',
  },
];

const EXIT_CODES: readonly NoteRow[] = [
  {
    label: '0',
    tone: 'green',
    desc: '成功 (含 status/set/max/min/auto/apply/persist/update/-V/-h)',
  },
  {
    label: '1',
    tone: 'red',
    desc: '失败 (参数非法、平台不支持、SMC/守护失败或提权被拒)',
  },
];

const RULE_WIDTH = 76;

function examplePlainParts(row: ExampleRow): string[] {
  return [row.cmd, ...(row.tail ?? []).map(([, value]) => value)];
}

function computeDescColumn(): number {
  const plainLefts: string[] = [
    ...SUBCOMMANDS.map((r) => r.name),
    ...OPTIONS.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...META_OPTIONS.map((r) =>
      r.arg === undefined ? r.flag : `${r.flag} ${r.arg}`,
    ),
    ...EXAMPLES.map((r) => examplePlainParts(r).join(' ')),
    ...ENV_NOTES.map((r) => r.label),
    ...EXIT_CODES.map((r) => r.label),
  ];
  const maxWidth = Math.max(...plainLefts.map(displayWidth));
  return maxWidth + 3;
}

export const HELP_DESC_COL = computeDescColumn();

export function helpText(color: boolean): string {
  const s = {
    badge: (text: string) => paint(`${BAR_BLOCK} ${text} `, '1;7', color),
    bold: (t: string) => paint(t, '1', color),
    dim: (t: string) => paint(t, '2', color),
    token: (t: string) => paint(t, '36', color),
    green: (t: string) => paint(t, '1;32', color),
    red: (t: string) => paint(t, '1;31', color),
  };

  const alignRow = (styledLeft: string, plainLeft: string, desc: string) => {
    const pad = ' '.repeat(
      Math.max(2, HELP_DESC_COL - displayWidth(plainLeft)),
    );
    return `    ${styledLeft}${pad}${desc}`;
  };

  const commandRows = SUBCOMMANDS.map((row) =>
    alignRow(s.bold(row.name), row.name, row.desc),
  );

  const formatOpt = (row: OptionRow) => {
    const plain = row.arg === undefined ? row.flag : `${row.flag} ${row.arg}`;
    const styled =
      row.arg === undefined
        ? s.token(row.flag)
        : `${s.token(row.flag)} ${s.dim(row.arg)}`;
    return alignRow(styled, plain, row.desc);
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
    alignRow(styleNoteLabel(row), row.label, row.desc);

  return [
    '',
    `  ${s.badge('FAN')}  ${s.bold('macOS 风扇查看与手动控制器')}`,
    `  ${s.dim('直接读写 AppleSMC 风扇键 (FNum/F*Ac/F*Tg/F*md), 合盖/睡眠自动停转, 开盖与重启自动恢复。')}`,
    `  ${s.dim('─'.repeat(RULE_WIDTH))}`,
    '',
    `  ${s.dim('用法')}`,
    `    ${s.bold('fan')} ${s.dim('[选项]')}`,
    `    ${s.bold('fan')} ${s.dim('<子命令> [参数] [选项]')}`,
    '',
    `  ${s.dim('子命令')}`,
    ...commandRows,
    '',
    `  ${s.dim('选项')}`,
    ...OPTIONS.map(formatOpt),
    '',
    ...META_OPTIONS.map(formatOpt),
    '',
    `  ${s.dim('示例')}`,
    ...EXAMPLES.map(formatEx),
    '',
    `  ${s.dim('环境与持久化')}`,
    ...ENV_NOTES.map(formatNote),
    '',
    `  ${s.dim('退出码')}`,
    ...EXIT_CODES.map(formatNote),
    '',
  ].join('\n');
}
