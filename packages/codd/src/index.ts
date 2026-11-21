/**
 * `@iyowei/codd` 核心引擎公共导出入口: 供 `@iyowei/codd-cli` 与编程式调用方消费。
 * 统一汇聚模板资产定位、硬件资源公式、部署清单校验、SSH 解析、幂等凭证状态机、
 * 严格模板渲染与 `generateBundle` 编排入口, 保持单一事实来源。
 */
export {
  ASSET_CARRIERS,
  copyTemplateFile,
  readPackageVersion,
  readTemplateFile,
  resolvePackageRoot,
  resolveTemplateFilePath,
  resolveTemplateRoot,
} from './assets.ts';
export {
  type ComputedSizing,
  HARDWARE_BOUNDS,
  computeSizing,
  digitalRoot,
  type FormulaStep,
  type HardwareSpec,
  recommendSafePort,
  SizingError,
  type WorkloadType,
} from './formulas.ts';
export { generateBundle } from './generate.ts';
export { renderTemplate, TemplateRenderError } from './render.ts';
export {
  deriveRemoteHome,
  parseSshInput,
  resolveServerBackupDir,
  resolveServerStackDir,
} from './ssh.ts';
export {
  loadOrUpdateState,
  prepareStateDir,
  randomAlnumSecret,
  randomFingerprint,
  randomKeyFile,
  withStateLock,
} from './state.ts';
export {
  type AppInput,
  ConfigError,
  type DeployManifest,
  type DeployMode,
  type GenerateOptions,
  type GenerateResult,
  type GenerateState,
  type NetworkMode,
  type NodeInput,
  type NodeOs,
  type ParsedSshTarget,
  type RotateMode,
} from './types.ts';
export {
  ALNUM_RE,
  DB_NAME_RE,
  DNS_LABEL_RE,
  DNS_SUBDOMAIN_RE,
  IPV4_RE,
  RESERVED_DBS,
  SAFE_ABS_PATH_RE,
  assertBunEngineCompatible,
  validateAppInput,
  validateManifest,
  validateNodeBindIp,
  validateSafeAbsPath,
} from './validate.ts';
