/**
 * 清单渲染 (纯函数, 零 IO): 入参决定全部输出; 颜色由调用方按 TTY / NO_COLOR 判定后传入;
 * 路径风味由调用方注入 (缺省平台原生), 保证同一份实现在 posix / win32 语义下均可测。
 * 视觉规范: 紧凑式 + 色块 (设计: cli-surface.md「输出规格」)。
 * 可移植性: packages/sweep-node-modules/docs/adrs/0007-platform-portability.md。
 */
import {
  type PathStyle,
  formatBytes,
  nativeStyle,
  sanitizeLine,
} from '@iyowei/sweep-node-modules';

// 展示辅助三件现居 API 包 (display.ts, OF-14 的唯一实现); 本行转出, 供本包消费方沿用既有写法
export {
  formatBytes,
  sanitizeLine,
  sanitizeOutputLine,
} from '@iyowei/sweep-node-modules';

/**
 * 渲染条目: 一个目标在清单上的呈现决定 (设计 §5.2 裁定归 CLI 包: 「这一行怎么印」是渲染决定)。
 * 本类型自 API 包迁回 (曾随 skip.ts 的入参类型落在彼处; 解耦后归属应随语义回 CLI)。
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
   * 必填的理由与 SkipCandidate.suspect 同源 (留可选等于给「疑似安装树静默进批」留后门);
   * CLI 的构造点两条分支本就都写了值, 故为零改动。
   */
  suspect: boolean;
}

/** 顶栏命令名短变体 (设计: cli-surface.md「命令面」) */
const BANNER = 'SWEEP-NM';

/**
 * 顶栏标识块: 输出规范的一部分, 导出给 cli 等消费方复用
 * (同一视觉常量只应有一处定义, 各消费方各写一份即规范漂移)。
 */
export const BAR_BLOCK = '▍';

/** 合计块 / 中性块: 空结果提示与中性行共用 (向导与 config 也复用, 见 neutralLine) */
const TOTAL_BLOCK = '█';
export const NEUTRAL_BLOCK = '░';

/** 缺省路径风味: 平台原生 (模块加载时定格一次, 调用期不再读环境, 保持 render 纯函数) */
const PLATFORM_STYLE = nativeStyle();

/** 档位块的中性形态: 体积测不到的条目用 (与空结果提示同族, 表示不表态) */
const NEUTRAL_TIER = { block: NEUTRAL_BLOCK, sgr: '2' };

/** 顶栏列出根路径的上限: 根数不超过此值时直接列路径 (只报数量时用户无法确认扫描范围) */
const ROOT_LIST_LIMIT = 3;

/**
 * 顶栏行: 反色加粗 (SGR 1;7) 的 `▍ SWEEP-NM` + 两空格 + 本次动作自述。
 * 清单 / 帮助 / config / 向导四处共用同一构造 (各写一份即视觉规范漂移); suffix 由调用方自负净化。
 */
export const bannerLine = (suffix: string, color: boolean): string =>
  paint(`${BAR_BLOCK} ${BANNER}  ${suffix}`, '1;7', color);

/** 中性提示行: 缩进 2 + 中性块 + 整行压暗 (色块视觉规范里的说明性行, 不打断顶栏与主体的紧邻关系) */
export const neutralLine = (text: string, color: boolean): string =>
  `  ${paint(`${NEUTRAL_BLOCK} ${text}`, '2', color)}`;

/**
 * 体积档位阈值 (绝对阈值, 不做分位数动态计算; 已按真实工作区实测重标, 设计: cli-surface.md「体积档位与阈值」)。
 * 大 >= 512 MiB; 中 >= 100 MiB; 小 < 100 MiB。
 * 重标依据 (2026-09-24 实测, 主样本 n=5): 原 1 GiB 阈值高于全样本最大值 (590.72 MiB), 该档永不触发;
 * 一维 k-means 的自然断点落在中 / 大之间 (约 405 MiB), 但红块须保持「稀有而醒目」, 取更保守的 512 MiB (半 GiB)。
 * 样本量小, 该组阈值属可再重标者, 不是一次定死的分位规则。
 */
const TIER_BIG = 512 * 1024 ** 2;
const TIER_MID = 100 * 1024 ** 2;

export interface RenderOptions {
  /** 预览 (零副作用) 或执行 (逐行结果 + 汇总) */
  mode: 'preview' | 'execute';
  /** 扫描根: 仅用于顶栏计数 */
  roots: string[];
  entries: RenderEntry[];
  /** false (非 TTY / NO_COLOR) 时输出零 ANSI, 信息与行结构与着色版一致 */
  color: boolean;
  /** 家目录前缀: 命中则缩写为 ~; 缺省不缩写 (保持纯函数, 不读环境) */
  home?: string;
  /** 执行模式: 已释放的字节总量; 提供时汇总行补 "释放 X", 缺省维持原文案 */
  releasedBytes?: number;
  /** 路径风味 (分隔符与大小写敏感性): 缺省平台原生; 传入 WIN32_STYLE 可在 posix 上测 win32 语义 */
  pathStyle?: PathStyle;
  /** 运行时自述 (如 `bun 1.4.2`): 提供时接在顶栏尾部; 缺省不显示 (调用方按 TTY 决定) */
  runtime?: string;
  /** 顶栏下方的中性提示行 (如名单回执); 缺省无。走 stdout 而非 stderr: 它们是本次运行的说明, 与清单同属一次输出 */
  notes?: string[];
  /**
   * 清单末尾的中性说明行 (如疑似安装树跳过计数), 压在合计 / 汇总行之后; 缺省无。
   * 与 notes 的分工: notes 交代本次运行的前置与过程, trailer 则是对整份清单的事后交代
   * (读者须先看完清单与合计, 才知道「N 处被跳过」指的是什么)。
   */
  trailer?: string[];
}

/**
 * 渲染清单。
 *
 * **执行步骤**：
 * 1. 顶栏按模式与根数量成行 (根数不超过 ROOT_LIST_LIMIT 时直接列出根路径), 提供 runtime 时把运行时自述接在尾部;
 * 2. 提供 notes 时先出顶栏下方的中性提示行 (如名单回执; 空结果分支同样呈现);
 * 3. 无条目则只出中性提示行并提前返回;
 * 4. 条目按体积降序 (体积测不到的排末尾), 由当前数据的最长体积与最长项目名定列宽 (二者右 / 左对齐);
 * 5. 逐行成清单 (预览出档位块, 执行出结果标记; 体积测不到的显示 ? 与中性块; 疑似安装树保留路径
 *    的 node_modules 后缀), 末行出合计或汇总; 合计只累加已测到的条目, 行数照常计入;
 * 6. 提供 trailer 时在末行之后再出中性说明行 (对整份清单的事后交代)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   options.mode = 'preview', options.roots = ['/Users/iyowei/workspace/development']
 *   options.entries = [
 *     { target: '/Users/iyowei/workspace/development/docs-site/node_modules', bytes: 90177536, project: 'docs-site' },
 *     { target: '/Users/iyowei/workspace/development/acme-web/node_modules', bytes: 4939212390, project: 'acme-web' },
 *   ]
 *   options.color = false, options.home = '/Users/iyowei'
 *
 * 步骤 1：按体积降序
 *   rows = [acme-web 4939212390, docs-site 90177536]
 *
 * 步骤 2：定列宽 (按显示宽度)
 *   volumeWidth = 6 ("4.6 GB" 与 "86 MB" 取长), nameWidth = 9 ("docs-site")
 *
 * 步骤 3：成行 (档位块随档位变, 体积右对齐, 项目名左对齐, 路径缩写)
 *   body = ['  █ 4.6 GB  acme-web     ~/workspace/development/acme-web',
 *           '  ▒  86 MB  docs-site    ~/workspace/development/docs-site']
 *
 * 步骤 4：末行合计
 *   foot = '  █ 合计 2 处 · 4.7 GB   加 --yes 执行删除'
 *
 * Output（数据契约）
 *   return 多行文本 (行以 \n 分隔, 无尾换行)
 * ```
 */
export function render(options: RenderOptions): string {
  const { mode, roots, entries, color, home, releasedBytes, pathStyle } =
    options;
  const style = pathStyle ?? PLATFORM_STYLE;
  const scope =
    roots.length > 0 && roots.length <= ROOT_LIST_LIMIT
      ? `${roots.length} 个根: ${roots.map((root) => sanitizeLine(shortenPath(root, style, home))).join(' · ')}`
      : `${roots.length} 个根`;
  const runtime = options.runtime ? ` · ${sanitizeLine(options.runtime)}` : '';
  const head = bannerLine(
    `${mode === 'execute' ? '执行' : '预览'} · ${scope}${runtime}`,
    color,
  );
  // 顶栏下方的中性提示: 与清单同一视觉语言, 不打断顶栏与清单的紧邻关系
  const notes = (options.notes ?? []).map((note) =>
    neutralLine(sanitizeLine(note), color),
  );
  // 末尾的中性说明行: 压在合计 / 汇总之后, 与 notes 同款构件 (同属 stdout 的一次输出)
  const trailer = (options.trailer ?? []).map((line) =>
    neutralLine(sanitizeLine(line), color),
  );

  if (entries.length === 0) {
    return [
      head,
      ...notes,
      // 空结果行保留内联形态: make-mutants.ts 以此字面量为 mutant 注入锚点, 换成 neutralLine 即失配
      `  ${paint(`${NEUTRAL_BLOCK} 未发现 node_modules`, '2', color)}`,
      ...trailer,
    ].join('\n');
  }

  const rows = [...entries].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1));
  const volumeWidth = Math.max(
    ...rows.map((row) => displayWidth(volumeOf(row))),
  );
  const nameWidth = Math.max(
    ...rows.map((row) => displayWidth(sanitizeLine(row.project))),
  );

  const body = rows.map((row) => {
    const fail = mode === 'execute' && row.ok === false;
    const tier = row.bytes === undefined ? NEUTRAL_TIER : tierOf(row.bytes);
    const mark =
      mode === 'execute'
        ? paint(fail ? '✗' : '✓', fail ? '31' : '32', color)
        : paint(tier.block, tier.sgr, color);
    const volume = padStart(volumeOf(row), volumeWidth);
    const name = sanitizeLine(row.project);
    const rawPath = displayPath(row.target, style, home, row.suspect === true);
    const path = sanitizeLine(rawPath);
    // 净化改写了显示名即与磁盘名不一致: 补提示, 防用户照显示名复制路径
    const rewritten = name !== row.project || path !== rawPath;
    const tail = tailsOf(row, fail, rewritten);
    const shown = `${paint(padEnd(name, nameWidth), '1', color)}    ${paint(path, '2', color)}`;
    return `  ${mark} ${volume}  ${shown}${tail ? `  ${paint(tail, '2', color)}` : ''}`;
  });

  // 提示整段压暗, 仅 --yes 加粗 (可执行动作是这行的落点; 空格留在着色段之外, 不入色)
  const hint = [
    paint('加', '2', color),
    paint('--yes', '1', color),
    paint('执行删除', '2', color),
  ].join(' ');
  const foot =
    mode === 'execute'
      ? footExecute(rows, color, releasedBytes)
      : `  ${paint(TOTAL_BLOCK, '7', color)} ${paint(`合计 ${rows.length} 处 · ${formatBytes(sum(rows))}`, '1', color)}   ${hint}`;

  return [head, ...notes, ...body, foot, ...trailer].join('\n');
}

/** 执行模式末行: 成功 / 失败计数汇总 (取代预览的合计); 提供 releasedBytes 时补释放体积 */
function footExecute(
  rows: RenderEntry[],
  color: boolean,
  releasedBytes?: number,
): string {
  const failed = rows.filter((row) => row.ok === false).length;
  const released =
    releasedBytes === undefined ? '' : ` · 释放 ${formatBytes(releasedBytes)}`;
  return `  ${paint(TOTAL_BLOCK, '7', color)} ${paint(`汇总 成功 ${rows.length - failed} 处${released} · 失败 ${failed} 处`, '1', color)}`;
}

/** 体积列文本: 未测到 (bytes undefined) 用 ? 占位 (与 0 B 区分开) */
const volumeOf = (row: RenderEntry): string =>
  row.bytes === undefined ? '?' : formatBytes(row.bytes);

/** 显示名被净化改写时的行尾提示 (控制类字符剥除或空白折叠都会改写显示名, 照显示名复制路径即失效) */
const SANITIZED_NOTE = '名字已净化显示';

/**
 * 行尾补充: 净化提示 / note / 执行失败原因并置
 * (净化提示最前 —— 它关乎整行显示名的可信度, 读者须先知道;
 * note 属目标属性, 失败原因属动作结果, 依次在后)。
 */
function tailsOf(row: RenderEntry, fail: boolean, rewritten: boolean): string {
  const parts: string[] = [];
  if (rewritten) parts.push(SANITIZED_NOTE);
  if (row.note) parts.push(sanitizeLine(row.note));
  if (fail && row.error) parts.push(sanitizeLine(row.error));
  return parts.join('  ');
}

/** 档位: 大 (红) / 中 (黄) / 小 (青); 返回色块字符与 SGR 前景码 */
function tierOf(bytes: number): { block: string; sgr: string } {
  if (bytes >= TIER_BIG) return { block: '█', sgr: '31' };
  if (bytes >= TIER_MID) return { block: '▓', sgr: '33' };
  return { block: '▒', sgr: '36' };
}

/**
 * 着色: color 为 false 时原样返回, 即降级开关 —— false (非 TTY / NO_COLOR) 时输出退化为
 * 纯文本, 零 ANSI 转义码, 且行结构、列对齐与全部信息与着色版逐字等价 (仅差颜色码)。
 * 导出给 cli 复用, 使整个 CLI 的降级契约同源。
 */
export const paint = (text: string, sgr: string, color: boolean): string =>
  color ? `\u001b[${sgr}m${text}\u001b[0m` : text;

/** 合计: 只累加已测到的条目 (未测到按 0 计, 不贡献总量; 全未测到时即 0 B) */
const sum = (rows: RenderEntry[]): number =>
  rows.reduce((total, row) => total + (row.bytes ?? 0), 0);

/** 大小写折叠: 仅 win32 生效 (与 guard 的折叠约定同源, 保证两处对同一 PathStyle 的解读一致) */
const fold = (text: string, style: PathStyle): string =>
  style.caseInsensitive ? text.toLowerCase() : text;

/** 家目录缩写: 命中前缀 (含家目录本身) 才替换为 ~; 前缀按风味分隔符拼装, 比较按风味折叠 */
function shortenPath(path: string, style: PathStyle, home?: string): string {
  if (!home) return path;
  if (fold(path, style) === fold(home, style)) return '~';
  const prefix = `${home}${style.ops.sep}`;
  return fold(path, style).startsWith(fold(prefix, style))
    ? `~${path.slice(home.length)}`
    : path;
}

/**
 * 家目录缩写 (平台原生风味): 与清单渲染内部同源, 导出供向导等复用。
 * home 缺省时不缩写 (保持纯函数, 不读环境)。
 */
export function shortenHome(path: string, home?: string): string {
  return shortenPath(path, PLATFORM_STYLE, home);
}

/**
 * 展示路径: 先剥掉尾部 node_modules (每行恒定的后缀, 与左侧项目名重复, 属噪声;
 * 示意里展示的是项目目录), 再做家目录缩写。后缀与前缀均按风味分隔符拼装。
 * keepSuffix 为真 (疑似安装树) 时保留后缀: 这类行剥掉后缀后剩下的目录 (如 ~/.bun/install/global)
 * 会被读成项目目录, 而它恰恰不是项目 —— 后缀在这里是唯一的类别线索, 与行尾标记互为印证。
 */
function displayPath(
  target: string,
  style: PathStyle,
  home?: string,
  keepSuffix = false,
): string {
  const suffix = `${style.ops.sep}node_modules`;
  const dir =
    keepSuffix || !fold(target, style).endsWith(fold(suffix, style))
      ? target
      : target.slice(0, -suffix.length);
  return shortenPath(dir, style, home);
}

/** 按显示宽度左对齐 (补齐尾部空格) */
const padEnd = (text: string, width: number): string =>
  text + ' '.repeat(Math.max(0, width - displayWidth(text)));

/** 按显示宽度右对齐 (补齐前导空格) */
const padStart = (text: string, width: number): string =>
  ' '.repeat(Math.max(0, width - displayWidth(text))) + text;

/**
 * 终端显示列宽: 汉字 / 全角标点 / 韩文按 2 列计, 其余按 1 列。
 * 只覆盖常见全角区间, 不求穷尽 East Asian Width 全表 (紧凑对齐够用即止)。
 */
function displayWidth(text: string): number {
  let width = 0;
  for (const char of text) {
    const code = char.codePointAt(0) ?? 0;
    width += isFullWidth(code) ? 2 : 1;
  }
  return width;
}

function isFullWidth(code: number): boolean {
  return (
    (code >= 0x1100 && code <= 0x115f) ||
    (code >= 0x2e80 && code <= 0xa4cf) ||
    (code >= 0xac00 && code <= 0xd7a3) ||
    (code >= 0xf900 && code <= 0xfaff) ||
    (code >= 0xfe30 && code <= 0xfe6f) ||
    (code >= 0xff00 && code <= 0xff60) ||
    (code >= 0xffe0 && code <= 0xffe6)
  );
}
