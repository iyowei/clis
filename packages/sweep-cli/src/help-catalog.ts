/**
 * `@iyowei/sweep-cli` 双语帮助页静态文案词典。
 * 权威来源: `cli-surface.md` (BC-30)。
 */
import type { Locale } from '@iyowei/cli-i18n';

export interface CommandRow {
  name: string;
  desc: string;
}

export interface OptionRow {
  flag: string;
  arg?: string;
  desc: string;
}

export interface ExampleRow {
  cmd: string;
  flag?: string;
  arg?: string;
  desc: string;
}

export interface NoteRow {
  label: string;
  rawFirstLine?: string;
  paragraphs: readonly string[];
}

export interface ExitCodeRow {
  code: string;
  tone: 'green' | 'red';
  desc: string;
}

export interface SweepHelpCatalog {
  subtitle: string;
  summary: string;
  usageArgs: readonly [string, string];
  sections: {
    usage: string;
    commands: string;
    options: string;
    examples: string;
    safety: string;
    exitCodes: string;
    docs: string;
  };
  subcommands: readonly CommandRow[];
  actionOptions: readonly OptionRow[];
  metaOptions: readonly OptionRow[];
  examples: readonly ExampleRow[];
  exitCodes: readonly ExitCodeRow[];
  notes: readonly NoteRow[];
}

function buildCatalogEn(configPath: string): SweepHelpCatalog {
  return {
    subtitle: 'Multi-Stack Workspace Cleaner',
    summary:
      'Scan build artifacts, dependency caches, and OS junk; preview before cleaning.',
    usageArgs: ['[options]', '<command> [options]'],
    sections: {
      usage: 'Usage',
      commands: 'Commands',
      options: 'Options',
      examples: 'Examples',
      safety: 'Config & Safety',
      exitCodes: 'Exit Codes',
      docs: 'Docs & Source',
    },
    subcommands: [
      {
        name: 'init',
        desc: 'Interactive v2 setup wizard (--default for preset)',
      },
      {
        name: 'migrate',
        desc: 'Losslessly migrate v1 config with auto-backup',
      },
      {
        name: 'config',
        desc: 'Show active config path, source, and file state',
      },
      {
        name: 'lang',
        desc: 'Show or save display language (system | en | zh)',
      },
      {
        name: 'update',
        desc: 'Upgrade CLI via detected installer (--check only)',
      },
    ],
    actionOptions: [
      {
        flag: '--yes',
        desc: 'Execute cleanup (default: dry-run preview only)',
      },
      {
        flag: '--force',
        desc: 'Include suspect install trees (skipped by default)',
      },
      {
        flag: '--default',
        desc: 'Write best-practice v2 config with sweep init',
      },
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
    ],
    metaOptions: [
      { flag: '-V, --version', desc: 'Print current version' },
      { flag: '-h, --help', desc: 'Show this help message' },
    ],
    examples: [
      { cmd: 'sweep', desc: 'Preview cleanable build artifacts & caches' },
      {
        cmd: 'sweep',
        flag: '--yes',
        desc: 'Clean matched items via trash/delete',
      },
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
    ],
    exitCodes: [
      {
        code: '0',
        tone: 'green',
        desc: 'Success (preview, empty, subcommands, -V, or -h)',
      },
      {
        code: '1',
        tone: 'red',
        desc: 'Failure (clean/trash/validation error or rejected)',
      },
    ],
    notes: [
      {
        label: 'Default Config',
        rawFirstLine: configPath,
        paragraphs: ["Run 'sweep config' with --config or SWEEP_CONFIG"],
      },
      {
        label: 'Project Anchor',
        paragraphs: [
          'node/rust/python/java/cpp verify project anchors',
          'Custom rules use trash; never falls back to rm',
        ],
      },
      {
        label: 'Name Matching',
        paragraphs: [
          '--exclude/--include match exact case-sensitive dirs',
          'Exclude wins on conflict; 32 default guardrails',
        ],
      },
      {
        label: 'Real Anchors',
        paragraphs: [
          '--force includes suspect trees; roots must be real',
          'Symlinks (/tmp, /var) reject --yes; pass real path',
        ],
      },
      {
        label: 'Plain Output',
        paragraphs: ['Auto-disables ANSI on NO_COLOR, TERM=dumb, or pipe'],
      },
    ],
  };
}

function buildCatalogZh(configPath: string): SweepHelpCatalog {
  return {
    subtitle: '工作区多技术栈清理器',
    summary:
      '跨工作区扫描构建产物、依赖缓存、系统垃圾与自定义规则, 先预览后清理。',
    usageArgs: ['[选项]', '<子命令> [选项]'],
    sections: {
      usage: '用法',
      commands: '子命令',
      options: '选项',
      examples: '示例',
      safety: '配置与安全',
      exitCodes: '退出码',
      docs: '文档与源码',
    },
    subcommands: [
      {
        name: 'init',
        desc: '交互式向导生成 v2 配置 (--default 写入最佳实践)',
      },
      { name: 'migrate', desc: '无损迁移旧版配置到 v2 (写前自动备份原配置)' },
      { name: 'config', desc: '查看实际生效的配置 (来源 / 路径 / 状态)' },
      {
        name: 'lang',
        desc: '查看或设置显示语言 (system | en | zh, 默认 system)',
      },
      { name: 'update', desc: '自动识别安装器升级到最新版 (--check 仅检查)' },
    ],
    actionOptions: [
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
    ],
    metaOptions: [
      { flag: '-V, --version', desc: '显示当前版本号' },
      { flag: '-h, --help', desc: '显示本帮助' },
    ],
    examples: [
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
    ],
    exitCodes: [
      {
        code: '0',
        tone: 'green',
        desc: '成功 (预览、空结果、各子命令及 -V / -h)',
      },
      {
        code: '1',
        tone: 'red',
        desc: '失败 (清理或回收站失败、拒绝执行或参数/配置错)',
      },
    ],
    notes: [
      {
        label: '默认配置',
        rawFirstLine: configPath,
        paragraphs: ['仅平台默认; 设 SWEEP_CONFIG 或 --config 请跑 config'],
      },
      {
        label: '预设锚定',
        paragraphs: [
          'node/rust/python/java/cpp 均校验项目锚点防误删',
          'rules 默认进回收站; 回收站失败严禁降级永久删除',
        ],
      },
      {
        label: '名单口径',
        paragraphs: [
          '--exclude / --include 按目录名精确匹配, 任一级命中',
          '同时命中 exclude 优先; 默认启用 32 项安全护栏',
        ],
      },
      {
        label: '删除安全',
        paragraphs: [
          '--force 仅放行疑似安装树; 根及祖先链须为真实路径',
          '--yes 拒 /tmp、/var 软链; 改用 /private/tmp/x 放行',
        ],
      },
      {
        label: '输出降级',
        paragraphs: ['设 NO_COLOR、TERM=dumb 或非 TTY 自动降级无色纯文本'],
      },
    ],
  };
}

export function buildSweepHelpCatalog(
  locale: Locale,
  configPath: string,
): SweepHelpCatalog {
  return locale === 'en'
    ? buildCatalogEn(configPath)
    : buildCatalogZh(configPath);
}
