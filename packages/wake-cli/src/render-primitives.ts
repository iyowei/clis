/**
 * `@iyowei/wake-cli` 终端渲染基础设施: 标准 ANSI SGR 着色、中英文混排显示宽度计算与状态徽章。
 */
import { displayWidth } from '@iyowei/cli-i18n';
import { sanitizeLine } from '@iyowei/wake';

export const BAR_BLOCK = '▍';
const ESC = String.fromCharCode(0x1b);

export { displayWidth };

/** 按 SGR 开关施加样式, 关闭颜色时返回纯文本 */
export function paint(text: string, sgr: string, enabled: boolean): string {
  if (!enabled || text === '') return text;
  return `${ESC}[${sgr}m${text}${ESC}[0m`;
}

/** 渲染反色顶栏徽章 + 副标题 */
export function renderHeader(
  subtitle: string,
  color: boolean,
  badgeLabel = 'WAKE',
): string {
  const badge = paint(`${BAR_BLOCK} ${badgeLabel} `, '1;7', color);
  return `${badge}  ${paint(subtitle, '1', color)}`;
}

/** 右侧填充空格以对齐混合中英文列宽 */
export function padDisplay(text: string, width: number): string {
  const pad = Math.max(0, width - displayWidth(text));
  return `${text}${' '.repeat(pad)}`;
}

/** 对外部数据执行行级安全净化 (OF-14) */
export function sanitizeOutputLine(raw: string): string {
  return sanitizeLine(raw);
}
