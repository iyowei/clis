/**
 * 零第三方依赖的跨平台回收站通道 (`trash`), 设计见 packages/sweep/docs/adrs/0023-zero-dep-cross-platform-trash.md。
 * 上游: `delete.ts` (`executeTrash`); 下游: 仅依赖 `node:` 内置模块与系统原生能力, 零第三方包/预编译二进制。
 * 绝对红线: 任何平台回收站通道失败或不可用时, 必须返回 `{ ok: false, code: 'TRASH_FAILED', ... }`
 * 并保持磁盘原文件完好不动, **严禁在任何 catch 或降级分支调用永久删除 (`fs.rm`)**。
 * 三端策略: `darwin` 优先 `/usr/bin/trash -s` 缺失再走 `/usr/bin/osascript`; `linux` 纯 TS 实现 XDG Trash 1.0;
 * `win32` 拦截 >= 260 字符路径、剥只读属性后经 PowerShell 调 `FileSystem` 移入回收站 (依赖桩测试验证)。
 */
import { execFile as execFileCb } from 'node:child_process';
import { existsSync as fsExistsSync } from 'node:fs';
import {
  chmod as fsChmod,
  lstat as fsLstat,
  mkdir as fsMkdir,
  readdir as fsReaddir,
  rename as fsRename,
  unlink as fsUnlink,
  writeFile as fsWriteFile,
} from 'node:fs/promises';
import { homedir as osHomedir } from 'node:os';
import { basename, isAbsolute, join, win32 } from 'node:path';

/** Windows Shell / VisualBasic FileSystem 的传统 MAX_PATH 上限 (含末尾 NUL 对应 >= 260 拦截) */
export const WIN32_TRASH_MAX_PATH = 260;

/** macOS 原生 trash 命令绝对路径 (不查 PATH 防劫持) */
export const MACOS_TRASH_BIN = '/usr/bin/trash';

/** macOS 原生 osascript 绝对路径 */
export const MACOS_OSASCRIPT_BIN = '/usr/bin/osascript';

/** 回收站操作结果 (判别联合; 失败时不修改磁盘原文件) */
export type TrashOutcome =
  | { ok: true; target: string; backend: string }
  | {
      ok: false;
      target: string;
      code: 'TRASH_FAILED';
      message: string;
      errno?: string;
    };

/** 子进程执行抽象 (便于全三端桩测试注入) */
export interface TrashExecResult {
  code: number | null;
  stdout: string;
  stderr: string;
  error?: Error & { code?: string };
}

export type TrashExecFn = (
  file: string,
  args: readonly string[],
  env?: NodeJS.ProcessEnv,
) => Promise<TrashExecResult>;

/** 可注入的外部系统与文件系统依赖 (支持三端确定性桩测试) */
export interface TrashDeps {
  platform?: NodeJS.Platform;
  env?: NodeJS.ProcessEnv;
  homedir?: () => string;
  now?: () => Date;
  existsSync?: (path: string) => boolean;
  execFile?: TrashExecFn;
  lstat?: typeof fsLstat;
  readdir?: typeof fsReaddir;
  chmod?: typeof fsChmod;
  mkdir?: typeof fsMkdir;
  writeFile?: typeof fsWriteFile;
  rename?: typeof fsRename;
  unlink?: typeof fsUnlink;
}

export const defaultExecFile: TrashExecFn = (file, args, env) =>
  new Promise((resolve) => {
    execFileCb(
      file,
      [...args],
      {
        encoding: 'utf8',
        windowsHide: true,
        env: env ?? process.env,
        maxBuffer: 1024 * 1024,
      },
      (error, stdout, stderr) => {
        if (error !== null) {
          const rawCode = (error as { code?: unknown }).code;
          const code = typeof rawCode === 'number' ? rawCode : null;
          const normalizedError: Error & { code?: string } = new Error(
            error.message,
            { cause: error },
          );
          normalizedError.name = error.name;
          if (typeof rawCode === 'string') {
            normalizedError.code = rawCode;
          }
          resolve({
            code,
            stdout: stdout ?? '',
            stderr: stderr ?? '',
            error: normalizedError,
          });
          return;
        }
        resolve({ code: 0, stdout: stdout ?? '', stderr: stderr ?? '' });
      },
    );
  });

function failTrash(
  target: string,
  detail: string,
  errno?: string,
): TrashOutcome {
  return {
    ok: false,
    target,
    code: 'TRASH_FAILED',
    message: `移入回收站失败 (${detail}) (目标: ${target}; 已保留原文件, 未执行永久删除)`,
    ...(typeof errno === 'string' && errno !== '' ? { errno } : {}),
  };
}

/** 按 Freedesktop Trash Specification 1.0 对路径做 RFC 2396 URI 编码 (保留 `/`) */
export function encodeXdgTrashPath(targetPath: string): string {
  return targetPath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
}

/** 格式化 XDG `.trashinfo` 规定的本地 DeletionDate (`YYYY-MM-DDTHH:MM:SS`) */
export function formatTrashDeletionDate(date: Date): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return (
    `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** 解析 Linux XDG Trash 根目录 (`$XDG_DATA_HOME/Trash`, 缺省 `~/.local/share/Trash`) */
export function resolveXdgTrashDir(
  env: NodeJS.ProcessEnv,
  home: string,
): string {
  const xdg = env.XDG_DATA_HOME?.trim();
  if (xdg !== undefined && xdg !== '' && isAbsolute(xdg)) {
    return join(xdg, 'Trash');
  }
  return join(home, '.local', 'share', 'Trash');
}

/** macOS: 优先 `/usr/bin/trash -s`, 旧系统缺失时降级 `/usr/bin/osascript` 通知 Finder (argv 传参防注入) */
async function trashMacos(
  target: string,
  deps: Required<Pick<TrashDeps, 'existsSync' | 'execFile' | 'lstat'>>,
): Promise<TrashOutcome> {
  try {
    await deps.lstat(target);
  } catch (error) {
    const rawCode = (error as { code?: unknown }).code;
    const code = typeof rawCode === 'string' ? rawCode : undefined;
    return failTrash(target, `目标不可访问 (${code ?? 'UNKNOWN'})`, code);
  }

  if (deps.existsSync(MACOS_TRASH_BIN)) {
    const res = await deps.execFile(MACOS_TRASH_BIN, ['-s', target]);
    if (res.code === 0 && res.error === undefined) {
      return { ok: true, target, backend: 'macos-trash' };
    }
    const reason =
      res.stderr.trim() || res.error?.message || `退出码 ${String(res.code)}`;
    return failTrash(target, `/usr/bin/trash: ${reason}`, res.error?.code);
  }

  if (!deps.existsSync(MACOS_OSASCRIPT_BIN)) {
    return failTrash(
      target,
      '系统缺少 /usr/bin/trash 与 /usr/bin/osascript 回收站通道',
      'ENOENT',
    );
  }

  const res = await deps.execFile(MACOS_OSASCRIPT_BIN, [
    '-e',
    'on run argv',
    '-e',
    'tell application "Finder" to delete POSIX file (item 1 of argv)',
    '-e',
    'end run',
    '--',
    target,
  ]);
  if (res.code === 0 && res.error === undefined) {
    return { ok: true, target, backend: 'macos-osascript' };
  }
  const reason =
    res.stderr.trim() || res.error?.message || `退出码 ${String(res.code)}`;
  return failTrash(target, `osascript Finder: ${reason}`, res.error?.code);
}

/** Linux: 纯 TS Freedesktop XDG Trash 实现 (`files/` + `info/*.trashinfo` + 原子占位同名冲突处理) */
async function trashLinuxXdg(
  target: string,
  deps: Required<
    Pick<
      TrashDeps,
      | 'env'
      | 'homedir'
      | 'now'
      | 'mkdir'
      | 'writeFile'
      | 'rename'
      | 'unlink'
      | 'lstat'
    >
  >,
): Promise<TrashOutcome> {
  // 确认目标存在 (用 lstat 不跟随软链)
  try {
    await deps.lstat(target);
  } catch (error) {
    const code = (error as { code?: string }).code;
    return failTrash(target, `目标不可访问 (${code ?? 'UNKNOWN'})`, code);
  }

  const trashRoot = resolveXdgTrashDir(deps.env, deps.homedir());
  const filesDir = join(trashRoot, 'files');
  const infoDir = join(trashRoot, 'info');

  try {
    await deps.mkdir(filesDir, { recursive: true });
    await deps.mkdir(infoDir, { recursive: true });
  } catch (error) {
    const code = (error as { code?: string }).code;
    return failTrash(
      target,
      `无法创建 XDG 回收站目录 ${trashRoot} (${code ?? (error as Error).message})`,
      code,
    );
  }

  const base = basename(target);
  const infoContent =
    '[Trash Info]\n' +
    `Path=${encodeXdgTrashPath(target)}\n` +
    `DeletionDate=${formatTrashDeletionDate(deps.now())}\n`;

  let uniqueName: string | null = null;
  let infoPath: string | null = null;

  for (let attempt = 1; attempt <= 10_000; attempt += 1) {
    const candidate = attempt === 1 ? base : `${base}.${attempt}`;
    const candidateInfo = join(infoDir, `${candidate}.trashinfo`);
    const candidateFile = join(filesDir, candidate);

    // 若 files/ 下已有孤立同名残留, 直接跳过递增序号避免覆盖
    let fileOccupied = false;
    try {
      await deps.lstat(candidateFile);
      fileOccupied = true;
    } catch {
      fileOccupied = false;
    }
    if (fileOccupied) continue;

    try {
      await deps.writeFile(candidateInfo, infoContent, {
        encoding: 'utf8',
        flag: 'wx',
      });
      uniqueName = candidate;
      infoPath = candidateInfo;
      break;
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code === 'EEXIST') continue;
      return failTrash(
        target,
        `写入 trashinfo 失败 (${code ?? (error as Error).message})`,
        code,
      );
    }
  }

  if (uniqueName === null || infoPath === null) {
    return failTrash(target, 'XDG 回收站同名冲突超出重试上限');
  }

  const destPath = join(filesDir, uniqueName);
  try {
    await deps.rename(target, destPath);
    return { ok: true, target, backend: 'linux-xdg-trash' };
  } catch (error) {
    // rename 失败 (如 EXDEV 跨设备 / EACCES): 清理刚占位的空 .trashinfo, 原文件严禁删动!
    await deps.unlink(infoPath).catch(() => {});
    const code = (error as { code?: string }).code;
    const hint =
      code === 'EXDEV'
        ? 'EXDEV: 跨文件系统无法原子移入 XDG 回收站'
        : `${code ?? 'UNKNOWN'}: ${(error as Error).message}`;
    return failTrash(target, hint, code);
  }
}

/** 递归剥离目标 (文件或目录树, 不跟随符号链接) 的只读属性, 便于 Windows 回收站接收 */
async function stripReadOnlyAttributes(
  rootTarget: string,
  deps: Required<Pick<TrashDeps, 'lstat' | 'readdir' | 'chmod'>>,
): Promise<void> {
  const stack: string[] = [rootTarget];
  while (stack.length > 0) {
    const current = stack.pop()!;
    let st;
    try {
      st = await deps.lstat(current);
    } catch {
      continue;
    }
    if (st.isSymbolicLink()) continue;
    await deps.chmod(current, st.isDirectory() ? 0o777 : 0o666).catch(() => {});
    if (st.isDirectory()) {
      let entries;
      try {
        entries = await deps.readdir(current, { withFileTypes: true });
      } catch {
        continue;
      }
      for (const entry of entries) {
        if (!entry.isSymbolicLink()) {
          stack.push(join(current, entry.name));
        }
      }
    }
  }
}

/** 解析 Windows 系统 PowerShell 绝对路径 (避免裸名从被扫 cwd 劫持) */
export function resolveWindowsPowerShell(
  env: NodeJS.ProcessEnv,
  existsSync: (path: string) => boolean,
): string | null {
  const sysRoot = env.SystemRoot ?? env.WINDIR ?? 'C:\\Windows';
  const builtin = win32.join(
    sysRoot,
    'System32',
    'WindowsPowerShell',
    'v1.0',
    'powershell.exe',
  );
  if (existsSync(builtin)) return builtin;
  return null;
}

/**
 * Windows: 超 260 字符路径前置拦截 + 剥离 Read-Only + PowerShell 调用 Microsoft.VisualBasic.FileIO.FileSystem。
 * 注意: 本分支未在 Windows 宿主机真机实测, 须依赖桩/逻辑测试覆盖并在交付说明显式标注。
 */
async function trashWindows(
  target: string,
  deps: Required<
    Pick<
      TrashDeps,
      'env' | 'existsSync' | 'execFile' | 'lstat' | 'readdir' | 'chmod'
    >
  >,
): Promise<TrashOutcome> {
  if (target.length >= WIN32_TRASH_MAX_PATH) {
    return failTrash(
      target,
      `路径长度 ${target.length} 达到或超过 Windows 回收站 ${WIN32_TRASH_MAX_PATH} 字符限制`,
      'ENAMETOOLONG',
    );
  }

  let isDir = false;
  try {
    const st = await deps.lstat(target);
    isDir = st.isDirectory();
  } catch (error) {
    const code = (error as { code?: string }).code;
    return failTrash(target, `目标不可访问 (${code ?? 'UNKNOWN'})`, code);
  }

  const psBin = resolveWindowsPowerShell(deps.env, deps.existsSync);
  if (psBin === null) {
    return failTrash(
      target,
      '未找到系统 Windows PowerShell 回收站通道',
      'ENOENT',
    );
  }

  await stripReadOnlyAttributes(target, deps);

  const method = isDir ? 'DeleteDirectory' : 'DeleteFile';
  const command =
    'Add-Type -AssemblyName Microsoft.VisualBasic; ' +
    `[Microsoft.VisualBasic.FileIO.FileSystem]::${method}(` +
    "$env:SWEEP_TRASH_TARGET, 'OnlyErrorDialogs', 'SendToRecycleBin')";

  const res = await deps.execFile(
    psBin,
    ['-NoProfile', '-NonInteractive', '-Command', command],
    { ...deps.env, SWEEP_TRASH_TARGET: target },
  );
  if (res.code === 0 && res.error === undefined) {
    return { ok: true, target, backend: 'win32-powershell-vb' };
  }
  const reason =
    res.stderr.trim() || res.error?.message || `退出码 ${String(res.code)}`;
  return failTrash(target, `PowerShell 回收站: ${reason}`, res.error?.code);
}

/**
 * 将单个已通过安全闸与路径复核的目标移入当前平台回收站 (`injected` 供三端桩测试注入)。
 * 红线: 任何失败均返回 `{ ok: false, code: 'TRASH_FAILED' }` 且保留磁盘原文件, 绝不静默降级为 `fs.rm`。
 *
 * ### 数据流转示例
 * ```text
 * Input: target = '/w/demo/cache', injected = { platform }
 * 分支 1 (darwin):
 *   存在 /usr/bin/trash -> execFile('/usr/bin/trash', ['-s', target]) -> ok: true, backend: 'macos-trash'
 *   缺失 /usr/bin/trash -> 降级 /usr/bin/osascript 经 argv 通知 Finder -> ok: true, backend: 'macos-osascript'
 * 分支 2 (linux):
 *   lstat 核验存在 -> 定位 $XDG_DATA_HOME/Trash -> wx 独占占位 info/<name>.trashinfo
 *   -> rename 移入 files/<name> -> ok: true, backend: 'linux-xdg-trash'
 *   (若 rename 报 EXDEV 跨设备 -> unlink 空 .trashinfo, 返回 TRASH_FAILED 且原文件完好)
 * 分支 3 (win32):
 *   拦截 length >= 260 (ENAMETOOLONG) -> lstat 判文件/目录 -> 定位 System32 PowerShell -> 递归剥离只读属性
 *   -> 经环境变量 SWEEP_TRASH_TARGET 调 FileSystem::DeleteDirectory/DeleteFile(..., 'SendToRecycleBin')
 *   -> ok: true, backend: 'win32-powershell-vb'
 * 分支 4 (其他平台 / 任意通道失败):
 *   Output: { ok: false, target, code: 'TRASH_FAILED', message: '...已保留原文件, 未执行永久删除', errno? }
 * ```
 */
export async function moveToTrash(
  target: string,
  injected: TrashDeps = {},
): Promise<TrashOutcome> {
  const platform = injected.platform ?? process.platform;
  const deps = {
    env: injected.env ?? process.env,
    homedir: injected.homedir ?? osHomedir,
    now: injected.now ?? (() => new Date()),
    existsSync: injected.existsSync ?? fsExistsSync,
    execFile: injected.execFile ?? defaultExecFile,
    lstat: injected.lstat ?? fsLstat,
    readdir: injected.readdir ?? fsReaddir,
    chmod: injected.chmod ?? fsChmod,
    mkdir: injected.mkdir ?? fsMkdir,
    writeFile: injected.writeFile ?? fsWriteFile,
    rename: injected.rename ?? fsRename,
    unlink: injected.unlink ?? fsUnlink,
  };

  if (platform === 'darwin') {
    return trashMacos(target, deps);
  }
  if (platform === 'linux') {
    return trashLinuxXdg(target, deps);
  }
  if (platform === 'win32') {
    return trashWindows(target, deps);
  }
  return failTrash(target, `当前平台 (${platform}) 暂不支持系统回收站`);
}
