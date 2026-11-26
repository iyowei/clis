/**
 * `@iyowei/wake` 配置文件路径解析与安全加载 (零外部依赖, 防符号链接逃逸与畸形数据注入)。
 */
import { lstatSync, readFileSync } from 'node:fs';
import { homedir as osHomedir } from 'node:os';
import { join } from 'node:path';

import { WakeError } from './errors.ts';
import {
  normalizeMacList,
  validateBroadcastIpv4,
  validatePort,
  validateSafeHost,
  validateSafeRelay,
  validateTargetName,
} from './magic.ts';
import type {
  LoadedWakeConfig,
  WakeConfig,
  WakePathContext,
  WakeTargetConfig,
} from './types.ts';

const DEFAULT_WAIT_TIMEOUT_MS = 90_000;
const DEFAULT_RELAY_TIMEOUT_MS = 10_000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

/** 按目标平台规范化路径分隔符, 消除测试桩与宿主平台差异 */
function joinPlatformPath(
  platform: NodeJS.Platform,
  ...parts: string[]
): string {
  const joined = join(...parts);
  return platform === 'win32'
    ? joined.replaceAll('/', '\\')
    : joined.replaceAll('\\', '/');
}

/** 解析默认配置文件路径 (POSIX: `~/.config/wake/config.json`; Windows: `%APPDATA%\\wake\\config.json`) */
export function resolveDefaultWakeConfigPath(
  context: WakePathContext = {},
): string {
  const platform = context.platform ?? process.platform;
  const env = context.env ?? process.env;
  const home = context.homedir ?? osHomedir();

  if (platform === 'win32') {
    const appData =
      env.APPDATA && env.APPDATA.trim() !== ''
        ? env.APPDATA
        : joinPlatformPath(platform, home, 'AppData', 'Roaming');
    return joinPlatformPath(platform, appData, 'wake', 'config.json');
  }

  const xdg = env.XDG_CONFIG_HOME;
  const base =
    xdg && xdg.trim() !== ''
      ? xdg
      : joinPlatformPath(platform, home, '.config');
  return joinPlatformPath(platform, base, 'wake', 'config.json');
}

/** 解析最终生效配置路径: 显式参数 `--config` > `WAKE_CONFIG` > 平台默认路径 */
export function resolveWakeConfigPath(context: WakePathContext = {}): string {
  if (context.configPath !== undefined && context.configPath.trim() !== '') {
    return context.configPath.trim();
  }
  const env = context.env ?? process.env;
  const envPath = env.WAKE_CONFIG;
  if (envPath !== undefined && envPath.trim() !== '') {
    return envPath.trim();
  }
  return resolveDefaultWakeConfigPath(context);
}

function parseOptionalStringArray(
  raw: unknown,
  field: string,
  targetName: string,
  normalize: (value: string) => string,
): string[] | undefined {
  if (raw === undefined) return undefined;
  if (!Array.isArray(raw)) {
    throw new WakeError(
      'CONFIG_INVALID',
      `目标 "${targetName}" 的 ${field} 必须为字符串数组`,
    );
  }
  const out: string[] = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== 'string') {
      throw new WakeError(
        'CONFIG_INVALID',
        `目标 "${targetName}" 的 ${field} 包含非字符串项`,
      );
    }
    const normalized = normalize(item);
    if (!seen.has(normalized)) {
      seen.add(normalized);
      out.push(normalized);
    }
  }
  return out;
}

function parsePositiveMs(
  raw: unknown,
  field: string,
  targetName: string,
  minMs: number,
  maxMs: number,
): number | undefined {
  if (raw === undefined) return undefined;
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new WakeError(
      'CONFIG_INVALID',
      `目标 "${targetName}" 的 ${field} 必须为有限数字`,
    );
  }
  const rounded = Math.round(raw);
  if (rounded < minMs || rounded > maxMs) {
    throw new WakeError(
      'CONFIG_INVALID',
      `目标 "${targetName}" 的 ${field} 超出允许范围 (${minMs}-${maxMs} ms)`,
    );
  }
  return rounded;
}

function normalizeTargetEntry(name: string, raw: unknown): WakeTargetConfig {
  if (!isRecord(raw)) {
    throw new WakeError('CONFIG_INVALID', `目标 "${name}" 必须为对象`);
  }
  if (!Array.isArray(raw.macs) || raw.macs.length === 0) {
    throw new WakeError('CONFIG_INVALID', `目标 "${name}" 缺少非空 macs 数组`);
  }
  const rawMacStrings: string[] = [];
  for (const item of raw.macs) {
    if (typeof item !== 'string') {
      throw new WakeError(
        'CONFIG_INVALID',
        `目标 "${name}" 的 macs 必须全为字符串`,
      );
    }
    rawMacStrings.push(item);
  }
  const macs = normalizeMacList(rawMacStrings);

  let host: string | undefined;
  if (raw.host !== undefined) {
    if (typeof raw.host !== 'string') {
      throw new WakeError(
        'CONFIG_INVALID',
        `目标 "${name}" 的 host 须为字符串`,
      );
    }
    host = validateSafeHost(raw.host);
  }

  const port = raw.port === undefined ? 22 : validatePort(raw.port);
  const broadcast = parseOptionalStringArray(
    raw.broadcast,
    'broadcast',
    name,
    validateBroadcastIpv4,
  );
  const relays = parseOptionalStringArray(
    raw.relays,
    'relays',
    name,
    validateSafeRelay,
  );
  const waitTimeoutMs = parsePositiveMs(
    raw.waitTimeoutMs,
    'waitTimeoutMs',
    name,
    1_000,
    600_000,
  );
  const relayTimeoutMs = parsePositiveMs(
    raw.relayTimeoutMs,
    'relayTimeoutMs',
    name,
    1_000,
    120_000,
  );

  let note: string | undefined;
  if (raw.note !== undefined) {
    if (typeof raw.note !== 'string') {
      throw new WakeError(
        'CONFIG_INVALID',
        `目标 "${name}" 的 note 须为字符串`,
      );
    }
    const trimmed = raw.note.trim();
    if (trimmed !== '') note = trimmed;
  }

  return {
    macs,
    ...(host !== undefined ? { host } : {}),
    port,
    ...(broadcast !== undefined && broadcast.length > 0 ? { broadcast } : {}),
    ...(relays !== undefined && relays.length > 0 ? { relays } : {}),
    ...(waitTimeoutMs !== undefined ? { waitTimeoutMs } : {}),
    ...(relayTimeoutMs !== undefined ? { relayTimeoutMs } : {}),
    ...(note !== undefined ? { note } : {}),
  };
}

/** 校验并规范化解析后的配置对象 (`version: 1`) */
export function validateWakeConfig(raw: unknown): WakeConfig {
  if (!isRecord(raw)) {
    throw new WakeError('CONFIG_INVALID', '配置文件根节点必须为 JSON 对象');
  }
  if (raw.version !== 1) {
    throw new WakeError(
      'CONFIG_INVALID',
      `不支持的配置版本: ${String(raw.version)} (期望 1)`,
    );
  }
  if (!isRecord(raw.targets)) {
    throw new WakeError('CONFIG_INVALID', '配置缺少 targets 对象');
  }

  const targets: Record<string, WakeTargetConfig> = {};
  for (const [rawKey, rawVal] of Object.entries(raw.targets)) {
    const key = validateTargetName(rawKey);
    if (Object.hasOwn(targets, key)) {
      throw new WakeError('CONFIG_INVALID', `重复的目标名称: ${key}`);
    }
    targets[key] = normalizeTargetEntry(key, rawVal);
  }

  let defaultTarget: string | undefined;
  if (raw.defaultTarget !== undefined) {
    if (typeof raw.defaultTarget !== 'string') {
      throw new WakeError('CONFIG_INVALID', 'defaultTarget 必须为字符串');
    }
    const name = validateTargetName(raw.defaultTarget);
    if (!Object.hasOwn(targets, name)) {
      throw new WakeError(
        'CONFIG_INVALID',
        `defaultTarget "${name}" 未在 targets 中定义`,
      );
    }
    defaultTarget = name;
  }

  return {
    version: 1,
    ...(defaultTarget !== undefined ? { defaultTarget } : {}),
    targets,
  };
}

/** 从磁盘严格加载并校验配置文件 (拒绝符号链接与损坏 JSON) */
export function loadWakeConfig(filePath: string): LoadedWakeConfig {
  let stat;
  try {
    stat = lstatSync(filePath);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') {
      throw new WakeError(
        'CONFIG_ABSENT',
        `未找到 wake 配置文件: ${filePath} (运行 wake init 创建)`,
        { cause: error },
      );
    }
    throw new WakeError(
      'CONFIG_READ_FAILED',
      `无法读取 wake 配置文件 ${filePath}: ${(error as Error).message}`,
      { cause: error },
    );
  }
  if (stat.isSymbolicLink() || !stat.isFile()) {
    throw new WakeError(
      'CONFIG_READ_FAILED',
      `拒绝从符号链接或非常规文件加载配置: ${filePath}`,
    );
  }

  let rawText: string;
  try {
    rawText = readFileSync(filePath, 'utf8');
  } catch (error) {
    throw new WakeError(
      'CONFIG_READ_FAILED',
      `读取配置文件失败 ${filePath}: ${(error as Error).message}`,
      { cause: error },
    );
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(rawText);
  } catch (error) {
    throw new WakeError(
      'CONFIG_INVALID',
      `配置文件不是合法 JSON (${filePath}): ${(error as Error).message}`,
      { cause: error },
    );
  }

  return {
    path: filePath,
    config: validateWakeConfig(parsed),
  };
}

/** 安全尝试加载配置: 不存在时返回 `{ exists: false }` 而不抛错 */
export function tryLoadWakeConfig(
  filePath: string,
):
  { exists: true; loaded: LoadedWakeConfig } | { exists: false; path: string } {
  try {
    return { exists: true, loaded: loadWakeConfig(filePath) };
  } catch (error) {
    if (error instanceof WakeError && error.code === 'CONFIG_ABSENT') {
      return { exists: false, path: filePath };
    }
    throw error;
  }
}

/** 从已加载配置按名称或默认规则解析目标配置 */
export function resolveTargetFromConfig(
  config: WakeConfig,
  requestedName?: string,
): { name: string; target: WakeTargetConfig } {
  if (requestedName !== undefined) {
    const safeName = validateTargetName(requestedName);
    const hit = Object.hasOwn(config.targets, safeName)
      ? config.targets[safeName]
      : undefined;
    if (hit === undefined) {
      const available = Object.keys(config.targets);
      throw new WakeError(
        'TARGET_NOT_FOUND',
        available.length > 0
          ? `未找到目标 "${safeName}" (已配置: ${available.join(', ')})`
          : `未找到目标 "${safeName}" (当前配置尚无任何目标)`,
      );
    }
    return { name: safeName, target: hit };
  }

  if (config.defaultTarget !== undefined) {
    const hit = config.targets[config.defaultTarget];
    if (hit !== undefined) {
      return { name: config.defaultTarget, target: hit };
    }
  }

  const names = Object.keys(config.targets);
  if (names.length === 1) {
    const onlyName = names[0]!;
    return { name: onlyName, target: config.targets[onlyName]! };
  }

  if (names.length === 0) {
    throw new WakeError(
      'TARGET_NOT_FOUND',
      '配置文件中尚无目标设备 (运行 wake init 添加或直接传入 --mac)',
    );
  }

  throw new WakeError(
    'TARGET_NOT_FOUND',
    `配置了多个目标 (${names.join(', ')}), 且未设置 defaultTarget, 请显式指定目标名`,
  );
}

export { DEFAULT_RELAY_TIMEOUT_MS, DEFAULT_WAIT_TIMEOUT_MS };
