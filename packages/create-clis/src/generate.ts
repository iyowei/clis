/**
 * 项目生成主流程: 目标校验 -> 复制快照 -> 载体还原 -> 按档裁剪 -> 代入变量 -> 格式化收口 -> 二道自检 -> 收尾 hooks。
 *
 * 上游由 `cli.ts` 调用, 下游串联 `template-snapshot.ts` / `tier.ts` / `render.ts` 与跨平台子进程收尾。
 * 关键约束: 目标已存在且非空抛 `TargetRejectedError` (未写入, 不得谎报半成品); 写入后失败保留半成品;
 * 紧贴 `cpSync` 还原 `_gitignore`/`_npmrc` 载体名 (避开 npm 打包机制剔除); 用生成器自带 prettier 收口,
 * 且二道自检先于 git init / bun install, 避免坏产物被收尾动作固化。
 */
import { spawnSync } from 'node:child_process';
import {
  chmodSync,
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmSync,
  rmdirSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve, win32 } from 'node:path';
import { fileURLToPath } from 'node:url';

import type * as Prettier from 'prettier';

import { cleanGitEnv } from '../../../scripts/lib/git-env.ts';
import {
  TEMPLATE_VOCABULARY,
  type Vocabulary,
  containsResidual,
  renderTemplate,
} from './render.ts';
import {
  fromCarrierPath,
  listTemplateDirs,
  listTemplateFiles,
} from './template-snapshot.ts';
import { type Tier, pruneTemplate, removeRulesFor } from './tier.ts';

/** 收尾动作: 由调用方注入真实实现, 未提供的动作不执行 */
export interface GenerateHooks {
  /** 在产物目录执行 git init (默认收尾; --no-git 时不提供) */
  gitInit?: (targetDir: string) => Promise<void> | void;
  /** 在产物目录安装依赖 (默认收尾; --no-install 时不提供) */
  install?: (targetDir: string) => Promise<void> | void;
}

export interface GenerateOptions {
  /** 模板快照目录 (通常为包内 assets/template, 测试可注入) */
  templateDir: string;
  /** 生成目标目录 (须不存在或为空) */
  targetDir: string;
  /** 用户词汇 (替换的目标值) */
  vocabulary: Vocabulary;
  /** 装备档位 (裁剪规则见 tier.ts) */
  tier: Tier;
  /** 原项目词汇 (二道自检的残留判据) */
  original: Vocabulary;
  /** 收尾动作 (缺省 = 全部跳过) */
  hooks?: GenerateHooks;
}

export interface GenerateResult {
  /** 实际执行过的收尾动作 (按执行顺序, 供调用方如实汇报) */
  executed: string[];
}

/**
 * 目标目录不可用 (已存在且非空 / 是文件): 生成尚未开始写入, 目标目录未被动过。
 * 调用方据此区分「拒绝类失败」与「写入后失败」: 前者不得向用户谎报半成品
 * (那是用户自己的目录), 只有后者才提示半成品保留。
 */
export class TargetRejectedError extends Error {}

/** 目标目录可用性: 不存在即通过; 已存在且非空或非目录即拒绝 (无 --force, 覆盖风险远大于便利) */
export function assertTargetAvailable(targetDir: string): void {
  if (!existsSync(targetDir)) return;
  if (!statSync(targetDir).isDirectory()) {
    throw new TargetRejectedError(`目标路径已存在且不是目录: ${targetDir}`);
  }
  if (readdirSync(targetDir).length > 0) {
    throw new TargetRejectedError(
      `目标目录已存在且非空: ${targetDir} (不覆盖已有目录; 请换一个目录或先清空)`,
    );
  }
}

/**
 * 代入变量: 模板占位词汇 (`{{NAME}}` 系) 替换为用户词汇, 文件路径与内容一并过替换面
 * (包目录 `packages/{{NAME}}/`、bin 文件 `{{BIN_NAME}}.mjs` 等都在路径里)。
 * 路径变名的旧文件删除, 末了按路径长度降序 (先深后浅) 删掉遗留的空目录。
 * 外部副作用: 原地重写 targetDir 内文件 (含改名与删空目录)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  files = ['packages/{{NAME}}/package.json', 'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs']
 *         vocabulary = { name: 'demo-tool', scope: '@demo', binName: 'dt', owner: 'demouser',
 *                        repoUrl: 'https://github.com/demouser/demo-tool' }
 * Step 1: 逐文件对相对路径与内容执行 renderTemplate(..., vocabulary, TEMPLATE_VOCABULARY)
 *         'packages/{{NAME}}/package.json' -> 'packages/demo-tool/package.json'
 *         内容 '"name": "{{SCOPE}}/{{NAME}}"' -> '"name": "@demo/demo-tool"'
 * Step 2: 路径变化时写新文件 (保留 mode) 并删旧文件, 末尾自底向上 rmdir 空壳目录
 * Output: targetDir 内路径与内容均完成占位代入
 * ```
 */
function substituteVocabulary(targetDir: string, vocabulary: Vocabulary): void {
  for (const rel of listTemplateFiles(targetDir)) {
    const srcPath = join(targetDir, rel);
    const { mode } = statSync(srcPath);
    const next = renderTemplate(rel, vocabulary, TEMPLATE_VOCABULARY);
    const source = readFileSync(srcPath, 'utf8');
    const rendered = renderTemplate(source, vocabulary, TEMPLATE_VOCABULARY);
    if (next === rel) {
      if (rendered !== source) writeFileSync(srcPath, rendered, { mode });
      continue;
    }
    const destination = join(targetDir, next);
    mkdirSync(dirname(destination), { recursive: true });
    writeFileSync(destination, rendered, { mode });
    if (process.platform !== 'win32') chmodSync(destination, mode);
    rmSync(srcPath);
  }
  // 先深后浅 (路径长度降序即深度降序): 只有子目录清空后父目录才可能空
  for (const rel of listTemplateDirs(targetDir).sort(
    (left, right) => right.length - left.length,
  )) {
    const full = join(targetDir, rel);
    if (existsSync(full) && readdirSync(full).length === 0) rmdirSync(full);
  }
}

/**
 * 载体还原: 把模板的落包载体名 (如 `_gitignore`) 改回 npm 打包机制剔除的真实名 (`.gitignore`);
 * 非载体名原样不动。只改名, 不动内容。
 * 外部副作用: 原地重命名 targetDir 内文件 (仅命中载体表的路径)。
 */
function restoreCarrierNames(targetDir: string): void {
  for (const rel of listTemplateFiles(targetDir)) {
    const restored = fromCarrierPath(rel);
    if (restored === rel) continue;
    renameSync(join(targetDir, rel), join(targetDir, restored));
  }
}

/**
 * 格式化收口: 按产物自带的 `.prettierrc` / `.prettierignore` 对全树跑一遍 prettier,
 * 使替换与裁剪后的产物回到 prettier 稳定态 (生成物 format-check 的直接前提)。
 * 插件取生成器自带的绝对路径 (产物的 `.prettierrc` 只声明插件名, 此刻依赖未装解析不到)。
 * 外部副作用: 按格式化结果原地重写 targetDir 内文件 (仅变更文件落盘)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  root/.prettierrc + 可选 root/.prettierignore + targetDir 全树模板文件
 * Step 1: 解析生成器内 `@trivago/prettier-plugin-sort-imports` 绝对路径并合并 `.prettierrc`
 * Step 2: 逐文件调 getFileInfo (跳过 ignored 或无 parser 文件), 格式化有变化的文件写回
 * Output: return void (targetDir 全树回到 prettier 稳定态)
 * ```
 */
async function formatTree(root: string): Promise<void> {
  const configPath = join(root, '.prettierrc');
  if (!existsSync(configPath)) {
    throw new Error(
      `模板缺少 .prettierrc: 无可用的格式化收口配置 (模板形态预期不符)`,
    );
  }
  const prettier = await import('prettier');
  const prettierPlugin = createRequire(import.meta.url).resolve(
    '@trivago/prettier-plugin-sort-imports',
  );
  const raw = JSON.parse(readFileSync(configPath, 'utf8')) as Prettier.Options;
  const options: Prettier.Options = { ...raw, plugins: [prettierPlugin] };
  const ignorePath = join(root, '.prettierignore');
  const fileInfoOptions: Prettier.FileInfoOptions = {
    plugins: [prettierPlugin],
    resolveConfig: false,
  };
  if (existsSync(ignorePath)) fileInfoOptions.ignorePath = ignorePath;

  for (const rel of listTemplateFiles(root)) {
    const filePath = join(root, rel);
    const info = await prettier.getFileInfo(filePath, fileInfoOptions);
    if (info.ignored || info.inferredParser === null) continue;
    const source = readFileSync(filePath, 'utf8');
    let output: string;
    try {
      output = await prettier.format(source, {
        ...options,
        filepath: filePath,
      });
    } catch (error) {
      throw new Error(
        `格式化收口失败于 ${rel}: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
    if (output !== source) writeFileSync(filePath, output);
  }
}

/**
 * 二道自检: 生成物全树扫描, 路径与内容均不得残留模板占位形态 (含 `TEMPLATE_VOCABULARY` 原始字面量
 * 兜底检查) 与原项目词汇。原词汇判据传入 `vocabulary` 遮蔽合法同名/超集取值 (如用户 owner 与本仓同名),
 * 避免误报同时仍能抓出同文件混杂的真残留。
 */
function assertNoResidual(
  targetDir: string,
  vocabulary: Vocabulary,
  original: Vocabulary,
): void {
  const placeholderLiterals = Object.values(TEMPLATE_VOCABULARY).filter(
    (value): value is string => typeof value === 'string' && value.length > 0,
  );
  const leftovers: string[] = [];
  for (const rel of listTemplateFiles(targetDir)) {
    const text = readFileSync(join(targetDir, rel), 'utf8');
    const hasPlaceholder =
      containsResidual(rel, TEMPLATE_VOCABULARY) ||
      containsResidual(text, TEMPLATE_VOCABULARY) ||
      placeholderLiterals.some(
        (literal) => rel.includes(literal) || text.includes(literal),
      );
    if (hasPlaceholder) {
      leftovers.push(`${rel} (模板占位形态残留)`);
    }
    if (
      containsResidual(rel, original, vocabulary) ||
      containsResidual(text, original, vocabulary)
    ) {
      leftovers.push(`${rel} (原项目词汇残留)`);
    }
  }
  if (leftovers.length > 0) {
    throw new Error(
      `二道自检未过, 生成物仍含未替换形态:\n  ${leftovers.join('\n  ')}`,
    );
  }
}

/** 收尾: 按调用方提供的 hook 逐项执行 (顺序即执行序), 返回实际执行过的动作名 */
async function runHooks(
  hooks: GenerateHooks,
  targetDir: string,
): Promise<string[]> {
  const executed: string[] = [];
  if (hooks.gitInit !== undefined) {
    await hooks.gitInit(targetDir);
    executed.push('git init');
  }
  if (hooks.install !== undefined) {
    await hooks.install(targetDir);
    executed.push('依赖安装');
  }
  return executed;
}

/**
 * 生成独立的新项目目录 (全流程见文件头)。
 *
 * 失败语义: 目标不可用抛 `TargetRejectedError` (未写入); 写入开始后任一步抛错即中止,
 * 已落盘的半成品目录保留 (不静默清理), 由调用方如实指出。
 *
 * ### 数据流转示例
 * ```text
 * Input:  options = { templateDir: '<pkg>/assets/template', targetDir: '/work/my-tool',
 *                     vocabulary: { name: 'my-tool', ..., binName: 'my-tool' }, tier: 'core',
 *                     original: ORIGINAL, hooks: { gitInit: fn } }
 * Step 1: assertTargetAvailable('/work/my-tool') -> cpSync 快照 -> restoreCarrierNames (_gitignore/_npmrc 还原)
 * Step 2: pruneTemplate(core) 删 transcription/、tech-debt.md、lint-dependency-direction.{ts,test.ts},
 *         同步摘除 ci.ts 的 conformance 与 lint:deps 步骤、根 package.json 的 conformance 脚本与 workflow 的 conformance job
 * Step 3: substituteVocabulary 代入用户词汇 -> formatTree 跑 prettier -> assertNoResidual 零残留自检
 * Step 4: runHooks 执行 gitInit -> executed = ['git init']
 * Output: return { executed: ['git init'] }
 * ```
 */
export async function generateProject(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const { templateDir, targetDir, vocabulary, tier, original } = options;

  assertTargetAvailable(targetDir);
  cpSync(templateDir, targetDir, { recursive: true });
  restoreCarrierNames(targetDir);
  pruneTemplate(targetDir, removeRulesFor(tier));
  substituteVocabulary(targetDir, vocabulary);
  await formatTree(targetDir);
  assertNoResidual(targetDir, vocabulary, original);

  const executed = await runHooks(options.hooks ?? {}, targetDir);
  return { executed };
}

const WIN32_ABS_DIR_RE = /^(?:[A-Za-z]:[/\\]|\\\\[^\\]+\\[^\\]+)/;
const WIN32_HOOK_EXTS = ['.exe', '.com', '.cmd'] as const;

const isFileAt = (filePath: string): boolean => {
  try {
    return statSync(filePath).isFile();
  } catch {
    return false;
  }
};

/** 清洗安装期环境变量: 剥离 npm_execpath 与 npm_lifecycle_* 防宿主包管理器上下文干扰 bun install */
export function cleanInstallEnv(
  sourceEnv: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [key, value] of Object.entries(sourceEnv)) {
    if (value === undefined) continue;
    const lower = key.toLowerCase();
    if (lower === 'npm_execpath' || lower.startsWith('npm_lifecycle_')) {
      continue;
    }
    env[key] = value;
  }
  return env;
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

/** 拆分含 `%` / `!` 的片段: 常规段双引号保护, 仅将 `%` / `!` 拆出引号并以指定前缀转义 */
function escapePercentAndBang(value: string, prefix: '^' | '^^^'): string {
  let out = '';
  let buf = '';
  for (const ch of value) {
    if (ch === '%' || ch === '!') {
      if (buf !== '') {
        out += wrapDoubleQuotes(buf);
        buf = '';
      }
      out += `${prefix}${ch}`;
    } else {
      buf += ch;
    }
  }
  if (buf !== '') out += wrapDoubleQuotes(buf);
  return out;
}

/** 转义 Windows .cmd/.bat 自身路径 (第一层 cmd.exe 解析: 常规段双引号保护, `%` / `!` 拆出用 `^`) */
function escapeBatchPath(batchPath: string): string {
  if (batchPath === '' || CMD_FORBIDDEN_RE.test(batchPath)) {
    throw new Error(
      'Windows 批处理路径包含非法控制字符或双引号, 拒绝经 cmd.exe 执行',
    );
  }
  if (!/[%!]/.test(batchPath)) return wrapDoubleQuotes(batchPath);
  return escapePercentAndBang(batchPath, '^');
}

/** 转义传入 .cmd/.bat 的单个参数 (防御外层 cmd.exe 与 .cmd 内部 `%*` 双层解析) */
function escapeBatchArg(arg: string): string {
  if (CMD_FORBIDDEN_RE.test(arg)) {
    throw new Error(
      'Windows 批处理参数包含非法控制字符或双引号, 拒绝经 cmd.exe 执行',
    );
  }
  if (arg === '') return '""';
  if (!CMD_META_OR_SPACE_RE.test(arg)) return arg;
  if (!/[%!]/.test(arg)) return wrapDoubleQuotes(arg);
  return escapePercentAndBang(arg, '^^^');
}

/**
 * 构造安全的 Windows cmd.exe 批处理调用 (对齐 packages/cli-updater/src/windows-exec.ts):
 * 搭配 `cmd.exe /d /s /c` + `windowsVerbatimArguments: true`, 外层额外包一对 `"..."` 供 `/s` 剥离。
 */
export function buildBatchInvocation(
  batchPath: string,
  args: readonly string[],
  env: Record<string, string> = {},
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  const escapedPath = escapeBatchPath(batchPath);
  const escapedArgs = args.map((arg) => escapeBatchArg(arg));
  const inner =
    escapedArgs.length === 0
      ? escapedPath
      : `${escapedPath} ${escapedArgs.join(' ')}`;
  const comspec = env.ComSpec?.trim() || env.COMSPEC?.trim() || 'cmd.exe';
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${inner}"`],
    windowsVerbatimArguments: true,
  };
}

/**
 * 跨平台解析收尾 hook 可执行文件:
 * - POSIX 直接按裸名走 execvp;
 * - Windows 严格按绝对 PATH 依次查找 .exe / .com / .cmd (规避盘根相对路径与裸名 cwd 劫持)。
 */
export function resolveHookCommand(
  name: string,
  options: {
    platform?: NodeJS.Platform;
    pathEnv?: string;
    fileProbe?: (candidate: string) => boolean;
  } = {},
): { command: string; isBatch: boolean } {
  const platform = options.platform ?? process.platform;
  if (platform !== 'win32') return { command: name, isBatch: false };
  const pathEnv = options.pathEnv ?? process.env.PATH ?? process.env.Path ?? '';
  const fileProbe = options.fileProbe ?? isFileAt;
  for (const raw of pathEnv.split(';')) {
    const dir =
      raw.length > 1 && raw.startsWith('"') && raw.endsWith('"')
        ? raw.slice(1, -1)
        : raw;
    if (dir === '' || !WIN32_ABS_DIR_RE.test(dir)) continue;
    for (const ext of WIN32_HOOK_EXTS) {
      const candidate = win32.join(dir, `${name}${ext}`);
      if (fileProbe(candidate)) {
        return { command: candidate, isBatch: ext === '.cmd' };
      }
    }
  }
  return { command: name, isBatch: false };
}

/** 供测试注入的子进程执行结果最小形状 */
export interface HookSpawnResult {
  status: number | null;
  signal: NodeJS.Signals | null;
  error?: Error;
  stderr?: string | Buffer | null;
}

/** 供测试注入的子进程执行器签名 */
export type HookSpawner = (
  command: string,
  args: readonly string[],
  options: {
    cwd: string;
    encoding?: 'utf8';
    stdio?: 'inherit';
    env: Record<string, string>;
    windowsVerbatimArguments?: boolean;
  },
) => HookSpawnResult;

const defaultSpawner: HookSpawner = (command, args, options) =>
  spawnSync(command, args, options);

/**
 * git init 收尾 hook (默认收尾): 清洗 GIT_* 环境变量后静默初始化, 缺失或失败清晰报错。
 * 外部副作用: 在 targetDir 建 .git 目录 (启动一次 git 子进程)。
 */
export function createGitInitHook(
  spawner: HookSpawner = defaultSpawner,
): (targetDir: string) => void {
  return (targetDir) => {
    const env = cleanGitEnv();
    const resolved = resolveHookCommand('git', {
      pathEnv: env.PATH ?? env.Path ?? '',
    });
    const invocation = resolved.isBatch
      ? buildBatchInvocation(resolved.command, ['init', '--quiet'], env)
      : {
          command: resolved.command,
          args: ['init', '--quiet'],
          windowsVerbatimArguments: false,
        };
    const result = spawner(invocation.command, invocation.args, {
      cwd: targetDir,
      encoding: 'utf8',
      env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          'git init 失败: 未找到 git 可执行文件 (请先安装 git, 或使用 --no-git 跳过)',
        );
      }
      throw new Error(`git init 启动失败: ${result.error.message}`);
    }
    if (result.status !== 0) {
      const rawStderr = result.stderr;
      const stderr = (
        typeof rawStderr === 'string'
          ? rawStderr
          : (rawStderr?.toString('utf8') ?? '')
      ).trim();
      const detail = stderr.length > 0 ? `: ${stderr}` : '';
      throw new Error(
        `git init 失败 (退出码 ${String(result.status ?? result.signal)})${detail}`,
      );
    }
  };
}

/**
 * 解析独立脚本安装或当前 Bun 宿主下的兜底 Bun 可执行文件:
 * 当用户在无全局 Bun 的裸机通过一键脚本安装 `create-clis` 时, 优先回退当前 Bun 进程自身 (`process.execPath`)
 * 或相邻隔离目录 `<dataDir>/runtime/bun(.exe)`, 确保默认 `bun install` 收尾开箱可用。
 */
export function resolveFallbackBunExecutable(
  options: {
    isBunProcess?: boolean;
    execPath?: string;
    moduleUrl?: string;
    platform?: NodeJS.Platform;
    fileProbe?: (candidate: string) => boolean;
  } = {},
): string | null {
  const isBunProc =
    options.isBunProcess ?? typeof process.versions.bun === 'string';
  const execPath = options.execPath ?? process.execPath;
  const probe = options.fileProbe ?? isFileAt;
  if (isBunProc && typeof execPath === 'string' && probe(execPath)) {
    return execPath;
  }
  const platform = options.platform ?? process.platform;
  const bunBin = platform === 'win32' ? 'bun.exe' : 'bun';
  try {
    const selfPath = fileURLToPath(options.moduleUrl ?? import.meta.url);
    const pkgRoot = dirname(dirname(selfPath));
    const siblingRuntimeBun = resolve(pkgRoot, '..', '..', 'runtime', bunBin);
    if (probe(siblingRuntimeBun)) {
      return siblingRuntimeBun;
    }
  } catch {
    // 非 file: URL 场景忽略
  }
  return null;
}

/**
 * 依赖安装收尾 hook (默认收尾): 产物是 bun 工程 (packageManager 声明 bun), 用 bun install。
 * 清洗 npm_execpath / npm_lifecycle_* 环境变量, 兼容 Windows .exe/.com/.cmd,
 * 全局 PATH 无 bun 时自动回退当前/隔离私有 Bun, 仍缺失再给出清晰指引。
 * 外部副作用: 在 targetDir 安装依赖 (stdio 透传给用户看进度)。
 */
export function createInstallHook(
  spawner: HookSpawner = defaultSpawner,
  fallbackResolver: () => string | null = () => resolveFallbackBunExecutable(),
): (targetDir: string) => void {
  return (targetDir) => {
    process.stdout.write('  安装依赖 (bun install) ...\n');
    const env = cleanInstallEnv();
    const resolved = resolveHookCommand('bun', {
      pathEnv: env.PATH ?? env.Path ?? '',
    });
    const invocation = resolved.isBatch
      ? buildBatchInvocation(resolved.command, ['install'], env)
      : {
          command: resolved.command,
          args: ['install'],
          windowsVerbatimArguments: false,
        };
    let result = spawner(invocation.command, invocation.args, {
      cwd: targetDir,
      stdio: 'inherit',
      env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
    if (
      result.error !== undefined &&
      (result.error as NodeJS.ErrnoException).code === 'ENOENT'
    ) {
      const fallbackBun = fallbackResolver();
      if (fallbackBun !== null && fallbackBun !== invocation.command) {
        result = spawner(fallbackBun, ['install'], {
          cwd: targetDir,
          stdio: 'inherit',
          env,
          windowsVerbatimArguments: false,
        });
      }
    }
    if (result.error !== undefined) {
      const code = (result.error as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        throw new Error(
          `依赖安装失败: 未找到 bun 可执行文件 (生成物为 bun 工程, 请先安装 bun: https://bun.sh, ` +
            `或使用 --no-install 跳过后进入 ${targetDir} 手动安装)`,
        );
      }
      throw new Error(
        `依赖安装启动失败: ${result.error.message}; 产物已生成完整, 可进入 ${targetDir} 重跑 bun install`,
      );
    }
    if (result.status !== 0) {
      throw new Error(
        `依赖安装失败 (退出码 ${String(result.status ?? result.signal)}); 产物已生成完整, ` +
          `可进入 ${targetDir} 重跑 bun install`,
      );
    }
  };
}
