/**
 * 6 大内置技术栈预设注册表与强制项目锚定校验 (设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)。
 * 上下游: 依赖 codes.ts 与 guard.ts; 供 config / config-validate 校验、scan-match 扫描锚定、sweep 安全闸末段核验及 sweep-cli 初始化向导消费。
 * 核心红线:
 * 1. 对象内出现预设键名即激活, 严禁 `enabled` 字段;
 * 2. 易撞名目录 (`node_modules` / `target` / `.venv` / `venv` / `build` / `.gradle` / `cmake-build-*`) 强制核验同级清单或内置指纹文件, 且拦截家目录本体 `~/.gradle`;
 * 3. `os-junk` 仅匹配 4 个普通文件白名单 (`.DS_Store` / `Thumbs.db` / `ehthumbs.db` / `ehthumbs_vista.db`), 严禁 `desktop.ini` / `.directory` / `._*`。
 */
import { lstat, realpath } from 'node:fs/promises';
import { join } from 'node:path';

import type { CleanupAction, EntryKind, PresetName } from './codes.ts';
import { type PathStyle, isHomeBody, nativeStyle } from './guard.ts';

/** 全部内置预设名 (稳定注册序, 兼作碰撞去重优先级) */
export const PRESET_NAMES: readonly PresetName[] = Object.freeze([
  'node',
  'rust',
  'python',
  'java',
  'cpp',
  'os-junk',
]);

const PRESET_NAME_SET: ReadonlySet<string> = new Set(PRESET_NAMES);

/** 判定给定键名是否为合法内置预设 */
export function isPresetName(value: string): value is PresetName {
  return PRESET_NAME_SET.has(value);
}

/** 单个预设的可选覆盖配置 (严禁 enabled 字段) */
export interface PresetConfig {
  /** 动作覆盖; 缺省取预设默认动作 ('delete') */
  action?: CleanupAction;
  /** 局部排除: 仅在全局安全护栏之上进一步收紧 */
  exclude?: string[];
  /** 局部包含: 非空时仅匹配路径祖先链命中该名单的目标 */
  include?: string[];
}

/** 预设配置映射 (键存在即激活) */
export type PresetsMap = Partial<Record<PresetName, PresetConfig>>;

/** 锚定校验所需的目录上下文 (优先消耗内存同级文件集合, 零多余磁盘 IO) */
export interface PresetMatchContext {
  /** 当前条目名称 */
  readonly name: string;
  /** 条目实体形态 ('file' | 'dir') */
  readonly kind: EntryKind;
  /** 条目所在父目录绝对路径 */
  readonly parentDir: string;
  /** 条目完整绝对路径 */
  readonly targetPath: string;
  /** 父目录内已读取的普通文件名集合 (不含目录与软链) */
  readonly siblingFiles: ReadonlySet<string>;
  /** 归一化后的家目录绝对路径 (用于拦截家目录本体 ~/.gradle 等全局缓存) */
  readonly realHome: string | null;
  /** 路径比较风味 (缺省平台原生; win32 下按 isHomeBody 折叠大小写与正反斜杠) */
  readonly style?: PathStyle;
}

/** 单个预设的声明式规格 */
export interface PresetSpec {
  readonly name: PresetName;
  readonly label: string;
  readonly defaultAction: CleanupAction;
  readonly kinds: readonly EntryKind[];
  /** 廉价名称初筛 (同步, O(1), 过滤 99%+ 非目标条目) */
  matchesName(name: string, kind: EntryKind): boolean;
  /**
   * 锚定核验 (先走同级内存集合, 仅少数需检内嵌指纹文件如 pyvenv.cfg / CMakeCache.txt 时走一次轻量 lstat)。
   * 返回 true 代表确认为本预设的合法可清理目标。
   */
  verifyAnchor(ctx: PresetMatchContext): Promise<boolean>;
}

/** 探测路径是否为真实普通文件 (不跟随符号链接) */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    const st = await lstat(path);
    return st.isFile();
  } catch {
    return false;
  }
}

/** 判定同级文件中是否存在 Gradle 项目锚点 (`build.gradle*` 或 `settings.gradle*`) */
function hasGradleSibling(siblingFiles: ReadonlySet<string>): boolean {
  for (const file of siblingFiles) {
    if (file.startsWith('build.gradle') || file.startsWith('settings.gradle')) {
      return true;
    }
  }
  return false;
}

/** `os-junk` 严格允许的 4 个垃圾文件名 (严禁 desktop.ini / .directory / ._*) */
export const OS_JUNK_FILES: ReadonlySet<string> = new Set([
  '.DS_Store',
  'Thumbs.db',
  'ehthumbs.db',
  'ehthumbs_vista.db',
]);

/** Python 工具固有缓存目录 (名称强特征, 可位于任意子包内) */
const PYTHON_CACHE_DIRS: ReadonlySet<string> = new Set([
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
]);

/** Python 虚拟环境目录 (必须过锚定校验) */
const PYTHON_VENV_DIRS: ReadonlySet<string> = new Set(['.venv', 'venv']);

/** 判断目录名是否匹配 C/C++ CMake 构建目录 (`build` 或 `cmake-build-*`) */
function isCppBuildDir(name: string): boolean {
  return (
    name === 'build' ||
    (name.startsWith('cmake-build-') && name.length > 'cmake-build-'.length)
  );
}

/**
 * 声明式 6 大内置预设注册表 (按 PRESET_NAMES 稳定序排列: node / rust / python / java / cpp / os-junk)。
 *
 * ### 数据流转示例 (扫描期两段锚定校验)
 * - Input: `{ name: 'target', kind: 'dir', parentDir: '/work/app', siblingFiles: Set(['Cargo.toml']) }`
 * - 流程: `rust.matchesName('target', 'dir') => true` -> `rust.verifyAnchor(ctx)` 查内存 `siblingFiles.has('Cargo.toml')` -> Output: `true` (命中 `rust`)
 * - 反例 1: `{ name: 'build', kind: 'dir', siblingFiles: Set(['README.md']) }` -> `java` 无 `build.gradle*`/`settings.gradle*`, `cpp` 无 `CMakeLists.txt` 且内无 `CMakeCache.txt` -> Output: `false` (业务目录放过)
 * - 反例 2: `{ name: '.gradle', parentDir: realHome, siblingFiles: Set(['settings.gradle']) }` -> `java.verifyAnchor` 经 `isHomeBody` 比对 `parentDir` 与 `realpath(parentDir)` 命中 `realHome` -> Output: `false` (保护全局缓存)
 */
export const BUILTIN_PRESETS: readonly PresetSpec[] = Object.freeze([
  {
    name: 'node',
    label: 'Node.js 依赖 (node_modules)',
    defaultAction: 'delete',
    kinds: ['dir'],
    matchesName: (name, kind) => kind === 'dir' && name === 'node_modules',
    verifyAnchor: async (ctx) => ctx.siblingFiles.has('package.json'),
  },
  {
    name: 'rust',
    label: 'Rust 构建产物 (target)',
    defaultAction: 'delete',
    kinds: ['dir'],
    matchesName: (name, kind) => kind === 'dir' && name === 'target',
    verifyAnchor: async (ctx) => ctx.siblingFiles.has('Cargo.toml'),
  },
  {
    name: 'python',
    label: 'Python 虚拟环境与缓存 (.venv/venv/__pycache__/.*_cache)',
    defaultAction: 'delete',
    kinds: ['dir'],
    matchesName: (name, kind) =>
      kind === 'dir' &&
      (PYTHON_VENV_DIRS.has(name) || PYTHON_CACHE_DIRS.has(name)),
    verifyAnchor: async (ctx) => {
      if (PYTHON_CACHE_DIRS.has(ctx.name)) return true;
      if (
        ctx.siblingFiles.has('pyproject.toml') ||
        ctx.siblingFiles.has('requirements.txt')
      ) {
        return true;
      }
      return isRegularFile(join(ctx.targetPath, 'pyvenv.cfg'));
    },
  },
  {
    name: 'java',
    label: 'Java Maven/Gradle 产物 (target/.gradle/build)',
    defaultAction: 'delete',
    kinds: ['dir'],
    matchesName: (name, kind) =>
      kind === 'dir' &&
      (name === 'target' || name === '.gradle' || name === 'build'),
    verifyAnchor: async (ctx) => {
      if (ctx.name === 'target') {
        return ctx.siblingFiles.has('pom.xml');
      }
      // 家目录本体的 ~/.gradle 是全局工具链缓存, 严禁被 java 预设纳入 (复用 isHomeBody 消除软链/尾斜杠/win32 大小写差异)
      if (ctx.name === '.gradle' && ctx.realHome !== null) {
        const style = ctx.style ?? nativeStyle();
        if (isHomeBody(ctx.parentDir, ctx.realHome, style)) return false;
        const resolvedParent = await realpath(ctx.parentDir).catch(
          () => ctx.parentDir,
        );
        if (isHomeBody(resolvedParent, ctx.realHome, style)) return false;
      }
      return hasGradleSibling(ctx.siblingFiles);
    },
  },
  {
    name: 'cpp',
    label: 'C/C++ CMake 构建产物 (build/cmake-build-*)',
    defaultAction: 'delete',
    kinds: ['dir'],
    matchesName: (name, kind) => kind === 'dir' && isCppBuildDir(name),
    verifyAnchor: async (ctx) => {
      if (ctx.siblingFiles.has('CMakeLists.txt')) return true;
      return isRegularFile(join(ctx.targetPath, 'CMakeCache.txt'));
    },
  },
  {
    name: 'os-junk',
    label: '系统元数据垃圾文件 (.DS_Store/Thumbs.db)',
    defaultAction: 'delete',
    kinds: ['file'],
    matchesName: (name, kind) => kind === 'file' && OS_JUNK_FILES.has(name),
    verifyAnchor: async () => true,
  },
]);

/** 按名称索引内置预设规格 */
export const PRESET_BY_NAME: Readonly<Record<PresetName, PresetSpec>> =
  Object.freeze(
    Object.fromEntries(
      BUILTIN_PRESETS.map((spec) => [spec.name, spec]),
    ) as Record<PresetName, PresetSpec>,
  );

/** `sweep init` 与 `sweep init --default` 推荐启用的完整最佳实践预设集 (含 os-junk) */
export function createDefaultPresets(): PresetsMap {
  return {
    node: {},
    rust: {},
    python: {},
    java: {},
    cpp: {},
    'os-junk': {},
  };
}

/** 计算给定预设的有效动作 (缺省为预设 defaultAction 即 'delete') */
export function resolvePresetAction(
  name: PresetName,
  config?: PresetConfig,
): CleanupAction {
  return config?.action ?? PRESET_BY_NAME[name].defaultAction;
}

/** 判定文件名/目录名是否可能匹配指定预设集合中的任一项 (用于安全闸末段合法性校验) */
export function matchesAnyActivePresetLeaf(
  leaf: string,
  presets: PresetsMap,
): boolean {
  for (const name of PRESET_NAMES) {
    if (presets[name] === undefined) continue;
    const spec = PRESET_BY_NAME[name];
    for (const kind of spec.kinds) {
      if (spec.matchesName(leaf, kind)) return true;
    }
  }
  return false;
}
