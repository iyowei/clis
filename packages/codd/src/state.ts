/**
 * 实例指纹与高熵凭证幂等状态机 (.codd-state/)。
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  existsSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';

import {
  ConfigError,
  type DeployManifest,
  type GenerateState,
  type RotateMode,
} from './types.ts';

export const randomAlnumSecret = (bytes = 12): string =>
  randomBytes(bytes).toString('hex');

export const randomFingerprint = (): string => randomBytes(6).toString('hex');

export const randomKeyFile = (): string =>
  randomBytes(756).toString('base64').replace(/\s+/g, '');

export const writeSecretFile = (
  filePath: string,
  content: string,
  mode = 0o600,
): void => {
  writeFileSync(filePath, content, { encoding: 'utf8', mode });
  chmodSync(filePath, mode);
};

/**
 * 创建 .codd-state/ 状态目录并收紧 0700 权限, 同时自动写入内建 .gitignore (*),
 * 确保用户在任何外部业务 Git 仓库运行 codd 时都不会把明文凭证误提交入库。
 */
export const prepareStateDir = (stateDir: string): void => {
  mkdirSync(stateDir, { recursive: true });
  chmodSync(stateDir, 0o700);
  const gitignorePath = join(stateDir, '.gitignore');
  if (!existsSync(gitignorePath)) {
    writeFileSync(gitignorePath, '*\n', 'utf8');
  }
};

const pickSecret = (
  explicitVal: string | undefined,
  prevVal: string | undefined,
  shouldRotate: boolean,
  generator: () => string,
): string => {
  if (explicitVal !== undefined) return explicitVal;
  if (!shouldRotate && prevVal) return prevVal;
  return generator();
};

const readPreviousState = (stateFile: string): Partial<GenerateState> => {
  if (!existsSync(stateFile)) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(stateFile, 'utf8'));
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new ConfigError(
      `状态文件 ${stateFile} 损坏 (不是合法 JSON): ${detail}`,
    );
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new ConfigError(`状态文件 ${stateFile} 损坏 (顶层应为 JSON 对象)`);
  }
  return parsed as Partial<GenerateState>;
};

export const loadOrUpdateState = (
  stateFile: string,
  manifest: DeployManifest,
  rotate: RotateMode,
  newFingerprint: boolean,
): GenerateState => {
  const prev = readPreviousState(stateFile);

  const fingerprint = newFingerprint
    ? randomFingerprint()
    : prev.fingerprint || randomFingerprint();

  const rootUsername =
    manifest.auth?.rootUsername ?? prev.rootUsername ?? 'root';
  const backupUsername =
    manifest.auth?.backupUsername ?? prev.backupUsername ?? 'backup';

  const rotateAll = rotate === 'all';
  const rotateApps = rotate === 'apps' || rotate === 'all';

  const rootPassword = pickSecret(
    manifest.auth?.rootPassword,
    prev.rootPassword,
    rotateAll,
    () => randomAlnumSecret(12),
  );

  const backupPassword = pickSecret(
    manifest.auth?.backupPassword,
    prev.backupPassword,
    rotateApps,
    () => randomAlnumSecret(12),
  );

  const keyFile = pickSecret(
    manifest.auth?.keyFile?.trim(),
    prev.keyFile,
    rotateAll,
    randomKeyFile,
  );

  const appPasswords: Record<string, string> = {};
  for (const app of manifest.apps) {
    appPasswords[app.db] = pickSecret(
      app.password,
      prev.appPasswords?.[app.db],
      rotateApps,
      () => randomAlnumSecret(12),
    );
  }

  return {
    mode: manifest.mode,
    name: manifest.name,
    fingerprint,
    rootUsername,
    rootPassword,
    backupUsername,
    backupPassword,
    keyFile,
    appPasswords,
    updatedAt: new Date().toISOString(),
  };
};
