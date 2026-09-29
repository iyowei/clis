/**
 * 展示辅助 (纯函数, 零 IO, 无打印): 人类可读体积与输出面净化。
 * 契约基准: docs/designs/api-surface.md §2.6; OF-14 的「唯一实现」义务落此 ——
 * 全输出面 (CLI 清单 / 诊断 stderr / config 报告 / 向导 / 帮助 / 内嵌方) 共用同一实现,
 * 各面一律经此, 严禁另写一份。本模块自 CLI 包 render.ts 上移 (逻辑逐字未动),
 * render.ts 转出转发以保持既有消费方写法不变。
 */

/**
 * 人类可读体积: 逐级 1024 (B / KB / MB / GB / TB), 保留 1 位小数、整数省略小数尾
 * (对齐示意里的 "4.6 GB" 与 "366 MB" 两种形态); 最小单位 B 取整。
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
 * 净化行内文本, 全输出面共用的唯一实现 (清单 / 诊断 stderr / config 报告 / 向导 / 帮助的默认配置位置行):
 * 先剥控制类字符 (C0 含 ESC / DEL、C1、bidi 控制含可视觉反转路径的 RLO、零宽与 BOM) ——
 * 既守住非 TTY 零 ANSI 强契约, 也防终端控制序列注入 (改标题 / 清屏 / 光标回写覆盖已打印内容)
 * 与显示名伪造; 制表与换行留给下一步。
 * 再把剩余空白 (含换行) 折成单空格, 使任意输入都压成一行: 既撑不破清单行结构, 也不让一条告警
 * 被换行劈成两行、伪造出一行可信输出 (非 TTY 下 stderr 常被 tee / CI 原样落盘, 日后回放同样生效)。
 * 列宽计算与渲染必须用同一份净化结果, 否则补位错位。
 * 消费方一律经此函数, 严禁各自另写一份 (两份实现必然漂移, 且漂移方向通常是漏剥控制字符)。
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
 * 输出行净化 (保留行首缩进): sanitizeLine 的薄包装, 供逐行写出的诊断与提示面调用。
 * 行首缩进是本工具自带的分级手段 (告警详情行 / 中性提示行压在同组首行之下), 属排版而非外部数据,
 * 不该被净化吞掉; 行内其余位置的空白仍折成单空格, 换行同样折叠。
 */
export const sanitizeOutputLine = (text: string): string => {
  const indent = /^[ \t]*/.exec(text)?.[0] ?? '';
  return `${indent}${sanitizeLine(text)}`;
};
