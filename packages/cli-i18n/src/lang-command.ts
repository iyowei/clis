/**
 * 统一 `<cli> lang [system|en|zh]` 子命令编排与 Apple HIG 风格双语视图渲染。
 */
import { homedir as osHomedir } from 'node:os';

import { parseLangPreference } from './detect.ts';
import {
  alignHelpRow,
  computeHelpDescColumn,
  displayWidth,
  resolveCliLocale,
  t,
  writePersistedLang,
} from './resolve.ts';
import type {
  LangCommandOptions,
  LangPreference,
  Locale,
  ResolvedLocale,
} from './types.ts';

const ESC = String.fromCharCode(0x1b);
const BAR_BLOCK = '▍';
const CONTROL_CHAR_RE = /\p{Cc}/gu;

function paint(text: string, sgr: string, enabled: boolean): string {
  if (!enabled || text === '') return text;
  return `${ESC}[${sgr}m${text}${ESC}[0m`;
}

function sanitizeInline(raw: string): string {
  return raw.replace(CONTROL_CHAR_RE, ' ').replace(/\s+/g, ' ').trim();
}

function detectColors(env: Record<string, string | undefined>): {
  stdout: boolean;
  stderr: boolean;
} {
  const allowed = !env.NO_COLOR && env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

function shortenHomePath(filePath: string, home: string): string {
  if (home !== '' && filePath.startsWith(`${home}/`)) {
    return `~${filePath.slice(home.length)}`;
  }
  return filePath;
}

function formatLocaleName(locale: Locale): string {
  return locale === 'zh' ? '简体中文 (zh)' : 'English (en)';
}

function formatSourceNote(resolved: ResolvedLocale, locale: Locale): string {
  switch (resolved.source) {
    case 'default':
      return t(locale, '默认跟随系统', 'default · system');
    case 'config':
      return resolved.preference === 'system'
        ? t(locale, '已保存 · 跟随系统', 'saved · system')
        : t(locale, '已保存配置', 'saved');
    case 'flag':
      return t(locale, '本次 --lang 覆盖', 'overridden via --lang');
    case 'tool-env':
      return t(
        locale,
        `环境变量 ${resolved.envVarName} 覆盖`,
        `overridden via ${resolved.envVarName}`,
      );
    case 'suite-env':
      return t(locale, '环境变量 CLIS_LANG 覆盖', 'overridden via CLIS_LANG');
  }
}

/**
 * 渲染 `<cli> lang --help` 双语帮助。
 * 遵循全仓「单轴线右栏左对齐」规范: 用法与可选值两栏共用同一 `descCol`, 确保右侧说明严格垂直对齐。
 */
export function formatLangHelp(options: {
  binName: string;
  envVarName: string;
  configPath: string;
  locale: Locale;
  color?: boolean;
  homedir?: string;
}): string {
  const color = options.color ?? false;
  const { locale } = options;
  const safeBin = sanitizeInline(options.binName);
  const safeCfg = sanitizeInline(
    shortenHomePath(options.configPath, options.homedir ?? osHomedir()),
  );
  const badge = paint(
    `${BAR_BLOCK} ${safeBin.toUpperCase()} LANG `,
    '1;7',
    color,
  );
  const bold = (s: string): string => paint(s, '1', color);
  const dim = (s: string): string => paint(s, '2', color);
  const cyan = (s: string): string => paint(s, '36', color);

  const cmdDefault = `${safeBin} lang`;
  const cmdSet = `${safeBin} lang <system|en|zh>`;
  // 全页两栏区 (用法 + 可选值) 统一使用同一个 `descCol` 右栏起始列线
  const descCol = computeHelpDescColumn([
    cmdDefault,
    cmdSet,
    'system',
    'en',
    'zh',
  ]);
  const row = (styledLeft: string, plainLeft: string, desc: string): string =>
    alignHelpRow(styledLeft, plainLeft, desc, descCol);

  if (locale === 'zh') {
    return [
      '',
      `  ${badge}  ${bold('界面语言设置')}`,
      `  ${dim(`查看或切换 ${safeBin} 的显示语言 (各 CLI 独立保存, 默认跟随操作系统语言)。`)}`,
      '',
      `  ${dim('用法')}`,
      row(bold(cmdDefault), cmdDefault, dim('查看当前生效语言与配置来源')),
      row(
        `${bold(cmdDefault)} ${cyan('<system|en|zh>')}`,
        cmdSet,
        dim('保存该工具的默认显示语言'),
      ),
      '',
      `  ${dim('可选值')}`,
      row(cyan('system'), 'system', '跟随操作系统首选语言 (默认)'),
      row(cyan('en'), 'en', '固定使用英文界面 (即使系统语言为中文)'),
      row(cyan('zh'), 'zh', '固定使用简体中文界面'),
      '',
      `  ${dim('优先级')}`,
      `    ${cyan('--lang')} > ${cyan(options.envVarName)} > ${cyan('CLIS_LANG')} > ${dim(safeCfg)}`,
      '',
    ].join('\n');
  }

  return [
    '',
    `  ${badge}  ${bold('Display Language')}`,
    `  ${dim(`Inspect or customize the display language for ${safeBin} (stored per tool, defaults to system).`)}`,
    '',
    `  ${dim('Usage')}`,
    row(
      bold(cmdDefault),
      cmdDefault,
      dim('Show active language and preference source'),
    ),
    row(
      `${bold(cmdDefault)} ${cyan('<system|en|zh>')}`,
      cmdSet,
      dim('Save persistent language preference'),
    ),
    '',
    `  ${dim('Values')}`,
    row(cyan('system'), 'system', 'Follow operating system language (default)'),
    row(cyan('en'), 'en', 'Always display in English (overrides Chinese OS)'),
    row(cyan('zh'), 'zh', 'Always display in Simplified Chinese'),
    '',
    `  ${dim('Precedence')}`,
    `    ${cyan('--lang')} > ${cyan(options.envVarName)} > ${cyan('CLIS_LANG')} > ${dim(safeCfg)}`,
    '',
  ].join('\n');
}

function resolveDashboardTitle(
  locale: Locale,
  updatedTo: LangPreference | undefined,
): string {
  if (updatedTo === undefined) return t(locale, '语言偏好', 'Language');
  if (updatedTo === 'system') {
    return t(locale, '已恢复跟随系统语言', 'Following System Language');
  }
  return t(locale, '已更新显示语言', 'Language Updated');
}

function resolveUpdatedSummary(
  locale: Locale,
  updatedTo: LangPreference,
  systemLocale: Locale,
): string {
  if (updatedTo === 'system') {
    return t(
      locale,
      '已保存为默认 system · 自动跟随操作系统语言',
      'Saved default (system) · Follows operating system language',
    );
  }
  if (updatedTo === 'en' && systemLocale === 'zh') {
    return 'Saved preference (en) · Overrides Chinese system language';
  }
  if (updatedTo === 'zh' && systemLocale === 'en') {
    return '已保存偏好 (zh) · 优先于英文系统语言展示';
  }
  return t(
    locale,
    `已保存语言偏好 (${updatedTo})`,
    `Saved language preference (${updatedTo})`,
  );
}

function renderLangDashboard(options: {
  binName: string;
  resolved: ResolvedLocale;
  updatedTo?: LangPreference;
  color: boolean;
  home: string;
}): string {
  const { binName, resolved, updatedTo, color, home } = options;
  const { locale } = resolved;
  const safeBin = sanitizeInline(binName);
  const badge = paint(`${BAR_BLOCK} ${safeBin.toUpperCase()} `, '1;7', color);
  const bold = (s: string): string => paint(s, '1', color);
  const dim = (s: string): string => paint(s, '2', color);
  const cyan = (s: string): string => paint(s, '36', color);
  const green = (s: string): string => paint(s, '32', color);

  const title = resolveDashboardTitle(locale, updatedTo);

  const labelCols = locale === 'zh' ? 12 : 14;
  const kv = (label: string, val: string): string => {
    const pad = ' '.repeat(Math.max(2, labelCols - displayWidth(label)));
    return `  ${dim(label)}${pad}${val}`;
  };

  const sysTag = sanitizeInline(resolved.system.rawTag);
  const sysText = `${sysTag} ${dim('→')} ${resolved.system.locale}`;
  const prefText = `${cyan(resolved.preference)} ${dim(`(${formatSourceNote(resolved, locale)})`)}`;
  const cfgShort = sanitizeInline(shortenHomePath(resolved.configPath, home));

  const rows = [
    '',
    ` ${badge}  ${bold(title)}`,
    '',
    kv(t(locale, '当前生效', 'Active'), bold(formatLocaleName(locale))),
    kv(t(locale, '自定义项', 'Preference'), prefText),
    kv(t(locale, '系统语言', 'System'), sysText),
    kv(t(locale, '配置文件', 'Config'), dim(cfgShort)),
    '',
  ];

  if (updatedTo !== undefined) {
    const summary = resolveUpdatedSummary(
      locale,
      updatedTo,
      resolved.system.locale,
    );
    rows.push(` ${green('✓')} ${dim(summary)}`);
  } else {
    rows.push(
      `  ${dim(
        t(
          locale,
          `切换语言: ${safeBin} lang <system|en|zh>`,
          `Switch language: ${safeBin} lang <system|en|zh>`,
        ),
      )}`,
    );
  }

  return rows.join('\n');
}

/** 执行 `<cli> lang [system|en|zh]` 子命令并返回退出码 */
export function runLangCommand(options: LangCommandOptions): number {
  const env = options.env ?? process.env;
  const home = options.homedir ?? env.HOME ?? osHomedir();
  const colors = options.color ?? detectColors(env);
  const invalidCode = options.invalidExitCode ?? 1;
  const out =
    options.out ?? ((line: string) => process.stdout.write(`${line}\n`));
  const err =
    options.err ??
    ((line: string) => {
      const safe = sanitizeInline(line);
      const prefix = colors.stderr ? `${paint('✗', '1;31', true)} ` : '';
      process.stderr.write(`${prefix}${safe}\n`);
    });

  const current = resolveCliLocale(options);
  const args = options.argv;

  if (args.includes('--help') || args.includes('-h')) {
    out(
      formatLangHelp({
        binName: options.binName,
        envVarName: current.envVarName,
        configPath: current.configPath,
        locale: current.locale,
        color: colors.stdout,
        homedir: home,
      }),
    );
    return 0;
  }

  if (args.length === 0) {
    out(
      renderLangDashboard({
        binName: options.binName,
        resolved: current,
        color: colors.stdout,
        home,
      }),
    );
    return 0;
  }

  if (args.length > 1) {
    err(
      t(
        current.locale,
        `子命令 lang 至多接受 1 个参数 (用法: ${options.binName} lang [system|en|zh])`,
        `Too many arguments for 'lang' (usage: ${options.binName} lang [system|en|zh])`,
      ),
    );
    return invalidCode;
  }

  const rawTarget = args[0]!;
  const target = parseLangPreference(rawTarget);
  if (target === null) {
    err(
      t(
        current.locale,
        `不支持的语言选项 "${rawTarget}" (可选值: system | en | zh)`,
        `Unsupported language "${rawTarget}" (expected: system | en | zh)`,
      ),
    );
    return invalidCode;
  }

  try {
    writePersistedLang(current.configPath, target);
  } catch (error) {
    const msg = error instanceof Error ? error.message : String(error);
    err(
      t(
        current.locale,
        `写入语言配置失败 (${current.configPath}): ${msg}`,
        `Failed to save language preference (${current.configPath}): ${msg}`,
      ),
    );
    return 1;
  }

  // 重新解析保存后的状态 (若未传 --lang / env 覆盖, 立即展示新语言确认界面)
  const updated = resolveCliLocale({
    ...options,
    flag: options.flag,
    env: {
      ...env,
      [current.envVarName]: undefined,
      CLIS_LANG: undefined,
    },
  });

  out(
    renderLangDashboard({
      binName: options.binName,
      resolved: updated,
      updatedTo: target,
      color: colors.stdout,
      home,
    }),
  );
  return 0;
}
