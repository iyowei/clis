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
export type EphemeralRunner = 'npx' | 'bunx' | 'pnpm-dlx' | 'yarn-dlx';

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
}

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

/** 合并并去重待检验的折叠路径候选 (真实包根优先, 附带原始入口/软链路径) */
function collectFoldedCandidates(input: DetectOriginInput): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const raw of [input.packageRoot, ...(input.rawPaths ?? [])]) {
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const folded = foldPath(raw);
    if (!seen.has(folded)) {
      seen.add(folded);
      out.push(folded);
    }
  }
  return out;
}

/** 检查是否命中临时一次性运行目录 (npx / bunx / pnpm dlx / yarn dlx) */
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
  }
  return null;
}

/** 依据包管理器显式环境变量根匹配全局安装来源 */
function detectFromEnvRoots(
  candidates: readonly string[],
  env: NodeJS.ProcessEnv,
  packageRoot: string,
): InstallOrigin | null {
  const checks: readonly (readonly [
    PackageManager,
    string | undefined,
    string,
  ])[] = [
    ['volta', env.VOLTA_HOME, '位于环境变量 VOLTA_HOME 目录内'],
    ['bun', env.BUN_INSTALL, '位于环境变量 BUN_INSTALL 目录内'],
    ['pnpm', env.PNPM_HOME, '位于环境变量 PNPM_HOME 目录内'],
    [
      'npm',
      env.NPM_CONFIG_PREFIX ?? env.npm_config_prefix,
      '位于环境变量 NPM_CONFIG_PREFIX 目录内',
    ],
  ];
  for (const [pm, root, reason] of checks) {
    if (root === undefined || root.trim() === '') continue;
    for (const candidate of candidates) {
      if (isWithinDir(candidate, root)) {
        return { kind: 'global', pm, reason, packageRoot };
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
      '/.nodenv/versions/',
      '/.n/lib/node_modules/',
      '/program files/nodejs/node_modules/',
      '/scoop/apps/nodejs/',
    ],
    '命中 npm 全局安装目录',
  ],
];

/** 依据各 OS 标准全局路径特征匹配 */
function detectFromStandardPaths(
  candidates: readonly string[],
  packageRoot: string,
  pathExists: (path: string) => boolean,
): InstallOrigin | null {
  for (const [pm, markers, reason] of GLOBAL_PATH_SIGNATURES) {
    for (const candidate of candidates) {
      if (markers.some((marker) => candidate.includes(marker))) {
        return { kind: 'global', pm, reason, packageRoot };
      }
    }
  }
  // 兜底识别自定义 prefix 的 POSIX npm 树: <prefix>/lib/node_modules/<pkg>, 且 <prefix> 非项目根
  const normRoot = normalizeSlashes(packageRoot);
  const libIdx = normRoot.toLowerCase().lastIndexOf('/lib/node_modules/');
  if (libIdx > 0) {
    const prefixDir = normRoot.slice(0, libIdx);
    if (!pathExists(join(prefixDir, 'package.json'))) {
      return {
        kind: 'global',
        pm: 'npm',
        reason: '命中标准 <prefix>/lib/node_modules 全局目录',
        packageRoot,
      };
    }
  }
  return null;
}

/** 依据动态实查到的包管理器全局目录映射做前缀比对 */
function detectFromGlobalRoots(
  candidates: readonly string[],
  globalRoots: GlobalRootMap | undefined,
  packageRoot: string,
): InstallOrigin | null {
  if (globalRoots === undefined) return null;
  for (const pm of SUPPORTED_PACKAGE_MANAGERS) {
    const root = globalRoots[pm];
    if (root === undefined || root.trim() === '') continue;
    for (const candidate of candidates) {
      if (isWithinDir(candidate, root)) {
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

/**
 * 纯判定函数: 依据包路径、原始软链/入口路径、环境变量与可选实查全局目录,
 * 确定本 CLI 的安装来源。
 *
 * 判定优先级 (由确定性最高到最低):
 * 1. 本地源码开发态 (真实包根不在 node_modules 且含 src/cli.ts — 含 npm/bun link 软链开发态);
 * 2. 临时一次性运行目录 (npx / bunx / pnpm dlx / yarn dlx);
 * 3. 包管理器环境变量全局根 (VOLTA_HOME / BUN_INSTALL / PNPM_HOME / NPM_CONFIG_PREFIX);
 * 4. 标准跨平台全局目录路径特征 (volta / bun / pnpm / yarn / npm);
 * 5. 动态实查的自定义全局根目录映射 (覆盖自定义 npm prefix / pnpm global-dir 等);
 * 6. 业务项目本地 node_modules 依赖 (宿主持有 package.json);
 * 7. 无法唯一定位 (unknown, 安全拒绝盲装, 引导用 --pm 显式指定)。
 */
export function detectInstallOriginFromPath(
  input: DetectOriginInput,
): InstallOrigin {
  const env = input.env ?? process.env;
  const pathExists = input.pathExists ?? existsSync;
  const packageRoot = normalizeSlashes(input.packageRoot);
  const foldedRoot = packageRoot.toLowerCase();
  const candidates = collectFoldedCandidates(input);

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

  // 2. 临时一次性运行器 (npx / bunx / pnpm dlx / yarn dlx)
  const ephemeral = detectEphemeral(candidates, packageRoot);
  if (ephemeral !== null) return ephemeral;

  // 3. 显式环境变量全局目录
  const fromEnv = detectFromEnvRoots(candidates, env, packageRoot);
  if (fromEnv !== null) return fromEnv;

  // 4. 标准跨平台全局路径特征
  const fromStd = detectFromStandardPaths(candidates, packageRoot, pathExists);
  if (fromStd !== null) return fromStd;

  // 5. 动态实查全局目录映射 (自定义 prefix / global-dir 兜底)
  const fromProbe = detectFromGlobalRoots(
    candidates,
    input.globalRoots,
    packageRoot,
  );
  if (fromProbe !== null) return fromProbe;

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

/** 解析真实路径 (不可解析时回退原值) */
export function safeRealpath(path: string): string {
  try {
    return realpathSync(path);
  } catch {
    return path;
  }
}
