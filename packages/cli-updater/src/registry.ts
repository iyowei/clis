/**
 * npm registry 解析、同源鉴权凭据提取与远端版本查询模块:
 * - Registry 优先级: 显式 --registry > 环境变量 > 用户家目录配置 > 官方源;
 *   仅 `pm === 'bun'` 或 `pm === undefined` 才读取 `~/.bunfig.toml`, 明确为 npm / pnpm /
 *   yarn / volta 时只读 `~/.npmrc`, 杜绝查源与装源分裂;
 * - 安全硬底线: 绝不读取当前工作目录 (cwd) 的 .npmrc 或 bunfig.toml, 防止被不可信目录劫持;
 *   鉴权 token 仅在目标 registry 与配置 host/path 精确匹配时注入 Authorization 头, 且绝不回显。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';

import {
  normalizeRegistryUrl,
  parseAuthTokenFromBunfig,
  parseAuthTokenFromNpmrc,
  parseRegistryFromBunfig,
  parseRegistryFromNpmrc,
} from './config-parse.ts';
import { type PackageManager, joinForPath } from './detect.ts';
import {
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
} from './semver.ts';

export {
  normalizeRegistryUrl,
  parseRegistryFromBunfig,
  parseRegistryFromNpmrc,
};

/** 默认官方 npm registry */
export const DEFAULT_REGISTRY = 'https://registry.npmjs.org';

/** 默认版本查询超时 (毫秒) */
export const DEFAULT_FETCH_TIMEOUT_MS = 10_000;

export interface ResolveRegistryInput {
  packageName: string;
  flagRegistry?: string;
  pm?: PackageManager;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readText?: (path: string) => string | null;
}

export interface ResolveRegistryAuthInput {
  packageName: string;
  registry: string;
  pm?: PackageManager;
  env?: NodeJS.ProcessEnv;
  homeDir?: string;
  readText?: (path: string) => string | null;
}

/** 轻量 fetch 函数签名 (兼容标准全局 fetch 与无 preconnect 字段的测试替身) */
export type FetchLike = (
  input: string | URL,
  init?: RequestInit,
) => Promise<Response>;

export interface FetchVersionInput {
  packageName: string;
  registry: string;
  tag?: string;
  timeoutMs?: number;
  fetchFn?: FetchLike;
  /** 可选同源 Bearer token (仅写入请求头, 绝不记录到日志或异常消息) */
  authToken?: string;
}

export type FetchVersionResult =
  | { ok: true; version: string; registry: string }
  | {
      ok: false;
      code: 'not-found' | 'auth' | 'network' | 'http' | 'invalid-response';
      message: string;
      status?: number;
    };

/** 安全读文本文件 (不存在或不可读返回 null) */
function defaultReadText(path: string): string | null {
  try {
    return readFileSync(path, 'utf8');
  } catch {
    return null;
  }
}

/** 推导本次查询应使用的 registry URL (仅查显式参数、环境变量与用户家目录配置) */
export function resolveRegistry(input: ResolveRegistryInput): string {
  if (
    input.flagRegistry !== undefined &&
    isValidRegistryUrl(input.flagRegistry)
  ) {
    return normalizeRegistryUrl(input.flagRegistry);
  }
  const env = input.env ?? process.env;
  const envReg = env.NPM_CONFIG_REGISTRY ?? env.npm_config_registry;
  if (typeof envReg === 'string' && isValidRegistryUrl(envReg)) {
    return normalizeRegistryUrl(envReg);
  }

  const home = input.homeDir ?? homedir();
  const readText = input.readText ?? defaultReadText;

  if (input.pm === 'bun') {
    const bunfig = readText(joinForPath(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const found = parseRegistryFromBunfig(bunfig, input.packageName);
      if (found !== null) return normalizeRegistryUrl(found);
    }
  }

  const npmrc = readText(joinForPath(home, '.npmrc'));
  if (npmrc !== null) {
    const found = parseRegistryFromNpmrc(npmrc, input.packageName);
    if (found !== null) return normalizeRegistryUrl(found);
  }

  // 仅当未确定包管理器时允许回退 ~/.bunfig.toml; 明确 npm/pnpm/yarn/volta 绝不读 bunfig
  if (input.pm === undefined) {
    const bunfig = readText(joinForPath(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const found = parseRegistryFromBunfig(bunfig, input.packageName);
      if (found !== null) return normalizeRegistryUrl(found);
    }
  }

  return DEFAULT_REGISTRY;
}

/**
 * 为指定目标 registry 解析同源同路径鉴权 token (仅从用户家目录配置读取, 严格对齐 pm 规则)。
 * 未配置、不匹配或环境变量缺失时返回 undefined。
 */
export function resolveRegistryAuthToken(
  input: ResolveRegistryAuthInput,
): string | undefined {
  if (!isValidRegistryUrl(input.registry)) return undefined;
  const env = input.env ?? process.env;
  const home = input.homeDir ?? homedir();
  const readText = input.readText ?? defaultReadText;
  const base = normalizeRegistryUrl(input.registry);

  if (input.pm === 'bun') {
    const bunfig = readText(joinForPath(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const token = parseAuthTokenFromBunfig(
        bunfig,
        base,
        input.packageName,
        env,
      );
      if (token !== null) return token;
    }
  }

  const npmrc = readText(joinForPath(home, '.npmrc'));
  if (npmrc !== null) {
    const token = parseAuthTokenFromNpmrc(npmrc, base, env);
    if (token !== null) return token;
  }

  if (input.pm === undefined) {
    const bunfig = readText(joinForPath(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const token = parseAuthTokenFromBunfig(
        bunfig,
        base,
        input.packageName,
        env,
      );
      if (token !== null) return token;
    }
  }

  return undefined;
}

/** 清理错误文本中的控制字符并防御性脱敏 token (防止远端响应或凭据泄漏到终端) */
function cleanMessage(raw: string, secret?: string): string {
  const redacted =
    secret !== undefined && secret !== ''
      ? raw.replaceAll(secret, '[REDACTED]')
      : raw;
  return redacted
    .replace(/\p{Cc}/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/** 向 registry 查询指定包最新 dist-tag 的版本号 */
export async function fetchLatestVersion(
  input: FetchVersionInput,
): Promise<FetchVersionResult> {
  const tag = input.tag ?? 'latest';
  if (!isValidPackageName(input.packageName)) {
    return {
      ok: false,
      code: 'invalid-response',
      message: `非法包名: ${cleanMessage(input.packageName)}`,
    };
  }
  if (!isValidTargetSpec(tag) || !isValidRegistryUrl(input.registry)) {
    return {
      ok: false,
      code: 'invalid-response',
      message: '非法的 registry 地址或版本标签',
    };
  }

  const base = normalizeRegistryUrl(input.registry);
  const url = `${base}/${encodeURIComponent(input.packageName)}/${encodeURIComponent(tag)}`;
  const fetchFn = input.fetchFn ?? fetch;
  const timeoutMs = input.timeoutMs ?? DEFAULT_FETCH_TIMEOUT_MS;
  const authToken =
    typeof input.authToken === 'string' &&
    input.authToken.trim() !== '' &&
    !/[\s\p{Cc}]/u.test(input.authToken)
      ? input.authToken.trim()
      : undefined;

  const headers: Record<string, string> = {
    accept: 'application/vnd.npm.install-v1+json, application/json',
  };
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
      error instanceof Error ? cleanMessage(error.message, authToken) : '';
    return {
      ok: false,
      code: 'network',
      message:
        detail === ''
          ? `无法连接包注册表 (${base})`
          : `无法连接包注册表 (${base}): ${detail}`,
    };
  }

  if (response.status === 401 || response.status === 403) {
    return {
      ok: false,
      code: 'auth',
      status: response.status,
      message: `访问包注册表 ${base} 鉴权失败 (HTTP ${response.status}), 请检查 ~/.npmrc / ~/.bunfig.toml 认证凭据或登录状态`,
    };
  }
  if (response.status === 404) {
    return {
      ok: false,
      code: 'not-found',
      status: 404,
      message: `${input.packageName} 尚未在 ${base} 发布 (HTTP 404)`,
    };
  }
  if (!response.ok) {
    return {
      ok: false,
      code: 'http',
      status: response.status,
      message: `包注册表返回异常状态 HTTP ${response.status} (${base})`,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    return {
      ok: false,
      code: 'invalid-response',
      message: `包注册表返回的内容不是合法 JSON (${base})`,
    };
  }

  const version =
    typeof body === 'object' && body !== null && !Array.isArray(body)
      ? (body as { version?: unknown }).version
      : undefined;
  if (typeof version !== 'string' || !isValidTargetSpec(version)) {
    return {
      ok: false,
      code: 'invalid-response',
      message: `包注册表响应缺少合法 version 字段 (${base})`,
    };
  }

  return { ok: true, version, registry: base };
}
