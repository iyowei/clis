/**
 * 展示辅助 (纯函数, 零 IO, 无打印): 人类可读体积格式化与输出面文本净化。
 * 上下游: 零内部依赖; 经 index.ts 公开导出, 并由 sweep-cli/src/render.ts 转出供全输出面共用。
 * 契约基准: packages/sweep/docs/designs/api-surface.md §2.6 与安全审计 OF-14。
 * 核心红线: 全输出面 (清单 / stderr 诊断 / 配置摘要 / 向导 / 帮助) 必须共用本模块唯一净化实现, 严禁另写第二份。
 */

/**
 * 人类可读体积: 逐级 1024 (B / KB / MB / GB / TB), 保留 1 位小数且整数省略 `.0`; 最小单位 B 取整。
 *
 * ### 数据流转示例
 * - `512` -> `< 1024` 直接取整 -> `'512 B'`
 * - `1536` -> `1536 / 1024 = 1.5` -> `'1.5 KB'`
 * - `383_778_816` (`366 * 1024^2`) -> 两次除 1024 得 `366.0` -> `'366 MB'`
 */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const units = ['KB', 'MB', 'GB', 'TB'];
  let value = bytes;
  let index = -1;
  do {
    value /= 1024;
    index += 1;
  } while (value >= 1024 && index < units.length - 1);
  return `${Math.round(value * 10) / 10} ${units[index]}`;
}

/**
 * 净化行内文本, 全输出面共用的唯一实现 (OF-14):
 * 1. 先剥控制类字符 (C0 含 ESC / DEL、C1、bidi 控制含可视觉反转路径的 RLO、零宽与 BOM),
 *    守住非 TTY 零 ANSI 强契约并防终端序列注入与显示名伪造 (制表符与换行留给下一步);
 * 2. 再把剩余空白 (含换行) 折成单空格并 trim, 防止任意外部路径/错误信息劈行伪造可信输出。
 * 列宽计算与渲染必须消费同一份净化结果, 否则补位错位; 严禁消费方各自另写实现。
 *
 * ### 数据流转示例
 * - Input: `'\u001b[2Jevil\n\tpath\u202espoof '`
 * - 流程: 剥 `\u001b` 与 `\u202e` -> `'[2Jevil\n\tpathspoof '` -> `\s+` 折为单空格并 trim
 * - Output: `'[2Jevil pathspoof'`
 */
export const sanitizeLine = (text: string): string =>
  text
    .replace(
      // 有意匹配控制字符 (C0 / DEL / C1 / bidi / 零宽与 BOM): 剥除即本函数的职责, 非误用
      // eslint-disable-next-line no-control-regex
      /[\u0000-\u0008\u000b-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2066-\u2069\ufeff]/g,
      '',
    )
    .replace(/\s+/g, ' ')
    .trim();

/**
 * 输出行净化 (保留行首空格/Tab 缩进): `sanitizeLine` 的薄包装, 供逐行写出的诊断与提示面调用。
 * 行首缩进用于同组提示分级排版, 其余位置控制字符剥除且换行/空白同样折叠。
 * 示例: `'  \u001b[31m告警\n详情'` -> `'  [31m告警 详情'`
 */
export const sanitizeOutputLine = (text: string): string => {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
  return `${indent}${sanitizeLine(text)}`;
};
