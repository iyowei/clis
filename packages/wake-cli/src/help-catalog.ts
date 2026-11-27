/**
 * `@iyowei/wake-cli` 双语帮助页静态文案词典。
 */

export interface HelpCatalog {
  subtitle: string;
  summary: string;
  usageArgs: readonly string[];
  sections: {
    usage: string;
    subcommands: string;
    options: string;
    examples: string;
    notes: string;
    exitCodes: string;
    docs: string;
  };
  subcommands: ReadonlyArray<{ name: string; desc: string }>;
  options: ReadonlyArray<{ flag: string; arg?: string; desc: string }>;
  examples: ReadonlyArray<{
    cmd: string;
    tail?: ReadonlyArray<readonly ['arg' | 'flag', string]>;
    desc: string;
  }>;
  notes: ReadonlyArray<{ label: string; desc: string }>;
  exitCodes: ReadonlyArray<{
    label: string;
    tone: 'green' | 'red';
    desc: string;
  }>;
}

export const CATALOG_ZH: HelpCatalog = {
  subtitle: '远程开机工具 (Wake-on-LAN)',
  summary:
    '同局域网可直接广播开机, 隔着外网或 VPN 也可借路家里其他常开机器 SSH 代发开机包。',
  usageArgs: ['<target> [选项]', '<command> [args] [选项]'],
  sections: {
    usage: '用法',
    subcommands: '子命令',
    options: '选项',
    examples: '示例',
    notes: '使用须知',
    exitCodes: '退出码',
    docs: '文档与源码',
  },
  subcommands: [
    { name: '<target>', desc: '唤醒指定别名的电脑 (不填则唤醒默认电脑)' },
    { name: 'list', desc: '查看已保存的电脑、MAC、跳板机与默认目标' },
    { name: 'init', desc: '引导添加或更新电脑 (自动扫局域网设备少手敲 MAC)' },
    {
      name: 'doctor [<target>]',
      desc: '只读检查配置、本机网卡和跳板机是否通畅 (不会开机)',
    },
    { name: 'lang [lang]', desc: '查看或固定显示语言 (system | en | zh)' },
    {
      name: 'update',
      desc: '检查或升级 wake 到最新版 (--check 只检查不更新)',
    },
  ],
  options: [
    {
      flag: '-c, --config',
      arg: '<path>',
      desc: '指定配置文件路径 (优先于环境变量 WAKE_CONFIG)',
    },
    {
      flag: '-m, --mac',
      arg: '<mac>',
      desc: '目标网卡 MAC 地址 (可多次传入或逗号隔开)',
    },
    {
      flag: '-H, --host',
      arg: '<host>',
      desc: '目标 IP 或域名 (用于确认对方是否已经开机)',
    },
    {
      flag: '-p, --port',
      arg: '<port>',
      desc: '检测开机就绪的 TCP 端口 (默认 22)',
    },
    {
      flag: '-b, --broadcast',
      arg: '<ip>',
      desc: '手动指定广播 IPv4 地址 (可多次传入)',
    },
    {
      flag: '-r, --relay',
      arg: '<ssh>',
      desc: '用来代发开机包的跳板机 (填 SSH 别名或 user@host, 连不上自动换下一台)',
    },
    {
      flag: '-t, --timeout',
      arg: '<sec>',
      desc: '最多等几秒确认对方开机 (默认 90 秒)',
    },
    {
      flag: '--no-wait',
      desc: '发完开机包立刻退出, 不等对方进系统',
    },
    {
      flag: '--force',
      desc: '就算检测到在线也再发一遍唤醒包; init 下允许覆盖同名配置',
    },
    {
      flag: '--local-only',
      desc: '不走跳板机, 直接从当前电脑发局域网广播',
    },
    {
      flag: '--no-local-fallback',
      desc: '跳板机全连不上时直接报错, 不退回当前电脑发广播',
    },
    {
      flag: '--name',
      arg: '<target>',
      desc: '配合 wake init 免交互指定要保存的电脑别名',
    },
    {
      flag: '--default',
      desc: '配合 wake init 保存后设为默认开机目标',
    },
    {
      flag: '--yes',
      desc: '配合 wake init 跳过确认提示直接保存',
    },
    {
      flag: '--json',
      desc: '输出 JSON 结构化结果 (方便脚本解析)',
    },
    {
      flag: '--lang',
      arg: '<system|en|zh>',
      desc: '仅本次运行临时切换显示语言',
    },
    { flag: '-V, --version', desc: '显示版本号并退出' },
    { flag: '-h, --help', desc: '显示本帮助信息并退出' },
  ],
  examples: [
    { cmd: 'wake', desc: '开机默认电脑并等到 SSH/端口通畅' },
    {
      cmd: 'wake',
      tail: [['arg', 'workstation']],
      desc: '唤醒已保存的 workstation',
    },
    {
      cmd: 'wake',
      tail: [
        ['flag', '--mac'],
        ['arg', '00:11:22:33:44:55'],
      ],
      desc: '不写配置直接按 MAC 临时开机',
    },
    {
      cmd: 'wake',
      tail: [
        ['arg', 'nas'],
        ['flag', '--relay'],
        ['arg', 'home'],
      ],
      desc: '通过跳板机 home 代发开机包',
    },
    { cmd: 'wake init', desc: '打开向导录入新电脑 (自动扫局域网)' },
    { cmd: 'wake doctor', desc: '只读检查本机网卡与各跳板机是否正常' },
  ],
  notes: [
    {
      label: '配置文件',
      desc: '~/.config/wake/config.json (Windows: %APPDATA%\\wake\\config.json)',
    },
    {
      label: '跳板机前提',
      desc: '须先配好免密 SSH (~/.ssh/config), 且跳板机上已装 wake',
    },
    {
      label: '显示语言',
      desc: '默认跟随系统语言; 运行 wake lang <system|en|zh> 可持久切换',
    },
    {
      label: '纯文本模式',
      desc: '设置 NO_COLOR、TERM=dumb 或管道输出时自动去掉 ANSI 颜色',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: '已在线 / 唤醒成功 / 已发包 (--no-wait) / 只读检查与帮助',
    },
    {
      label: '1',
      tone: 'red',
      desc: '参数无效、等待开机超时、缺配置文件或跳板机与本地发包全失败',
    },
  ],
};

export const CATALOG_EN: HelpCatalog = {
  subtitle: 'Remote Power-On via Wake-on-LAN',
  summary:
    'Send WoL magic packets directly on your LAN, or bounce via SSH jump hosts when remote.',
  usageArgs: ['<target> [options]', '<command> [args] [options]'],
  sections: {
    usage: 'Usage',
    subcommands: 'Commands',
    options: 'Options',
    examples: 'Examples',
    notes: 'Notes',
    exitCodes: 'Exit Codes',
    docs: 'Docs & Source',
  },
  subcommands: [
    {
      name: '<target>',
      desc: 'Wake saved target by alias (uses defaultTarget if omitted)',
    },
    {
      name: 'list',
      desc: 'Show saved targets, MACs, SSH jump hosts, and default',
    },
    {
      name: 'init',
      desc: 'Add or update a target (scans LAN ARP table to prefill MAC)',
    },
    {
      name: 'doctor [<target>]',
      desc: 'Read-only check of config, NICs, and SSH jump hosts (never wakes)',
    },
    {
      name: 'lang [lang]',
      desc: 'Show or save display language (system | en | zh)',
    },
    {
      name: 'update',
      desc: 'Upgrade CLI to latest version (--check only)',
    },
  ],
  options: [
    {
      flag: '-c, --config',
      arg: '<path>',
      desc: 'Use custom config file (overrides WAKE_CONFIG)',
    },
    {
      flag: '-m, --mac',
      arg: '<mac>',
      desc: 'Target NIC MAC address (repeatable or comma-separated)',
    },
    {
      flag: '-H, --host',
      arg: '<host>',
      desc: 'Target IP or hostname for online check & boot wait',
    },
    {
      flag: '-p, --port',
      arg: '<port>',
      desc: 'TCP port polled to confirm boot readiness (default 22)',
    },
    {
      flag: '-b, --broadcast',
      arg: '<ip>',
      desc: 'Explicit IPv4 broadcast address (repeatable)',
    },
    {
      flag: '-r, --relay',
      arg: '<ssh>',
      desc: 'SSH jump host on target LAN (alias or user@host; falls back in order)',
    },
    {
      flag: '-t, --timeout',
      arg: '<sec>',
      desc: 'Max seconds to wait for target to come online (default 90)',
    },
    {
      flag: '--no-wait',
      desc: 'Exit immediately after sending packets without waiting',
    },
    {
      flag: '--force',
      desc: 'Send packet even if online; allow overwrite on init',
    },
    {
      flag: '--local-only',
      desc: 'Ignore saved SSH jump hosts and broadcast locally only',
    },
    {
      flag: '--no-local-fallback',
      desc: 'Fail instead of falling back locally if all jump hosts fail',
    },
    {
      flag: '--name',
      arg: '<target>',
      desc: 'Target alias for non-interactive wake init',
    },
    {
      flag: '--default',
      desc: 'Set saved target as defaultTarget in wake init',
    },
    {
      flag: '--yes',
      desc: 'Save config without confirmation in wake init',
    },
    {
      flag: '--json',
      desc: 'Emit structured JSON report or target list',
    },
    {
      flag: '--lang',
      arg: '<system|en|zh>',
      desc: 'Override display language for this run',
    },
    { flag: '-V, --version', desc: 'Show CLI version and exit' },
    { flag: '-h, --help', desc: 'Show this help and exit' },
  ],
  examples: [
    { cmd: 'wake', desc: 'Wake default target and wait until reachable' },
    {
      cmd: 'wake',
      tail: [['arg', 'workstation']],
      desc: 'Wake saved alias workstation',
    },
    {
      cmd: 'wake',
      tail: [
        ['flag', '--mac'],
        ['arg', '00:11:22:33:44:55'],
      ],
      desc: 'Ad-hoc wake by MAC without a config file',
    },
    {
      cmd: 'wake',
      tail: [
        ['arg', 'nas'],
        ['flag', '--relay'],
        ['arg', 'home'],
      ],
      desc: 'Bounce magic packet via SSH jump host home',
    },
    {
      cmd: 'wake init',
      desc: 'Start setup wizard with local ARP neighbor discovery',
    },
    {
      cmd: 'wake doctor',
      desc: 'Read-only check of local interfaces and SSH jump hosts',
    },
  ],
  notes: [
    {
      label: 'Config File',
      desc: '~/.config/wake/config.json (Windows: %APPDATA%\\wake\\config.json)',
    },
    {
      label: 'Jump Hosts',
      desc: 'Requires passwordless SSH (~/.ssh/config) and wake in remote PATH',
    },
    {
      label: 'Language',
      desc: 'Follows OS locale by default; run wake lang <system|en|zh> to persist',
    },
    {
      label: 'Plain Output',
      desc: 'Omits ANSI escape codes under NO_COLOR, TERM=dumb, or non-TTY streams',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: 'Online / woken / dispatched (--no-wait) / read-only check & help',
    },
    {
      label: '1',
      tone: 'red',
      desc: 'Validation error, timeout, missing config, or dispatch failure',
    },
  ],
};
