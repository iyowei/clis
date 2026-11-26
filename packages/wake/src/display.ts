/**
 * 终端行级输出消毒助手 (OF-14): 剥除来自主机名、配置或远端 stderr 的控制序列与 C0 字符, 防 ANSI 欺骗与换行注入。
 */

const ESC = String.fromCharCode(0x1b);
const CSI_RE = new RegExp(`${ESC}\\[[0-9;?]*[ -/]*[@-~]`, 'g');
const OSC_RE = new RegExp(`${ESC}\\][^${ESC}\\x07]*(?:\\x07|${ESC}\\\\)`, 'g');
const CTRL_RE = /\p{Cc}/gu;

/** 单行外部文本消毒 (剥离 ANSI/OSC 并压缩控制字符为空格) */
export function sanitizeLine(raw: string): string {
  return raw
    .replace(OSC_RE, '')
    .replace(CSI_RE, '')
    .replace(CTRL_RE, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}
