/**
 * 配置落盘后的结构化人话摘要渲染 (纯函数, 零 IO, 支持中英双语, 设计见 ADR 0024):
 * 红线: 写盘后严禁输出原始 JSON 全文; 全部路径经 `sanitizeLine` 净化后再渲染与拼装平台快捷指令。
 */
import { type Locale, displayWidth, t } from '@iyowei/cli-i18n';
import {
  type Config,
  PRESET_NAMES,
  type PresetName,
  resolvePresetAction,
  sanitizeLine,
} from '@iyowei/sweep';

import { inferPathStyle, neutralLine, paint, shortenHome } from './render.ts';

export interface ConfigSummaryOptions {
  configPath: string;
  config: Config;
  excludeExplicit?: boolean;
  heading: string;
  backupPath?: string;
  newAvailablePresets?: readonly PresetName[];
  home?: string;
  platform?: NodeJS.Platform;
  color: boolean;
  locale?: Locale;
}

const POSIX_BARE_PATH_RE = /^[A-Za-z0-9_./:@~+-]+$/;

function quoteCommandPath(rawPath: string, platform: NodeJS.Platform): string {
  const clean = sanitizeLine(rawPath);
  if (platform === 'win32') {
    const escaped = clean.replaceAll('"', '`"');
    return `"${escaped}"`;
  }
  if (POSIX_BARE_PATH_RE.test(clean)) return clean;
  return `'${clean.replaceAll("'", "'\\''")}'`;
}

export function buildConfigQuickCommands(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
  home?: string,
  locale: Locale = 'zh',
): { label: string; command: string }[] {
  let quoted: string;
  if (platform === 'win32') {
    quoted = quoteCommandPath(sanitizeLine(configPath), platform);
  } else {
    const shortened = sanitizeLine(
      shortenHome(
        configPath,
        home,
        inferPathStyle(home ?? configPath, platform),
      ),
    );
    quoted =
      POSIX_BARE_PATH_RE.test(shortened) && !shortened.includes('\\')
        ? shortened
        : quoteCommandPath(sanitizeLine(configPath), platform);
  }

  if (platform === 'win32') {
    return [
      {
        label: t(locale, '查看生效配置', 'Inspect active'),
        command: 'sweep config',
      },
      {
        label: t(locale, '查看原始配置', 'View raw JSON'),
        command: `Get-Content ${quoted}`,
      },
      {
        label: t(locale, '手动编辑配置', 'Edit in Notepad'),
        command: `notepad ${quoted}`,
      },
    ];
  }

  const commands = [
    {
      label: t(locale, '查看生效配置', 'Inspect active'),
      command: 'sweep config',
    },
    {
      label: t(locale, '查看原始配置', 'View raw JSON'),
      command: `cat ${quoted}`,
    },
    {
      label: t(locale, '手动编辑配置', 'Edit in $EDITOR'),
      command: `\${EDITOR:-vi} ${quoted}`,
    },
  ];
  if (platform === 'darwin') {
    commands.push({
      label: t(locale, '图形界面编辑', 'Open in TextEdit'),
      command: `open -e ${quoted}`,
    });
  }
  return commands;
}

function actionBadge(action: 'trash' | 'delete', color: boolean): string {
  return action === 'trash'
    ? paint('[TRASH]', '36', color)
    : paint('[DELETE]', '33', color);
}

export function renderConfigSummary(options: ConfigSummaryOptions): string[] {
  const { configPath, config, heading, home, color } = options;
  const locale = options.locale ?? 'zh';
  const platform = options.platform ?? process.platform;
  const style = inferPathStyle(home ?? configPath, platform);
  const lines: string[] = [];

  const shownPath = sanitizeLine(shortenHome(configPath, home, style));
  lines.push(`  ${heading}: ${shownPath}  ${paint('✓', '32', color)}`);

  if (options.backupPath !== undefined) {
    const shownBackup = sanitizeLine(
      shortenHome(options.backupPath, home, style),
    );
    lines.push(
      neutralLine(
        t(
          locale,
          `原配置已备份: ${shownBackup}`,
          `Previous config backed up: ${shownBackup}`,
        ),
        color,
      ),
    );
  }

  const rootLabels = config.roots.map((r) =>
    sanitizeLine(shortenHome(r, home, style)),
  );
  lines.push(
    neutralLine(
      t(
        locale,
        `扫描根 (${rootLabels.length} 个): ${rootLabels.join(' · ')}`,
        `Scan roots (${rootLabels.length}): ${rootLabels.join(' · ')}`,
      ),
      color,
    ),
  );

  const activePresets = PRESET_NAMES.filter(
    (name) => config.presets[name] !== undefined,
  );
  if (activePresets.length === 0) {
    lines.push(
      neutralLine(t(locale, '激活预设: 0 项', 'Active presets: 0'), color),
    );
  } else {
    const presetText = activePresets
      .map(
        (name) =>
          `${name} ${actionBadge(resolvePresetAction(name, config.presets[name]), color)}`,
      )
      .join(' · ');
    const prefix = t(
      locale,
      `激活预设 (${activePresets.length} 项):`,
      `Active presets (${activePresets.length}):`,
    );
    lines.push(
      `  ${paint('░', '2', color)} ${paint(prefix, '2', color)} ${presetText}`,
    );
  }

  if (config.rules.length === 0) {
    lines.push(
      neutralLine(t(locale, '自定义规则: 0 条', 'Custom rules: 0'), color),
    );
  } else {
    const ruleText = config.rules
      .map((rule) => {
        const name = sanitizeLine(rule.name);
        const days =
          rule.olderThanDays !== undefined
            ? t(
                locale,
                ` · > ${rule.olderThanDays} 天`,
                ` · > ${rule.olderThanDays}d`,
              )
            : '';
        return `${name} ${actionBadge(rule.action, color)}${days}`;
      })
      .join(' · ');
    const prefix = t(
      locale,
      `自定义规则 (${config.rules.length} 条):`,
      `Custom rules (${config.rules.length}):`,
    );
    lines.push(
      `  ${paint('░', '2', color)} ${paint(prefix, '2', color)} ${ruleText}`,
    );
  }

  const excludeTag =
    options.excludeExplicit === true
      ? ''
      : t(locale, ' (内置安全护栏)', ' (built-in safety guardrails)');
  lines.push(
    neutralLine(
      t(
        locale,
        `全局排除: ${config.exclude.length} 条${excludeTag}`,
        `Global excludes: ${config.exclude.length}${excludeTag}`,
      ),
      color,
    ),
  );

  if (config.include.length > 0) {
    const shownInc = config.include.map((item) => sanitizeLine(item));
    lines.push(
      neutralLine(
        t(
          locale,
          `全局白名单 (${shownInc.length} 条): ${shownInc.join(' · ')}`,
          `Global includes (${shownInc.length}): ${shownInc.join(' · ')}`,
        ),
        color,
      ),
    );
  }

  if (
    options.newAvailablePresets !== undefined &&
    options.newAvailablePresets.length > 0
  ) {
    lines.push(
      neutralLine(
        t(
          locale,
          `新增可用预设: ${options.newAvailablePresets.join(' · ')} (可手动编辑配置按需启用)`,
          `New presets available: ${options.newAvailablePresets.join(' · ')} (edit config to enable)`,
        ),
        color,
      ),
    );
  }

  lines.push(neutralLine(t(locale, '快捷指令:', 'Quick commands:'), color));
  const quickCmds = buildConfigQuickCommands(
    configPath,
    platform,
    home,
    locale,
  );
  const labelWidth = Math.max(...quickCmds.map((c) => displayWidth(c.label)));
  for (const item of quickCmds) {
    const pad = ' '.repeat(
      Math.max(2, labelWidth - displayWidth(item.label) + 2),
    );
    lines.push(
      `    ${paint(item.label, '2', color)}${pad}${paint(item.command, '36', color)}`,
    );
  }

  return lines;
}
