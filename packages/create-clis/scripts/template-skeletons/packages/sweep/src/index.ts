/**
 * 示例包入口 (模板骨架): 展示最小可用的可编程 API 形状 —— 具名导出 + 参数对象 + 纯函数净化。
 *
 * 生成后的项目应把它替换为自己的领域实现 (并同步包 README 与包级文档)。
 * 注意: 模板内的代码标识符避开与占位词汇同名的插值形态, 防生成期变量替换误伤。
 */

/** 问候选项 */
export interface GreetOptions {
  /** 要问候的名字 */
  who: string;
}

/** 判定字符是否属于控制字符或 bidi 伪造符 */
const isControlOrBidi = (code: number): boolean =>
  code <= 0x1f ||
  (code >= 0x7f && code <= 0x9f) ||
  (code >= 0x200b && code <= 0x200f) ||
  (code >= 0x202a && code <= 0x202e) ||
  (code >= 0x2066 && code <= 0x2069) ||
  code === 0xfeff;

/** 剥除 ANSI / 控制字符 / bidi 伪造符并折叠空白 (供示例 API 与增强档差分模糊测试复用) */
export const normalizeWho = (raw: string): string => {
  const esc = String.fromCharCode(27);
  const bel = String.fromCharCode(7);
  const noAnsi = raw
    .replace(new RegExp(`${esc}\\[[0-9;?]*[ -/]*[@-~]`, 'g'), '')
    .replace(new RegExp(`${esc}\\][^${bel}]*(?:${bel}|${esc}\\\\)`, 'g'), '');
  let stripped = '';
  for (const ch of noAnsi) {
    const code = ch.codePointAt(0) ?? 0;
    stripped += isControlOrBidi(code) ? ' ' : ch;
  }
  const cleaned = stripped.replace(/\s+/g, ' ').trim();
  return cleaned === '' ? 'world' : cleaned;
};

/** 生成一句问候语 (示例实现, 无外部依赖) */
export const greet = ({ who }: GreetOptions): string =>
  `Hello, ${normalizeWho(who)}!`;
