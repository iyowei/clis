/**
 * 配置落盘后的结构化人话摘要渲染 (纯函数, 零 IO, 设计见 ADR 0024):
 * 上游供 `init.ts` (`init` / `init --default`) 与 `migrate-cli.ts` (`migrate`) 写盘后调用,
 * 下游复用 `render.ts` 的 `neutralLine` / `paint` / `shortenHome` 与 `@iyowei/sweep` 的 `sanitizeLine`。
 * 红线: 写盘后严禁输出原始 JSON 全文; 全部路径经 `sanitizeLine` 净化后再渲染与拼装平台快捷指令。
 */
import {
  type Config,
  PRESET_NAMES,
  type PresetName,
  resolvePresetAction,
  sanitizeLine,
} from '@iyowei/sweep';

import { inferPathStyle, neutralLine, paint, shortenHome } from './render.ts';

export interface ConfigSummaryOptions {
  /** 落盘配置路径 */
  configPath: string;
  /** 归一化后的 v2 配置 */
  config: Config;
  /** 是否显式写出了 exclude (false 表示采用内置默认护栏) */
  excludeExplicit?: boolean;
  /** 落盘标题前缀 (如 '配置已写入' / '配置已迁移') */
  heading: string;
  /** 迁移时生成的备份路径 (可选) */
  backupPath?: string;
  /** 迁移完成后以中性一行告知的新增可用预设名称 (可选) */
  newAvailablePresets?: readonly PresetName[];
  /** 家目录 (缩写显示用) */
  home?: string;
  /** 目标平台 (用于生成平台专属查看/编辑命令, 缺省 process.platform) */
  platform?: NodeJS.Platform;
  /** 是否启用 ANSI 着色 */
  color: boolean;
}

/** POSIX shell 无需单引号包裹的安全裸路径字符集 (含波浪号 ~ 以便 shell 自然展开) */
const POSIX_BARE_PATH_RE = /^[A-Za-z0-9_./:@~+-]+$/;

/** 对展示进 shell 指令的路径做安全引用 (先经 OF-14 净化再按平台引用) */
function quoteCommandPath(rawPath: string, platform: NodeJS.Platform): string {
  const clean = sanitizeLine(rawPath);
  if (platform === 'win32') {
    const escaped = clean.replaceAll('"', '`"');
    return `"${escaped}"`;
  }
  if (POSIX_BARE_PATH_RE.test(clean)) return clean;
  return `'${clean.replaceAll("'", "'\\''")}'`;
}

/** 按当前平台生成可直接复制执行的查看/编辑配置命令列表 */
export function buildConfigQuickCommands(
  configPath: string,
  platform: NodeJS.Platform = process.platform,
  home?: string,
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
    // 仅当缩写路径无需加引号且不含反斜杠时使用 ~/...; 一旦需单引号包裹, 直接引用完整原路径防 '~' 无法展开
    quoted =
      POSIX_BARE_PATH_RE.test(shortened) && !shortened.includes('\\')
        ? shortened
        : quoteCommandPath(sanitizeLine(configPath), platform);
  }

  if (platform === 'win32') {
    return [
      { label: '查看生效配置', command: 'sweep config' },
      { label: '查看原始配置', command: `Get-Content ${quoted}` },
      { label: '手动编辑配置', command: `notepad ${quoted}` },
    ];
  }

  const commands = [
    { label: '查看生效配置', command: 'sweep config' },
    { label: '查看原始配置', command: `cat ${quoted}` },
    { label: '手动编辑配置', command: `\${EDITOR:-vi} ${quoted}` },
  ];
  if (platform === 'darwin') {
    commands.push({ label: '图形界面编辑', command: `open -e ${quoted}` });
  }
  return commands;
}

/** 格式化动作标签: `[TRASH]` (青色 36) 或 `[DELETE]` (黄色 33) */
function actionBadge(action: 'trash' | 'delete', color: boolean): string {
  return action === 'trash'
    ? paint('[TRASH]', '36', color)
    : paint('[DELETE]', '33', color);
}

/**
 * 渲染 `init` / `init --default` / `migrate` 落盘后的紧凑结构化摘要 (严禁输出原始 JSON 全文):
 * 依次输出落盘标题、可选备份路径、扫描根、激活预设、自定义规则、全局排除 (标注内置安全护栏)、
 * 可选全局白名单、可选新增可用预设与平台快捷指令 (顶栏 `▍ SWEEP` 由调用方输出)。
 *
 * ### 数据流转示例
 * ```text
 * Input  : configPath = '/Users/me/.config/sweep/config.json', heading = '配置已写入',
 *          config = { roots: ['/Users/me/dev'], presets: { node: {} }, rules: [{ name: 'logs', action: 'trash', olderThanDays: 7 }], exclude: [32 项], include: [] },
 *          excludeExplicit = false, home = '/Users/me', platform = 'darwin', color = false
 * 步骤 1 : 路径经 shortenHome + sanitizeLine 缩写净化 -> '~/.config/sweep/config.json'
 * 步骤 2 : 按 PRESET_NAMES 顺序拼预设徽章 ('node [DELETE]'), 规则拼 'logs [TRASH] · > 7 天'
 * 步骤 3 : excludeExplicit !== true -> 补 '(内置安全护栏)'; buildConfigQuickCommands 生成 darwin 4 条指令
 * Output : ['  配置已写入: ~/.config/sweep/config.json  ✓', '  ░ 扫描根 (1 个): ~/dev', ..., '    图形界面编辑  open -e ~/.config/sweep/config.json']
 * ```
 */
export function renderConfigSummary(options: ConfigSummaryOptions): string[] {
  const { configPath, config, heading, home, color } = options;
  const platform = options.platform ?? process.platform;
  const style = inferPathStyle(home ?? configPath, platform);
  const lines: string[] = [];

  const shownPath = sanitizeLine(shortenHome(configPath, home, style));
  lines.push(`  ${heading}: ${shownPath}  ${paint('✓', '32', color)}`);

  if (options.backupPath !== undefined) {
    const shownBackup = sanitizeLine(
      shortenHome(options.backupPath, home, style),
    );
    lines.push(neutralLine(`原配置已备份: ${shownBackup}`, color));
  }

  const rootLabels = config.roots.map((r) =>
    sanitizeLine(shortenHome(r, home, style)),
  );
  lines.push(
    neutralLine(
      `扫描根 (${rootLabels.length} 个): ${rootLabels.join(' · ')}`,
      color,
    ),
  );

  const activePresets = PRESET_NAMES.filter(
    (name) => config.presets[name] !== undefined,
  );
  if (activePresets.length === 0) {
    lines.push(neutralLine('激活预设: 0 项', color));
  } else {
    const presetText = activePresets
      .map(
        (name) =>
          `${name} ${actionBadge(resolvePresetAction(name, config.presets[name]), color)}`,
      )
      .join(' · ');
    lines.push(
      `  ${paint('░', '2', color)} ${paint(`激活预设 (${activePresets.length} 项):`, '2', color)} ${presetText}`,
    );
  }

  if (config.rules.length === 0) {
    lines.push(neutralLine('自定义规则: 0 条', color));
  } else {
    const ruleText = config.rules
      .map((rule) => {
        const name = sanitizeLine(rule.name);
        const days =
          rule.olderThanDays !== undefined
            ? ` · > ${rule.olderThanDays} 天`
            : '';
        return `${name} ${actionBadge(rule.action, color)}${days}`;
      })
      .join(' · ');
    lines.push(
      `  ${paint('░', '2', color)} ${paint(`自定义规则 (${config.rules.length} 条):`, '2', color)} ${ruleText}`,
    );
  }

  const excludeTag = options.excludeExplicit === true ? '' : ' (内置安全护栏)';
  lines.push(
    neutralLine(`全局排除: ${config.exclude.length} 条${excludeTag}`, color),
  );

  if (config.include.length > 0) {
    const shownInc = config.include.map((item) => sanitizeLine(item));
    lines.push(
      neutralLine(
        `全局白名单 (${shownInc.length} 条): ${shownInc.join(' · ')}`,
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
        `新增可用预设: ${options.newAvailablePresets.join(' · ')} (可手动编辑配置按需启用)`,
        color,
      ),
    );
  }

  lines.push(neutralLine('快捷指令:', color));
  for (const item of buildConfigQuickCommands(configPath, platform, home)) {
    lines.push(
      `    ${paint(item.label, '2', color)}  ${paint(item.command, '36', color)}`,
    );
  }

  return lines;
}
