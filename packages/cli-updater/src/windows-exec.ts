/**
 * Windows 平台包管理器安全调用封装 (纯函数, 无平台硬编码副作用):
 * 1. 优先绕开 .cmd/.bat 壳层, 直调 node.exe + npm-cli.js / pnpm.cjs / yarn.js;
 * 2. 必须经 ComSpec (/d /s /c) 调用 .cmd/.bat 时, 构造适配 `windowsVerbatimArguments: true`
 *    的单串命令 `""<batchPath>" <escapedArgs>"`, 防空格断句、元字符 (&|<>^()%!) 注入与
 *    .cmd 内部 `%*` 二次展开漏洞。
 */
import { win32 } from 'node:path';

import { type PackageManager } from './detect.ts';

/** 单个可执行的底层调用结构 */
export interface PmInvocation {
  command: string;
  args: string[];
  /** Windows .cmd/.bat 经 ComSpec /d /s /c 调用时为 true */
  windowsVerbatimArguments?: boolean;
}

/** 校验 Windows 绝对路径 (仅允许盘符绝对路径或 UNC 路径, 拒绝 Git Bash /usr/bin 盘根相对路径) */
export function isWin32AbsolutePath(dir: string): boolean {
  return /^(?:[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/.test(dir);
}

/** cmd.exe 敏感元字符集合 */
const CMD_META_OR_SPACE_RE = /[\s&|<>^()%!]/;

/** 无法在 cmd.exe 批处理命令行中安全转义的危险字符 */
const CMD_FORBIDDEN_RE = /[\r\n\0"]/;

/** 将字符串包裹进双引号, 并将末尾连续反斜杠加倍防闭合引号被吞 */
function wrapDoubleQuotes(segment: string): string {
  const escaped = segment.replace(/(\\+)$/, '$1$1');
  return `"${escaped}"`;
}

/**
 * 转义 Windows .cmd/.bat 自身路径 (位于第一层 cmd.exe 命令行):
 * - 路径整体用双引号保护, 空格、()、&|<>^ 在双引号内作为字面路径字符不触发断句;
 * - 仅将双引号内仍可能展开的 `%` / `!` 拆出引号用 `^` 转义。
 */
function escapeBatchPath(batchPath: string): string | null {
  if (batchPath === '' || CMD_FORBIDDEN_RE.test(batchPath)) return null;
  if (!/[%!]/.test(batchPath)) return wrapDoubleQuotes(batchPath);

  let out = '';
  let buf = '';
  for (const ch of batchPath) {
    if (ch === '%' || ch === '!') {
      if (buf !== '') {
        out += wrapDoubleQuotes(buf);
        buf = '';
      }
      out += `^${ch}`;
    } else {
      buf += ch;
    }
  }
  if (buf !== '') out += wrapDoubleQuotes(buf);
  return out;
}

/**
 * 转义传入 .cmd/.bat 的单个参数 (防御外层 cmd.exe 与 .cmd 内部 `%*` 双层解析):
 * - 无空白与 cmd 元字符的常规参数原样返回;
 * - 含空白或 `&|<>^()` 的参数以双引号保护, 穿透两层 cmd 解析不触发断句或命令链接;
 * - 含 `%` / `!` 时拆出引号使用 `^^^%` / `^^^!` 防止两层环境变量或延迟扩展展开。
 */
function escapeBatchArg(arg: string): string | null {
  if (CMD_FORBIDDEN_RE.test(arg)) return null;
  if (arg === '') return '""';
  if (!CMD_META_OR_SPACE_RE.test(arg)) return arg;
  if (!/[%!]/.test(arg)) return wrapDoubleQuotes(arg);

  let out = '';
  let buf = '';
  for (const ch of arg) {
    if (ch === '%' || ch === '!') {
      if (buf !== '') {
        out += wrapDoubleQuotes(buf);
        buf = '';
      }
      out += `^^^${ch}`;
    } else {
      buf += ch;
    }
  }
  if (buf !== '') out += wrapDoubleQuotes(buf);
  return out;
}

/**
 * 构造搭配 `cmd.exe /d /s /c` + `windowsVerbatimArguments: true` 使用的完整单串命令。
 * 外层额外包裹一对 `"..."`, 供 `/s` 剥除后留下完整的 `"<batchPath>" <escapedArgs>`。
 */
export function buildWindowsBatchCommandLine(
  batchPath: string,
  pmArgs: readonly string[],
): string | null {
  const escapedPath = escapeBatchPath(batchPath);
  if (escapedPath === null) return null;

  const escapedArgs: string[] = [];
  for (const arg of pmArgs) {
    const escaped = escapeBatchArg(arg);
    if (escaped === null) return null;
    escapedArgs.push(escaped);
  }

  const inner =
    escapedArgs.length === 0
      ? escapedPath
      : `${escapedPath} ${escapedArgs.join(' ')}`;
  return `"${inner}"`;
}

/** 在同目录或 PATH 中解析原生 node.exe */
function resolveNodeExeForDir(
  dir: string,
  isFile: (path: string) => boolean,
  findNativeNode: () => string | null,
): string | null {
  const sibling = win32.join(dir, 'node.exe');
  if (isFile(sibling)) return sibling;
  return findNativeNode();
}

/** 根据找到的 .cmd/.bat 批处理目录探测 npm / pnpm / yarn 相邻 JS 入口, 优先直调 node.exe 绕开 cmd.exe */
export function resolveWindowsBatchDirectJs(
  pm: PackageManager,
  batchPath: string,
  args: readonly string[],
  isFile: (path: string) => boolean,
  findNativeNode: () => string | null,
): PmInvocation | null {
  const dir = win32.dirname(batchPath);
  let candidates: string[] = [];
  if (pm === 'npm') {
    candidates = [win32.join(dir, 'node_modules', 'npm', 'bin', 'npm-cli.js')];
  } else if (pm === 'pnpm') {
    candidates = [
      win32.join(dir, 'node_modules', 'pnpm', 'bin', 'pnpm.cjs'),
      win32.join(dir, 'node_modules', 'corepack', 'dist', 'pnpm.js'),
    ];
  } else if (pm === 'yarn') {
    candidates = [
      win32.join(dir, 'yarn.js'),
      win32.join(dir, 'node_modules', 'yarn', 'bin', 'yarn.js'),
      win32.join(dir, 'node_modules', 'corepack', 'dist', 'yarn.js'),
    ];
  } else {
    return null;
  }

  for (const entryJs of candidates) {
    if (!isFile(entryJs)) continue;
    const nodeExe = resolveNodeExeForDir(dir, isFile, findNativeNode);
    if (nodeExe !== null) {
      return { command: nodeExe, args: [entryJs, ...args] };
    }
  }
  return null;
}

/**
 * 构造 Windows .cmd/.bat 的最终安全调用 (先试直调 JS 入口, 否则走 ComSpec /d /s /c 单串)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  pm = 'npm', batchPath = 'C:\\Program Files\\nodejs\\npm.cmd', pmArgs = ['install', '-g', '@iyowei/codd-cli@1.3.0']
 * 分支 A (存在相邻 npm-cli.js 与 node.exe):
 *   Output -> { command: 'C:\\Program Files\\nodejs\\node.exe', args: ['...\\npm-cli.js', 'install', '-g', '@iyowei/codd-cli@1.3.0'] }
 * 分支 B (无相邻 JS 入口, 兜底 ComSpec):
 *   Output -> { command: 'cmd.exe', args: ['/d', '/s', '/c', '""C:\\Program Files\\nodejs\\npm.cmd" install -g @iyowei/codd-cli@1.3.0"'], windowsVerbatimArguments: true }
 * ```
 */
export function resolveWindowsBatchInvocation(
  pm: PackageManager,
  batchPath: string,
  pmArgs: readonly string[],
  env: NodeJS.ProcessEnv,
  isFile: (path: string) => boolean,
  findNativeNode: () => string | null,
): PmInvocation | null {
  const directJs = resolveWindowsBatchDirectJs(
    pm,
    batchPath,
    pmArgs,
    isFile,
    findNativeNode,
  );
  if (directJs !== null) return directJs;

  const cmdLine = buildWindowsBatchCommandLine(batchPath, pmArgs);
  if (cmdLine === null) return null;
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', cmdLine],
    windowsVerbatimArguments: true,
  };
}
