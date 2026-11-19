/**
 * 生成主流程: 复制模板快照 → 载体还原 → 按档裁剪 → 代入变量 → 格式化收口 → 二道自检 → 收尾。
 *
 * 顺序与失败语义以 docs/designs/scaffold-contract.md 为权威: 目标目录已存在且非空直接拒绝
 * (不覆盖, 该路径抛 TargetRejectedError —— 生成尚未写入, 目标目录未被动过); 写入开始后任一步
 * 失败即抛错, 已产生的半成品目录保留不清理 (由调用方如实指出, 用户可自行查看)。
 * 收尾动作经 hooks 注入 (git init / 依赖安装), 未提供的 hook 视为不执行 —— 调用方据此把
 * --no-git / --no-install 折算成 hook 的存在与否, 执行过的动作由返回值如实带回。
 *
 * 与初稿 spec 流程的三处差异, 2026-10-01 已同步进契约文档的流程 (见 docs/designs/
 * scaffold-contract.md): ① 二道自检前置于收尾 (spec 列在收尾之后; 此处取更稳的读法: 残留
 * 未清就不做 git init / 装依赖, 免坏产物被收尾动作固化); ② 多出「格式化收口」一步 (T4 / T5
 * 移交, 见下); ③ 多出「载体还原」一步 (T8 发行面修复, 见下)。
 *
 * 载体还原 (T8, TD-05 的修复面): 模板资产里 npm 面包机制剔除的真实名 (.gitignore / .npmrc)
 * 以载体名随包 (见 template-snapshot.ts 的 ASSET_CARRIERS); 复制进产物目录后立刻还原成真实名,
 * 使后续每一步 (裁剪 / 替换 / 格式化 / 自检) 与用户看到的产物都是真实项目形态。时序上取
 * 「紧贴 cpSync」而非更晚: 还原是落包改名的逆变换, 越早还原, 管道其余环节越少感知载体名;
 * 裁剪与替换的路径面本就不含这两个文件 (裁剪面是 transcription 目录与技术债册子; 替换面是
 * 词汇形态), 故前移不改变它们的既有行为。
 *
 * 格式化收口 (T4 / T5 移交): 占位符替换与档位裁剪都会改变行宽与结构 (如单元素组数组),
 * 产物须回到 prettier 稳定态才过生成物自己的 format-check; 收口用生成器自带的 prettier
 * 与同版本插件 (此时产物尚未安装依赖, 不依赖产物侧 node_modules)。
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
import { dirname, join, win32 } from 'node:path';

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
 * 代入变量: 模板占位词汇 ({{NAME}} 系) 替换为用户词汇, 文件路径与内容一并过替换面
 * (包目录 packages/{{NAME}}/、bin 文件 {{BIN_NAME}}.mjs 等都在路径里)。
 * 路径变名的旧文件删除, 末了自底向上清掉遗留的空目录 (如 packages/{{NAME}}/ 改名后的空壳)。
 * 外部副作用：原地重写 targetDir 内文件 (含改名与删空目录)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   targetDir 内文件 = ['packages/{{NAME}}/package.json', 'packages/{{NAME}}-cli/bin/{{BIN_NAME}}.mjs']
 *   vocabulary = { name: 'demo-tool', scope: '@demo', binName: 'dt', owner: 'demouser',
 *                  repoUrl: 'https://github.com/demouser/demo-tool' }
 *
 * 步骤 1：逐文件算目标路径与内容 (最长匹配替换, 见 render.ts)
 *   'packages/{{NAME}}/package.json' → 'packages/demo-tool/package.json' (改路径)
 *   内容 '"name": "{{SCOPE}}/{{NAME}}"' → '"name": "@demo/demo-tool"'
 *
 * 步骤 2：落盘改名 (写新路径 + 删旧文件), 末了清空目录
 *   packages/{{NAME}}/ 空壳与 packages/{{NAME}}-cli/ 空壳被 rmdir
 *
 * Output（数据契约）
 *   targetDir 内路径与内容均不含模板占位形态 (由二道自检背书)
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
 * 载体还原: 把模板的落包载体名 (如 `_gitignore`) 改回 npm 面包机制剔除的真实名 (`.gitignore`);
 * 非载体名原样不动。理由与时序见文件头「载体还原」; 只改名, 不动内容。
 * 外部副作用：原地重命名 targetDir 内文件 (仅命中载体表的两类路径)。
 */
function restoreCarrierNames(targetDir: string): void {
  for (const rel of listTemplateFiles(targetDir)) {
    const restored = fromCarrierPath(rel);
    if (restored === rel) continue;
    renameSync(join(targetDir, rel), join(targetDir, restored));
  }
}

/**
 * 格式化收口: 按产物自带的 .prettierrc / .prettierignore 对全树跑一遍 prettier,
 * 使替换与裁剪后的产物回到 prettier 稳定态 (生成物 format-check 的直接前提)。
 * 插件取生成器自带的绝对路径 (产物的 .prettierrc 只声明插件名, 此刻依赖未装解析不到)。
 * 外部副作用：按格式化结果原地重写 targetDir 内文件 (仅变更文件落盘)。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   root/.prettierrc = { tabWidth: 2, singleQuote: true, plugins: ['@trivago/...'] }
 *   待格式化文件 = ['scripts/ci.ts', 'CHANGELOG.md', ...]  (94 个)
 *
 * 步骤 1：取配置与忽略面
 *   config = { ..., plugins: ['<生成器包内 @trivago/... 绝对路径>'] }
 *   'CHANGELOG.md' → getFileInfo: { ignored: true } → 跳过 (与产物 prettier --check 同口径)
 *
 * 步骤 2：逐文件格式化 (仅变更文件写回)
 *   'scripts/ci.ts' 的 CONFORMANCE_GROUP 单元素数组收正为 ['build']
 *
 * Output（数据契约）
 *   return void; targetDir 全树通过 prettier --check (由 e2e 与 T8 heavy-smoke 在产物内实跑背书)
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
 * 二道自检: 生成物全树扫描, 路径与内容都不得残留模板占位形态 (替换完整性) 与原项目词汇
 * (替换方向正确性)。快照构建侧已保证模板干净, 这一步是替换面的第二道防线。
 * 原词汇判据排除与用户词汇取值重合的形态 —— 二者同名是合法配置 (如用户 owner 与本仓 owner
 * 同名), 生成物出现同名值是预期结果, 不得误报。
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
 * 失败语义: 任一步抛错即中止, 已落盘的半成品目录保留 (不静默清理), 由调用方如实指出。
 *
 * ### 数据追踪示例
 * ```text
 * Input（真实 Payload）
 *   options = { templateDir: '<pkg>/assets/template', targetDir: '/work/my-tool',
 *               vocabulary: { name: 'my-tool', ..., binName: 'mt' }, tier: 'core',
 *               original: ORIGINAL, hooks: { gitInit: fn } }
 *
 * 步骤 1：目标可用性 → 复制快照 → 载体还原 → 按档裁剪
 *   '/work/my-tool' 不存在 ✓ (非空即抛错)
 *   targetDir 内出现 94 个模板文件, 其中 _gitignore / _npmrc 还原为 .gitignore / .npmrc
 *   core 档删除 scripts/transcription/ 与 docs/designs/tech-debt.md 并摘除 ci.ts 的 conformance 步骤声明
 *
 * 步骤 2：代入变量 → 格式化收口 → 二道自检
 *   packages/{{NAME}}/ → packages/my-tool/; 占位形态全数替换为用户词汇
 *   行宽 / 结构偏离回到 prettier 稳定态; 全树零残留自检通过
 *
 * 步骤 3：收尾 hooks
 *   gitInit('/work/my-tool') 执行成功 → executed = ['git init']
 *
 * Output（数据契约）
 *   return { executed: ['git init'] }  // 供 CLI 汇报与 e2e 断言
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

/** 构造安全的 Windows cmd.exe 批处理命令行 (逐元字符转义并用最外层引号包裹防 /s 剥离) */
function escapeCmdMeta(value: string): string {
  return value.replace(/[&|<>^()%!]/g, '^$&');
}

function buildBatchInvocation(
  batchPath: string,
  args: readonly string[],
  env: Record<string, string>,
): { command: string; args: string[]; windowsVerbatimArguments: boolean } {
  const comspec = env.ComSpec ?? env.COMSPEC ?? 'cmd.exe';
  const quoted = [batchPath, ...args]
    .map((item) => `"${escapeCmdMeta(item)}"`)
    .join(' ');
  return {
    command: comspec,
    args: ['/d', '/s', '/c', `"${quoted}"`],
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
 * 外部副作用：在 targetDir 建 .git 目录 (启动一次 git 子进程)。
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
 * 依赖安装收尾 hook (默认收尾): 产物是 bun 工程 (packageManager 声明 bun), 用 bun install。
 * 清洗 npm_execpath / npm_lifecycle_* 环境变量, 兼容 Windows .exe/.com/.cmd, 缺 bun 给出清晰指引。
 * 外部副作用：在 targetDir 安装依赖 (stdio 透传给用户看进度)。
 */
export function createInstallHook(
  spawner: HookSpawner = defaultSpawner,
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
    const result = spawner(invocation.command, invocation.args, {
      cwd: targetDir,
      stdio: 'inherit',
      env,
      windowsVerbatimArguments: invocation.windowsVerbatimArguments,
    });
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
