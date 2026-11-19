/**
 * 跨包管理器安装来源探测器: 仅依据包真实磁盘路径、启动入口路径、包管理器环境根与
 * 可选动态全局根目录探针来判定「本 CLI 是被谁装进来的」。
 *
 * 关键不变量: 绝不依据当前进程运行时 (`process.versions.bun` / `node`) 猜测安装器!
 * clis 启动器均为 Bun 优先, 即使用户经 npm / pnpm / yarn / volta 安装, 运行时仍可能是 Bun;
 * 唯一真相来源是包本体在磁盘上的真实落位路径。
 */
import { existsSync, realpathSync } from 'node:fs';
import { join } from 'node:path';

/** 支持自更新执行的包管理器 / 工具管理器 */
export type PackageManager = 'bun' | 'npm' | 'pnpm' | 'yarn' | 'volta';

/** 支持手动指定的所有包管理器集合 (供参数校验与帮助复用) */
export const SUPPORTED_PACKAGE_MANAGERS: readonly PackageManager[] = [
  'bun',
  'npm',
  'pnpm',
  'yarn',
  'volta',
];

/** 临时一次性执行器类型 */
export type EphemeralRunner = 'npx' | 'bunx' | 'pnpm-dlx' | 'yarn-dlx' | 'deno';

/** 项目本地依赖建议的包管理器 */
export type ProjectPackageManager = 'bun' | 'pnpm' | 'yarn' | 'npm';

/** 安装来源判定结果 */
export type InstallOrigin =
  | {
      kind: 'global';
      pm: PackageManager;
      reason: string;
      packageRoot: string;
    }
  | {
      kind: 'ephemeral';
      runner: EphemeralRunner;
      reason: string;
      packageRoot: string;
    }
  | {
      kind: 'source';
      reason: string;
      packageRoot: string;
    }
  | {
      kind: 'local-project';
      projectDir: string;
      suggestedPm: ProjectPackageManager;
      reason: string;
      packageRoot: string;
    }
  | {
      kind: 'unknown';
      reason: string;
      packageRoot: string;
    };

/** 动态探测出的包管理器全局根目录映射 (用于自定义 prefix 兜底) */
export type GlobalRootMap = Partial<Record<PackageManager, string>>;

/** 路径探测输入 (全部可注入, 便于无副作用跨平台单元测试) */
export interface DetectOriginInput {
  /** 解析软链后的真实包根目录 */
  packageRoot: string;
  /** 可选: 未解软链的原始包目录或入口脚本路径 (保留 shim / 软链目录线索) */
  rawPaths?: readonly string[];
  /** 环境变量 (默认 process.env) */
  env?: NodeJS.ProcessEnv;
  /** 文件存在探针 (默认 existsSync) */
  pathExists?: (path: string) => boolean;
  /** 可选: 已实查到的自定义全局根目录映射 */
  globalRoots?: GlobalRootMap;
  /** 可选: realpath 解析器 (默认 safeRealpath, 便于跨平台单测覆盖 8.3 短路径展开) */
  realpath?: (path: string) => string;
}

/** `<prefix>/lib/node_modules` 启发式兜底原因常量 (供 resolveOrigin 识别是否需要动态复核) */
export const LIB_NODE_MODULES_HEURISTIC_REASON =
  '命中标准 <prefix>/lib/node_modules 全局目录';

/** 路径归一为 POSIX 分隔符并剥离尾部斜杠 */
export function normalizeSlashes(path: string): string {
  return path.replaceAll('\\', '/').replace(/\/+$/, '');
}

/** 跨平台大小写折叠路径 (仅用于目录特征与前缀比较) */
function foldPath(path: string): string {
  return normalizeSlashes(path).toLowerCase();
}

/** 判定 child 是否位于 parent 目录之下 (按路径边界比对, 避免字符串前缀误伤) */
export function isWithinDir(child: string, parent: string): boolean {
  const normParent = foldPath(parent);
  if (normParent === '') return false;
  const normChild = foldPath(child);
  return normChild === normParent || normChild.startsWith(`${normParent}/`);
}

/** 提取去重后的低可信辅助路径候选 (剔除已包含的真实包根) */
function collectRawFoldedCandidates(
  foldedRoot: string,
  rawPaths: readonly string[] | undefined,
): string[] {
  const seen = new Set<string>([foldedRoot]);
  const out: string[] = [];
  for (const raw of rawPaths ?? []) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const folded = foldPath(raw);
    if (!seen.has(folded)) {
      seen.add(folded);
      out.push(folded);
    }
  }
  return out;
}

/** 展开目录原值及其 realpath 变体 (兼容软链及 Windows 8.3 短路径 RUNNER~1) */
function expandRootVariants(
  root: string,
  realpath: (path: string) => string,
): string[] {
  const trimmed = root.trim();
  if (trimmed === '') return [];
  const out = [trimmed];
  const resolved = realpath(trimmed);
  if (foldPath(resolved) !== foldPath(trimmed)) {
    out.push(resolved);
  }
  return out;
}

/** 检查是否命中临时一次性运行目录 (npx / bunx / pnpm dlx / yarn dlx / deno) */
function detectEphemeral(
  candidates: readonly string[],
  packageRoot: string,
): InstallOrigin | null {
  for (const p of candidates) {
    if (p.includes('/_npx/')) {
      return {
        kind: 'ephemeral',
        runner: 'npx',
        reason: '位于 npx 临时缓存目录 (_npx)',
        packageRoot,
      };
    }
    if (p.includes('/bunx-')) {
      return {
        kind: 'ephemeral',
        runner: 'bunx',
        reason: '位于 bunx 临时执行目录',
        packageRoot,
      };
    }
    if (
      p.includes('/pnpm/dlx/') ||
      p.includes('/pnpm-cache/dlx/') ||
      p.includes('/pnpm-dlx/')
    ) {
      return {
        kind: 'ephemeral',
        runner: 'pnpm-dlx',
        reason: '位于 pnpm dlx 临时缓存目录',
        packageRoot,
      };
    }
    if (
      (p.includes('/xfs-') && p.includes('/dlx-')) ||
      (p.includes('/berry/cache/') && p.includes('/dlx'))
    ) {
      return {
        kind: 'ephemeral',
        runner: 'yarn-dlx',
        reason: '位于 yarn dlx 临时执行目录',
        packageRoot,
      };
    }
    if (p.includes('/deno/npm/')) {
      return {
        kind: 'ephemeral',
        runner: 'deno',
        reason: '位于 Deno npm 缓存目录 (/deno/npm/)',
        packageRoot,
      };
    }
  }
  return null;
}

interface EnvRootRule {
  pm: PackageManager;
  roots: string[];
  reason: string;
}

/** 构造已展开 realpath 的包管理器环境根规则 (NPM_CONFIG_PREFIX 收紧至 (lib/)?node_modules) */
function buildEnvRootRules(
  env: NodeJS.ProcessEnv,
  realpath: (path: string) => string,
): EnvRootRule[] {
  const rules: EnvRootRule[] = [];
  const directSpecs: readonly (readonly [
    PackageManager,
    string | undefined,
    string,
  ])[] = [
    ['volta', env.VOLTA_HOME, '位于环境变量 VOLTA_HOME 目录内'],
    ['bun', env.BUN_INSTALL, '位于环境变量 BUN_INSTALL 目录内'],
    [
      'bun',
      env.BUN_INSTALL_GLOBAL_DIR,
      '位于环境变量 BUN_INSTALL_GLOBAL_DIR 目录内',
    ],
    ['pnpm', env.PNPM_HOME, '位于环境变量 PNPM_HOME 目录内'],
  ];

  for (const [pm, rawRoot, reason] of directSpecs) {
    if (rawRoot === undefined || rawRoot.trim() === '') continue;
    const roots = expandRootVariants(rawRoot, realpath);
    if (roots.length > 0) rules.push({ pm, roots, reason });
  }

  const npmPrefix = env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix;
  if (npmPrefix !== undefined && npmPrefix.trim() !== '') {
    const npmRoots: string[] = [];
    for (const base of expandRootVariants(npmPrefix, realpath)) {
      const norm = normalizeSlashes(base);
      if (norm === '') continue;
      npmRoots.push(`${norm}/lib/node_modules`, `${norm}/node_modules`);
    }
    if (npmRoots.length > 0) {
      rules.push({
        pm: 'npm',
        roots: npmRoots,
        reason: '位于环境变量 NPM_CONFIG_PREFIX 目录内',
      });
    }
  }

  return rules;
}

/** 依据包管理器显式环境变量根匹配全局安装来源 (外层按候选优先级, 内层遍历各 PM) */
function detectFromEnvRoots(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv,
  packageRoot: string,
  realpath: (path: string) => string,
): InstallOrigin | null {
  if (candidates.length === 0) return null;
  const rules = buildEnvRootRules(env, realpath);
  for (const candidate of candidates) {
    for (const rule of rules) {
      if (rule.roots.some((root) => isWithinDir(candidate, root))) {
        return {
          kind: 'global',
          pm: rule.pm,
          reason: rule.reason,
          packageRoot,
        };
      }
    }
  }
  return null;
}

/** 各包管理器标准全局路径片段表 (全 OS 折叠小写形态) */
const GLOBAL_PATH_SIGNATURES: readonly (readonly [
  PackageManager,
  readonly string[],
  string,
])[] = [
  [
    'volta',
    ['/.volta/tools/', '/volta/tools/', '/.volta/bin/', '/volta/bin/'],
    '命中 Volta 全局工具安装目录',
  ],
  [
    'bun',
    ['/.bun/install/global/', '/.bun/bin/'],
    '命中 Bun 全局安装目录 (~/.bun)',
  ],
  [
    'pnpm',
    [
      '/pnpm/global/',
      '/library/pnpm/global/',
      '/.local/share/pnpm/global/',
      '/appdata/local/pnpm/global/',
      '/pnpm-global/',
    ],
    '命中 pnpm 全局安装目录',
  ],
  [
    'yarn',
    [
      '/.config/yarn/global/',
      '/yarn/data/global/',
      '/yarn/config/global/',
      '/yarn/global/',
      '/.yarn/global/',
    ],
    '命中 Yarn 全局安装目录',
  ],
  [
    'npm',
    [
      '/appdata/roaming/npm/node_modules/',
      '/usr/local/lib/node_modules/',
      '/usr/lib/node_modules/',
      '/opt/homebrew/lib/node_modules/',
      '/.nvm/versions/node/',
      '/nvm4w/',
      '/fnm/node-versions/',
      '/.fnm/node-versions/',
      '/fnm_multishells/',
      '/.asdf/installs/nodejs/',
      '/.local/share/mise/installs/node/',
      '/.mise/installs/node/',
      '/mise/installs/node/',
      '/.nodenv/versions/',
      '/.n/lib/node_modules/',
      '/program files/nodejs/node_modules/',
      '/scoop/apps/nodejs/',
    ],
    '命中 npm 全局安装目录',
  ],
];

/** 依据各 OS 标准全局路径特征匹配 (外层按候选优先级, 内层遍历各 PM) */
function detectFromStandardPaths(
  candidates: readonly string[],
  packageRoot: string,
): InstallOrigin | null {
  for (const candidate of candidates) {
    for (const [pm, markers, reason] of GLOBAL_PATH_SIGNATURES) {
      if (markers.some((marker) => candidate.includes(marker))) {
        return { kind: 'global', pm, reason, packageRoot };
      }
    }
  }
  return null;
}

/** 依据动态实查到的包管理器全局目录映射做前缀比对 (外层按候选优先级, 内层遍历各 PM) */
function detectFromGlobalRoots(
  candidates: readonly string[],
  globalRoots: GlobalRootMap | undefined,
  packageRoot: string,
  realpath: (path: string) => string,
): InstallOrigin | null {
  if (globalRoots === undefined || candidates.length === 0) return null;
  for (const candidate of candidates) {
    for (const pm of SUPPORTED_PACKAGE_MANAGERS) {
      const root = globalRoots[pm];
      if (root === undefined || root.trim() === '') continue;
      const variants = expandRootVariants(root, realpath);
      if (variants.some((v) => isWithinDir(candidate, v))) {
        return {
          kind: 'global',
          pm,
          reason: `匹配 ${pm} 实查全局目录 (${root})`,
          packageRoot,
        };
      }
    }
  }
  return null;
}

/** 兜底识别自定义 prefix 的 POSIX npm 树: <prefix>/lib/node_modules/<pkg>, 且 <prefix> 非项目根 */
function detectFromLibNodeModulesHeuristic(
  packageRoot: string,
  pathExists: (path: string) => boolean,
): InstallOrigin | null {
  const libIdx = packageRoot.toLowerCase().lastIndexOf('/lib/node_modules/');
  if (libIdx <= 0) return null;
  const prefixDir = packageRoot.slice(0, libIdx);
  if (pathExists(join(prefixDir, 'package.json'))) return null;
  return {
    kind: 'global',
    pm: 'npm',
    reason: LIB_NODE_MODULES_HEURISTIC_REASON,
    packageRoot,
  };
}

/** 按项目根目录锁文件推导推荐包管理器 */
function detectProjectPm(
  projectDir: string,
  pathExists: (path: string) => boolean,
): ProjectPackageManager {
  if (
    pathExists(join(projectDir, 'bun.lock')) ||
    pathExists(join(projectDir, 'bun.lockb'))
  ) {
    return 'bun';
  }
  if (pathExists(join(projectDir, 'pnpm-lock.yaml'))) return 'pnpm';
  if (pathExists(join(projectDir, 'yarn.lock'))) return 'yarn';
  return 'npm';
}

/** 对单组路径候选依次尝试: 显式环境变量根 → 标准全局路径 → 动态实查全局根 */
function detectGlobalForCandidates(
  candidates: readonly string[],
  input: {
    env: NodeJS.ProcessEnv;
    globalRoots?: GlobalRootMap;
    packageRoot: string;
    realpath: (path: string) => string;
  },
): InstallOrigin | null {
  if (candidates.length === 0) return null;
  return (
    detectFromEnvRoots(
      candidates,
      input.env,
      input.packageRoot,
      input.realpath,
    ) ??
    detectFromStandardPaths(candidates, input.packageRoot) ??
    detectFromGlobalRoots(
      candidates,
      input.globalRoots,
      input.packageRoot,
      input.realpath,
    )
  );
}

/**
 * 纯判定函数: 依据包路径、原始软链/入口路径、环境变量与可选实查全局目录,
 * 确定本 CLI 的安装来源。
 *
 * 判定优先级 (由确定性最高到最低):
 * 1. 本地源码开发态 (真实包根不在 node_modules 且含 src/cli.ts — 含 npm/bun link 软链开发态);
 * 2. 临时一次性运行目录 (npx / bunx / pnpm dlx / yarn dlx / deno);
 * 3. 高可信真实 packageRoot 完整匹配 (环境变量全局根 → 标准全局路径特征 → 动态实查全局目录);
 * 4. 低可信 rawPaths / argv[1] 完整匹配 (仅高可信均未命中时回退);
 * 5. 标准 `<prefix>/lib/node_modules/` 启发式兜底 (置于动态实查之后, 避免抢跑自定义非 npm 目录);
 * 6. 业务项目本地 node_modules 依赖 (宿主持有 package.json);
 * 7. 无法唯一定位 (unknown, 安全拒绝盲装, 引导用 --pm 显式指定)。
 */
export function detectInstallOriginFromPath(
  input: DetectOriginInput,
): InstallOrigin {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;
  const realpath = input.realpath ?? safeRealpath;
  const packageRoot = normalizeSlashes(input.packageRoot);
  const foldedRoot = packageRoot.toLowerCase();
  const rawCandidates = collectRawFoldedCandidates(foldedRoot, input.rawPaths);

  // 1. 源码开发态 (覆盖直接跑 src/cli.ts、~/.local/bin 软链及 npm/bun link 软链进全局)
  if (
    !foldedRoot.includes('/node_modules/') &&
    pathExists(join(input.packageRoot, 'src', 'cli.ts'))
  ) {
    return {
      kind: 'source',
      reason: '包根目录位于本地源码工作树 (存在 src/cli.ts)',
      packageRoot,
    };
  }

  // 2. 临时一次性运行器 (npx / bunx / pnpm dlx / yarn dlx / deno)
  const ephemeral = detectEphemeral(
    [foldedRoot, ...rawCandidates],
    packageRoot,
  );
  if (ephemeral !== null) return ephemeral;

  // 3. 高可信真实包根优先跑完 env → standard → globalRoots
  const fromRoot = detectGlobalForCandidates([foldedRoot], {
    env,
    globalRoots: input.globalRoots,
    packageRoot,
    realpath,
  });
  if (fromRoot !== null) return fromRoot;

  // 4. 仅当高可信包根未命中时, 再以低可信 rawPaths / argv[1] 兜底判定
  const fromRaw = detectGlobalForCandidates(rawCandidates, {
    env,
    globalRoots: input.globalRoots,
    packageRoot,
    realpath,
  });
  if (fromRaw !== null) return fromRaw;

  // 5. `<prefix>/lib/node_modules/` 启发式兜底 (位于动态实查之后)
  const fromHeuristic = detectFromLibNodeModulesHeuristic(
    packageRoot,
    pathExists,
  );
  if (fromHeuristic !== null) return fromHeuristic;

  // 6. 业务项目本地依赖 (<project>/node_modules/<pkg>, 取首个 /node_modules/ 防 .pnpm 嵌套)
  const nmIdx = foldedRoot.indexOf('/node_modules/');
  if (nmIdx > 0) {
    const projectDir = packageRoot.slice(0, nmIdx);
    if (pathExists(join(projectDir, 'package.json'))) {
      return {
        kind: 'local-project',
        projectDir,
        suggestedPm: detectProjectPm(projectDir, pathExists),
        reason: `位于项目本地 node_modules (${projectDir})`,
        packageRoot,
      };
    }
  }

  return {
    kind: 'unknown',
    reason: '未匹配已知全局包管理器路径或本地源码工作树',
    packageRoot,
  };
}

/** 解析真实路径 (优先 realpathSync.native 展开 Windows 8.3 短路径; 不可解析时回退原值) */
export function safeRealpath(path: string): string {
  try {
    const fn = realpathSync.native ?? realpathSync;
    return fn(path);
  } catch {
    return path;
  }
}
