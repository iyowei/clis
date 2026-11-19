/**
 * npm Trusted Publisher 登记解析、差异比对与运行环境判定纯函数库 (零副作用、零 I/O)。
 */
import type { WorkspacePackage } from './workspace.ts';

/** npm trust list 解析出的登记条目 (缺行字段落成 null) */
export interface TrustEntry {
  type: string | null;
  id: string | null;
  file: string | null;
  environment: string | null;
  repository: string;
}

/** 期望的登记形态 (owner/repo 从 git origin 派生, 其余为常量) */
export interface TrustExpectation {
  repository: string;
  file: string;
  environment: string;
}

/** OIDC 运行环境判定: ready = 可预检; missing-permission = Actions 里漏配 id-token; not-ci = 本地 */
export type OidcEnvVerdict = 'ready' | 'missing-permission' | 'not-ci';

/** 剥终端 CSI 序列 (颜色着色与 spinner 的光标控制; 参数段 [0-9;?]*, 末字符为任意字母) */
export const stripCsi = (text: string): string =>
  text.replace(
    new RegExp(String.fromCharCode(27) + '\\[[0-9;?]*[A-Za-z]', 'g'),
    '',
  );

/** 剥控制字符并收拢空白 (npm 输出属低信任输入, 落进人读文案前先降噪) */
export const cleanText = (text: string): string =>
  text.replace(/[\p{Cc}]+/gu, ' ').trim();

/**
 * 剥 pty 伪影: `script` 开场的 ^D + 退格序列、CRLF 行尾与孤立终端控制符。
 * 须在 stripCsi 之后调用: 本函数的控制符剥离面覆盖 ESC 本身, 先把完整 CSI 序列剥掉再除残留。
 */
export const stripPtyNoise = (text: string): string =>
  text
    .replace(/\r/g, '')
    // eslint-disable-next-line no-control-regex -- 此处刻意匹配 pty 残留控制符 (script 开场的 ^D 与退格), 属预期匹配
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f]/g, '');

/** 从 git remote 原文派生 owner/repo; 非 GitHub 远端或形状不符返回 null */
export function deriveRepoFromRemoteUrl(raw: string): string | null {
  const cleaned = raw.trim().replace(/\.git$/, '');
  const match = cleaned.match(/github\.com[:/]([^/\s]+)\/([^/\s]+)$/);
  if (match === null || match[1] === undefined || match[2] === undefined) {
    return null;
  }
  return `${match[1]}/${match[2]}`;
}

/** Trusted Publisher ID 合法字符白名单 (UUID / 字母数字连字符下划线点) */
export const isValidTrustId = (id: string): boolean =>
  /^[A-Za-z0-9._-]+$/.test(id);

/** POSIX 单引号安全转义 (安全字符集保持裸写便于日志阅读, 含元字符或空白则严格单引号包裹) */
export const shellQuote = (arg: string): string =>
  /^[A-Za-z0-9_@%+=:,./-]+$/.test(arg)
    ? arg
    : `'${arg.replace(/'/g, "'\\''")}'`;

/**
 * 解析 `npm trust list` 的人读输出为多条记录 (防止多条登记时跨条串味)。
 * 遇到重复键名或空行分段时自动切分新条目; 仅保留含非空 repository 字段的可信条目。
 */
export function parseTrustListEntries(raw: string): TrustEntry[] {
  const text = stripPtyNoise(stripCsi(raw));
  const keys = new Set(['type', 'id', 'file', 'environment', 'repository']);
  const entries: TrustEntry[] = [];
  let current: Partial<Record<keyof TrustEntry, string>> = {};

  const flush = (): void => {
    if (current.repository !== undefined && current.repository !== '') {
      entries.push({
        type: current.type ?? null,
        id: current.id ?? null,
        file: current.file ?? null,
        environment: current.environment ?? null,
        repository: current.repository,
      });
    }
    current = {};
  };

  for (const line of text.split('\n')) {
    const match = /^([a-z]+):[ \t]*(.+)$/.exec(line.trim());
    if (match === null) {
      if (line.trim() === '' && Object.keys(current).length > 0) flush();
      continue;
    }
    const key = match[1] as keyof TrustEntry;
    if (!keys.has(key)) continue;
    if (current[key] !== undefined) flush();
    const cleaned = cleanText(match[2]!);
    if (cleaned !== '') current[key] = cleaned;
  }
  flush();
  return entries;
}

/** 解析 `npm trust list` 的首条记录 (兼容单登记调用方; 未见 repository 行时返回 null) */
export function parseTrustListOutput(raw: string): TrustEntry | null {
  return parseTrustListEntries(raw)[0] ?? null;
}

/** 登记比对 (纯函数): 逐字段列出与期望值的差异, 全一致返回空列表 */
export function diffTrust(
  actual: TrustEntry,
  expected: TrustExpectation,
): string[] {
  const problems: string[] = [];
  if (actual.repository !== expected.repository) {
    problems.push(
      `repository: ${actual.repository} → 期望 ${expected.repository}`,
    );
  }
  if (actual.file !== expected.file) {
    problems.push(
      `workflow 文件: ${actual.file ?? '(未设置)'} → 期望 ${expected.file}`,
    );
  }
  if (actual.environment !== expected.environment) {
    problems.push(
      `environment: ${actual.environment ?? '(未设置)'} → 期望 ${expected.environment}`,
    );
  }
  return problems;
}

/** OIDC 环境判定 (纯函数): 三分支各自对应不同出口, 防「权限漏配」被静默放过 */
export function classifyOidcEnv(
  env: Record<string, string | undefined>,
): OidcEnvVerdict {
  if (env.GITHUB_ACTIONS !== 'true') return 'not-ci';
  return env.ACTIONS_ID_TOKEN_REQUEST_URL !== undefined &&
    env.ACTIONS_ID_TOKEN_REQUEST_TOKEN !== undefined
    ? 'ready'
    : 'missing-permission';
}

/** 生成经 pty 包装的 npm 调用坐标 (保证 npm web 认证交互的 TTY 要求) */
export function ptyWrapArgs(
  platform: NodeJS.Platform,
  npm: string,
  args: string[],
): { command: string; args: string[] } {
  if (platform === 'darwin') {
    return { command: 'script', args: ['-q', '/dev/null', npm, ...args] };
  }
  if (platform === 'linux') {
    const quoted = [npm, ...args].map(shellQuote).join(' ');
    return {
      command: 'script',
      args: ['-qec', quoted, '/dev/null'],
    };
  }
  return { command: npm, args };
}

/** 预检核对面 (纯函数): 可发布 (非 private) 的包, 与发布链单源一致 */
export function filterPublishable(
  packages: readonly WorkspacePackage[],
): WorkspacePackage[] {
  return packages.filter((pkg) => pkg.manifest.private !== true);
}
