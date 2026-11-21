/**
 * 用户家目录 ~/.npmrc 与 ~/.bunfig.toml 的轻量无依赖解析器 (纯函数, 零 IO)。
 *
 * 覆盖范围:
 * - registry 解析 (含 scoped 覆盖、引号感知行尾注释、[install.registry]、
 *   [install.scopes."@scope"] 与内联表 `{ url = ..., token = ... }`);
 * - 同源 host/path 精确匹配的鉴权 token 解析 (支持 ${ENV} / $ENV 展开, 缺失不回退字面量);
 * - ~/.bunfig.toml 中 [install] globalDir 解析 (供自定义 Bun 全局目录兜底)。
 */
import { isValidRegistryUrl } from './semver.ts';

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

/** 剥去值外层成对的双引号或单引号 */
function unquotePair(raw: string): string {
  const trimmed = raw.trim();
  if (
    trimmed.length >= 2 &&
    ((trimmed.startsWith('"') && trimmed.endsWith('"')) ||
      (trimmed.startsWith("'") && trimmed.endsWith("'")))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

/** 引号感知地剥离 TOML 行尾 `#` 注释 (不截断引号内部的 `#`) */
export function stripTomlComment(line: string): string {
  let inDouble = false;
  let inSingle = false;
  let escaped = false;
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (inDouble) {
      if (escaped) {
        escaped = false;
      } else if (ch === '\\') {
        escaped = true;
      } else if (ch === '"') {
        inDouble = false;
      }
      continue;
    }
    if (inSingle) {
      if (ch === "'") inSingle = false;
      continue;
    }
    if (ch === '#') return line.slice(0, i).trim();
    if (ch === '"') inDouble = true;
    else if (ch === "'") inSingle = true;
  }
  return line.trim();
}

/** 解析单个 TOML 引号字符串 (双引号或单引号) */
function parseTomlString(raw: string): string | null {
  const trimmed = raw.trim();
  if (trimmed.length < 2) return null;
  const quote = trimmed[0];
  if (quote !== '"' && quote !== "'") return null;
  if (quote === "'") {
    const end = trimmed.indexOf("'", 1);
    return end === trimmed.length - 1 ? trimmed.slice(1, end) : null;
  }
  let out = '';
  let escaped = false;
  for (let i = 1; i < trimmed.length; i += 1) {
    const ch = trimmed[i]!;
    if (escaped) {
      out += ch;
      escaped = false;
      continue;
    }
    if (ch === '\\') {
      escaped = true;
      continue;
    }
    if (ch === '"') {
      return i === trimmed.length - 1 ? out : null;
    }
    out += ch;
  }
  return null;
}

/** 解析 TOML 内联表 `{ url = "...", token = "..." }` 中指定的字符串字段 */
function extractInlineField(body: string, fieldName: string): string | null {
  const re = new RegExp(
    `(?:^|[,{])\\s*${fieldName}\\s*=\\s*("[^"\\\\]*(?:\\\\.[^"\\\\]*)*"|'[^']*')`,
  );
  const m = re.exec(body);
  return m === null ? null : parseTomlString(m[1]!);
}

/** 归一 URL pathname 为 `/foo/` 形式 (根路径为 `/`) */
function normalizeUrlPath(pathname: string): string {
  const trimmed = pathname.replace(/\/+$/, '');
  return trimmed === '' ? '/' : `${trimmed}/`;
}

/** 安全展开 token 中的环境变量 (${VAR}, 可选 $VAR); 缺失变量或含非法头字符一律返回 null */
function expandEnvToken(
  raw: string,
  env: NodeJS.ProcessEnv,
  allowBareDollar: boolean,
): string | null {
  let missing = false;
  let expanded = raw.replace(/\$\{([A-Za-z_][A-Za-z0-9_]*)\}/g, (_m, name) => {
    const val = env[name as string];
    if (typeof val !== 'string' || val === '') {
      missing = true;
      return '';
    }
    return val;
  });
  if (missing || expanded.includes('${')) return null;

  if (allowBareDollar) {
    expanded = expanded.replace(/\$([A-Za-z_][A-Za-z0-9_]*)/g, (_m, name) => {
      const val = env[name as string];
      if (typeof val !== 'string' || val === '') {
        missing = true;
        return '';
      }
      return val;
    });
    if (missing) return null;
  }

  const trimmed = expanded.trim();
  if (trimmed === '' || /[\s\p{Cc}]/u.test(trimmed)) return null;
  return trimmed;
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
    const value = unquotePair(line.slice(eq + 1));
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
 * 从 ~/.npmrc 解析与目标 registry 精确匹配同 host 与 path 的 `_authToken`。
 * 仅处理 `//host/path/:_authToken=...`, 支持 `${ENV}` 展开; 未匹配或变量缺失返回 null。
 */
export function parseAuthTokenFromNpmrc(
  content: string,
  registryUrl: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  let target: URL;
  try {
    target = new URL(normalizeRegistryUrl(registryUrl));
  } catch {
    return null;
  }
  const targetHost = target.host.toLowerCase();
  const targetPath = normalizeUrlPath(target.pathname);
  let matched: string | null = null;

  for (const rawLine of content.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line === '' || line.startsWith('#') || line.startsWith(';')) continue;
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const key = line.slice(0, eq).trim();
    if (!key.startsWith('//') || !key.endsWith(':_authToken')) continue;

    const hostPath = key.slice(2, -':_authToken'.length);
    if (hostPath === '') continue;
    let entry: URL;
    try {
      entry = new URL(`https://${hostPath}`);
    } catch {
      continue;
    }
    if (
      entry.host.toLowerCase() !== targetHost ||
      normalizeUrlPath(entry.pathname) !== targetPath
    ) {
      continue;
    }

    const token = expandEnvToken(unquotePair(line.slice(eq + 1)), env, false);
    if (token !== null) matched = token;
  }
  return matched;
}

interface BunfigRegistryEntry {
  url?: string;
  token?: string;
}

interface ParsedBunfigInstall {
  globalEntry: BunfigRegistryEntry;
  scopes: Map<string, BunfigRegistryEntry>;
  globalDir: string | null;
}

/** 解析 `[install.scopes."@scope"]` 子表头, 返回 scope 名或 null */
function parseScopedSubtableHeader(section: string): string | null {
  const m = /^install\.scopes\.(?:"([^"]+)"|'([^']+)'|([^\s.\]]+))$/.exec(
    section,
  );
  if (m === null) return null;
  const scopeName = (m[1] ?? m[2] ?? m[3] ?? '').trim();
  return scopeName.startsWith('@') ? scopeName : null;
}

/** 解析 `[install]` / `[install.registry]` / `[install.scopes]` 的键值分配 */
function applyBunfigKeyValue(
  target: BunfigRegistryEntry,
  key: string,
  rhs: string,
): void {
  const str = parseTomlString(rhs);
  if (str === null) return;
  if (key === 'url' && isValidRegistryUrl(str)) {
    target.url = str;
  } else if (key === 'token' && str.trim() !== '') {
    target.token = str;
  }
}

/** 解析 `registry = "..."` 或 `registry = { url = "...", token = "..." }` */
function applyBunfigRegistryRhs(
  target: BunfigRegistryEntry,
  rhs: string,
): void {
  const str = parseTomlString(rhs);
  if (str !== null) {
    if (isValidRegistryUrl(str)) target.url = str;
    return;
  }
  if (!rhs.startsWith('{') || !rhs.endsWith('}')) return;
  const url = extractInlineField(rhs, 'url');
  if (url !== null && isValidRegistryUrl(url)) target.url = url;
  const token = extractInlineField(rhs, 'token');
  if (token !== null && token.trim() !== '') target.token = token;
}

/**
 * 一次性解析 ~/.bunfig.toml 中的 install 配置 (行级状态机, 引号感知剥注释)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  content = "[install]\nregistry = \"https://r.example\"\n[install.scopes.\"@iyowei\"]\nurl = \"https://p.example\"\ntoken = \"$MY_TOKEN\""
 * 步骤 1: 逐行 stripTomlComment -> 识别 [section] (install / install.registry / install.scopes / install.scopes."@scope")
 * 步骤 2: 解析字符串或内联表 { url = ..., token = ... }, 分别落入 globalEntry / scopes Map / globalDir
 * Output: { globalEntry: { url }, scopes: Map { '@iyowei' => { url, token } }, globalDir: null }
 * ```
 */
function parseBunfigInstall(content: string): ParsedBunfigInstall {
  const result: ParsedBunfigInstall = {
    globalEntry: {},
    scopes: new Map(),
    globalDir: null,
  };
  let section = '';

  const getScopeEntry = (scopeName: string): BunfigRegistryEntry => {
    const existing = result.scopes.get(scopeName);
    if (existing !== undefined) return existing;
    const created: BunfigRegistryEntry = {};
    result.scopes.set(scopeName, created);
    return created;
  };

  for (const rawLine of content.split(/\r?\n/)) {
    const line = stripTomlComment(rawLine);
    if (line === '') continue;
    const secMatch = /^\[([^\]]+)\]$/.exec(line);
    if (secMatch !== null) {
      section = secMatch[1]!.trim();
      continue;
    }
    const eq = line.indexOf('=');
    if (eq <= 0) continue;
    const rawKey = line.slice(0, eq).trim();
    const rhs = line.slice(eq + 1).trim();

    if (section === 'install') {
      if (rawKey === 'registry') {
        applyBunfigRegistryRhs(result.globalEntry, rhs);
      } else if (rawKey === 'globalDir') {
        const dir = parseTomlString(rhs);
        if (dir !== null && dir.trim() !== '') result.globalDir = dir.trim();
      }
      continue;
    }
    if (section === 'install.registry') {
      applyBunfigKeyValue(result.globalEntry, rawKey, rhs);
      continue;
    }
    if (section === 'install.scopes') {
      const scopeName = unquotePair(rawKey);
      if (scopeName.startsWith('@')) {
        applyBunfigRegistryRhs(getScopeEntry(scopeName), rhs);
      }
      continue;
    }
    const subScope = parseScopedSubtableHeader(section);
    if (subScope !== null) {
      applyBunfigKeyValue(getScopeEntry(subScope), rawKey, rhs);
    }
  }
  return result;
}

/**
 * 从 ~/.bunfig.toml 解析 [install] / [install.registry] / [install.scopes] 中的 registry。
 * 支持引号感知注释、字符串赋值、内联表 `{ url = ..., token = ... }` 与子表头。
 */
export function parseRegistryFromBunfig(
  content: string,
  packageName: string,
): string | null {
  const parsed = parseBunfigInstall(content);
  const scope = extractScope(packageName);
  const scopedUrl = scope !== null ? parsed.scopes.get(scope)?.url : undefined;
  return scopedUrl ?? parsed.globalEntry.url ?? null;
}

/** 判断两个 registry URL 是否同协议、同 host (含端口) 且同 path */
function matchesRegistryOriginAndPath(
  targetUrl: string,
  entryUrl: string,
): boolean {
  try {
    const a = new URL(normalizeRegistryUrl(targetUrl));
    const b = new URL(normalizeRegistryUrl(entryUrl));
    return (
      a.protocol === b.protocol &&
      a.host.toLowerCase() === b.host.toLowerCase() &&
      normalizeUrlPath(a.pathname) === normalizeUrlPath(b.pathname)
    );
  } catch {
    return false;
  }
}

/**
 * 从 ~/.bunfig.toml 提取与目标 registry 精确同源同路径匹配的 token (支持 $ENV / ${ENV} 展开)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  registryUrl = "https://p.example/npm/", packageName = "@iyowei/sweep-cli", env = { MY_TOKEN: "tok" }
 * 步骤 1: parseBunfigInstall -> 构造优先级队列 [本包 scope 项, globalEntry, 其余 scope 项]
 * 步骤 2: 逐项 matchesRegistryOriginAndPath (同协议 + 同 host 含端口 + 归一 pathname 相等)
 * 步骤 3: 命中后 expandEnvToken (支持 ${VAR} 与 $VAR; 缺失或含控制字符返回 null 不透传字面量)
 * Output: "tok" (或未匹配返回 null)
 * ```
 */
export function parseAuthTokenFromBunfig(
  content: string,
  registryUrl: string,
  packageName: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const parsed = parseBunfigInstall(content);
  const scope = extractScope(packageName);
  const ordered: BunfigRegistryEntry[] = [];
  if (scope !== null) {
    const scoped = parsed.scopes.get(scope);
    if (scoped !== undefined) ordered.push(scoped);
  }
  ordered.push(parsed.globalEntry);
  for (const [k, entry] of parsed.scopes.entries()) {
    if (k !== scope) ordered.push(entry);
  }

  for (const entry of ordered) {
    if (entry.url === undefined || entry.token === undefined) continue;
    if (!matchesRegistryOriginAndPath(registryUrl, entry.url)) continue;
    const expanded = expandEnvToken(entry.token, env, true);
    if (expanded !== null) return expanded;
  }
  return null;
}

/** 从 ~/.bunfig.toml 解析 `[install] globalDir` 配置值 */
export function parseGlobalDirFromBunfig(content: string): string | null {
  return parseBunfigInstall(content).globalDir;
}
