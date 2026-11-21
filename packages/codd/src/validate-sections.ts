/**
 * 清单子段内部校验器: 由 `validate.ts` 委托调用, 负责 Kubernetes (`k8s`) 与 Podman (`nodes`) 子段校验。
 * 依赖 `ssh.ts` 校验 `sshTarget`, 复用 `validate.ts` 注入的正则与路径/IP 校验函数。
 * 关键约束: `single` 恰 1 节点、`replica-set` 恰 3 节点且禁重复 `name`/`host`/`bindIp`;
 * macOS 节点禁 `networkMode=host`, 且 `backupDir` 须位于 `/Users/` 或 `/private/` 下 (`stackDir` 仅验安全绝对路径)。
 */
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

const validateSinglePodmanNode = (
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
    const stackErr = ctx.validators.validateSafeAbsPath(node.stackDir);
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
    if (ctx.networkMode === 'host') {
      ctx.warnings.push(
        `安全告警: nodes[${index}] 在 networkMode=host 下显式配置 bindIp=0.0.0.0, MongoDB 将在宿主机全部网卡 (含公网) 监听 ${ctx.port} 端口, 请务必通过防火墙/安全组收紧来源 IP`,
      );
    } else {
      ctx.warnings.push(
        `安全提醒: nodes[${index}] 显式绑定 bindIp=0.0.0.0, 请确认已在宿主机防火墙/安全组限制 ${ctx.hostPort} 端口仅对受信任网段开放`,
      );
    }
  }

  const host = node.host ?? (ctx.mode === 'single' ? '127.0.0.1' : nodeName);
  checkPattern(host, HOST_NAME_RE, `nodes[${index}].host`);
  if (ctx.seenHosts.has(host)) {
    throw new ConfigError(`nodes 存在重复 host: ${host}`);
  }
  ctx.seenHosts.add(host);

  if (node.sshTarget !== undefined && node.sshTarget !== '') {
    if (typeof node.sshTarget !== 'string') {
      throw new ConfigError(`nodes[${index}].sshTarget 必须为字符串`);
    }
    parseSshInput(node.sshTarget, `nodes[${index}].sshTarget`);
  }
};

/** 校验 Podman `nodes` 数量 (`single`=1, `replica-set`=3)、各节点安全路径/唯一标识/IP/SSH, 并将 `0.0.0.0` 风险记入 `warnings` */
export const validatePodmanNodesSection = (
  input: PodmanNodesValidateInput,
): void => {
  const expected = input.mode === 'single' ? 1 : 3;
  if (!Array.isArray(input.nodes) || input.nodes.length !== expected) {
    throw new ConfigError(
      `${input.mode} 模式需要恰好 ${expected} 个 nodes 定义`,
    );
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
  }
};
