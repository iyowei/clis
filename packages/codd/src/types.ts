/**
 * @iyowei/codd 核心数据契约与配置异常定义。
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
