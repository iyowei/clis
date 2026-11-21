/**
 * `@iyowei/codd` 核心数据契约与配置异常定义 (`ConfigError`)。
 * 供本包校验、公式推导、状态机与 Podman/K8s 渲染器共用, 同时对外导出给 `@iyowei/codd-cli`。
 * 关键约束: 清单中的 `fingerprint` 与 `overrides` 禁止手写 (前者由 `.codd-state/` 锁存, 后者由硬件公式推导)。
 */
import type { ComputedSizing, HardwareSpec } from './formulas.ts';

export type DeployMode = 'single' | 'replica-set' | 'k8s-single' | 'k8s-rs';
export type NodeOs = 'linux' | 'macos';
export type NetworkMode = 'bridge' | 'host';
export type RotateMode = 'none' | 'apps' | 'all';

export interface AppInput {
  db: string;
  user: string;
  password?: string;
}

export interface NodeInput {
  name?: string;
  os: NodeOs;
  bindIp?: string;
  host?: string;
  sshTarget?: string;
  backupDir: string;
  stackDir?: string;
  podmanBin?: string;
}

/** 部署清单 (`deploy.json`): 描述拓扑模式、硬件规格、业务库及节点/K8s 目标参数 */
export interface DeployManifest {
  $schema?: string;
  mode: DeployMode;
  name: string;
  stackPrefix?: string;
  hardware?: HardwareSpec;
  imageName?: string;
  imageTag?: string;
  bunImage?: string;
  tz?: string;
  port?: number;
  hostPort?: number;
  rsName?: string;
  networkMode?: NetworkMode;
  multiNetAlias?: boolean;
  keepDaily?: number;
  keepWeekly?: number;
  backupMinFreeMb?: number;
  backupMaxTotalMb?: number;
  apps: AppInput[];
  auth?: {
    rootUsername?: string;
    rootPassword?: string;
    backupUsername?: string;
    backupPassword?: string;
    keyFile?: string;
    existingSecret?: string;
  };
  nodes?: NodeInput[];
  k8s?: {
    namespace?: string;
    releaseName?: string;
    storageClass?: string;
    serviceType?: 'ClusterIP' | 'NodePort';
    nodePort?: number;
    podAntiAffinity?: 'hard' | 'soft';
    existingSecret?: string;
  };
}

/** 持久化于 `.codd-state/<deployId>.state.json` 的幂等实例指纹与凭证快照 */
export interface GenerateState {
  mode: DeployMode;
  name: string;
  fingerprint: string;
  rootUsername: string;
  rootPassword: string;
  backupUsername: string;
  backupPassword: string;
  keyFile: string;
  appPasswords: Record<string, string>;
  updatedAt: string;
}

export interface GenerateOptions {
  /** 用户工作目录 (解析 deploy.json、输出 dist/ 与保存 .codd-state/ 的基准路径, 默认为 process.cwd()) */
  workDir?: string;
  /** 兼容旧版调用方的目录别名 (若未传 workDir 则回退使用 rootDir) */
  rootDir?: string;
  /** 覆盖内置模板目录路径 (供测试注入) */
  templateDir?: string;
  manifest?: DeployManifest;
  manifestPath?: string;
  outDir?: string;
  stateDir?: string;
  rotate?: RotateMode;
  newFingerprint?: boolean;
  dryRun?: boolean;
}

/** `generateBundle` 的汇总返回契约 (含推导公式、产物目录、备份目录、告警与后续步骤) */
export interface GenerateResult {
  deployId: string;
  mode: DeployMode;
  fingerprint: string;
  sizing: ComputedSizing;
  bundleDirs: string[];
  backupDirs: string[];
  stateFile: string;
  credentialsFile: string;
  warnings: string[];
  nextSteps: string[];
}

export interface ParsedSshTarget {
  target: string;
  port?: number;
  identityFile?: string;
  normalized: string;
  rsyncRshFlag: string;
}

export class ConfigError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'ConfigError';
  }
}
