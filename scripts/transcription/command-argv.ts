/**
 * 转写契约套件 · 外部命令字符串解析与相对路径绝对化 (run-conformance / run-diff-fuzz 共享单源)。
 *
 * 支持单/双引号包裹含空格路径, 遇到未闭合引号显式抛错 (绝不静默截断);
 * 绝对化规则保守: 跳过 argv[0] (命令名留给 PATH 解析)、绝对路径与 `-` 开头旗标,
 * 仅当相对启动目录真实存在时才绝对化 (防止被测进程切换 cwd 到 fixture 后找不到相对入口脚本)。
 */
import { existsSync } from 'node:fs';
import { isAbsolute, resolve } from 'node:path';

/** 将带引号的命令字符串切分为 argv 数组; 存在未闭合引号时抛错 */
export function splitCommandArgv(raw: string): string[] {
  const parts: string[] = [];
  let current = '';
  let quote: string | null = null;
  for (let index = 0; index < raw.length; index += 1) {
    const ch = raw[index]!;
    if (quote !== null) {
      if (ch === quote) quote = null;
      else current += ch;
      continue;
    }
    if (ch === '"' || ch === "'") {
      quote = ch;
      continue;
    }
    if (/\s/.test(ch)) {
      if (current !== '') {
        parts.push(current);
        current = '';
      }
      continue;
    }
    current += ch;
  }
  if (quote !== null) {
    throw new Error(`命令字符串存在未闭合引号 (${quote}): ${raw}`);
  }
  if (current !== '') parts.push(current);
  return parts;
}

/** 把 argv 中按启动目录书写的相对路径参数绝对化 */
export function absolutizeCommandArgv(
  argv: readonly string[],
  launchDir: string,
): string[] {
  return argv.map((part, index) => {
    if (index === 0 || isAbsolute(part) || part.startsWith('-')) return part;
    const candidate = resolve(launchDir, part);
    return existsSync(candidate) ? candidate : part;
  });
}

/** 一步完成带引号切分 + 启动目录相对路径绝对化 */
export function resolveCommandArgv(raw: string, launchDir: string): string[] {
  return absolutizeCommandArgv(splitCommandArgv(raw), launchDir);
}
