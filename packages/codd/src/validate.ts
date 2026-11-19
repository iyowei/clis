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

const VALID_MODES = new Set(['single', 'replica-set', 'k8s-single', 'k8s-rs']);
const RESERVED_DBS = new Set(['admin', 'local', 'config']);
const WARN_PORTS = new Set([27017, 27018, 27019]);

const ALLOWED_KEYS = new Set([
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
const ALLOWED_AUTH_KEYS = new Set([
  'rootUsername',
  'rootPassword',
  'backupUsername',
  'backupPassword',
  'keyFile',
  'existingSecret',
]);
const ALLOWED_K8S_KEYS = new Set([
  'namespace',
  'releaseName',
  'storageClass',
  'serviceType',
  'nodePort',
  'podAntiAffinity',
  'existingSecret',
]);

/** 合规 DNS-1123 标签: 首尾为小写字母或数字, 中间允许连字符 */
export const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** 合规 DNS-1123 子域名 (K8s Secret / StorageClass 名称) */
export const DNS_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;

const ALNUM_RE = /^[A-Za-z0-9]+$/;
const DB_NAME_RE = /^[A-Za-z0-9_-]+$/;
const HOST_NAME_RE = /^[A-Za-z0-9._-]+$/;
const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TZ_RE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const RS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;
const SAFE_ABS_PATH_RE = /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;
const PODMAN_BIN_RE =
  /^(?:[A-Za-z0-9._-]+|\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*)$/;

const isPlainObject = (val: unknown): val is Record<string, unknown> =>
  val !== null && typeof val === 'object' && !Array.isArray(val);

const hasPathTraversal = (p: string): boolean => p.split('/').includes('..');

const checkAllowedKeys = (
  obj: Record<string, unknown>,
  allowed: Set<string>,
  scope: string,
): void => {
  for (const key of Object.keys(obj)) {
    if (!allowed.has(key)) {
      throw new ConfigError(`${scope} 包含不支持的字段: '${key}'`);
    }
  }
};

const checkAlnum = (val: unknown, label: string): string => {
  if (
    typeof val !== 'string' ||
    val.length === 0 ||
    !ALNUM_RE.test(val) ||
    val === 'CHANGE_ME'
  ) {
    throw new ConfigError(
      `${label} 必须为非空字母数字字符串, 且不能为 CHANGE_ME`,
    );
  }
  return val;
};

const checkIntRange = (
  val: unknown,
  min: number,
  max: number,
  label: string,
): number => {
  if (
    typeof val !== 'number' ||
    !Number.isInteger(val) ||
    val < min ||
    val > max
  ) {
    throw new ConfigError(
      `${label} 必须为 ${min}-${max} 之间的整数, 当前为 ${String(val)}`,
    );
  }
  return val;
};

const checkPattern = (
  val: unknown,
  re: RegExp,
  label: string,
  forbidDotDot = false,
): string => {
  if (
    typeof val !== 'string' ||
    !re.test(val) ||
    (forbidDotDot && val.includes('..'))
  ) {
    throw new ConfigError(`${label} 格式非法或含不允许字符: '${String(val)}'`);
  }
  return val;
};

const checkDnsLabel = (val: unknown, label: string, maxLen: number): string => {
  if (
    typeof val !== 'string' ||
    val.length === 0 ||
    val.length > maxLen ||
    !DNS_LABEL_RE.test(val)
  ) {
    throw new ConfigError(
      `${label} 须为合规 DNS-1123 标签 (仅小写字母、数字和中间连字符, <= ${maxLen} 字符), 当前为 '${String(val)}'`,
    );
  }
  return val;
};

const checkK8sResourceName = (val: unknown, label: string): void => {
  if (typeof val !== 'string') throw new ConfigError(`${label} 必须为字符串`);
  if (val === '') return;
  if (val.length > 253 || !DNS_SUBDOMAIN_RE.test(val)) {
    throw new ConfigError(
      `${label} 须为合规 Kubernetes 资源名 (小写字母、数字、点或连字符, <= 253 字符), 当前为 '${val}'`,
    );
  }
};

const checkSafeAbsPath = (val: unknown, label: string): string => {
  if (
    typeof val !== 'string' ||
    !SAFE_ABS_PATH_RE.test(val) ||
    hasPathTraversal(val) ||
    val.includes('CHANGE_ME')
  ) {
    throw new ConfigError(
      `${label} 必须是安全的绝对路径 (不含 '..'、空格、引号或 Shell 元字符, 且不含 CHANGE_ME)`,
    );
  }
  return val;
};

const parseSemverTuple = (ver: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

/**
 * 纯工具函数: 显式检查给定 Bun 版本是否满足目标引擎下限。
 * 注意: generateBundle 不应拿容器工具镜像的 engines.bun 去阻断本机宿主运行生成器。
 */
export const assertBunEngineCompatible = (
  requiredRange: string | undefined,
  currentBunVersion: string | undefined = process.versions.bun,
): void => {
  if (!requiredRange || !currentBunVersion) return;
  const min = parseSemverTuple(requiredRange.replace(/^>=\s*/, ''));
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

const validateScalarFields = (m: DeployManifest): void => {
  if (m.imageName !== undefined)
    checkPattern(m.imageName, IMAGE_REF_RE, 'imageName', true);
  if (m.imageTag !== undefined)
    checkPattern(m.imageTag, IMAGE_TAG_RE, 'imageTag');
  if (m.bunImage !== undefined)
    checkPattern(m.bunImage, IMAGE_REF_RE, 'bunImage', true);
  if (m.tz !== undefined) checkPattern(m.tz, TZ_RE, 'tz');
  if (m.rsName !== undefined) checkPattern(m.rsName, RS_NAME_RE, 'rsName');
  if (m.keepDaily !== undefined) {
    checkIntRange(m.keepDaily, 1, Number.MAX_SAFE_INTEGER, 'keepDaily');
  }
  if (m.keepWeekly !== undefined) {
    checkIntRange(m.keepWeekly, 0, Number.MAX_SAFE_INTEGER, 'keepWeekly');
  }
  if (m.multiNetAlias !== undefined && typeof m.multiNetAlias !== 'boolean') {
    throw new ConfigError('multiNetAlias 必须为布尔值 (true 或 false)');
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
  for (let i = 0; i < apps.length; i += 1) {
    const app = apps[i];
    if (!isPlainObject(app))
      throw new ConfigError(`apps[${i}] 必须是 JSON 对象`);
    const db = app.db;
    if (
      typeof db !== 'string' ||
      !DB_NAME_RE.test(db) ||
      RESERVED_DBS.has(db)
    ) {
      throw new ConfigError(
        `业务库名 '${String(db)}' 非法或使用了保留系统库名`,
      );
    }
    if (seenDbs.has(db))
      throw new ConfigError(`apps 中存在重复数据库名: ${db}`);
    seenDbs.add(db);
    checkAlnum(app.user, `apps[${db}].user`);
    if (app.password !== undefined)
      checkAlnum(app.password, `apps[${db}].password`);
  }

  if (auth === undefined) return;
  if (!isPlainObject(auth)) throw new ConfigError('auth 必须是 JSON 对象');
  checkAllowedKeys(auth, ALLOWED_AUTH_KEYS, 'auth');

  const authAlnumKeys = [
    'rootUsername',
    'rootPassword',
    'backupUsername',
    'backupPassword',
  ] as const;
  for (const key of authAlnumKeys) {
    if (auth[key] !== undefined) checkAlnum(auth[key], `auth.${key}`);
  }
  if (auth.keyFile !== undefined && auth.keyFile !== '') {
    if (typeof auth.keyFile !== 'string')
      throw new ConfigError('auth.keyFile 必须是字符串');
    const kf = auth.keyFile.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(kf) || kf.length < 16 || kf.length > 1024) {
      throw new ConfigError('auth.keyFile 须为 16-1024 位单行 base64 字符串');
    }
  }
  if (auth.existingSecret !== undefined) {
    checkK8sResourceName(auth.existingSecret, 'auth.existingSecret');
  }
};

const validateK8sConfig = (k8s: DeployManifest['k8s']): void => {
  if (k8s === undefined) return;
  if (!isPlainObject(k8s)) throw new ConfigError('k8s 必须是 JSON 对象');
  checkAllowedKeys(k8s, ALLOWED_K8S_KEYS, 'k8s');

  if (k8s.namespace !== undefined)
    checkDnsLabel(k8s.namespace, 'k8s.namespace', 63);
  if (k8s.releaseName !== undefined)
    checkDnsLabel(k8s.releaseName, 'k8s.releaseName', 53);
  if (k8s.storageClass !== undefined)
    checkK8sResourceName(k8s.storageClass, 'k8s.storageClass');
  if (
    k8s.serviceType !== undefined &&
    k8s.serviceType !== 'ClusterIP' &&
    k8s.serviceType !== 'NodePort'
  ) {
    throw new ConfigError(
      `k8s.serviceType 只允许 ClusterIP 或 NodePort, 当前为 '${String(k8s.serviceType)}'`,
    );
  }
  if (k8s.nodePort !== undefined)
    checkIntRange(k8s.nodePort, 30000, 32767, 'k8s.nodePort');
  if (
    k8s.podAntiAffinity !== undefined &&
    k8s.podAntiAffinity !== 'hard' &&
    k8s.podAntiAffinity !== 'soft'
  ) {
    throw new ConfigError(
      `k8s.podAntiAffinity 只允许 hard 或 soft, 当前为 '${String(k8s.podAntiAffinity)}'`,
    );
  }
  if (k8s.existingSecret !== undefined) {
    checkK8sResourceName(k8s.existingSecret, 'k8s.existingSecret');
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
  if (!isPlainObject(node))
    throw new ConfigError(`nodes[${index}] 必须是 JSON 对象`);
  if (node.os !== 'linux' && node.os !== 'macos') {
    throw new ConfigError(`nodes[${index}].os 只允许 linux 或 macos`);
  }
  if (networkMode === 'host' && node.os === 'macos') {
    throw new ConfigError(
      'macOS 节点运行在 Podman 虚拟机内, 不支持 networkMode=host, 请改用默认 bridge',
    );
  }
  const backupDir = checkSafeAbsPath(
    node.backupDir,
    `nodes[${index}].backupDir`,
  );
  if (
    node.os === 'macos' &&
    !backupDir.startsWith('/Users/') &&
    !backupDir.startsWith('/private/')
  ) {
    throw new ConfigError(
      `macOS 节点 nodes[${index}].backupDir 必须位于 /Users/ 或 /private/ 下`,
    );
  }
  if (node.stackDir !== undefined)
    checkSafeAbsPath(node.stackDir, `nodes[${index}].stackDir`);
  if (node.podmanBin !== undefined) {
    if (
      typeof node.podmanBin !== 'string' ||
      !PODMAN_BIN_RE.test(node.podmanBin) ||
      hasPathTraversal(node.podmanBin)
    ) {
      throw new ConfigError(
        `nodes[${index}].podmanBin 必须为安全的命令名或绝对路径 (不含 '..' 与 Shell 元字符)`,
      );
    }
  }

  const nodeName =
    node.name ?? (mode === 'single' ? 'main' : `node${index + 1}`);
  checkPattern(nodeName, HOST_NAME_RE, `nodes[${index}].name`);
  if (seenNames.has(nodeName))
    throw new ConfigError(`nodes 存在重复名称: ${nodeName}`);
  seenNames.add(nodeName);

  const bindIp = node.bindIp ?? (mode === 'single' ? '127.0.0.1' : '');
  if (typeof bindIp !== 'string' || !IPV4_RE.test(bindIp)) {
    throw new ConfigError(
      `nodes[${index}].bindIp 必须是合法 IPv4 地址, 当前为 '${String(bindIp)}'`,
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

  const host = node.host ?? (mode === 'single' ? '127.0.0.1' : nodeName);
  checkPattern(host, HOST_NAME_RE, `nodes[${index}].host`);
  if (seenHosts.has(host))
    throw new ConfigError(`nodes 存在重复 host: ${host}`);
  seenHosts.add(host);

  if (node.sshTarget !== undefined && node.sshTarget !== '') {
    if (typeof node.sshTarget !== 'string') {
      throw new ConfigError(`nodes[${index}].sshTarget 必须为字符串`);
    }
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
  if (!isPlainObject(manifest)) {
    throw new ConfigError('deploy.json 顶层必须是 JSON 对象');
  }
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
  checkAllowedKeys(rawObj, ALLOWED_KEYS, 'deploy.json');

  if (typeof manifest.mode !== 'string' || !VALID_MODES.has(manifest.mode)) {
    throw new ConfigError(`不支持的 mode: ${String(manifest.mode)}`);
  }
  checkDnsLabel(manifest.name, 'name', 32);
  if (manifest.stackPrefix !== undefined) {
    checkDnsLabel(manifest.stackPrefix, 'stackPrefix', 32);
  }
  validateScalarFields(manifest);

  const networkMode: NetworkMode = manifest.networkMode ?? 'bridge';
  if (networkMode !== 'bridge' && networkMode !== 'host') {
    throw new ConfigError(
      `networkMode 只允许 bridge 或 host, 当前为 '${String(networkMode)}'`,
    );
  }

  const port = checkIntRange(manifest.port ?? 27117, 1024, 65535, 'port');
  const hostPort = checkIntRange(
    manifest.hostPort ?? port,
    1024,
    65535,
    'hostPort',
  );
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
  validateK8sConfig(manifest.k8s);
  if (manifest.mode === 'single' || manifest.mode === 'replica-set') {
    validatePodmanNodes(manifest.nodes, manifest.mode, networkMode);
  }

  return warnings;
};
