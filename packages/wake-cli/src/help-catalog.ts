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
  subtitle: '跨网段 Wake-on-LAN 远程唤醒工具',
  summary:
    '自动识别局域网子网与 SSH 中继故障转移, 从休眠或关机态可靠唤醒目标主机。',
  usageArgs: ['<target> [选项]', '<command> [args] [选项]'],
  sections: {
    usage: '用法',
    subcommands: '子命令',
    options: '选项',
    examples: '示例',
    notes: '网络与安全',
    exitCodes: '退出码',
    docs: '文档与源码',
  },
  subcommands: [
    { name: '<target>', desc: '唤醒配置的目标主机 (省略时使用默认目标)' },
    { name: 'list', desc: '查看已配置的目标主机、MAC、中继与默认目标' },
    { name: 'init', desc: '通过交互向导或参数新增/更新目标主机配置' },
    {
      name: 'doctor [<target>]',
      desc: '只读排查本机网卡、配置、SSH 中继与目标状态',
    },
    { name: 'lang [lang]', desc: '查看或固定界面语言 (system | en | zh)' },
    {
      name: 'update',
      desc: '检查或执行跨包管理器在线自更新 (--check 仅检查)',
    },
  ],
  options: [
    {
      flag: '-c, --config',
      arg: '<path>',
      desc: '指定配置文件路径 (高于 WAKE_CONFIG)',
    },
    {
      flag: '-m, --mac',
      arg: '<mac>',
      desc: '直接指定 MAC 地址 (可重复或逗号分隔)',
    },
    {
      flag: '-H, --host',
      arg: '<host>',
      desc: '目标主机 IP 或域名 (用于预检与等待上线)',
    },
    { flag: '-p, --port', arg: '<port>', desc: 'TCP 就绪探测端口 (默认 22)' },
    {
      flag: '-b, --broadcast',
      arg: '<ip>',
      desc: '额外或显式定向广播 IPv4 (可重复)',
    },
    {
      flag: '-r, --relay',
      arg: '<ssh>',
      desc: 'SSH 中继主机或别名, 按顺序故障转移 (可重复)',
    },
    {
      flag: '-t, --timeout',
      arg: '<sec>',
      desc: '等待目标端口上线的超时秒数 (默认 90)',
    },
    { flag: '--no-wait', desc: '仅投递魔术包后立即返回, 不等待端口上线' },
    {
      flag: '--force',
      desc: '目标已在线时仍强制重发魔术包; init 时覆盖同名目标',
    },
    { flag: '--local-only', desc: '忽略配置的 SSH 中继, 仅本机局域网广播' },
    {
      flag: '--no-local-fallback',
      desc: '中继全失败时直接报错, 不回退本机广播',
    },
    {
      flag: '--name',
      arg: '<target>',
      desc: 'init 子命令非交互指定保存的目标名',
    },
    { flag: '--default', desc: 'init 子命令保存后设为默认唤醒目标' },
    { flag: '--yes', desc: 'init 子命令跳过确认提示直接保存' },
    { flag: '--json', desc: '以结构化 JSON 输出报告或目标清单' },
    { flag: '--lang', arg: '<system|en|zh>', desc: '单次覆盖界面语言' },
    { flag: '-V, --version', desc: '输出版本号并退出' },
    { flag: '-h, --help', desc: '显示本帮助信息并退出' },
  ],
  examples: [
    { cmd: 'wake', desc: '唤醒默认配置目标并等待 SSH/端口就绪' },
    {
      cmd: 'wake',
      tail: [['arg', 'workstation']],
      desc: '按别名唤醒配置中的工作站',
    },
    {
      cmd: 'wake',
      tail: [
        ['flag', '--mac'],
        ['arg', '00:11:22:33:44:55'],
        ['flag', '--host'],
        ['arg', '192.0.2.10'],
      ],
      desc: '无配置文件按 MAC 临时唤醒并等待就绪',
    },
    {
      cmd: 'wake',
      tail: [
        ['arg', 'nas'],
        ['flag', '--relay'],
        ['arg', 'bastion-a'],
        ['flag', '--no-wait'],
      ],
      desc: '经 SSH 中继节点发包并立即返回',
    },
    { cmd: 'wake init', desc: '启动交互向导并扫描 ARP 邻接表辅助配置' },
    { cmd: 'wake doctor', desc: '只读诊断本机局域网接口与中继 SSH 连通性' },
  ],
  notes: [
    {
      label: '配置位置',
      desc: 'POSIX ~/.config/wake/config.json · Windows %APPDATA%\\wake\\config.json (WAKE_CONFIG 可覆盖)',
    },
    {
      label: '防劫持链路',
      desc: 'SSH 中继禁用密码交互与 shell 注入, 全量经白名单校验参数无 shell 执行',
    },
    {
      label: '语言偏好',
      desc: '默认跟随系统语言; wake lang <system|en|zh> 保存至 ~/.config/wake/lang.json',
    },
    {
      label: '输出降级',
      desc: '设 NO_COLOR、TERM=dumb 或非 TTY 输出时自动禁用 ANSI 转义',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: '已上线 / 成功唤醒 / 发包完成 / 只读检查与帮助',
    },
    {
      label: '1',
      tone: 'red',
      desc: '参数错误、等待上线超时、配置缺失或中继/发包失败',
    },
  ],
};

export const CATALOG_EN: HelpCatalog = {
  subtitle: 'Subnet-Aware & SSH-Relay Wake-on-LAN CLI',
  summary:
    'Send 102-byte WoL magic packets locally or fail over across SSH relays until the target comes online.',
  usageArgs: ['<target> [options]', '<command> [args] [options]'],
  sections: {
    usage: 'Usage',
    subcommands: 'Commands',
    options: 'Options',
    examples: 'Examples',
    notes: 'Network & Safety',
    exitCodes: 'Exit Codes',
    docs: 'Docs & Source',
  },
  subcommands: [
    {
      name: '<target>',
      desc: 'Wake configured target (defaultTarget when omitted)',
    },
    {
      name: 'list',
      desc: 'Show configured targets, MACs, relays, and default',
    },
    { name: 'init', desc: 'Create or update a target via wizard or flags' },
    {
      name: 'doctor [<target>]',
      desc: 'Read-only check of NICs, config, SSH relays, and host',
    },
    {
      name: 'lang [lang]',
      desc: 'Show or save display language (system | en | zh)',
    },
    {
      name: 'update',
      desc: 'Upgrade CLI via detected package manager (--check only)',
    },
  ],
  options: [
    {
      flag: '-c, --config',
      arg: '<path>',
      desc: 'Config file path override (over WAKE_CONFIG)',
    },
    {
      flag: '-m, --mac',
      arg: '<mac>',
      desc: 'Target MAC address (repeatable or comma-separated)',
    },
    {
      flag: '-H, --host',
      arg: '<host>',
      desc: 'Host IP/name for precheck and readiness wait',
    },
    {
      flag: '-p, --port',
      arg: '<port>',
      desc: 'TCP readiness probe port (default 22)',
    },
    {
      flag: '-b, --broadcast',
      arg: '<ip>',
      desc: 'Explicit directed broadcast IPv4 (repeatable)',
    },
    {
      flag: '-r, --relay',
      arg: '<ssh>',
      desc: 'SSH relay host/alias tried in order (repeatable)',
    },
    {
      flag: '-t, --timeout',
      arg: '<sec>',
      desc: 'Readiness wait timeout in seconds (default 90)',
    },
    { flag: '--no-wait', desc: 'Exit immediately after sending magic packets' },
    {
      flag: '--force',
      desc: 'Send packet even if target is online; overwrite on init',
    },
    {
      flag: '--local-only',
      desc: 'Skip configured relays and broadcast locally only',
    },
    {
      flag: '--no-local-fallback',
      desc: 'Fail instead of falling back locally when relays fail',
    },
    {
      flag: '--name',
      arg: '<target>',
      desc: 'Target alias name for non-interactive wake init',
    },
    {
      flag: '--default',
      desc: 'Set target as defaultTarget when running wake init',
    },
    { flag: '--yes', desc: 'Confirm writes without prompts on wake init' },
    { flag: '--json', desc: 'Emit structured JSON report or target listing' },
    {
      flag: '--lang',
      arg: '<system|en|zh>',
      desc: 'Override display language for this run',
    },
    { flag: '-V, --version', desc: 'Show CLI version and exit' },
    { flag: '-h, --help', desc: 'Show this help and exit' },
  ],
  examples: [
    { cmd: 'wake', desc: 'Wake defaultTarget and wait until reachable' },
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
        ['flag', '--host'],
        ['arg', '192.0.2.10'],
      ],
      desc: 'Ad-hoc wake by MAC without a config file',
    },
    {
      cmd: 'wake',
      tail: [
        ['arg', 'nas'],
        ['flag', '--relay'],
        ['arg', 'bastion-a'],
        ['flag', '--no-wait'],
      ],
      desc: 'Wake via SSH relay without blocking on TCP readiness',
    },
    {
      cmd: 'wake init',
      desc: 'Run setup wizard with local ARP neighbor discovery',
    },
    {
      cmd: 'wake doctor',
      desc: 'Read-only check of local interfaces and SSH relays',
    },
  ],
  notes: [
    {
      label: 'Config Path',
      desc: '~/.config/wake/config.json (POSIX) · %APPDATA%\\wake\\config.json (Win) · WAKE_CONFIG',
    },
    {
      label: 'Relay Safety',
      desc: 'Strict allowlisted arguments with BatchMode SSH; zero shell interpolation',
    },
    {
      label: 'Language',
      desc: 'Follows OS locale by default; wake lang <system|en|zh> persists ~/.config/wake/lang.json',
    },
    {
      label: 'Plain Output',
      desc: 'Omits ANSI escape sequences under NO_COLOR, TERM=dumb, or non-TTY streams',
    },
  ],
  exitCodes: [
    {
      label: '0',
      tone: 'green',
      desc: 'Online / woken / dispatched / read-only check & help',
    },
    {
      label: '1',
      tone: 'red',
      desc: 'Validation error, wait timeout, missing config, or dispatch failure',
    },
  ],
};
