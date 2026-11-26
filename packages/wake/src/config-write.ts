/**
 * `@iyowei/wake` 配置文件安全原子写入 (0o600 权限, 祖先路径符号链接检查, wx 临时文件 + rename)。
 */
import {
  chmodSync,
  lstatSync,
  mkdirSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join } from 'node:path';

import { tryLoadWakeConfig, validateWakeConfig } from './config.ts';
import { WakeError } from './errors.ts';
import { validateTargetName } from './magic.ts';
import type { WakeConfig, WakeTargetConfig } from './types.ts';

function checkParentDirSafe(dirPath: string): void {
  try {
    const st = lstatSync(dirPath);
    if (st.isSymbolicLink() || !st.isDirectory()) {
      throw new WakeError(
        'CONFIG_WRITE_FAILED',
        `拒绝经由符号链接或非目录路径写入配置: ${dirPath}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof WakeError) throw error;
    throw new WakeError(
      'CONFIG_WRITE_FAILED',
      `检查配置目录权限失败 (${dirPath}): ${(error as Error).message}`,
      { cause: error },
    );
  }
}

function checkTargetNotSymlink(filePath: string): void {
  try {
    const st = lstatSync(filePath);
    if (st.isSymbolicLink() || !st.isFile()) {
      throw new WakeError(
        'CONFIG_WRITE_FAILED',
        `拒绝覆盖符号链接或非常规配置文件: ${filePath}`,
      );
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    if (error instanceof WakeError) throw error;
    throw new WakeError(
      'CONFIG_WRITE_FAILED',
      `检查目标配置文件状态失败 (${filePath}): ${(error as Error).message}`,
      { cause: error },
    );
  }
}

/** 校验并原子落盘 `config.json` (POSIX 下锁定为 0o600 仅当前用户可读) */
export function saveWakeConfig(
  filePath: string,
  config: WakeConfig,
  options: { platform?: NodeJS.Platform } = {},
): WakeConfig {
  const normalized = validateWakeConfig(config);
  const platform = options.platform ?? process.platform;
  const parent = dirname(filePath);

  checkParentDirSafe(parent);
  checkTargetNotSymlink(filePath);

  try {
    mkdirSync(parent, { recursive: true, mode: 0o700 });
  } catch (error) {
    throw new WakeError(
      'CONFIG_WRITE_FAILED',
      `创建配置目录失败 (${parent}): ${(error as Error).message}`,
      { cause: error },
    );
  }

  const tmpPath = join(
    parent,
    `.config.tmp.${String(process.pid)}.${String(Date.now())}`,
  );
  const payload = `${JSON.stringify(normalized, null, 2)}\n`;

  try {
    writeFileSync(tmpPath, payload, {
      encoding: 'utf8',
      flag: 'wx',
      mode: 0o600,
    });
    if (platform !== 'win32') {
      chmodSync(tmpPath, 0o600);
    }
    renameSync(tmpPath, filePath);
    if (platform !== 'win32') {
      chmodSync(filePath, 0o600);
    }
  } catch (error) {
    try {
      rmSync(tmpPath, { force: true });
    } catch {
      // 清理临时文件尽力而为
    }
    throw new WakeError(
      'CONFIG_WRITE_FAILED',
      `写入配置文件失败 (${filePath}): ${(error as Error).message}`,
      { cause: error },
    );
  }

  return normalized;
}

/** 新增或更新单个目标设备条目并落盘 */
export function upsertWakeTarget(
  filePath: string,
  name: string,
  target: WakeTargetConfig,
  options: { setDefault?: boolean; overwrite?: boolean } = {},
): WakeConfig {
  const safeName = validateTargetName(name);
  const loaded = tryLoadWakeConfig(filePath);
  const current: WakeConfig = loaded.exists
    ? loaded.loaded.config
    : { version: 1, targets: {} };

  if (options.overwrite === false && Object.hasOwn(current.targets, safeName)) {
    throw new WakeError(
      'CONFIG_WRITE_FAILED',
      `目标 "${safeName}" 已存在于 ${filePath} (传入 --force 允许覆盖)`,
    );
  }

  const nextTargets: Record<string, WakeTargetConfig> = {
    ...current.targets,
    [safeName]: target,
  };
  const shouldSetDefault =
    options.setDefault === true ||
    current.defaultTarget === undefined ||
    Object.keys(current.targets).length === 0;
  let nextDefault = current.defaultTarget;
  if (shouldSetDefault) {
    nextDefault = safeName;
  }

  return saveWakeConfig(filePath, {
    version: 1,
    ...(nextDefault !== undefined ? { defaultTarget: nextDefault } : {}),
    targets: nextTargets,
  });
}

/** 从配置中移除指定目标 (若为 defaultTarget 则同步重置) */
export function removeWakeTarget(filePath: string, name: string): WakeConfig {
  const safeName = validateTargetName(name);
  const loaded = tryLoadWakeConfig(filePath);
  if (!loaded.exists) {
    throw new WakeError('CONFIG_ABSENT', `未找到配置文件: ${filePath}`);
  }
  const current = loaded.loaded.config;
  if (!Object.hasOwn(current.targets, safeName)) {
    throw new WakeError('TARGET_NOT_FOUND', `目标 "${safeName}" 不存在`);
  }

  const nextTargets: Record<string, WakeTargetConfig> = {};
  for (const [k, v] of Object.entries(current.targets)) {
    if (k !== safeName) nextTargets[k] = v;
  }
  const remaining = Object.keys(nextTargets);
  let nextDefault = current.defaultTarget;
  if (current.defaultTarget === safeName) {
    nextDefault = remaining.length === 1 ? remaining[0] : undefined;
  }

  return saveWakeConfig(filePath, {
    version: 1,
    ...(nextDefault !== undefined ? { defaultTarget: nextDefault } : {}),
    targets: nextTargets,
  });
}
