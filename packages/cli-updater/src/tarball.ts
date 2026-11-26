/**
 * npm tarball 元数据解析与完整性校验 (SRI SHA-512/SHA-256 / SHA-1), 并聚合重导出安全 USTAR 解包原语。
 */
import { createHash, timingSafeEqual } from 'node:crypto';

import { type Locale, t } from '@iyowei/cli-i18n';

import {
  DEFAULT_FETCH_TIMEOUT_MS,
  type FetchLike,
  normalizeRegistryUrl,
} from './registry.ts';
import {
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
} from './semver.ts';

export {
  MAX_TARBALL_COMPRESSED_BYTES,
  MAX_TARBALL_ENTRY_COUNT,
  MAX_TARBALL_UNCOMPRESSED_BYTES,
  type TarEntry,
  extractNpmTarball,
  parseNpmTarArchive,
  verifyExtractedCliBundle,
} from './tar-extract.ts';

/** 单个 CLI tarball 允许的最大下载字节数 (64 MiB 安全上限) */
export const DEFAULT_MAX_TARBALL_BYTES = 64 * 1024 * 1024;

/** Tarball 元数据查询结果 */
export type TarballMetaResult =
  | {
      ok: true;
      version: string;
      registry: string;
      tarballUrl: string;
      integrity?: string;
      shasum?: string;
    }
  | {
      ok: false;
      code: 'network' | 'http' | 'not-found' | 'auth' | 'invalid-response';
      status?: number;
      message: string;
    };

/** Tarball 下载与校验结果 */
export type TarballDownloadResult =
  | { ok: true; bytes: Buffer }
  | {
      ok: false;
      code: 'network' | 'http' | 'auth' | 'integrity' | 'invalid-response';
      status?: number;
      message: string;
    };

function cleanMsg(raw: string, secret?: string): string {
  const redacted =
    secret !== undefined && secret !== ''
      ? raw.replaceAll(secret, '[REDACTED]')
      : raw;
  return redacted
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function sanitizeToken(token: string | undefined): string | undefined {
  if (
    typeof token === 'string' &&
    token.trim() !== '' &&
    !/[\s\p{Cc}]/u.test(token)
  ) {
    return token.trim();
  }
  return undefined;
}

function sameOrigin(urlA: string, urlB: string): boolean {
  try {
    return new URL(urlA).origin === new URL(urlB).origin;
  } catch {
    return false;
  }
}

function isHttpUrl(raw: string): boolean {
  try {
    const parsed = new URL(raw);
    return parsed.protocol === 'https:' || parsed.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 从包注册表查询指定版本或 dist-tag 的 tarball 下载地址与完整性摘要 */
export async function fetchTarballMetadata(input: {
  packageName: string;
  targetSpec?: string;
  registry: string;
  authToken?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  locale?: Locale;
}): Promise<TarballMetaResult> {
  const locale = input.locale ?? 'zh';
  const spec = input.targetSpec ?? 'latest';
  if (
    !isValidPackageName(input.packageName) ||
    !isValidTargetSpec(spec) ||
    !isValidRegistryUrl(input.registry)
  ) {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(
        locale,
        '非法的包名、目标版本或 registry 地址',
        'Invalid package name, version spec, or registry URL',
      ),
    };
  }

  const base = normalizeRegistryUrl(input.registry);
  const url = `${base}/${encodeURIComponent(input.packageName)}/${encodeURIComponent(spec)}`;
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const authToken = sanitizeToken(input.authToken);
  const headers: Record<string, string> = { accept: 'application/json' };
  if (authToken !== undefined) {
    headers.authorization = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? cleanMsg(error.message, authToken) : '';
    return {
      ok: false,
      code: 'network',
      message:
        detail === ''
          ? t(locale, `无法连接源 (${base})`, `Cannot reach registry (${base})`)
          : t(
              locale,
              `无法连接源 (${base}): ${detail}`,
              `Cannot reach registry (${base}): ${detail}`,
            ),
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'auth',
      status: response.status,
      message: t(
        locale,
        `访问源 ${base} 鉴权失败 (HTTP ${response.status})`,
        `Authentication failed for ${base} (HTTP ${response.status})`,
      ),
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      code: 'not-found',
      status: 404,
      message: t(
        locale,
        `${input.packageName}@${spec} 在 ${base} 不存在 (HTTP 404)`,
        `${input.packageName}@${spec} not found on ${base} (HTTP 404)`,
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'http',
      status: response.status,
      message: t(
        locale,
        `注册表返回 HTTP ${response.status} (${base})`,
        `Registry returned HTTP ${response.status} (${base})`,
      ),
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(
        locale,
        `包元数据不是合法 JSON (${base})`,
        `Package metadata is not valid JSON (${base})`,
      ),
    };
  }

  if (typeof body !== 'object' || body === null || Array.isArray(body)) {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(
        locale,
        '包元数据响应格式无效',
        'Invalid package metadata object',
      ),
    };
  }

  const record = body as {
    version?: unknown;
    dist?: { tarball?: unknown; integrity?: unknown; shasum?: unknown };
  };
  const version = record.version;
  const tarballUrl = record.dist?.tarball;
  const integrity =
    typeof record.dist?.integrity === 'string'
      ? record.dist.integrity.trim()
      : undefined;
  const shasum =
    typeof record.dist?.shasum === 'string'
      ? record.dist.shasum.trim().toLowerCase()
      : undefined;

  if (
    typeof version !== 'string' ||
    !isValidTargetSpec(version) ||
    typeof tarballUrl !== 'string' ||
    !isHttpUrl(tarballUrl)
  ) {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(
        locale,
        '包元数据缺少合法 version 或 dist.tarball 地址',
        'Package metadata is missing valid version or dist.tarball URL',
      ),
    };
  }

  return {
    ok: true,
    version,
    registry: base,
    tarballUrl,
    integrity: integrity === '' ? undefined : integrity,
    shasum: shasum === '' ? undefined : shasum,
  };
}

/** 按 SRI (sha512 / sha256) 或 shasum (sha1) 校验 tarball 字节完整性 */
export function verifyTarballDigest(
  bytes: Uint8Array,
  integrity: string | undefined,
  shasum: string | undefined,
  locale: Locale = 'zh',
): { ok: true } | { ok: false; message: string } {
  if (integrity !== undefined) {
    const tokens = integrity.split(/\s+/).filter(Boolean);
    for (const token of tokens) {
      const dashIdx = token.indexOf('-');
      if (dashIdx <= 0) continue;
      const algo = token.slice(0, dashIdx).toLowerCase();
      const expectedB64 = token.slice(dashIdx + 1);
      if (algo !== 'sha512' && algo !== 'sha256') continue;
      const expected = Buffer.from(expectedB64, 'base64');
      const actual = createHash(algo).update(bytes).digest();
      if (
        expected.length > 0 &&
        expected.length === actual.length &&
        timingSafeEqual(expected, actual)
      ) {
        return { ok: true };
      }
      return {
        ok: false,
        message: t(
          locale,
          `Tarball ${algo} 完整性校验失败 (可能已损坏或被篡改)`,
          `Tarball ${algo} integrity check failed`,
        ),
      };
    }
  }

  if (shasum !== undefined && /^[0-9a-f]{40}$/i.test(shasum)) {
    const expected = Buffer.from(shasum, 'hex');
    const actual = createHash('sha1').update(bytes).digest();
    if (
      expected.length === actual.length &&
      timingSafeEqual(expected, actual)
    ) {
      return { ok: true };
    }
    return {
      ok: false,
      message: t(
        locale,
        'Tarball sha1 (shasum) 完整性校验失败',
        'Tarball sha1 (shasum) check failed',
      ),
    };
  }

  return {
    ok: false,
    message: t(
      locale,
      '注册表元数据缺少可验证的 dist.integrity 或 dist.shasum, 已拒绝安装',
      'Missing verifiable dist.integrity or dist.shasum in metadata; aborted',
    ),
  };
}

/** 下载 tarball 并完成签名摘要校验 (仅同源附带 authToken, 绝不跨域名泄漏) */
export async function downloadAndVerifyTarball(input: {
  tarballUrl: string;
  integrity?: string;
  shasum?: string;
  authToken?: string;
  expectedRegistryBase?: string;
  fetchFn?: FetchLike;
  timeoutMs?: number;
  maxBytes?: number;
  locale?: Locale;
}): Promise<TarballDownloadResult> {
  const locale = input.locale ?? 'zh';
  if (!isHttpUrl(input.tarballUrl)) {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(locale, '非法的 tarball 下载地址', 'Invalid tarball URL'),
    };
  }

  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS * 3;
  const maxBytes = input.maxBytes ?? DEFAULT_MAX_TARBALL_BYTES;
  const authToken = sanitizeToken(input.authToken);
  const headers: Record<string, string> = {};
  if (
    authToken !== undefined &&
    input.expectedRegistryBase !== undefined &&
    sameOrigin(input.tarballUrl, input.expectedRegistryBase)
  ) {
    headers.authorization = `Bearer ${authToken}`;
  }

  let response: Response;
  try {
    response = await fetchFn(input.tarballUrl, {
      headers,
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail =
      error instanceof Error ? cleanMsg(error.message, authToken) : '';
    return {
      ok: false,
      code: 'network',
      message:
        detail === ''
          ? t(locale, '下载安装包失败', 'Failed to download package tarball')
          : t(
              locale,
              `下载安装包失败: ${detail}`,
              `Failed to download package tarball: ${detail}`,
            ),
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'auth',
      status: response.status,
      message: t(
        locale,
        `下载安装包鉴权失败 (HTTP ${response.status})`,
        `Authentication failed downloading tarball (HTTP ${response.status})`,
      ),
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'http',
      status: response.status,
      message: t(
        locale,
        `下载安装包返回 HTTP ${response.status}`,
        `Tarball download returned HTTP ${response.status}`,
      ),
    };
  }

  const rawBuf = Buffer.from(await response.arrayBuffer());
  if (rawBuf.length > maxBytes) {
    return {
      ok: false,
      code: 'invalid-response',
      message: t(
        locale,
        `安装包体积超出安全上限 (${rawBuf.length} > ${maxBytes} 字节)`,
        `Tarball size exceeds limit (${rawBuf.length} > ${maxBytes} bytes)`,
      ),
    };
  }

  const digestCheck = verifyTarballDigest(
    rawBuf,
    input.integrity,
    input.shasum,
    locale,
  );
  if (!digestCheck.ok) {
    return {
      ok: false,
      code: 'integrity',
      message: digestCheck.message,
    };
  }

  return { ok: true, bytes: rawBuf };
}
