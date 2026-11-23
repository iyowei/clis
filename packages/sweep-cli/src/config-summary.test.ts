/**
 * 配置摘要渲染 (`renderConfigSummary`) 与跨平台快捷指令 (`buildConfigQuickCommands`) 单测:
 * 覆盖 darwin / linux / win32 三端指令、预设与规则标注、护栏提示、迁移提示、
 * 零原始 JSON 红线与 OF-14 恶意路径净化及安全引用。
 */
import { describe, expect, test } from 'bun:test';

import { type Config, DEFAULT_EXCLUDE, NEW_PRESET_HINTS } from '@iyowei/sweep';

import {
  buildConfigQuickCommands,
  renderConfigSummary,
} from './config-summary.ts';

const ANSI_RE = new RegExp(`${String.fromCharCode(0x1b)}\\[[0-9;]*m`, 'g');
const stripAnsi = (text: string): string => text.replace(ANSI_RE, '');

function baseConfig(overrides: Partial<Config> = {}): Config {
  return {
    version: 2,
    roots: ['/Users/alice/workspace'],
    exclude: [...DEFAULT_EXCLUDE],
    include: [],
    presets: { node: {}, 'os-junk': { action: 'trash' } },
    rules: [],
    ...overrides,
  };
}

describe('buildConfigQuickCommands 三端平台快捷指令', () => {
  test('macOS (darwin): 含 sweep config、cat、${EDITOR:-vi} 与 open -e, 家目录缩写为 ~', () => {
    const cmds = buildConfigQuickCommands(
      '/Users/alice/.config/sweep/config.json',
      'darwin',
      '/Users/alice',
    );
    const list = cmds.map((c) => c.command);

    expect(list).toEqual([
      'sweep config',
      'cat ~/.config/sweep/config.json',
      '${EDITOR:-vi} ~/.config/sweep/config.json',
      'open -e ~/.config/sweep/config.json',
    ]);
  });

  test('Linux (linux): 含 sweep config、cat、${EDITOR:-vi}, 不含 open -e', () => {
    const cmds = buildConfigQuickCommands(
      '/home/bob/.config/sweep/config.json',
      'linux',
      '/home/bob',
    );
    const list = cmds.map((c) => c.command);

    expect(list).toEqual([
      'sweep config',
      'cat ~/.config/sweep/config.json',
      '${EDITOR:-vi} ~/.config/sweep/config.json',
    ]);
    expect(list.some((c) => c.includes('open -e'))).toBe(false);
  });

  test('Windows (win32): 含 sweep config、Get-Content 与 notepad, 保留原路径并用双引号包裹', () => {
    const winPath = 'C:\\Users\\alice\\AppData\\Roaming\\sweep\\config.json';
    const cmds = buildConfigQuickCommands(winPath, 'win32', 'C:\\Users\\alice');
    const list = cmds.map((c) => c.command);

    expect(list).toEqual([
      'sweep config',
      `Get-Content "${winPath}"`,
      `notepad "${winPath}"`,
    ]);
    expect(list.some((c) => c.includes('cat '))).toBe(false);
    expect(list.some((c) => c.includes('open -e'))).toBe(false);
  });

  test('含 ANSI / 控制字符 / 空格 / 引号的恶意路径统一过 OF-14 净化且 shell 引用安全', () => {
    const evilPosix = "/tmp/my 'evil'\u001b[2J\u202e\ndir/config.json";
    const posixCmds = buildConfigQuickCommands(evilPosix, 'darwin');
    const catCmd = posixCmds.find((c) => c.command.startsWith('cat '))!.command;

    expect(catCmd).not.toContain('\u001b');
    expect(catCmd).not.toContain('\u202e');
    expect(catCmd).not.toContain('\n');
    expect(catCmd).toBe("cat '/tmp/my '\\''evil'\\''[2J dir/config.json'");

    const evilWin = 'C:\\Users\\my "bad"\u001b[31m\npath\\config.json';
    const winCmds = buildConfigQuickCommands(evilWin, 'win32');
    const gcCmd = winCmds.find((c) =>
      c.command.startsWith('Get-Content '),
    )!.command;

    expect(gcCmd).not.toContain('\u001b');
    expect(gcCmd).not.toContain('\n');
    expect(gcCmd).toBe(
      'Get-Content "C:\\Users\\my `"bad`"[31m path\\config.json"',
    );
  });

  test("POSIX / macOS 家目录内含空格与中文路径时回退单引号包裹完整绝对路径, 避免产出不可展开的 '~/...'", () => {
    const darwinCfg = '/Users/alice/My Configs/清理配置 (v2)/config.json';
    const darwinCmds = buildConfigQuickCommands(
      darwinCfg,
      'darwin',
      '/Users/alice',
    ).map((c) => c.command);

    expect(darwinCmds).toEqual([
      'sweep config',
      `cat '${darwinCfg}'`,
      `\${EDITOR:-vi} '${darwinCfg}'`,
      `open -e '${darwinCfg}'`,
    ]);
    expect(darwinCmds.some((c) => c.includes("'~/"))).toBe(false);

    const linuxHomeWithSpace = '/home/Alice Smith';
    const linuxCfg = `${linuxHomeWithSpace}/配置目录/config.json`;
    const linuxCmds = buildConfigQuickCommands(
      linuxCfg,
      'linux',
      linuxHomeWithSpace,
    ).map((c) => c.command);

    expect(linuxCmds).toEqual([
      'sweep config',
      `cat '${linuxCfg}'`,
      `\${EDITOR:-vi} '${linuxCfg}'`,
    ]);
    expect(linuxCmds.some((c) => c.includes("'~/"))).toBe(false);
  });
});

describe('renderConfigSummary 结构化配置摘要与零原始 JSON 红线', () => {
  test('渲染预设 [DELETE]/[TRASH]、自定义规则与保留天数、排除护栏、白名单及迁移提示, 绝不含原始 JSON', () => {
    const config = baseConfig({
      roots: ['/Users/alice/dev', '/opt/work'],
      include: ['web-app', 'api-srv'],
      rules: [
        {
          name: 'temp-logs',
          match: '*.log',
          kind: 'file',
          action: 'trash',
          olderThanDays: 14,
        },
        {
          name: 'dist-out',
          match: 'dist',
          kind: 'dir',
          action: 'delete',
        },
      ],
    });

    const lines = renderConfigSummary({
      configPath: '/Users/alice/.config/sweep/config.json',
      config,
      excludeExplicit: false,
      heading: '配置已迁移',
      backupPath:
        '/Users/alice/.config/sweep-node-modules/config.json.20261120_120000.modified',
      newAvailablePresets: NEW_PRESET_HINTS,
      home: '/Users/alice',
      platform: 'darwin',
      color: false,
    });
    const text = lines.join('\n');

    expect(text).toContain('配置已迁移: ~/.config/sweep/config.json  ✓');
    expect(text).toContain(
      '原配置已备份: ~/.config/sweep-node-modules/config.json.20261120_120000.modified',
    );
    expect(text).toContain('扫描根 (2 个): ~/dev · /opt/work');
    expect(text).toContain('激活预设 (2 项): node [DELETE] · os-junk [TRASH]');
    expect(text).toContain(
      '自定义规则 (2 条): temp-logs [TRASH] · > 14 天 · dist-out [DELETE]',
    );
    expect(text).toContain(
      `全局排除: ${DEFAULT_EXCLUDE.length} 条 (内置安全护栏)`,
    );
    expect(text).toContain('全局白名单 (2 条): web-app · api-srv');
    expect(text).toContain(
      '新增可用预设: rust · python · java · cpp · os-junk (可手动编辑配置按需启用)',
    );
    expect(text).toContain('open -e ~/.config/sweep/config.json');

    // 核心红线: 严禁输出原始 JSON 全文
    expect(text).not.toContain('"version":');
    expect(text).not.toContain('"presets":');
    expect(text).not.toContain('{\n');
  });

  test('0 预设 / 0 规则 / 显式排除 (不带护栏标注) 及着色降级逐字节等价', () => {
    const config = baseConfig({
      exclude: ['vendor', 'fixtures'],
      presets: {},
      rules: [],
    });
    const baseOpts = {
      configPath: '/home/dev/.config/sweep/config.json',
      config,
      excludeExplicit: true,
      heading: '配置已写入',
      home: '/home/dev',
      platform: 'linux' as const,
    };

    const plain = renderConfigSummary({ ...baseOpts, color: false });
    const colored = renderConfigSummary({ ...baseOpts, color: true });
    const plainText = plain.join('\n');

    expect(plainText).toContain('激活预设: 0 项');
    expect(plainText).toContain('自定义规则: 0 条');
    expect(plainText).toContain('全局排除: 2 条');
    expect(plainText).not.toContain('(内置安全护栏)');
    expect(plainText).not.toContain('全局白名单');
    expect(plainText).not.toContain('"version":');
    expect(plainText).not.toContain('"presets":');

    expect(colored.some((l) => l.includes('\u001b['))).toBe(true);
    expect(colored.map(stripAnsi)).toEqual(plain);
  });

  test('恶意规则名与路径经 OF-14 净化后不外泄控制字符且不劈行', () => {
    const config = baseConfig({
      roots: ['/Users/alice/bad\u001b[2J\nroot'],
      include: ['inc\u202e\nname'],
      rules: [
        {
          name: 'rule\u001b[31m\nboom',
          match: '*.tmp',
          kind: 'file',
          action: 'trash',
        },
      ],
    });
    const lines = renderConfigSummary({
      configPath: '/Users/alice/evil\u001b[2J\npath/config.json',
      config,
      heading: '配置已写入',
      home: '/Users/alice',
      platform: 'darwin',
      color: false,
    });

    for (const line of lines) {
      expect(line).not.toContain('\u001b');
      expect(line).not.toContain('\u202e');
      expect(line).not.toContain('\n');
    }
    const text = lines.join('\n');
    expect(text).toContain('rule[31m boom [TRASH]');
    expect(text).toContain('inc name');
  });

  test('路径字符串物理风味与 platform 命令方言解耦: Windows 路径注入 darwin 平台时仍按反斜杠正确缩写 ~', () => {
    const winHome = 'C:\\Users\\runneradmin\\tmp\\ci-home';
    const winCfg = `${winHome}\\.config\\sweep\\config.json`;
    const lines = renderConfigSummary({
      configPath: winCfg,
      config: baseConfig({ roots: [`${winHome}\\dev`] }),
      heading: '配置已写入',
      home: winHome,
      platform: 'darwin',
      color: false,
    });
    const text = lines.join('\n');
    expect(text).toContain('配置已写入: ~\\.config\\sweep\\config.json  ✓');
    expect(text).toContain('扫描根 (1 个): ~\\dev');
    expect(text).toContain(`cat '${winCfg}'`);
    expect(text).toContain(`\${EDITOR:-vi} '${winCfg}'`);
    expect(text).toContain(`open -e '${winCfg}'`);
    expect(text).not.toContain("'~\\");
  });
});
