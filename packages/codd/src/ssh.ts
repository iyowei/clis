/**
 * SSH 连接串智能解析与目标服务器目录幂等计算工具。
 * 供 `validate-sections.ts`、`generate.ts`、`emit-podman*.ts` 与 `codd-cli/wizard-steps.ts` 共用。
 * 安全约束: 拒绝 Shell 元字符及 `-F`/`-J` (防 rsync 跳转失效); 备份与栈目录计算严格幂等, 防同机多实例重名。
 */
import { posix } from 'node:path';

import { ConfigError, type NodeOs, type ParsedSshTarget } from './types.ts';

export const deriveRemoteHome = (
  backupDir: string,
  os: NodeOs,
): string | undefined => {
  if (os === 'macos') {
    const m = /^\/Users\/([^/]+)(?:\/|$)/.exec(backupDir);
    return m ? `/Users/${m[1]}` : undefined;
  }
  const mHome = /^\/home\/([^/]+)(?:\/|$)/.exec(backupDir);
  if (mHome) return `/home/${mHome[1]}`;
  if (backupDir.startsWith('/root/')) return '/root';
  return undefined;
};

/**
 * 幂等计算目标服务器上的唯一实例备份目录 (防同机多实例重名冲突):
 * - 末段已是 `<prefix>-<name>-<fp>[-<node>]`, 或无 `nodeSuffix` 且路径中已含该目录段时原样返回;
 * - 带 `nodeSuffix` 且末段为无节点后缀的 `<prefix>-<name>-<fp>` 时, 末段升级替换为带节点后缀;
 * - 末段命中旧无指纹名 (`<prefix>-<name>`, `<name>` 等) 时替换为带指纹目录; 其余情况直接追加末段。
 */
export const resolveServerBackupDir = (
  rawBackupDir: string,
  stackPrefix: string,
  name: string,
  fingerprint: string,
  nodeSuffix?: string,
): string => {
  const clean = rawBackupDir.replace(/\/+$/, '') || '/';
  const unitSlug = nodeSuffix
    ? `${stackPrefix}-${name}-${fingerprint}-${nodeSuffix}`
    : `${stackPrefix}-${name}-${fingerprint}`;

  const base = posix.basename(clean);
  if (base === unitSlug) {
    return clean;
  }
  if (nodeSuffix && base === `${stackPrefix}-${name}-${fingerprint}`) {
    return posix.join(posix.dirname(clean), unitSlug);
  }
  if (!nodeSuffix && clean.split('/').includes(unitSlug)) {
    return clean;
  }

  const legacySlugs = new Set([
    `${stackPrefix}-${name}`,
    name,
    ...(nodeSuffix
      ? [`${stackPrefix}-${name}-${nodeSuffix}`, `${name}-${nodeSuffix}`]
      : []),
  ]);

  if (legacySlugs.has(base)) {
    return posix.join(posix.dirname(clean), unitSlug);
  }
  return posix.join(clean, unitSlug);
};

/**
 * 幂等计算目标服务器上的唯一部署栈目录 (用于 LaunchAgent WorkingDirectory 等)。
 */
export const resolveServerStackDir = (
  rawStackDir: string | undefined,
  home: string,
  dirName: string,
  stackPrefix: string,
  name: string,
  fingerprint: string,
): string => {
  if (!rawStackDir) {
    return posix.join(home, 'srv/stacks', dirName);
  }
  const clean = rawStackDir.replace(/\/+$/, '') || '/';
  const base = posix.basename(clean);
  if (base === dirName || clean.split('/').includes(dirName)) {
    return clean;
  }
  if (base === `${stackPrefix}-${name}-${fingerprint}`) {
    return posix.join(posix.dirname(clean), dirName);
  }
  if (base === `${stackPrefix}-${name}` || base === name) {
    return posix.join(posix.dirname(clean), dirName);
  }
  return posix.join(clean, dirName);
};

const UNSUPPORTED_SSH_CONFIG_FLAGS = new Set(['-F', '-J']);

const SKIP_NEXT_ARG_FLAGS = new Set([
  '-L',
  '-R',
  '-D',
  '-W',
  '-b',
  '-c',
  '-E',
  '-e',
  '-m',
  '-O',
  '-Q',
  '-S',
  '-w',
]);

const SKIP_BOOL_FLAGS = /^-[46AaCfGgKkMNnqsTtVvXxYy]+$/;
const SSH_TARGET_RE =
  /^(?:[A-Za-z0-9._-]+@)?[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/;

const parsePortValue = (rawPort: string, field: string): number => {
  const p = Number(rawPort);
  if (!Number.isInteger(p) || p < 1 || p > 65535) {
    throw new ConfigError(`${field} 中的 SSH 端口号非法: '${rawPort}'`);
  }
  return p;
};

interface SshScanState {
  port?: number;
  identityFile?: string;
  explicitUser?: string;
  hosts: string[];
}

const scanSshTokens = (
  tokens: string[],
  startIdx: number,
  field: string,
): SshScanState => {
  const state: SshScanState = { hosts: [] };
  let idx = startIdx;

  while (idx < tokens.length) {
    const tok = tokens[idx]!;
    const nextTok = tokens[idx + 1];

    if (tok === '-p' && nextTok !== undefined) {
      state.port = parsePortValue(nextTok, field);
      idx += 2;
      continue;
    }
    if (/^-p\d+$/.test(tok)) {
      state.port = parsePortValue(tok.slice(2), field);
      idx += 1;
      continue;
    }
    if (tok === '-i' && nextTok !== undefined) {
      if (nextTok.startsWith('-') || !/^[A-Za-z0-9._/~-]+$/.test(nextTok)) {
        throw new ConfigError(`${field} 中的私钥路径格式非法: '${nextTok}'`);
      }
      state.identityFile = nextTok;
      idx += 2;
      continue;
    }
    if (tok === '-l' && nextTok !== undefined) {
      if (!/^[A-Za-z0-9._-]+$/.test(nextTok)) {
        throw new ConfigError(`${field} 中的登录用户名非法: '${nextTok}'`);
      }
      state.explicitUser = nextTok;
      idx += 2;
      continue;
    }
    if (UNSUPPORTED_SSH_CONFIG_FLAGS.has(tok)) {
      throw new ConfigError(
        `${field} 不支持直接传递 ${tok} 参数 (会导致 rsync 跳转或配置文件丢失), 请在 ~/.ssh/config 中配置主机别名后直接填写别名`,
      );
    }
    if (SKIP_NEXT_ARG_FLAGS.has(tok) && nextTok !== undefined) {
      idx += 2;
      continue;
    }
    if (SKIP_BOOL_FLAGS.test(tok)) {
      idx += 1;
      continue;
    }
    if (tok.startsWith('-')) {
      throw new ConfigError(
        `${field} 包含不支持的参数 '${tok}', 请填写如 'ops@10.0.0.2' 或 SSH 主机别名`,
      );
    }
    state.hosts.push(tok);
    idx += 1;
  }
  return state;
};

/**
 * 智能提取用户输入的 SSH 连接串或命令: 剥离前导 `ssh` 与隧道/布尔开关 (`-N`, `-L` 等),
 * 支持 `-l <user>` 合并进目标地址与 `-p2222`/`-p 2222`、`-i <key>` 透传给 rsync (默认端口 22 省略),
 * 拒绝 Shell 元字符及 `-F`/`-J`。
 *
 * ### 数据流转示例
 * ```text
 * Input:  raw = 'ssh -p 2222 -i ~/.ssh/id_ed25519 -N ops@10.0.0.2'
 * Step 1: 拒检特殊字符 -> 剥离前导 'ssh' -> scanSshTokens 提取 port=2222, identityFile='~/.ssh/id_ed25519',
 *         跳过 '-N', 捕获 host='ops@10.0.0.2'
 * Step 2: 组装 normalized 与 rsync '-e' 传输选项 (port=22 时自动省略 -p)
 * Output: { target: 'ops@10.0.0.2', port: 2222, identityFile: '~/.ssh/id_ed25519',
 *           normalized: 'ssh -p 2222 -i ~/.ssh/id_ed25519 ops@10.0.0.2',
 *           rsyncRshFlag: '-e "ssh -p 2222 -i ~/.ssh/id_ed25519" ' }
 * ```
 */
export const parseSshInput = (
  raw: string,
  field = 'sshTarget',
): ParsedSshTarget => {
  const trimmed = raw.trim();
  if (!trimmed) {
    throw new ConfigError(`${field} 不能为空`);
  }
  if (/[;|`$&()<>'"\\\n\r]/.test(trimmed)) {
    throw new ConfigError(`${field} 包含非法特殊字符: '${raw}'`);
  }

  const tokens = trimmed.split(/\s+/).filter(Boolean);
  const startIdx = tokens[0]?.toLowerCase() === 'ssh' ? 1 : 0;
  const scanned = scanSshTokens(tokens, startIdx, field);

  const hostToken = scanned.hosts[0];
  if (!hostToken) {
    throw new ConfigError(
      `${field} 未识别到主机名或 IP, 请填写如 'ops@10.0.0.2' 或主机别名`,
    );
  }
  const target =
    scanned.explicitUser && !hostToken.includes('@')
      ? `${scanned.explicitUser}@${hostToken}`
      : hostToken;
  if (target.startsWith('-') || !SSH_TARGET_RE.test(target)) {
    throw new ConfigError(`${field} 目标地址格式非法: '${target}'`);
  }

  const sshParts = ['ssh'];
  if (scanned.port && scanned.port !== 22) sshParts.push(`-p ${scanned.port}`);
  if (scanned.identityFile) sshParts.push(`-i ${scanned.identityFile}`);
  const hasExtraSshOpts = sshParts.length > 1;

  return {
    target,
    ...(scanned.port && scanned.port !== 22 ? { port: scanned.port } : {}),
    ...(scanned.identityFile ? { identityFile: scanned.identityFile } : {}),
    normalized: hasExtraSshOpts ? `${sshParts.join(' ')} ${target}` : target,
    rsyncRshFlag: hasExtraSshOpts ? `-e "${sshParts.join(' ')}" ` : '',
  };
};
