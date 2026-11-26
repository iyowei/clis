/**
 * `@iyowei/cli-updater` 统一终端排版、标准 SGR 配色与输出净化 (零外部依赖)。
 *
 * 与仓内 CLI 主视图共用同一套终端原生 ANSI SGR 色盘 (`1;7` 反色徽章、`1` 粗白、`2` 压暗、
 * `36` 青、`1;32` 绿、`1;31` 红、`33` 黄, 零硬编码 24-bit RGB), 自动融入用户终端明暗主题;
 * 非 TTY / NO_COLOR / TERM=dumb 下自动降级为零 ANSI 纯文本且字符骨架逐字等价。
 */
import { type Locale, t } from '@iyowei/cli-i18n';

/** stdout 与 stderr 各自独立的着色开关 (任一通道重定向为非 TTY 时互不串色) */
export interface ColorChannels {
  stdout: boolean;
  stderr: boolean;
}

const ESC = String.fromCharCode(0x1b);
const BEL = String.fromCharCode(0x07);

/** 匹配 ANSI CSI (含 SGR) / OSC / 双字节转义序列 (用于净化子进程捕获日志与去色校验) */
const ANSI_ESCAPE_RE = new RegExp(
  `${ESC}(?:\\[[0-?]*[ -/]*[@-~]|\\][^${BEL}${ESC}]*(?:${BEL}|${ESC}\\\\)|[@-Z\\\\-_])`,
  'g',
);

/** 匹配 bidi 视觉反转、零宽字符与 BOM (防止外部文本伪造或错位终端内容) */
const BIDI_AND_ZERO_WIDTH_RE =
  /[\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g;

/** 匹配全量 C0 / C1 控制字符 */
const CONTROL_CHAR_RE = /\p{Cc}/gu;

/** 顶栏色块前缀 (与 sweep 主视图同源) */
export const BAR_BLOCK = '▍';

/** 判定当前进程 stdout / stderr 是否允许着色 (尊重 NO_COLOR 与 TERM=dumb) */
export function detectColorChannels(
  env: NodeJS.ProcessEnv = process.env,
): ColorChannels {
  const allowed = !env.NO_COLOR && env.TERM?.toLowerCase() !== 'dumb';
  return {
    stdout: allowed && process.stdout.isTTY === true,
    stderr: allowed && process.stderr.isTTY === true,
  };
}

/** 判定 stderr 是否适合渲染动态 TTY Spinner (仅真终端且非 dumb 模式) */
export function stderrSupportsSpinner(
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return process.stderr.isTTY === true && env.TERM?.toLowerCase() !== 'dumb';
}

/** 施加受控标准 ANSI SGR 样式 (enabled=false 时原样返回零 ANSI) */
export function paint(text: string, sgr: string, enabled: boolean): string {
  if (!enabled || text === '') return text;
  return `${ESC}[${sgr}m${text}${ESC}[0m`;
}

/** 剥除全部 ANSI 转义序列 (用于去色等价断言与子进程日志清洗) */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_ESCAPE_RE, '');
}

/**
 * 净化单行外部数据 (包名 / 路径 / 版本号 / 错误消息):
 * 剥除控制字符与 bidi/零宽字符, 折叠换行与连续空白, 防止终端逃逸与劈行注入。
 */
export function sanitizeText(raw: string): string {
  return raw
    .replace(BIDI_AND_ZERO_WIDTH_RE, '')
    .replace(CONTROL_CHAR_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

/**
 * 清洗并截断子进程多行尾部日志 (仅失败时展开):
 * 先剥除子进程自带 ANSI 颜色序列, 再按行剥控制符与 bidi 字符, 保留最新若干有效行。
 */
export function sanitizeMultilineTail(
  raw: string,
  maxLines = 12,
  maxChars = 2048,
): { lines: string[]; clipped: boolean } {
  const withoutAnsi = stripAnsi(raw);
  const rawLines = withoutAnsi
    .split(/\r\n|\r|\n/)
    .map((line) =>
      line
        .replace(BIDI_AND_ZERO_WIDTH_RE, '')
        .replace(CONTROL_CHAR_RE, ' ')
        .replace(/\s+$/g, ''),
    );

  // 裁剪首尾空白行, 保留中间段落结构
  let start = 0;
  let end = rawLines.length;
  while (start < end && rawLines[start]!.trim() === '') start += 1;
  while (end > start && rawLines[end - 1]!.trim() === '') end -= 1;
  const meaningful = rawLines.slice(start, end);
  if (meaningful.length === 0) return { lines: [], clipped: false };

  let clipped = meaningful.length > maxLines;
  const tail = meaningful.slice(-maxLines);

  // 从末尾向前按总字符预算截取, 保证最关键的最终报错行始终完整保留
  const kept: string[] = [];
  let chars = 0;
  for (let i = tail.length - 1; i >= 0; i -= 1) {
    const line = tail[i]!;
    const nextChars = chars + line.length + (kept.length > 0 ? 1 : 0);
    if (nextChars > maxChars && kept.length > 0) {
      clipped = true;
      break;
    }
    const safeLine =
      line.length > maxChars ? `…${line.slice(-(maxChars - 1))}` : line;
    if (safeLine !== line) clipped = true;
    kept.push(safeLine);
    chars += safeLine.length + (kept.length > 1 ? 1 : 0);
  }
  kept.reverse();
  return { lines: kept, clipped };
}

/** 格式化已用耗时 (>= 100ms 显示一位小数秒; 更短或缺失返回空串) */
export function formatElapsedMs(elapsedMs: number | undefined): string {
  if (
    elapsedMs === undefined ||
    !Number.isFinite(elapsedMs) ||
    elapsedMs < 100
  ) {
    return '';
  }
  return `${(elapsedMs / 1000).toFixed(1)}s`;
}

/** 从 registry URL 提取紧凑主机名供进度条展示 (解析失败返回空串) */
export function extractRegistryHost(registry: string): string {
  try {
    return new URL(registry).host;
  } catch {
    return '';
  }
}

/** 计算单行中文/ASCII 混合文本的终端显示列宽 (CJK 与常见全角按 2 列) */
export function displayWidth(text: string): number {
  let width = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    const wide =
      (code >= 0x1100 && code <= 0x115f) ||
      (code >= 0x2e80 && code <= 0xa4cf) ||
      (code >= 0xac00 && code <= 0xd7a3) ||
      (code >= 0xf900 && code <= 0xfaff) ||
      (code >= 0xff00 && code <= 0xff60);
    width += wide ? 2 : 1;
  }
  return width;
}

/** 跑马灯流光渐进调色配置 (仅使用标准 ANSI SGR, 零 24-bit RGB 硬编码) */
export interface ShimmerSgrPalette {
  /** 静默背景字符 SGR (默认 `'2'` 压暗灰) */
  base: string;
  /** 光斑过渡边缘 SGR (默认 `'34'` 柔和蓝) */
  shoulder: string;
  /** 光斑高光核心 SGR (默认 `'1;94'` 亮蓝加粗) */
  peak: string;
}

const DEFAULT_SHIMMER_PALETTE: ShimmerSgrPalette = {
  base: '2',
  shoulder: '34',
  peak: '1;94',
};

/**
 * 跑马灯流光渲染 (零 24-bit RGB 硬编码, `enabled=false` 时原样返回零 ANSI 文本):
 * 按终端显示列宽推进光斑中心使中英文保持视觉等速平滑扫过, 合并连续同色片段减少控制符开销。
 */
export function renderShimmerText(
  text: string,
  step: number,
  enabled: boolean,
  palette: ShimmerSgrPalette = DEFAULT_SHIMMER_PALETTE,
): string {
  if (!enabled || text === '') return text;
  const chars = Array.from(text);
  const widths = chars.map((ch) => Math.max(1, displayWidth(ch)));
  const starts: number[] = [];
  let totalWidth = 0;
  for (const w of widths) {
    starts.push(totalWidth);
    totalWidth += w;
  }

  const pauseCols = 6;
  const cycle = Math.max(1, totalWidth + pauseCols);
  const pos = ((Math.trunc(step) % cycle) + cycle) % cycle;
  const centerCol = pos - 1;

  const pickSgr = (colCenter: number): string => {
    const dist = Math.abs(colCenter - centerCol);
    if (dist <= 1.1) return palette.peak;
    if (dist <= 2.6) return palette.shoulder;
    return palette.base;
  };

  const parts: string[] = [];
  let runSgr = '';
  let runText = '';
  for (let i = 0; i < chars.length; i += 1) {
    const ch = chars[i]!;
    const colCenter = starts[i]! + widths[i]! / 2;
    const sgr = pickSgr(colCenter);
    if (sgr === runSgr) {
      runText += ch;
    } else {
      if (runText !== '') parts.push(paint(runText, runSgr, true));
      runSgr = sgr;
      runText = ch;
    }
  }
  if (runText !== '') parts.push(paint(runText, runSgr, true));
  return parts.join('');
}

const KV_LABEL_COLS = 10;

/** 统一自更新渲染器 (受控标准 SGR, 全部外部文本强制经 sanitizeText 净化, 全文左对齐) */
export interface UpdateUi {
  /** 顶栏: ▍ <BIN>   自更新 */
  header(binName: string): string;
  /** 键值信息行: `<压暗标签>  <内容>` */
  kv(
    label: string,
    value: string,
    tone?: 'plain' | 'bold' | 'cyan' | 'dim',
  ): string;
  /** 正文行 */
  body(text: string): string;
  /** 柔和提示行 (压暗) */
  hint(text: string): string;
  /** 黄色警示行 */
  warn(text: string): string;
  /** 绿色成功确认行 (行尾绿色 ✓) */
  success(text: string, suffix?: string): string;
  /** 发现新版本行 (高亮目标版本号) */
  foundUpdate(fromVer: string, toVer: string, registry: string): string;
  /** 错误首行 (stderr 着色时带红色 ✗ 前缀) */
  error(text: string): string;
  /** 错误补充行 */
  errorHint(text: string): string;
  /** 失败时展示的捕获日志单行 (`│ <line>`) */
  errorLogLine(line: string): string;
}

/** 创建绑定双通道着色开关与界面语言的自更新渲染器 */
export function createUpdateUi(
  color: ColorChannels,
  locale: Locale = 'zh',
): UpdateUi {
  const out = color.stdout;
  const err = color.stderr;
  const labelCols = locale === 'en' ? 14 : KV_LABEL_COLS;

  return {
    header(binName: string): string {
      const badgeText = `${BAR_BLOCK} ${sanitizeText(binName).toUpperCase()} `;
      return `${paint(badgeText, '1;7', out)}  ${paint(t(locale, '自更新', 'Self-Update'), '1', out)}`;
    },
    kv(label: string, value: string, tone = 'plain'): string {
      const safeLabel = sanitizeText(label);
      const safeValue = sanitizeText(value);
      const pad = ' '.repeat(Math.max(2, labelCols - displayWidth(safeLabel)));
      let styledValue = safeValue;
      if (tone === 'bold') styledValue = paint(safeValue, '1', out);
      else if (tone === 'cyan') styledValue = paint(safeValue, '36', out);
      else if (tone === 'dim') styledValue = paint(safeValue, '2', out);
      return `${paint(safeLabel, '2', out)}${pad}${styledValue}`;
    },
    body(text: string): string {
      return text;
    },
    hint(text: string): string {
      return paint(text, '2', out);
    },
    warn(text: string): string {
      return paint(text, '33', out);
    },
    success(text: string, suffix?: string): string {
      const tail =
        suffix !== undefined && suffix !== ''
          ? ` ${paint(suffix, '2', out)}`
          : '';
      return `${text}${tail} ${paint('✓', '1;32', out)}`;
    },
    foundUpdate(fromVer: string, toVer: string, registry: string): string {
      const safeFrom = sanitizeText(fromVer);
      const safeTo = sanitizeText(toVer);
      const safeReg = sanitizeText(registry);
      const arrow = paint('→', '2', out);
      const target = paint(`v${safeTo}`, '1;36', out);
      if (locale === 'en') {
        const src = paint(`(${safeReg})`, '2', out);
        return `Update available: v${safeFrom} ${arrow} ${target} ${src}`;
      }
      const src = paint(`(源: ${safeReg})`, '2', out);
      return `发现新版本: v${safeFrom} ${arrow} ${target} ${src}`;
    },
    error(text: string): string {
      const safe = sanitizeText(text);
      return err ? `${paint('✗', '1;31', true)} ${safe}` : safe;
    },
    errorHint(text: string): string {
      const safe = sanitizeText(text);
      return paint(safe, '2', err);
    },
    errorLogLine(line: string): string {
      const bar = paint('│', '2', err);
      return `${bar} ${line}`;
    },
  };
}
