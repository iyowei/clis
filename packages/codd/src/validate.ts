/**
 * 部署清单 (DeployManifest) 与运行时引擎兼容性校验。
 */
import { parseSshInput } from './ssh.ts';
import {
  type AppInput,
  ConfigError,
  type DeployManifest,
  type DeployMode,
  type NetworkMode,
  type NodeInput,
} from './types.ts';

const VALID_MODES = new Set<string>([
  'single',
  'replica-set',
  'k8s-single',
  'k8s-rs',
]);
const RESERVED_DBS = new Set<string>(['admin', 'local', 'config']);
const WARN_PORTS = new Set<number>([27017, 27018, 27019]);

const ALLOWED_KEYS = new Set<string>([
  '$schema',
  'mode',
  'name',
  'stackPrefix',
  'hardware',
  'imageName',
  'imageTag',
  'bunImage',
  'tz',
  'port',
  'hostPort',
  'rsName',
  'networkMode',
  'multiNetAlias',
  'keepDaily',
  'keepWeekly',
  'apps',
  'auth',
  'nodes',
  'k8s',
]);

const NAME_RE = /^[a-z0-9-]+$/;
const ALNUM_RE = /^[A-Za-z0-9]+$/;
const DB_NAME_RE = /^[A-Za-z0-9_-]+$/;
const HOST_NAME_RE = /^[A-Za-z0-9._-]+$/;
export const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const checkAlnum = (val: string, label: string): string => {
  if (!ALNUM_RE.test(val) || val === 'CHANGE_ME') {
    throw new ConfigError(`${label} 只允许字母和数字, 且不能为 CHANGE_ME`);
  }
  return val;
};

const checkPort = (val: number, label: string): number => {
  if (!Number.isInteger(val) || val < 1024 || val > 65535) {
    throw new ConfigError(
      `${label} 必须为 1024-65535 之间的整数, 当前为 ${val}`,
    );
  }
  return val;
};

const parseSemverTuple = (ver: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver.trim());
  if (!m) return null;
  return [Number(m[1]), Number(m[2]), Number(m[3])];
};

export const assertBunEngineCompatible = (
  requiredRange: string | undefined,
  currentBunVersion: string | undefined = process.versions.bun,
): void => {
  if (!requiredRange || !currentBunVersion) return;
  const minStr = requiredRange.replace(/^>=\s*/, '');
  const min = parseSemverTuple(minStr);
  const cur = parseSemverTuple(currentBunVersion);
  if (!min || !cur) return;
  const ok =
    cur[0] > min[0] ||
    (cur[0] === min[0] && cur[1] > min[1]) ||
    (cur[0] === min[0] && cur[1] === min[1] && cur[2] >= min[2]);
  if (!ok) {
    throw new ConfigError(
      `当前 Bun 版本 (${currentBunVersion}) 低于最低要求 (${requiredRange}), 请执行 bun upgrade 升级后再运行`,
    );
  }
};

const validateAppsAndAuth = (
  apps: AppInput[],
  auth: DeployManifest['auth'],
): void => {
  if (!Array.isArray(apps) || apps.length === 0) {
    throw new ConfigError('apps 至少需要配置 1 个业务库');
  }
  const seenDbs = new Set<string>();
  for (const app of apps) {
    if (!app.db || !DB_NAME_RE.test(app.db) || RESERVED_DBS.has(app.db)) {
      throw new ConfigError(`业务库名 '${app.db}' 非法或使用了保留系统库名`);
    }
    if (seenDbs.has(app.db)) {
      throw new ConfigError(`apps 中存在重复数据库名: ${app.db}`);
    }
    seenDbs.add(app.db);
    checkAlnum(app.user, `apps[${app.db}].user`);
    if (app.password) checkAlnum(app.password, `apps[${app.db}].password`);
  }

  if (auth?.rootUsername) checkAlnum(auth.rootUsername, 'auth.rootUsername');
  if (auth?.rootPassword) checkAlnum(auth.rootPassword, 'auth.rootPassword');
  if (auth?.backupUsername)
    checkAlnum(auth.backupUsername, 'auth.backupUsername');
  if (auth?.backupPassword)
    checkAlnum(auth.backupPassword, 'auth.backupPassword');
  if (auth?.keyFile) {
    const kf = auth.keyFile.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(kf) || kf.length < 16 || kf.length > 1024) {
      throw new ConfigError('auth.keyFile 须为 16-1024 位单行 base64 字符串');
    }
  }
};

const validateSinglePodmanNode = (
  node: NodeInput,
  index: number,
  mode: DeployMode,
  networkMode: NetworkMode,
  seenNames: Set<string>,
  seenHosts: Set<string>,
): void => {
  if (node.os !== 'linux' && node.os !== 'macos') {
    throw new ConfigError(`nodes[${index}].os 只允许 linux 或 macos`);
  }
  if (networkMode === 'host' && node.os === 'macos') {
    throw new ConfigError(
      'macOS 节点运行在 Podman 虚拟机内, 不支持 networkMode=host, 请改用默认 bridge',
    );
  }
  if (
    !node.backupDir ||
    !node.backupDir.startsWith('/') ||
    node.backupDir.includes('CHANGE_ME')
  ) {
    throw new ConfigError(`nodes[${index}].backupDir 必须是目标机真实绝对路径`);
  }
  const macValidPrefix =
    node.backupDir.startsWith('/Users/') ||
    node.backupDir.startsWith('/private/');
  if (node.os === 'macos' && !macValidPrefix) {
    throw new ConfigError(
      `macOS 节点 nodes[${index}].backupDir 必须位于 /Users/ 或 /private/ 下`,
    );
  }

  const fallbackName = mode === 'single' ? 'main' : `node${index + 1}`;
  const nodeName = node.name || fallbackName;
  if (!HOST_NAME_RE.test(nodeName)) {
    throw new ConfigError(`nodes[${index}].name 非法: ${nodeName}`);
  }
  if (seenNames.has(nodeName)) {
    throw new ConfigError(`nodes 存在重复名称: ${nodeName}`);
  }
  seenNames.add(nodeName);

  const bindIp = node.bindIp ?? (mode === 'single' ? '127.0.0.1' : '');
  if (!IPV4_RE.test(bindIp)) {
    throw new ConfigError(
      `nodes[${index}].bindIp 必须是合法 IPv4 地址, 当前为 '${bindIp}'`,
    );
  }
  if (
    mode === 'replica-set' &&
    (bindIp === '127.0.0.1' || bindIp === '0.0.0.0')
  ) {
    throw new ConfigError(
      `replica-set 模式 nodes[${index}].bindIp 不能是 ${bindIp}, 请填私网或 WireGuard IP`,
    );
  }

  const fallbackHost = mode === 'single' ? '127.0.0.1' : nodeName;
  const host = node.host || fallbackHost;
  if (!HOST_NAME_RE.test(host)) {
    throw new ConfigError(`nodes[${index}].host 非法: ${host}`);
  }
  if (seenHosts.has(host)) {
    throw new ConfigError(`nodes 存在重复 host: ${host}`);
  }
  seenHosts.add(host);

  if (node.sshTarget !== undefined && node.sshTarget !== '') {
    parseSshInput(node.sshTarget, `nodes[${index}].sshTarget`);
  }
};

const validatePodmanNodes = (
  nodes: NodeInput[] | undefined,
  mode: DeployMode,
  networkMode: NetworkMode,
): void => {
  const expected = mode === 'single' ? 1 : 3;
  if (!Array.isArray(nodes) || nodes.length !== expected) {
    throw new ConfigError(`${mode} 模式需要恰好 ${expected} 个 nodes 定义`);
  }
  const seenNames = new Set<string>();
  const seenHosts = new Set<string>();
  for (let i = 0; i < nodes.length; i += 1) {
    validateSinglePodmanNode(
      nodes[i]!,
      i,
      mode,
      networkMode,
      seenNames,
      seenHosts,
    );
  }
};

export const validateManifest = (manifest: DeployManifest): string[] => {
  const warnings: string[] = [];
  const rawObj = manifest as unknown as Record<string, unknown>;

  if ('fingerprint' in rawObj) {
    throw new ConfigError(
      'fingerprint 由生成器自动生成并锁存 .codd-state/, 不得在 deploy.json 中配置 (确需换指纹请用 CLI 参数 --new-fingerprint)',
    );
  }
  if ('overrides' in rawObj) {
    throw new ConfigError(
      'overrides 不允许在 deploy.json 手写覆盖: 所有资源/缓存/连接/oplog 均须通过 hardware 公式自动推导',
    );
  }
  for (const key of Object.keys(rawObj)) {
    if (!ALLOWED_KEYS.has(key)) {
      throw new ConfigError(
        `deploy.json 包含不支持的字段: '${key}', 请参照 deploy.schema.json 检查拼写`,
      );
    }
  }

  if (!VALID_MODES.has(manifest.mode)) {
    throw new ConfigError(`不支持的 mode: ${manifest.mode}`);
  }
  if (
    !manifest.name ||
    !NAME_RE.test(manifest.name) ||
    manifest.name.length > 32
  ) {
    throw new ConfigError(
      `name 须匹配 ^[a-z0-9-]+$ 且不超过 32 字符, 当前为 '${manifest.name}'`,
    );
  }
  if (manifest.stackPrefix && !NAME_RE.test(manifest.stackPrefix)) {
    throw new ConfigError(
      `stackPrefix 须匹配 ^[a-z0-9-]+$, 当前为 '${manifest.stackPrefix}'`,
    );
  }

  const networkMode: NetworkMode = manifest.networkMode ?? 'bridge';
  if (networkMode !== 'bridge' && networkMode !== 'host') {
    throw new ConfigError(
      `networkMode 只允许 bridge 或 host, 当前为 '${String(networkMode)}'`,
    );
  }

  const port = checkPort(manifest.port ?? 27117, 'port');
  const hostPort = checkPort(manifest.hostPort ?? port, 'hostPort');
  if (WARN_PORTS.has(port) || port >= 32768) {
    warnings.push(
      `port=${port} 位于默认扫描/保留/系统临时端口区间, 推荐使用 27117`,
    );
  }
  if (hostPort !== port && manifest.mode === 'replica-set') {
    throw new ConfigError('replica-set 模式下三机 hostPort 必须与 port 一致');
  }
  if (hostPort !== port && networkMode === 'host') {
    throw new ConfigError(
      'networkMode=host 下容器直接使用宿主机网络栈, hostPort 必须与 port 一致',
    );
  }

  validateAppsAndAuth(manifest.apps, manifest.auth);

  if (manifest.mode === 'single' || manifest.mode === 'replica-set') {
    validatePodmanNodes(manifest.nodes, manifest.mode, networkMode);
  }

  return warnings;
};
