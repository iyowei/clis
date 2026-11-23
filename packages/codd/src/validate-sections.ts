/**
 * 清单子段内部校验器: 由 `validate.ts` 委托调用, 负责 `hardware`、Kubernetes (`k8s`) 与 Podman (`nodes`) 子段校验。
 * 依赖 `formulas.ts` (`HARDWARE_BOUNDS`) 与 `ssh.ts` 校验 `sshTarget`, 复用 `validate.ts` 注入的正则与路径/IP 校验函数。
 * 关键约束: `single` 恰 1 节点、`replica-set` 恰 3 节点且禁重复 `name`/`host`/`bindIp`;
 * macOS 节点禁 `networkMode=host`, 且 `backupDir` 与 `stackDir` 均执行安全绝对路径及系统核心目录黑名单校验。
 */
import { HARDWARE_BOUNDS } from './formulas.ts';
import { parseSshInput } from './ssh.ts';
import {
  ConfigError,
  type DeployManifest,
  type DeployMode,
  type NetworkMode,
  type NodeInput,
  type NodeOs,
} from './types.ts';

export interface SectionValidators {
  dnsLabelRe: RegExp;
  dnsSubdomainRe: RegExp;
  validateSafeAbsPath: (val: unknown, nodeOs?: NodeOs) => string | null;
  validateNodeBindIp: (bindIp: unknown, mode: DeployMode) => string | null;
}

const ALLOWED_HARDWARE_KEYS = new Set([
  'cpuCores',
  'memoryGb',
  'diskGb',
  'workload',
  'expectedAppConnections',
]);
const ALLOWED_NODE_KEYS = new Set([
  'name',
  'os',
  'bindIp',
  'host',
  'sshTarget',
  'backupDir',
  'stackDir',
  'podmanBin',
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

const HOST_NAME_RE = /^[A-Za-z0-9._-]+$/;
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

const checkDnsLabel = (
  val: unknown,
  label: string,
  maxLen: number,
  re: RegExp,
): string => {
  if (
    typeof val !== 'string' ||
    val.length === 0 ||
    val.length > maxLen ||
    !re.test(val)
  ) {
    throw new ConfigError(
      `${label} 须为合规 DNS-1123 标签 (仅小写字母、数字和中间连字符, <= ${maxLen} 字符), 当前为 '${String(val)}'`,
    );
  }
  return val;
};

const checkK8sResourceName = (
  val: unknown,
  label: string,
  re: RegExp,
): void => {
  if (typeof val !== 'string') throw new ConfigError(`${label} 必须为字符串`);
  if (val === '') return;
  if (val.length > 253 || !re.test(val)) {
    throw new ConfigError(
      `${label} 须为合规 Kubernetes 资源名 (小写字母、数字、点或连字符, <= 253 字符), 当前为 '${val}'`,
    );
  }
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

const checkPattern = (val: unknown, re: RegExp, label: string): string => {
  if (typeof val !== 'string' || !re.test(val)) {
    throw new ConfigError(`${label} 格式非法或含不允许字符: '${String(val)}'`);
  }
  return val;
};

const VALID_WORKLOADS = new Set(['balanced', 'write-heavy', 'read-heavy']);

const checkFiniteRange = (
  val: unknown,
  min: number,
  max: number,
  label: string,
): void => {
  if (
    typeof val !== 'number' ||
    !Number.isFinite(val) ||
    val < min ||
    val > max
  ) {
    throw new ConfigError(
      `${label} 必须为 ${min}-${max} 之间的有限数字, 当前为 ${String(val)}`,
    );
  }
};

/** 校验可选 `hardware` 对象字段白名单、必填数值边界 (`HARDWARE_BOUNDS`)、`workload` 枚举与 `expectedAppConnections` 正整数约束 */
export const validateHardwareSection = (hardware: unknown): void => {
  if (hardware === undefined) return;
  if (!isPlainObject(hardware)) {
    throw new ConfigError('hardware 必须是 JSON 对象');
  }
  checkAllowedKeys(hardware, ALLOWED_HARDWARE_KEYS, 'hardware');
  const { cpuCores: cpuB, memoryGb: memB, diskGb: diskB } = HARDWARE_BOUNDS;
  checkFiniteRange(hardware.cpuCores, cpuB.min, cpuB.max, 'hardware.cpuCores');
  checkFiniteRange(hardware.memoryGb, memB.min, memB.max, 'hardware.memoryGb');
  checkFiniteRange(hardware.diskGb, diskB.min, diskB.max, 'hardware.diskGb');
  if (
    hardware.workload !== undefined &&
    (typeof hardware.workload !== 'string' ||
      !VALID_WORKLOADS.has(hardware.workload))
  ) {
    throw new ConfigError(
      `hardware.workload 只允许 balanced、write-heavy 或 read-heavy, 当前为 '${String(hardware.workload)}'`,
    );
  }
  if (
    hardware.expectedAppConnections !== undefined &&
    (typeof hardware.expectedAppConnections !== 'number' ||
      !Number.isSafeInteger(hardware.expectedAppConnections) ||
      hardware.expectedAppConnections < 1)
  ) {
    throw new ConfigError(
      `hardware.expectedAppConnections 须为 1-${Number.MAX_SAFE_INTEGER} 之间的安全整数, 当前为 ${String(hardware.expectedAppConnections)}`,
    );
  }
};

/** 校验 `k8s` 子段字段白名单、DNS 标签/资源名、`serviceType`/`nodePort` (30000-32767) 与反亲和策略 */
export const validateK8sSection = (
  k8s: DeployManifest['k8s'],
  validators: SectionValidators,
): void => {
  if (k8s === undefined) return;
  if (!isPlainObject(k8s)) throw new ConfigError('k8s 必须是 JSON 对象');
  checkAllowedKeys(k8s, ALLOWED_K8S_KEYS, 'k8s');

  if (k8s.namespace !== undefined)
    checkDnsLabel(k8s.namespace, 'k8s.namespace', 63, validators.dnsLabelRe);
  if (k8s.releaseName !== undefined)
    checkDnsLabel(
      k8s.releaseName,
      'k8s.releaseName',
      50,
      validators.dnsLabelRe,
    );
  if (k8s.storageClass !== undefined)
    checkK8sResourceName(
      k8s.storageClass,
      'k8s.storageClass',
      validators.dnsSubdomainRe,
    );
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
    checkK8sResourceName(
      k8s.existingSecret,
      'k8s.existingSecret',
      validators.dnsSubdomainRe,
    );
  }
};

export interface PodmanNodesValidateInput {
  nodes: NodeInput[] | undefined;
  mode: DeployMode;
  networkMode: NetworkMode;
  port: number;
  hostPort: number;
  warnings: string[];
  validators: SectionValidators;
}

interface PodmanNodeScanCtx {
  mode: DeployMode;
  networkMode: NetworkMode;
  port: number;
  hostPort: number;
  seenNames: Set<string>;
  seenHosts: Set<string>;
  seenBindIps: Set<string>;
  warnings: string[];
  validators: SectionValidators;
}

const isJsonDeepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a) && Array.isArray(b)) {
    if (a.length !== b.length) return false;
    return a.every((item, idx) => isJsonDeepEqual(item, b[idx]));
  }
  if (!isPlainObject(a) || !isPlainObject(b)) return false;
  const keysA = Object.keys(a);
  const keysB = Object.keys(b);
  if (keysA.length !== keysB.length) return false;
  return keysA.every((k) => Object.hasOwn(b, k) && isJsonDeepEqual(a[k], b[k]));
};

const validateNodeSshTarget = (sshTarget: unknown, index: number): void => {
  if (sshTarget === undefined || sshTarget === '') return;
  if (typeof sshTarget !== 'string') {
    throw new ConfigError(`nodes[${index}].sshTarget 必须为字符串`);
  }
  parseSshInput(sshTarget, `nodes[${index}].sshTarget`);
};

const validateNodeCommonFields = (
  node: NodeInput,
  index: number,
  ctx: PodmanNodeScanCtx,
): void => {
  if (!isPlainObject(node)) {
    throw new ConfigError(`nodes[${index}] 必须是 JSON 对象`);
  }
  checkAllowedKeys(node, ALLOWED_NODE_KEYS, `nodes[${index}]`);
  if (node.os !== 'linux' && node.os !== 'macos') {
    throw new ConfigError(`nodes[${index}].os 只允许 linux 或 macos`);
  }
  if (ctx.networkMode === 'host' && node.os === 'macos') {
    throw new ConfigError(
      'macOS 节点运行在 Podman 虚拟机内, 不支持 networkMode=host, 请改用默认 bridge',
    );
  }
  const backupErr = ctx.validators.validateSafeAbsPath(node.backupDir, node.os);
  if (backupErr)
    throw new ConfigError(`nodes[${index}].backupDir ${backupErr}`);
  if (node.stackDir !== undefined) {
    const stackErr = ctx.validators.validateSafeAbsPath(node.stackDir, node.os);
    if (stackErr) throw new ConfigError(`nodes[${index}].stackDir ${stackErr}`);
  }
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
};

const validateSinglePodmanNode = (
  node: NodeInput,
  index: number,
  ctx: PodmanNodeScanCtx,
): void => {
  validateNodeCommonFields(node, index, ctx);
  const isPodmanMode = ctx.mode === 'single' || ctx.mode === 'replica-set';
  if (!isPodmanMode) {
    if (node.name !== undefined) {
      checkPattern(node.name, HOST_NAME_RE, `nodes[${index}].name`);
    }
    if (node.bindIp !== undefined) {
      const bindIpErr = ctx.validators.validateNodeBindIp(
        node.bindIp,
        ctx.mode,
      );
      if (bindIpErr) throw new ConfigError(`nodes[${index}].${bindIpErr}`);
    }
    if (node.host !== undefined) {
      checkPattern(node.host, HOST_NAME_RE, `nodes[${index}].host`);
    }
    validateNodeSshTarget(node.sshTarget, index);
    return;
  }

  const nodeName =
    node.name ?? (ctx.mode === 'single' ? 'main' : `node${index + 1}`);
  checkPattern(nodeName, HOST_NAME_RE, `nodes[${index}].name`);
  if (ctx.seenNames.has(nodeName)) {
    throw new ConfigError(`nodes 存在重复名称: ${nodeName}`);
  }
  ctx.seenNames.add(nodeName);

  const bindIp = node.bindIp ?? (ctx.mode === 'single' ? '127.0.0.1' : '');
  const bindIpErr = ctx.validators.validateNodeBindIp(bindIp, ctx.mode);
  if (bindIpErr) throw new ConfigError(`nodes[${index}].${bindIpErr}`);
  if (ctx.mode === 'replica-set') {
    if (ctx.seenBindIps.has(bindIp)) {
      throw new ConfigError(
        `replica-set 模式 nodes 存在重复 bindIp: ${bindIp}`,
      );
    }
    ctx.seenBindIps.add(bindIp);
    if (node.os === 'macos') {
      ctx.warnings.push(
        `跨平台提醒: nodes[${index}] 为 macOS 节点且配置 bindIp=${bindIp}, Podman VM 通过 gvproxy 转发端口, 绑定宿主机 VPN/非默认接口特定 IP 易触发 cannot assign requested address; 若遇启动绑定失败, 请改用 Linux 节点、为 lo0 配置接口别名或改由可信内网防火墙保护的 0.0.0.0`,
      );
    }
  }
  if (bindIp === '0.0.0.0') {
    const warnMsg =
      ctx.networkMode === 'host'
        ? `安全告警: nodes[${index}] 在 networkMode=host 下显式配置 bindIp=0.0.0.0, MongoDB 将在宿主机全部网卡 (含公网) 监听 ${ctx.port} 端口, 请务必通过防火墙/安全组收紧来源 IP`
        : `安全提醒: nodes[${index}] 显式绑定 bindIp=0.0.0.0, 请确认已在宿主机防火墙/安全组限制 ${ctx.hostPort} 端口仅对受信任网段开放`;
    ctx.warnings.push(warnMsg);
  }

  const host = node.host ?? (ctx.mode === 'single' ? '127.0.0.1' : nodeName);
  checkPattern(host, HOST_NAME_RE, `nodes[${index}].host`);
  if (ctx.seenHosts.has(host)) {
    throw new ConfigError(`nodes 存在重复 host: ${host}`);
  }
  ctx.seenHosts.add(host);

  validateNodeSshTarget(node.sshTarget, index);
};

/** 校验 `nodes` 数量 (`single`=1, `replica-set`=3; `k8s-*` 显式传入时校验数组元素合法性但不限个数) 与各节点安全路径/唯一性/IP/SSH */
export const validatePodmanNodesSection = (
  input: PodmanNodesValidateInput,
): void => {
  const isPodmanMode = input.mode === 'single' || input.mode === 'replica-set';
  if (isPodmanMode) {
    const expected = input.mode === 'single' ? 1 : 3;
    if (!Array.isArray(input.nodes) || input.nodes.length !== expected) {
      throw new ConfigError(
        `${input.mode} 模式需要恰好 ${expected} 个 nodes 定义`,
      );
    }
  } else {
    if (input.nodes === undefined) return;
    if (!Array.isArray(input.nodes)) {
      throw new ConfigError('nodes 必须是 JSON 数组');
    }
  }
  const ctx: PodmanNodeScanCtx = {
    mode: input.mode,
    networkMode: input.networkMode,
    port: input.port,
    hostPort: input.hostPort,
    seenNames: new Set<string>(),
    seenHosts: new Set<string>(),
    seenBindIps: new Set<string>(),
    warnings: input.warnings,
    validators: input.validators,
  };
  for (let i = 0; i < input.nodes.length; i += 1) {
    validateSinglePodmanNode(input.nodes[i]!, i, ctx);
    for (let j = 0; j < i; j += 1) {
      if (isJsonDeepEqual(input.nodes[j], input.nodes[i])) {
        throw new ConfigError(
          `nodes 中存在完全重复的节点定义 (索引 ${j} 与 ${i})`,
        );
      }
    }
  }
};
