/**
 * 部署清单 (`DeployManifest`) 细粒度校验与 Bun 引擎兼容性检查。
 * 上游由 `generate.ts` 调用 `validateManifest`, 细粒度函数同时被 `codd-cli` 向导单源复用;
 * 下游将 `k8s` 与 Podman `nodes` 子段校验委托给 `validate-sections.ts`。
 * 关键约束: 严禁手写 `fingerprint`/`overrides` 与白名单外字段; 硬错误抛 `ConfigError`, 软风险记入 `warnings[]`。
 */
import {
  type AppInput,
  ConfigError,
  type DeployManifest,
  type DeployMode,
  type NetworkMode,
  type NodeOs,
} from './types.ts';
import {
  validateK8sSection,
  validatePodmanNodesSection,
} from './validate-sections.ts';

const VALID_MODES = new Set(['single', 'replica-set', 'k8s-single', 'k8s-rs']);
export const RESERVED_DBS: ReadonlySet<string> = new Set([
  'admin',
  'local',
  'config',
]);
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
  'backupMinFreeMb',
  'backupMaxTotalMb',
  'apps',
  'auth',
  'nodes',
  'k8s',
]);
const ALLOWED_HARDWARE_KEYS = new Set([
  'cpuCores',
  'memoryGb',
  'diskGb',
  'workload',
  'expectedAppConnections',
]);
const ALLOWED_APP_KEYS = new Set(['db', 'user', 'password']);
const ALLOWED_AUTH_KEYS = new Set([
  'rootUsername',
  'rootPassword',
  'backupUsername',
  'backupPassword',
  'keyFile',
  'existingSecret',
]);

/** 合规 DNS-1123 标签: 首尾为小写字母或数字, 中间允许连字符 */
export const DNS_LABEL_RE = /^[a-z0-9](?:[a-z0-9-]*[a-z0-9])?$/;
/** 合规 DNS-1123 子域名 (K8s Secret / StorageClass 名称) */
export const DNS_SUBDOMAIN_RE = /^[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/;
export const IPV4_RE =
  /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
export const ALNUM_RE = /^[A-Za-z0-9]+$/;
export const DB_NAME_RE = /^[A-Za-z0-9_-]+$/;
export const SAFE_ABS_PATH_RE =
  /^\/[A-Za-z0-9._@+-]+(?:\/[A-Za-z0-9._@+-]+)*\/?$/;

const IMAGE_REF_RE = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;
const IMAGE_TAG_RE = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,127}$/;
const TZ_RE = /^[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+){0,2}$/;
const RS_NAME_RE = /^[A-Za-z0-9][A-Za-z0-9_-]{0,62}$/;

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

const isValidAlnum = (val: unknown): val is string =>
  typeof val === 'string' &&
  val.length > 0 &&
  ALNUM_RE.test(val) &&
  val !== 'CHANGE_ME';

const checkAlnum = (val: unknown, label: string): string => {
  if (!isValidAlnum(val)) {
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

/** 细粒度校验安全绝对路径 (供 CLI 向导与清单校验共用) */
export const validateSafeAbsPath = (
  val: unknown,
  nodeOs?: NodeOs,
): string | null => {
  if (
    typeof val !== 'string' ||
    !SAFE_ABS_PATH_RE.test(val) ||
    hasPathTraversal(val) ||
    val.includes('CHANGE_ME')
  ) {
    return "必须是安全的绝对路径 (以 / 开头, 不含 '..'、空格、引号或 Shell 元字符, 且不含 CHANGE_ME)";
  }
  if (
    nodeOs === 'macos' &&
    !val.startsWith('/Users/') &&
    !val.startsWith('/private/')
  ) {
    return 'macOS 节点路径必须位于 /Users/ 或 /private/ 下以便 Podman VM 挂载';
  }
  return null;
};

/** 细粒度校验单个业务库与账号配置 (供 CLI 向导与清单校验共用) */
export const validateAppInput = (app: Partial<AppInput>): string | null => {
  const db = app.db;
  if (
    typeof db !== 'string' ||
    db.length === 0 ||
    db.length > 63 ||
    !DB_NAME_RE.test(db)
  ) {
    return `业务库名 '${String(db)}' 非法 (仅允许字母、数字、下划线与连字符, 长度 1-63)`;
  }
  if (RESERVED_DBS.has(db)) {
    return `业务库名 '${db}' 使用了保留系统库名 (admin / local / config)`;
  }
  if (!isValidAlnum(app.user)) {
    return `业务库 '${db}' 的账号名必须为非空字母数字字符串, 且不能为 CHANGE_ME`;
  }
  if (app.password !== undefined && !isValidAlnum(app.password)) {
    return `业务库 '${db}' 的密码必须为非空字母数字字符串, 且不能为 CHANGE_ME`;
  }
  return null;
};

/** 细粒度校验节点 bindIp (供 CLI 向导与清单校验共用) */
export const validateNodeBindIp = (
  bindIp: unknown,
  mode: DeployMode,
): string | null => {
  if (typeof bindIp !== 'string' || !IPV4_RE.test(bindIp)) {
    return `bindIp 必须是合法 IPv4 地址, 当前为 '${String(bindIp)}'`;
  }
  if (
    mode === 'replica-set' &&
    (bindIp === '127.0.0.1' || bindIp === '0.0.0.0')
  ) {
    return `replica-set 模式 bindIp 不能是 ${bindIp}, 请填私网或 WireGuard IP`;
  }
  return null;
};

const parseSemverTuple = (ver: string): [number, number, number] | null => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)/.exec(ver.trim());
  return m ? [Number(m[1]), Number(m[2]), Number(m[3])] : null;
};

const compareSemver = (
  a: [number, number, number],
  b: [number, number, number],
): number => {
  if (a[0] !== b[0]) return a[0] - b[0];
  if (a[1] !== b[1]) return a[1] - b[1];
  return a[2] - b[2];
};

const matchesUpperBound = (
  prefix: string,
  cur: [number, number, number],
  min: [number, number, number],
): boolean => {
  if (prefix === '^') {
    if (min[0] > 0) return cur[0] === min[0];
    if (min[1] > 0) return cur[0] === 0 && cur[1] === min[1];
    return cur[0] === 0 && cur[1] === 0 && cur[2] === min[2];
  }
  if (prefix === '~') {
    return cur[0] === min[0] && cur[1] === min[1];
  }
  return true;
};

/**
 * 纯工具函数: 显式检查给定 Bun 版本是否满足目标引擎范围 (支持 `>=` / `^` / `~` 与无前缀下限, 无前缀按 `>=` 处理)。
 */
export const assertBunEngineCompatible = (
  requiredRange: string | undefined,
  currentBunVersion: string | undefined = process.versions.bun,
): void => {
  if (!requiredRange || !currentBunVersion) return;
  const trimmed = requiredRange.trim();
  const opMatch = /^(>=|\^|~)?\s*(.+)$/.exec(trimmed);
  if (!opMatch) return;
  const prefix = opMatch[1] ?? '>=';
  const min = parseSemverTuple(opMatch[2]!);
  const cur = parseSemverTuple(currentBunVersion);
  if (!min || !cur) return;

  const ok =
    compareSemver(cur, min) >= 0 && matchesUpperBound(prefix, cur, min);
  if (!ok) {
    throw new ConfigError(
      `当前 Bun 版本 (${currentBunVersion}) 不满足引擎要求 (${requiredRange}), 请执行 bun upgrade 调整版本后再运行`,
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
  for (const [k, min] of [
    ['keepDaily', 1],
    ['keepWeekly', 0],
    ['backupMinFreeMb', 0],
    ['backupMaxTotalMb', 0],
  ] as const) {
    if (m[k] !== undefined)
      checkIntRange(m[k], min, Number.MAX_SAFE_INTEGER, k);
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
    if (!isPlainObject(app)) {
      throw new ConfigError(`apps[${i}] 必须是 JSON 对象`);
    }
    checkAllowedKeys(app, ALLOWED_APP_KEYS, `apps[${i}]`);
    const appErr = validateAppInput(app as Partial<AppInput>);
    if (appErr) throw new ConfigError(appErr);
    const db = (app as unknown as AppInput).db;
    if (seenDbs.has(db)) {
      throw new ConfigError(`apps 中存在重复数据库名: ${db}`);
    }
    seenDbs.add(db);
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
    if (typeof auth.keyFile !== 'string') {
      throw new ConfigError('auth.keyFile 必须是字符串');
    }
    const kf = auth.keyFile.trim();
    if (!/^[A-Za-z0-9+/=]+$/.test(kf) || kf.length < 16 || kf.length > 1024) {
      throw new ConfigError('auth.keyFile 须为 16-1024 位单行 base64 字符串');
    }
  }
  if (auth.existingSecret !== undefined) {
    checkK8sResourceName(auth.existingSecret, 'auth.existingSecret');
  }
};

/**
 * 全量校验部署清单合法性并返回非阻断告警列表 (`warnings[]`); 任意配置违规即抛 `ConfigError`。
 *
 * 端口与网络约束: `port` 默认 27117, `hostPort` 默认同 `port`, `networkMode` 默认 `'bridge'`;
 * `replica-set` 或 `networkMode=host` 下要求 `hostPort === port`; 命中 27017-27019 或 `>= 32768` 记告警。
 *
 * ### 数据流转示例
 * ```text
 * Input:  manifest = { mode: 'single', name: 'app', port: 27017,
 *                      apps: [{ db: 'shop', user: 'shopuser' }],
 *                      nodes: [{ os: 'linux', backupDir: '/home/ops/srv/backups' }] }
 * Step 1: 拦截手写 fingerprint/overrides -> 顶层字段白名单 -> 校验 mode/name/标量字段/port 范围
 * Step 2: validateAppsAndAuth 校验业务库名 (非 admin/local/config 且无重复) 与 auth 凭证字符集
 * Step 3: validateK8sSection + validatePodmanNodesSection (single 恰 1 节点, 校验路径/IP/SSH)
 * Output: warnings = ['port=27017 位于默认扫描/保留/系统临时端口区间, 推荐使用 27117']
 * ```
 */
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
  if (manifest.hardware !== undefined) {
    if (!isPlainObject(manifest.hardware)) {
      throw new ConfigError('hardware 必须是 JSON 对象');
    }
    checkAllowedKeys(manifest.hardware, ALLOWED_HARDWARE_KEYS, 'hardware');
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
  const sectionValidators = {
    dnsLabelRe: DNS_LABEL_RE,
    dnsSubdomainRe: DNS_SUBDOMAIN_RE,
    validateSafeAbsPath,
    validateNodeBindIp,
  };
  validateK8sSection(manifest.k8s, sectionValidators);
  if (manifest.mode === 'single' || manifest.mode === 'replica-set') {
    validatePodmanNodesSection({
      nodes: manifest.nodes,
      mode: manifest.mode,
      networkMode,
      port,
      hostPort,
      warnings,
      validators: sectionValidators,
    });
  }

  return warnings;
};
