/**
 * npm registry 解析与远端版本查询模块:
 * - Registry 优先级: 显式 --registry > 环境变量 > 用户家目录配置 (~/.bunfig.toml / ~/.npmrc) > 官方源;
 * - 安全硬底线: 绝不读取当前工作目录 (cwd) 的 .npmrc 或 bunfig.toml, 防止在不可信目录跑
 *   update 时被恶意配置劫持到钓鱼源;
 * - 查询端点使用轻量的 /<pkg>/<tag> dist-tag 接口并设严格超时。
 */
import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { type PackageManager } from './detect.ts';
import {
  isValidPackageName,
  isValidRegistryUrl,
  isValidTargetSpec,
} from './semver.ts';

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
}

export type FetchVersionResult =
  | { ok: true; version: string; registry: string }
  | {
      ok: false;
      code: 'not-found' | 'network' | 'http' | 'invalid-response';
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

/** 归一 registry URL (去掉末尾斜杠) */
export function normalizeRegistryUrl(url: string): string {
  return url.trim().replace(/\/+$/, '');
}

/** 提取包名的 scope (如 "@iyowei/foo" -> "@iyowei"; 裸包返回 null) */
function extractScope(packageName: string): string | null {
  if (!packageName.startsWith('@')) return null;
  const slash = packageName.indexOf('/');
  return slash > 1 ? packageName.slice(0, slash) : null;
}

/**
 * 从 ~/.npmrc 解析 registry: 若包带 scope, 优先匹配 `@scope:registry=...`, 否则回退 `registry=...`。
 * 支持双引号/单引号包裹的值, 忽略 `#` 与 `;` 注释行。
 */
export function parseRegistryFromNpmrc(
  content: string,
  packageName: string,
): string | null {
  const scope = extractScope(packageName);
  let globalReg: string | null = null;
  let scopedReg: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    const value = line
      .slice(eq + 1)
      .trim()
      .replace(/^["']|["']$/g, '');
    if (!isValidRegistryUrl(value)) continue;
    if (scope !== null && key === `${scope}:registry`) {
      scopedReg = value;
    } else if (key === 'registry') {
      globalReg = value;
    }
  }
  return scopedReg ?? globalReg;
}

/**
 * 从 ~/.bunfig.toml 解析 [install] / [install.scopes] 中的 registry。
 * 支持常见字符串形式: `registry = "https://..."` 与 `"@scope" = "https://..."` 或内联表。
 */
export function parseRegistryFromBunfig(
  content: string,
  packageName: string,
): string | null {
  const scope = extractScope(packageName);
  let section = '';
  let globalReg: string | null = null;
  let scopedReg: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line === '') continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch !== null) {
      section = secMatch[1]!.trim();
      continue;
    }
    if (section === 'install') {
      const m = /^registry\s*=\s*["']([^"']+)["']/.exec(line);
      if (m !== null && isValidRegistryUrl(m[1]!)) globalReg = m[1]!;
      continue;
    }
    if (section === 'install.scopes' && scope !== null) {
      const quoted = new RegExp(
        `^["']?${scope.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}["']?\\s*=\\s*(.+)$`,
      ).exec(line);
      if (quoted === null) continue;
      const rhs = quoted[1]!.trim();
      const strMatch = /^["']([^"']+)["']/.exec(rhs);
      if (strMatch !== null && isValidRegistryUrl(strMatch[1]!)) {
        scopedReg = strMatch[1]!;
        continue;
      }
      const inlineMatch = /url\s*=\s*["']([^"']+)["']/.exec(rhs);
      if (inlineMatch !== null && isValidRegistryUrl(inlineMatch[1]!)) {
        scopedReg = inlineMatch[1]!;
      }
    }
  }
  return scopedReg ?? globalReg;
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
    const bunfig = readText(join(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const found = parseRegistryFromBunfig(bunfig, input.packageName);
      if (found !== null) return normalizeRegistryUrl(found);
    }
  }

  const npmrc = readText(join(home, '.npmrc'));
  if (npmrc !== null) {
    const found = parseRegistryFromNpmrc(npmrc, input.packageName);
    if (found !== null) return normalizeRegistryUrl(found);
  }

  if (input.pm !== 'bun') {
    const bunfig = readText(join(home, '.bunfig.toml'));
    if (bunfig !== null) {
      const found = parseRegistryFromBunfig(bunfig, input.packageName);
      if (found !== null) return normalizeRegistryUrl(found);
    }
  }

  return DEFAULT_REGISTRY;
}

/** 清理错误文本中的控制字符 (防止远端响应或异常文本注入终端控制序列) */
function cleanMessage(raw: string): string {
  return raw
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

  let response: Response;
  try {
    response = await fetchFn(url, {
      headers: {
        accept: 'application/vnd.npm.install-v1+json, application/json',
      },
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (error) {
    const detail = error instanceof Error ? cleanMessage(error.message) : '';
    return {
      ok: false,
      code: 'network',
      message:
        detail === ''
          ? `无法连接包注册表 (${base})`
          : `无法连接包注册表 (${base}): ${detail}`,
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
