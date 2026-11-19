/**
 * 实例指纹与高熵凭证幂等状态机 (.codd-state/)。
 */
import { randomBytes } from 'node:crypto';
import {
  chmodSync,
  closeSync,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readFileSync,
  renameSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { basename, dirname, join } from 'node:path';

import {
  ConfigError,
  type DeployManifest,
  type GenerateState,
  type RotateMode,
} from './types.ts';

const FINGERPRINT_RE = /^[a-z0-9-]{6,32}$/;
const STATE_ALNUM_RE = /^[A-Za-z0-9]+$/;
const STATE_KEYFILE_RE = /^[A-Za-z0-9+/=]{16,1024}$/;
const STATE_DB_RE = /^[A-Za-z0-9_-]{1,63}$/;
const RETRYABLE_RENAME_CODES = new Set(['EPERM', 'EACCES', 'EBUSY']);

export const randomAlnumSecret = (bytes = 12): string =>
  randomBytes(bytes).toString('hex');

export const randomFingerprint = (): string => randomBytes(6).toString('hex');

export const randomKeyFile = (): string =>
  randomBytes(756).toString('base64').replace(/\s+/g, '');

const renameAtomically = (tmpPath: string, targetPath: string): void => {
  const maxAttempts = process.platform === 'win32' ? 3 : 1;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      renameSync(tmpPath, targetPath);
      return;
    } catch (err) {
      const code =
        typeof err === 'object' && err !== null && 'code' in err
          ? String((err as { code?: unknown }).code)
          : '';
      const canRetry =
        process.platform === 'win32' &&
        RETRYABLE_RENAME_CODES.has(code) &&
        attempt < maxAttempts - 1;
      if (!canRetry) throw err;
      rmSync(targetPath, { force: true });
    }
  }
};

/**
 * 原子写入敏感文件 (强制 LF、同目录排他临时文件 wx + fsync + chmod + rename),
 * 防止写入中途异常截断既有生产凭证或遭同目录符号链接劫持。
 */
export const writeSecretFile = (
  filePath: string,
  content: string,
  mode = 0o600,
): void => {
  const normalized = content.replaceAll('\r\n', '\n');
  const dir = dirname(filePath);
  const tmpName = `.${basename(filePath)}.${process.pid}.${randomBytes(6).toString('hex')}.tmp`;
  const tmpPath = join(dir, tmpName);

  let fd: number | null = null;
  try {
    fd = openSync(tmpPath, 'wx', mode);
    writeFileSync(fd, normalized, 'utf8');
    fsyncSync(fd);
    closeSync(fd);
    fd = null;
    chmodSync(tmpPath, mode);
    renameAtomically(tmpPath, filePath);
  } catch (err) {
    if (fd !== null) {
      try {
        closeSync(fd);
      } catch {
        // ignore close failure on error path
      }
    }
    rmSync(tmpPath, { force: true });
    throw err;
  }
};

/**
 * 在状态文件同目录加排他锁 (${stateFile}.lock, wx 模式), 防止多进程并发改写状态与交付包。
 */
export const withStateLock = <T>(stateFile: string, fn: () => T): T => {
  const lockPath = `${stateFile}.lock`;
  let fd: number;
  try {
    fd = openSync(lockPath, 'wx', 0o600);
  } catch (err) {
    const code =
      typeof err === 'object' && err !== null && 'code' in err
        ? String((err as { code?: unknown }).code)
        : '';
    if (code === 'EEXIST') {
      throw new ConfigError(
        `检测到并发写锁 ${lockPath}, 可能有另一个 codd 进程正在运行 (若确认无并发进程, 请手动删除该锁文件后重试)`,
      );
    }
    throw err;
  }

  try {
    writeFileSync(
      fd,
      `pid=${process.pid}\ncreatedAt=${new Date().toISOString()}\n`,
      'utf8',
    );
  } finally {
    closeSync(fd);
  }

  try {
    return fn();
  } finally {
    rmSync(lockPath, { force: true });
  }
};

/**
 * 创建 .codd-state/ 状态目录并收紧 0700 权限, 同时自动写入内建 .gitignore (*),
 * 确保用户在任何外部业务 Git 仓库运行 codd 时都不会把明文凭证误提交入库。
 */
export const prepareStateDir = (stateDir: string): void => {
  mkdirSync(stateDir, { recursive: true, mode: 0o700 });
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

const assertStateField = (
  ok: boolean,
  stateFile: string,
  field: string,
): void => {
  if (!ok) {
    throw new ConfigError(
      `状态文件 ${stateFile} 字段 '${field}' 格式非法或已被篡改, 已拒绝加载`,
    );
  }
};

const validatePreviousStateFields = (
  stateFile: string,
  raw: Record<string, unknown>,
): Partial<GenerateState> => {
  if (raw.fingerprint !== undefined) {
    assertStateField(
      typeof raw.fingerprint === 'string' &&
        FINGERPRINT_RE.test(raw.fingerprint),
      stateFile,
      'fingerprint',
    );
  }

  const alnumKeys = [
    'rootUsername',
    'rootPassword',
    'backupUsername',
    'backupPassword',
  ] as const;
  for (const key of alnumKeys) {
    const val = raw[key];
    if (val !== undefined) {
      assertStateField(
        typeof val === 'string' &&
          STATE_ALNUM_RE.test(val) &&
          val !== 'CHANGE_ME',
        stateFile,
        key,
      );
    }
  }

  if (raw.keyFile !== undefined) {
    assertStateField(
      typeof raw.keyFile === 'string' && STATE_KEYFILE_RE.test(raw.keyFile),
      stateFile,
      'keyFile',
    );
  }

  if (raw.appPasswords !== undefined) {
    const apps = raw.appPasswords;
    assertStateField(
      apps !== null && typeof apps === 'object' && !Array.isArray(apps),
      stateFile,
      'appPasswords',
    );
    for (const [db, pwd] of Object.entries(apps as Record<string, unknown>)) {
      assertStateField(
        STATE_DB_RE.test(db) &&
          typeof pwd === 'string' &&
          STATE_ALNUM_RE.test(pwd) &&
          pwd !== 'CHANGE_ME',
        stateFile,
        `appPasswords.${db}`,
      );
    }
  }

  return raw as Partial<GenerateState>;
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
  return validatePreviousStateFields(
    stateFile,
    parsed as Record<string, unknown>,
  );
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
    manifest.auth?.keyFile?.trim() || undefined,
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
