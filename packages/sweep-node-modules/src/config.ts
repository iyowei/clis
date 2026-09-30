/**
 * 配置定位与装载: 三级覆盖 (旗标 > 环境变量 > 平台默认) 与三态装载 (ok / absent / 损坏)。
 * 平台 / 环境变量表 / 家目录均可注入, 供测试在任意宿主上跑平台矩阵 (设计: 分册「配置与初始化」)。
 */
import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { posix, win32 } from 'node:path';

import { SweepError } from './errors.ts';

export interface Config {
  /** 扫描根, 任意多个 */
  roots: string[];
  /** 排除名单: 从根到命中点的任意一级目录名命中即跳过; 配置文件省略该字段时取 DEFAULT_EXCLUDE */
  exclude: string[];
  /** 包含名单 (白名单): 从根到 node_modules 的任意一级目录名命中才纳入; 空数组 = 不过滤 */
  include: string[];
}

/**
 * 默认排除名单 (保守基线): 已知的包管理器 / 版本管理器安装树、编辑器扩展目录与系统 / 应用数据根。
 * 这些目录下的 node_modules 是工具自身的安装树 (全局包树、npx 缓存、扩展依赖), 删除后无法由
 * 项目级重装恢复 — 安全审计确证 ADR 0002 的「可恢复, 非数据损失」前提在此类目标上不成立
 * (实测: `~/.bun/install/global` 4.25 GB / 1627 包, 且本工具自身即装于其中; 版本管理器的
 * `lib/node_modules` 是用户全局包清单的唯一所在; 编辑器扩展目录逐个自带 node_modules)。
 *
 * 语义与用户写的名单完全一致 (任意一级目录名命中即跳过), 只是默认值不再为空; 生效与覆盖规则:
 * - 配置文件省略 `exclude` 字段时取本名单; 显式写出该字段 (含写空数组) 即以用户名单为准;
 * - `init` 向导的排除一问以本名单为默认回填, 用户所见即所得;
 * - 名单项在本次扫描零命中时不告警 (静默规则见 CLI 包 cli.ts 的 collectNameNotes): 名单依平台与用户
 *   环境而异, 逐项告警必然刷屏且无行动价值, 与用户手写名字拼错的情况不同。
 *
 * 保守取向: 宁可挡住个别同名的真实项目 (用户可从配置中删除该项), 也不漏放安装树。
 */
export const DEFAULT_EXCLUDE: readonly string[] = [
  // 包管理器 / 版本管理器的安装树与缓存: 全局包树、npx 缓存与 store 删后无法由项目级重装恢复
  '.bun',
  '.npm',
  '.pnpm-store',
  '.yarn',
  '.nvm',
  'nvm',
  '.fnm',
  '.volta',
  '.asdf',
  '.n',
  // 编辑器 / IDE 的扩展目录: 每个扩展自带 node_modules, 属应用自身而非用户项目
  '.vscode',
  '.vscode-insiders',
  '.vscode-server',
  '.cursor',
  '.antigravity',
  // 系统与应用数据根 / XDG 根: 其下散落工具私有安装树 (macOS 的 Library 含 fnm 与各应用插件)
  'Library',
  '.local',
  '.config',
  '.cache',
  '.claude',
];

/** 配置路径来源 */
export type ConfigSource = 'flag' | 'env' | 'platform-default';

/** 环境变量表 (注入; 生产默认 process.env) */
export type EnvTable = Record<string, string | undefined>;

export interface ResolveConfigPathOptions {
  /** `--config` 旗标值, 最高优先级 */
  flag?: string;
  /** 平台标识, 默认 process.platform; 测试注入 'win32' 等 */
  platform?: string;
  /** 家目录, 默认 os.homedir() */
  homedir?: string;
  /** 环境变量表, 默认 process.env; 承载 SWEEP_NM_CONFIG 与 win32 的 APPDATA / USERPROFILE */
  env?: EnvTable;
}

export interface ResolvedConfigPath {
  /** 配置文件路径 (旗标 / 环境变量值原样透传, 平台默认按目标平台拼装) */
  path: string;
  /** 命中来源, 供调用方日志与分流 */
  source: ConfigSource;
}

export type LoadConfigResult =
  { state: 'ok'; config: Config } | { state: 'absent' };

/**
 * 平台默认配置路径 (按其目标平台拼装, 与宿主平台无关):
 * - win32: `%APPDATA%\sweep-node-modules\config.json`, APPDATA 缺失时以 `USERPROFILE\AppData\Roaming` 兜底, 再缺则退到注入的家目录;
 * - 其余 (macOS / Linux): `~/.config/sweep-node-modules/config.json`。
 */
function platformDefaultPath(
  platform: string,
  env: EnvTable,
  home: string,
): string {
  if (platform === 'win32') {
    const roaming =
      env.APPDATA || win32.join(env.USERPROFILE || home, 'AppData', 'Roaming');
    return win32.join(roaming, 'sweep-node-modules', 'config.json');
  }
  return posix.join(home, '.config', 'sweep-node-modules', 'config.json');
}

/**
 * 解析配置路径: 按 `--config` 旗标 > 环境变量 SWEEP_NM_CONFIG > 平台默认 的顺序取首个可用来源。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   options = { flag: undefined, env: { SWEEP_NM_CONFIG: '/env/config.json' }, platform: 'win32', homedir: 'C:\\Users\\u' }
 *
 * 步骤 1：旗标缺失, 环境变量命中
 *   path = '/env/config.json'
 *   source = 'env'
 *
 * Output（数据契约）
 *   return { path: '/env/config.json', source: 'env' }
 * ```
 */
export function resolveConfigPath(
  options: ResolveConfigPathOptions,
): ResolvedConfigPath {
  if (options.flag) {
    return { path: options.flag, source: 'flag' };
  }

  const env = options.env ?? process.env;
  if (env.SWEEP_NM_CONFIG) {
    return { path: env.SWEEP_NM_CONFIG, source: 'env' };
  }

  const platform = options.platform ?? process.platform;
  const home = options.homedir ?? homedir();
  return {
    path: platformDefaultPath(platform, env, home),
    source: 'platform-default',
  };
}

/** 值的实际类型描述 (供逐字段报错文案): 缺失 / null / array / typeof */
function describeActual(value: unknown): string {
  if (value === undefined) return '缺失';
  if (value === null) return 'null';
  if (Array.isArray(value)) return 'array';
  return typeof value;
}

/** 形状校验的失败形态: 首个不符字段名 (供 SweepError 的 details.field) + 人话原因 (供 message) */
interface ShapeProblem {
  field: string;
  message: string;
}

/**
 * 单字段形状校验: 字段须为字符串数组, 返回首个问题; 通过返回 null。
 * optional 为 true 时字段缺省放行 (由调用方补默认值), 出现但类型不符仍报错。
 */
function fieldError(
  container: Record<string, unknown>,
  field: string,
  optional: boolean,
): ShapeProblem | null {
  const value = container[field];
  if (value === undefined) {
    return optional
      ? null
      : { field, message: `${field} 应为字符串数组 (实际: 缺失)` };
  }
  if (!Array.isArray(value)) {
    return {
      field,
      message: `${field} 应为字符串数组 (实际: ${describeActual(value)})`,
    };
  }
  const badIndex = value.findIndex((item) => typeof item !== 'string');
  if (badIndex !== -1) {
    return {
      field,
      message: `${field} 第 ${badIndex + 1} 项应为字符串 (实际: ${describeActual(value[badIndex])})`,
    };
  }
  return null;
}

/**
 * 配置形状校验 (最小口径, 只校验类型不校验语义): 顶层须为非数组对象;
 * roots 必填, exclude / include 均可缺省 (依序补 DEFAULT_EXCLUDE 与 []); 返回首个问题
 * (逐字段具体), 通过返回 null。
 */
function shapeError(value: unknown): ShapeProblem | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    return {
      field: '顶层',
      message: `顶层应为对象 (实际: ${describeActual(value)})`,
    };
  }
  const candidate = value as Record<string, unknown>;
  const rootsError = fieldError(candidate, 'roots', false);
  if (rootsError !== null) return rootsError;
  const excludeError = fieldError(candidate, 'exclude', true);
  if (excludeError !== null) return excludeError;
  return fieldError(candidate, 'include', true);
}

/**
 * 装载配置: 文件缺失是正常状态 (absent), 供 init 向导分流, 不作为错误;
 * 损坏 (JSON 解析失败 / 形状不符) 与读取失败一律抛 SweepError (CONFIG_* 码与 details, 见 §3.6)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   path = '/Users/iyowei/.config/sweep-node-modules/config.json'
 *
 * 步骤 1：读文件
 *   text = '{"roots":["/a"],"exclude":["x"]}'
 *   *(ENOENT 时提前返回 { state: 'absent' }, 其余读取失败立即抛错)*
 *
 * 步骤 2：JSON 解析 + 形状校验 (roots 须为字符串数组; 字段缺省时 exclude 补默认名单、include 补 [])
 *   data = { roots: ['/a'], exclude: ['x'] }
 *
 * Output（数据契约）
 *   return { state: 'ok', config: { roots: ['/a'], exclude: ['x'], include: [] } }
 * ```
 */
export async function loadConfig(path: string): Promise<LoadConfigResult> {
  let text: string;
  try {
    text = await readFile(path, 'utf8');
  } catch (error) {
    if ((error as { code?: string }).code === 'ENOENT')
      return { state: 'absent' };
    throw new SweepError(
      'CONFIG_READ_FAILED',
      `配置读取失败 (${path}): ${(error as Error).message}`,
      { path, errno: (error as { code?: string }).code },
    );
  }

  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch (error) {
    throw new SweepError(
      'CONFIG_CORRUPT_JSON',
      `配置损坏 (${path}): JSON 解析失败: ${(error as Error).message}`,
      { path },
    );
  }

  const problem = shapeError(data);
  if (problem !== null) {
    throw new SweepError(
      'CONFIG_CORRUPT_SHAPE',
      `配置损坏 (${path}): ${problem.message}`,
      { path, field: problem.field },
    );
  }

  // 形状已保证: roots 为字符串数组; exclude / include 缺省分别补默认名单与空数组。
  // 判定「缺省」而非「空」: 显式写出的空数组是用户接管排除名单的表示, 不得被默认值回填
  // (回填即让「我想排除什么就排除什么」失效), 故用 ?? 而非长度判断
  const raw = data as {
    roots: string[];
    exclude?: string[];
    include?: string[];
  };
  return {
    state: 'ok',
    config: {
      roots: raw.roots,
      exclude: raw.exclude ?? [...DEFAULT_EXCLUDE],
      include: raw.include ?? [],
    },
  };
}

/**
 * 装载已解析路径的配置: 显式来源 (--config 旗标 / SWEEP_NM_CONFIG) 指向的文件不存在时抛错,
 * 防打错的路径被静默降级为「配置缺失」而回退扫 cwd (配 --yes 会删错地方);
 * 平台默认来源保留软行为, absent 交上层走向导 / cwd 回退。
 * 须在 scan 之前调用, 保证显式路径写错时不进入扫描与删除。
 */
export async function loadResolvedConfig(
  resolved: ResolvedConfigPath,
): Promise<LoadConfigResult> {
  const result = await loadConfig(resolved.path);
  if (result.state === 'absent' && resolved.source !== 'platform-default') {
    throw new SweepError(
      'CONFIG_ABSENT',
      `配置不存在 (${resolved.path}), 请检查路径`,
      { path: resolved.path, source: resolved.source },
    );
  }
  return result;
}

/**
 * 合并名单 (排除与包含共用): 配置名单在前、命令行追加在后, 跨来源去重 (保留首见顺序);
 * 同时静默剔除两个写进名单也永不生效的名字, 两者理由不同:
 * - node_modules: 本工具唯一的目标, 写进两份名单里都不成立。列入排除名单等于排掉唯一操作目标
 *   (工具彻底失效); 列入包含名单则是永久零命中 (扫描读到 node_modules 即剪枝, 该名字只可能落在
 *   候选路径的末段, 而名单判定只看中间级别, 见 scan-native.ts 中 Candidate.segments 的
 *   「末段恒为 node_modules」)。
 * - .git: 扫描恒定跳过的目录 (三名候选均不产出其下的命中: prune / parallel 在进入目录时短路,
 *   native 在后过滤里剔除含 .git 路径段的候选), 从不参与名单判定。留在名单里只会换来一条结构性
 *   假告警: 该目录客观存在, 却因剪枝早于逐名计数而被报成「未命中任何已扫描的目录」, 恰是这条反馈通道
 *   最该避免的误导。
 *
 * 剔除只做静默丢弃, 不报错、不阻断、不告警; 匹配口径与其余名单判定一致, 按名精确匹配且区分大小写。
 * 内含 include 侧的一个易误解点: 剔空后等于「不过滤」(空数组即不过滤, 见 Config.include),
 * 而不是「只扫 node_modules」。
 *
 * 落点选在合并收口处而非逐个扫描候选改判定: 所有消费方都经此处取名单, 三名候选
 * (prune / parallel / native) 天然不含这两个名字, 一处收口胜过三处判定修改。
 */
export function mergeNames(
  configNames: string[],
  cliNames: string[],
): string[] {
  return [...new Set([...configNames, ...cliNames])].filter(
    // 两个名字写进任何一份名单都永不生效, 一律静默剔除 (各自理由见上方 JSDoc)
    (name) => name !== 'node_modules' && name !== '.git',
  );
}
