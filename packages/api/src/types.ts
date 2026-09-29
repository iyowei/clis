/**
 * 扫描契约: 候选实现共享的接口与返回形态 (设计: 分册「扫描与体积」)。
 * 候选差异只允许存在于接口内部, 调用方无感。
 */

export interface RenderEntry {
  /** node_modules 绝对路径 */
  target: string;
  /** 字节数; undefined = 体积测不到 (体积列显示 ?, 档位块转中性, 不计入合计总量) */
  bytes?: number;
  /** 项目名 */
  project: string;
  /** 执行模式: 删除是否成功 (缺省视为成功) */
  ok?: boolean;
  /** 执行模式: 失败原因 (ok === false 时附在行尾) */
  error?: string;
  /** 行尾补充说明 (如体积统计失败原因); 与失败原因同位并置, note 在前 */
  note?: string;
  /**
   * 疑似安装树 (工具 / 应用自身的安装树, 默认不进删除批; 判定见 classify.ts)。
   * 该行的路径不剥 node_modules 后缀: 剥掉后剩下的目录 (如 ~/.bun/install/global) 会被
   * 读成项目目录, 反而抹去唯一的类别提示; 保后缀与行尾标记互为印证。
   */
  suspect?: boolean;
}

export interface ScanOptions {
  /** 扫描根 (调用方保证为绝对路径) */
  roots: string[];
  /** 排除名单: 目录名; 从根到命中点的任意一级命中即整棵子树跳过 (装载层在配置省略该字段时缺省注入内置默认名单, 见 config.ts) */
  exclude: string[];
  /**
   * 包含名单 (白名单): 目录名; 从根到 node_modules 的任意一级命中即纳入。
   * 空数组 = 不过滤 (全部纳入); 与 exclude 同时命中时 exclude 优先 (先按白名单筛候选, 再排掉命中排除的)。
   */
  include: string[];
}

export interface ScanHit {
  /** 直接包含 node_modules 的项目目录 */
  project: string;
  /** node_modules 绝对路径 */
  target: string;
}

export interface ScanResult {
  /** 命中清单: 按 target 排序, 已按 realpath 去重 */
  hits: ScanHit[];
  /** 非致命告警 (如不可读目录), 不中断扫描 */
  warnings: string[];
  /**
   * 排除名单命中统计 (名称 → 命中次数); 未命中的名称也在列 (hits === 0)。
   * 性质: 破坏性动作的「保命名单」反馈通道 —— 名字打错/大小写不符时不得静默。
   * 例外: 内置默认名单项零命中不告警 (名单依平台与用户环境而异, 不是可修正的拼写错误;
   * 见 behavior-contract.md BC-09), 用户显式写出同名项时同样静默 (该项已由默认名单覆盖)。
   * 胜出门面 (parallel) 必须提供; 历史候选可缺省。
   */
  excludeMatches?: { name: string; hits: number }[];
  /**
   * 包含名单命中统计 (名称 → 命中该名的子树数); 未命中的名称也在列 (hits === 0)。
   * 计数独立于 exclude 优先: 名字命中白名单、随后被 exclude 截走的同样计入 (截走不等于没匹配上),
   * 否则被截走的名字会以 0 报「未匹配」, 诱导用户去排查不存在的拼写问题。
   * 性质: 与 excludeMatches 同款的名单反馈通道, 后果却更重: 白名单写错名字时扫描结果直接为空,
   * 更不能静默。胜出门面 (parallel) 必须提供; 历史候选可缺省。
   */
  includeMatches?: { name: string; hits: number }[];
}

export interface Scanner {
  /** 候选中立名, 供基准与日志区分 */
  name: string;
  scan(options: ScanOptions): Promise<ScanResult>;
}

export interface SizeEntry {
  /** node_modules 绝对路径 (对应 ScanHit.target) */
  target: string;
  /** 字节数; 口径: du 候选 = 磁盘占用, js 候选 = 逻辑大小 (差异由基准环节记录裁定) */
  bytes: number;
}

/** 存在但无法测量的目标 (权限等): 结构化上报, 下游不得静默移出清单 */
export interface UnmeasuredEntry {
  /** node_modules 绝对路径 (对应 ScanHit.target) */
  target: string;
  /** 人话中文原因 (不含路径本身, 与 target 字段各司其职) */
  reason: string;
}

export interface SizeResult {
  /** 可测量目标的体积, 按 target 排序 */
  entries: SizeEntry[];
  /** 非致命告警 (如子目录不可读), 不中断统计 */
  warnings: string[];
  /** 存在但无法测量的目标 (如权限不足), 按 target 排序; 「不存在」的路径跳过、不入任何桶 */
  unmeasured: UnmeasuredEntry[];
}

export interface Sizer {
  /** 候选中立名, 供基准与日志区分 */
  name: string;
  measure(targets: string[]): Promise<SizeResult>;
}
