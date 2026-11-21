/**
 * 配置无损自动迁移 (`v1 -> v2` 与旧路径 `sweep-node-modules/config.json -> sweep/config.json`)。
 * 设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md 与 0024-cli-init-migrate-and-summary-display.md。
 * 上下游: 依赖 config / config-validate / guard (`firstSymlinkOnTarget`) / errors; 供 sweep-cli 的 migrate-cli 调度。
 * 核心红线:
 * 1. 写盘前必检目标与备份路径符号链接锚点 (BC-40), 并在源目录以 `wx` 创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份 (失败即中止);
 * 2. 100% 无损等价升版: v1 仅映射为 `presets: { node: {} }`, 严禁替用户悄悄激活其余 5 个预设;
 * 3. 含未知字段 / 未来版本 / 结构损坏时一律返回 `state: 'unsupported'`, 绝不静默丢字段 (由 CLI 在非 TTY 下拒跑)。
 */
import { lstat, mkdir, readFile, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import type { PresetName } from './codes.ts';
import { parseV2ConfigObject } from './config-validate.ts';
import {
  CONFIG_VERSION,
  type Config,
  DEFAULT_EXCLUDE,
  type ResolvedConfigPath,
  type StoredConfigV2,
  resolveDefaultRoot,
  resolveLegacyConfigPath,
} from './config.ts';
import { SweepError } from './errors.ts';
import { firstSymlinkOnTarget } from './guard.ts';

/** v1 迁移后以中性提示告知用户的新增可用预设列表 (绝不替用户自动开启) */
export const NEW_PRESET_HINTS: readonly PresetName[] = Object.freeze([
  'rust',
  'python',
  'java',
  'cpp',
  'os-junk',
]);

/** v1 配置允许出现的全部合法键 (出现此外键即判定非 100% 无损) */
const V1_ALLOWED_KEYS = new Set(['version', 'roots', 'exclude', 'include']);

/** 迁移候选分析结果 */
export type MigrationDetection =
  | { state: 'none' }
  | {
      state: 'migratable';
      /** 迁移源文件路径 (旧路径或当前路径) */
      sourcePath: string;
      /** 迁移后落盘路径 */
      targetPath: string;
      /** 是否来自旧 `sweep-node-modules/config.json` 路径 */
      fromLegacyPath: boolean;
      /** 原文件完整文本 (用于原样写入备份) */
      rawSource: string;
      /** 100% 无损等价升版标志 */
      lossless: true;
      /** 将落盘的 v2 序列化对象 */
      stored: StoredConfigV2;
      /** 归一化后的 v2 配置对象 */
      config: Config;
      /** 源配置是否显式写了 exclude */
      excludeExplicit: boolean;
    }
  | {
      state: 'unsupported';
      sourcePath: string;
      targetPath: string;
      fromLegacyPath: boolean;
      reason: string;
    };

/** 迁移执行完成结果 */
export interface MigrationApplied {
  sourcePath: string;
  targetPath: string;
  backupPath: string;
  fromLegacyPath: boolean;
  stored: StoredConfigV2;
  config: Config;
  excludeExplicit: boolean;
  newAvailablePresets: readonly PresetName[];
}

/** 格式化强制备份时间戳: `YYYYMMDD_HHMMSS` */
export function formatBackupTimestamp(date: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}${pad(date.getMonth() + 1)}${pad(date.getDate())}` +
    `_${pad(date.getHours())}${pad(date.getMinutes())}${pad(date.getSeconds())}`
  );
}

/** 计算写前备份路径: 在源配置目录创建 `config.json.YYYYMMDD_HHMMSS.modified` */
export function buildMigrationBackupPath(
  sourcePath: string,
  date: Date = new Date(),
): string {
  return join(
    dirname(sourcePath),
    `config.json.${formatBackupTimestamp(date)}.modified`,
  );
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isStringArray(
  value: unknown,
  requireNonEmptyItems: boolean,
): value is string[] {
  if (!Array.isArray(value)) return false;
  return value.every(
    (item) =>
      typeof item === 'string' && (!requireNonEmptyItems || item.trim() !== ''),
  );
}

/**
 * 将 v1 配置对象做 100% 无损等价转换到 v2:
 * - 仅接受 `{ version?: 1, roots: string[], exclude?: string[], include?: string[] }`;
 * - `presets` 严格等价映射为 `{ node: {} }`, 绝不悄悄启用任何新预设;
 * - 发现未知字段或类型不符时返回 `{ ok: false, reason }` (拒作无损自动迁移)。
 *
 * ### 数据流转示例
 * - Input: `{ roots: ['/work'], include: ['app'] }` (合法 v1, 省略 exclude)
 * - 流程: 校验仅含 V1_ALLOWED_KEYS -> 构造 `stored` (`version: 2`, `presets: { node: {} }`, `rules: []`) -> `parseV2ConfigObject` 归一化 (补 32 项 `DEFAULT_EXCLUDE`)
 * - Output: `{ ok: true, stored: { version: 2, roots: ['/work'], include: ['app'], presets: { node: {} }, rules: [] }, config, excludeExplicit: false }`
 * - Input (非无损): `{ roots: ['/work'], customFlag: true }` -> Output: `{ ok: false, reason: '包含无法自动无损迁移的未知字段: customFlag' }`
 */
export function convertV1ToV2(
  raw: unknown,
  homedir?: string,
):
  | {
      ok: true;
      stored: StoredConfigV2;
      config: Config;
      excludeExplicit: boolean;
    }
  | { ok: false; reason: string } {
  if (!isPlainRecord(raw)) {
    return { ok: false, reason: '配置顶层不是 JSON 对象, 无法无损迁移' };
  }
  const unknownKeys = Object.keys(raw).filter((k) => !V1_ALLOWED_KEYS.has(k));
  if (unknownKeys.length > 0) {
    return {
      ok: false,
      reason: `包含无法自动无损迁移的未知字段: ${unknownKeys.join(', ')}`,
    };
  }
  if (raw.version !== undefined && raw.version !== 1) {
    return {
      ok: false,
      reason: `不支持自动迁移的配置版本: version=${String(raw.version)}`,
    };
  }
  if (!isStringArray(raw.roots, true) || raw.roots.length === 0) {
    return {
      ok: false,
      reason: 'v1 配置缺少非空字符串数组 roots, 无法无损迁移',
    };
  }
  if (raw.exclude !== undefined && !isStringArray(raw.exclude, false)) {
    return { ok: false, reason: 'v1 配置的 exclude 必须是字符串数组' };
  }
  if (raw.include !== undefined && !isStringArray(raw.include, false)) {
    return { ok: false, reason: 'v1 配置的 include 必须是字符串数组' };
  }

  const stored: StoredConfigV2 = {
    version: CONFIG_VERSION,
    roots: [...raw.roots],
    ...(raw.exclude !== undefined ? { exclude: [...raw.exclude] } : {}),
    ...(raw.include !== undefined ? { include: [...raw.include] } : {}),
    presets: { node: {} },
    rules: [],
  };

  const parsed = parseV2ConfigObject(
    stored,
    resolveDefaultRoot(homedir),
    DEFAULT_EXCLUDE,
  );
  if (!parsed.ok) {
    return { ok: false, reason: parsed.failure.message };
  }
  const { excludeExplicit, ...config } = parsed.value;
  return { ok: true, stored, config, excludeExplicit };
}

async function fileExists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch {
    return false;
  }
}

export interface DetectMigrationOptions {
  platform?: string;
  homedir?: string;
  env?: Record<string, string | undefined>;
}

/**
 * 检测是否需要触发自动迁移:
 * 1. 目标路径已存在: 若已是 v2 或读取/JSON 损坏返 `{ state: 'none' }` (交给常规 loadConfig 报错);
 *    若 `version > 2` 返 `unsupported`; 若为 v1 则经 `convertV1ToV2` 判 `migratable` 或 `unsupported`;
 * 2. 来源为 `platform-default` 且目标路径不存在, 但旧路径 `sweep-node-modules/config.json` 存在:
 *    旧文件为合法 v1 或合法 v2 均返 `migratable`, 损坏或非法则返 `unsupported`。
 *
 * ### 数据流转示例
 * - 新路径缺失 + `source === 'platform-default'` + 旧路径存在 v1 -> 读旧文件 -> `convertV1ToV2` 通过 -> `{ state: 'migratable', fromLegacyPath: true, sourcePath: legacy, targetPath: resolved.path, ... }`
 * - 新路径存在 v2 -> 直接放行 -> `{ state: 'none' }`
 * - 新路径存在 `version: 9` -> 高于当前版本 -> `{ state: 'unsupported', reason: '配置版本 v9 高于当前工具支持的版本 v2...' }`
 */
export async function detectMigration(
  resolved: ResolvedConfigPath,
  options: DetectMigrationOptions = {},
): Promise<MigrationDetection> {
  const targetExists = await fileExists(resolved.path);
  let sourcePath = resolved.path;
  let fromLegacyPath = false;

  if (!targetExists) {
    if (resolved.source !== 'platform-default') {
      return { state: 'none' };
    }
    const legacyPath = resolveLegacyConfigPath(options);
    if (!(await fileExists(legacyPath))) {
      return { state: 'none' };
    }
    sourcePath = legacyPath;
    fromLegacyPath = true;
  }

  let rawSource: string;
  try {
    rawSource = await readFile(sourcePath, 'utf8');
  } catch (error) {
    if (!fromLegacyPath) return { state: 'none' };
    return {
      state: 'unsupported',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      reason: `旧配置不可读: ${(error as Error).message}`,
    };
  }

  let parsedJson: unknown;
  try {
    parsedJson = JSON.parse(rawSource);
  } catch (error) {
    // 若在当前路径且 JSON 损坏, 交给后续常规 loadConfig 报 CONFIG_CORRUPT_JSON
    if (!fromLegacyPath) return { state: 'none' };
    return {
      state: 'unsupported',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      reason: `旧配置不是合法 JSON: ${(error as Error).message}`,
    };
  }

  if (!isPlainRecord(parsedJson)) {
    if (!fromLegacyPath) return { state: 'none' };
    return {
      state: 'unsupported',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      reason: '旧配置顶层不是 JSON 对象, 无法无损迁移',
    };
  }

  if (parsedJson.version === CONFIG_VERSION) {
    if (!fromLegacyPath) return { state: 'none' };
    // 旧路径已是 v2 (罕见): 校验合法后同样可迁移复制到新路径
    const v2 = parseV2ConfigObject(
      parsedJson,
      resolveDefaultRoot(options.homedir),
      DEFAULT_EXCLUDE,
    );
    if (!v2.ok) {
      return {
        state: 'unsupported',
        sourcePath,
        targetPath: resolved.path,
        fromLegacyPath,
        reason: v2.failure.message,
      };
    }
    const { excludeExplicit, ...config } = v2.value;
    const stored: StoredConfigV2 = {
      version: 2,
      roots: [...config.roots],
      ...(excludeExplicit ? { exclude: [...config.exclude] } : {}),
      ...(config.include.length > 0 ? { include: [...config.include] } : {}),
      presets: config.presets,
      rules: config.rules,
    };
    return {
      state: 'migratable',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      rawSource,
      lossless: true,
      stored,
      config,
      excludeExplicit,
    };
  }

  if (
    isPlainRecord(parsedJson) &&
    typeof parsedJson.version === 'number' &&
    parsedJson.version > CONFIG_VERSION
  ) {
    return {
      state: 'unsupported',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      reason: `配置版本 v${parsedJson.version} 高于当前工具支持的版本 v${CONFIG_VERSION}, 无法自动迁移`,
    };
  }

  const converted = convertV1ToV2(parsedJson, options.homedir);
  if (!converted.ok) {
    return {
      state: 'unsupported',
      sourcePath,
      targetPath: resolved.path,
      fromLegacyPath,
      reason: converted.reason,
    };
  }

  return {
    state: 'migratable',
    sourcePath,
    targetPath: resolved.path,
    fromLegacyPath,
    rawSource,
    lossless: true,
    stored: converted.stored,
    config: converted.config,
    excludeExplicit: converted.excludeExplicit,
  };
}

export interface ApplyMigrationOptions {
  now?: () => Date;
}

/**
 * 执行无损配置迁移:
 * 1. 对目标与备份路径均执行写入侧符号链接锚点安全检查 (BC-40);
 * 2. 先在源配置目录以 `wx` 排他创建 `config.json.YYYYMMDD_HHMMSS.modified` 备份 (失败即停写);
 * 3. 写入等价 v2 配置到目标路径并返回摘要 (含 5 个可自选启用的 `NEW_PRESET_HINTS`)。
 *
 * ### 数据流转示例
 * - Input: `plan` (`state: 'migratable'`, `sourcePath: '.../sweep-node-modules/config.json'`, `targetPath: '.../sweep/config.json'`)
 * - 流程: `firstSymlinkOnTarget(targetPath)` -> `firstSymlinkOnTarget(backupPath)` -> `writeFile(backupPath, rawSource, { flag: 'wx' })` -> `writeFile(targetPath, JSON(stored))`
 * - Output: `{ sourcePath, targetPath, backupPath, fromLegacyPath: true, stored, config, excludeExplicit, newAvailablePresets: ['rust', 'python', 'java', 'cpp', 'os-junk'] }`
 */
export async function applyMigration(
  plan: Extract<MigrationDetection, { state: 'migratable' }>,
  options: ApplyMigrationOptions = {},
): Promise<MigrationApplied> {
  const targetLink = await firstSymlinkOnTarget(plan.targetPath);
  if (targetLink !== null) {
    throw new SweepError(
      'CONFIG_MIGRATION_FAILED',
      `配置迁移被拒: 目标配置路径锚点链包含符号链接 (${targetLink})`,
      { path: plan.targetPath },
    );
  }

  const backupPath = buildMigrationBackupPath(
    plan.sourcePath,
    options.now?.() ?? new Date(),
  );
  const backupLink = await firstSymlinkOnTarget(backupPath);
  if (backupLink !== null) {
    throw new SweepError(
      'CONFIG_MIGRATION_FAILED',
      `配置迁移被拒: 备份路径锚点链包含符号链接 (${backupLink})`,
      { path: plan.targetPath, backupPath },
    );
  }

  // 强制写前备份 (wx 防覆盖已有备份; 失败立即中止, 绝不覆写原配置)
  try {
    await mkdir(dirname(backupPath), { recursive: true });
    await writeFile(backupPath, plan.rawSource, {
      encoding: 'utf8',
      flag: 'wx',
    });
  } catch (error) {
    throw new SweepError(
      'CONFIG_MIGRATION_FAILED',
      `配置迁移中止: 创建原配置备份失败 (${backupPath}): ${(error as Error).message}`,
      { path: plan.targetPath, backupPath },
      { cause: error },
    );
  }

  try {
    await mkdir(dirname(plan.targetPath), { recursive: true });
    await writeFile(
      plan.targetPath,
      `${JSON.stringify(plan.stored, null, 2)}\n`,
      'utf8',
    );
  } catch (error) {
    throw new SweepError(
      'CONFIG_MIGRATION_FAILED',
      `配置迁移失败: 写入新配置失败 (${plan.targetPath}): ${(error as Error).message} (原配置已备份于 ${backupPath})`,
      { path: plan.targetPath, backupPath },
      { cause: error },
    );
  }

  return {
    sourcePath: plan.sourcePath,
    targetPath: plan.targetPath,
    backupPath,
    fromLegacyPath: plan.fromLegacyPath,
    stored: plan.stored,
    config: plan.config,
    excludeExplicit: plan.excludeExplicit,
    newAvailablePresets: NEW_PRESET_HINTS,
  };
}
