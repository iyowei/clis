/**
 * 多预设与自定义规则的扫描期匹配、锚定校验、局部过滤与动作合并引擎 (内部模块)。
 * 上游: scan-parallel.ts 遍历回调; 下游: presets.ts 内置预设规格与 rules.ts 自定义规则编译。
 * 设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md:
 * - 多数预设锚定校验直接查询内存同级文件集合 `siblingFiles`, 零额外磁盘 syscall;
 * - 仅 `python` (`pyvenv.cfg`) 与 `cpp` (`CMakeCache.txt`) 在同级清单未命中时走一次轻量 `lstat`;
 * - `java` 的项目 `.gradle` 须同级含 Gradle 锚点且父目录非 `home` 本体, 未被用户显式排除 `.gradle`; 其余任何 `.gradle` 一律剪枝不下钻;
 * - 多源碰撞时严格取保守优先 (`'trash'` 优先于 `'delete'`)。
 */
import { lstat, realpath } from 'node:fs/promises';

import type { CleanupAction, EntryKind, PresetName } from './codes.ts';
import { type PathStyle, isHomeBody, nativeStyle } from './guard.ts';
import {
  BUILTIN_PRESETS,
  type PresetConfig,
  type PresetMatchContext,
  type PresetSpec,
  type PresetsMap,
  resolvePresetAction,
} from './presets.ts';
import {
  type CompiledRule,
  type CustomRule,
  compileRules,
  isOlderThanDays,
  ruleMatchesKind,
} from './rules.ts';
import type { HitSource } from './types.ts';

interface ActivePreset {
  readonly spec: PresetSpec;
  readonly action: CleanupAction;
  readonly exclude: ReadonlySet<string>;
  readonly include: ReadonlySet<string>;
}

/** 扫描期编译后的匹配上下文 */
export interface CompiledScanMatcher {
  readonly activePresets: readonly ActivePreset[];
  readonly compiledRules: readonly CompiledRule[];
  readonly hasDirTargets: boolean;
  readonly hasFileTargets: boolean;
  readonly javaPreset: ActivePreset | null;
  readonly excludeExplicit: boolean;
  readonly rawHome: string | null;
  readonly realHome: string | null;
  readonly style: PathStyle;
  readonly nowMs: number;
}

/** 单次目标命中结果 */
export interface TargetMatchResult {
  readonly action: CleanupAction;
  readonly source: HitSource;
}

/** 合并动作: 任一命中来源要求回收站时, 保守优先取 `'trash'` */
export function mergeCleanupActions(
  a: CleanupAction,
  b: CleanupAction,
): CleanupAction {
  return a === 'trash' || b === 'trash' ? 'trash' : 'delete';
}

/** 构建扫描期匹配器 (未显式传 presets 且未传 rules 时缺省启用 `{ node: {} }`) */
export function createScanMatcher(options: {
  presets?: PresetsMap;
  rules?: readonly CustomRule[];
  excludeExplicit?: boolean;
  rawHome?: string | null;
  realHome: string | null;
  style?: PathStyle;
  nowMs?: number;
}): CompiledScanMatcher {
  const effectivePresets: PresetsMap =
    options.presets === undefined && options.rules === undefined
      ? { node: {} }
      : (options.presets ?? {});
  const activePresets: ActivePreset[] = [];
  let javaPreset: ActivePreset | null = null;

  for (const spec of BUILTIN_PRESETS) {
    const cfg: PresetConfig | undefined = effectivePresets[spec.name];
    if (cfg === undefined) continue;
    const item: ActivePreset = {
      spec,
      action: resolvePresetAction(spec.name, cfg),
      exclude: new Set(cfg.exclude ?? []),
      include: new Set(cfg.include ?? []),
    };
    activePresets.push(item);
    if (spec.name === 'java') javaPreset = item;
  }

  const compiledRules = compileRules(options.rules ?? []);
  const hasDirTargets =
    activePresets.some((p) => p.spec.kinds.includes('dir')) ||
    compiledRules.some((r) => r.rule.kind === 'dir' || r.rule.kind === 'any');
  const hasFileTargets =
    activePresets.some((p) => p.spec.kinds.includes('file')) ||
    compiledRules.some((r) => r.rule.kind === 'file' || r.rule.kind === 'any');

  return {
    activePresets,
    compiledRules,
    hasDirTargets,
    hasFileTargets,
    javaPreset,
    excludeExplicit: options.excludeExplicit ?? false,
    rawHome: options.rawHome ?? null,
    realHome: options.realHome,
    style: options.style ?? nativeStyle(),
    nowMs: options.nowMs ?? Date.now(),
  };
}

/** 校验局部 exclude / include 名单是否放行 (基于自根至当前条目的目录段链) */
function passesLocalFilters(
  segments: readonly string[],
  localExclude: ReadonlySet<string>,
  localInclude: ReadonlySet<string>,
): boolean {
  if (localExclude.size > 0) {
    for (const seg of segments) {
      if (localExclude.has(seg)) return false;
    }
  }
  if (localInclude.size > 0) {
    let matched = false;
    for (const seg of segments) {
      if (localInclude.has(seg)) {
        matched = true;
        break;
      }
    }
    if (!matched) return false;
  }
  return true;
}

/** 判断同级文件中是否存在 Gradle 项目锚点 (`build.gradle*` / `settings.gradle*`) */
function hasGradleAnchor(siblingFiles: ReadonlySet<string>): boolean {
  for (const file of siblingFiles) {
    if (file.startsWith('build.gradle') || file.startsWith('settings.gradle')) {
      return true;
    }
  }
  return false;
}

/**
 * 判定 `.gradle` 是否可作为 `java` 预设的项目级缓存跳过默认全局护栏 (`DEFAULT_EXCLUDE` 中的 `.gradle`):
 * - 当默认护栏生效 (`excludeExplicit === false`) 时, 仅在 `java` 预设激活、`java` 预设局部未排除 `.gradle`、
 *   父目录既非 `realHome` 也非 `rawHome`、且同级存在 Gradle 锚点 (`build.gradle*` / `settings.gradle*`) 时返回 true 越过默认护栏;
 * - 当用户显式传入不含 `.gradle` 的全局 `exclude` (`excludeExplicit === true`) 时, `.gradle` 不受全局 `exclude` 阻拦而直接进入
 *   `evaluateTargetMatch`, 满足同一锚定与非 `home` 条件且局部未排除的项目级 `.gradle` 照常命中 `java` 预设;
 * - 其余任何未命中的 `.gradle` (含 `~/.gradle` 及无 Gradle 锚点的目录) 均由 `shouldPruneUnmatchedDir` 剪枝跳过, 严禁下钻。
 *
 * ### 数据流转示例
 * ```text
 * Input: entryName = '.gradle', parentDir = '/w/demo', siblingFiles = Set { 'build.gradle.kts' },
 *        matcher = { javaPreset: active(exclude: []), excludeExplicit: false, realHome: '/Users/u', rawHome: '/Users/u' }
 * 步骤 1: 逐条门控 -> 名称是 '.gradle' -> java 激活 -> 全局未显式排除 .gradle -> 局部未排除 -> parentDir !== home
 * 步骤 2: 查内存同级文件集合 hasGradleAnchor(siblingFiles) -> 'build.gradle.kts' 命中
 * Output: true (若 parentDir = '/Users/u' 或无锚点则返回 false, 且后续由 shouldPruneUnmatchedDir 阻断下钻护住 ~/.gradle)
 * ```
 */
export function canBypassDefaultGradleExclude(
  entryName: string,
  parentDir: string,
  siblingFiles: ReadonlySet<string>,
  matcher: CompiledScanMatcher,
): boolean {
  if (entryName !== '.gradle') return false;
  if (matcher.javaPreset === null) return false;
  if (matcher.excludeExplicit) return false;
  if (matcher.javaPreset.exclude.has('.gradle')) return false;
  if (isHomeBody(parentDir, matcher.realHome, matcher.style)) return false;
  if (isHomeBody(parentDir, matcher.rawHome, matcher.style)) return false;
  return hasGradleAnchor(siblingFiles);
}

/**
 * 判定未命中目标的目录是否必须直接剪枝跳过而严禁回压栈下钻 (ADR 0022):
 * 任何名为 `.gradle` 的目录 (如家目录本体 `~/.gradle` 或无 Gradle 锚点的 `.gradle`) 及曾绕过默认护栏的候选均严禁下钻其内部子树。
 */
export function shouldPruneUnmatchedDir(
  entryName: string,
  bypassedExclude: boolean,
): boolean {
  return bypassedExclude || entryName === '.gradle';
}

/** 廉价同步预筛: 判定条目是否可能命中任一预设或规则 (零异步开销, 过滤 99%+ 非目标) */
export function isPotentialTarget(
  name: string,
  kind: EntryKind,
  matcher: CompiledScanMatcher,
): boolean {
  if (kind === 'dir' && !matcher.hasDirTargets) return false;
  if (kind === 'file' && !matcher.hasFileTargets) return false;

  for (const preset of matcher.activePresets) {
    if (preset.spec.matchesName(name, kind)) return true;
  }
  for (const compiled of matcher.compiledRules) {
    if (
      ruleMatchesKind(compiled.rule.kind, kind) &&
      compiled.matchesName(name)
    ) {
      return true;
    }
  }
  return false;
}

/** 单次目标评估入参 */
export interface TargetEvalInput {
  readonly name: string;
  readonly kind: EntryKind;
  readonly parentDir: string;
  readonly targetPath: string;
  readonly siblingFiles: ReadonlySet<string>;
  readonly ancestors: readonly string[];
  /** true 表示该候选因 java 特批越过默认全局护栏 DEFAULT_EXCLUDE, 仅允许评估 java 预设, 严禁自定义规则借道 */
  readonly bypassedExclude?: boolean;
}

/** 判定 `.gradle` 的父目录是否为家目录本体 (同时核对字面路径与 realpath 展开路径, 防软链根绕过) */
async function isGradleAtHome(
  parentDir: string,
  matcher: CompiledScanMatcher,
): Promise<boolean> {
  if (matcher.realHome === null && matcher.rawHome === null) return false;
  if (
    isHomeBody(parentDir, matcher.realHome, matcher.style) ||
    isHomeBody(parentDir, matcher.rawHome, matcher.style)
  ) {
    return true;
  }
  const resolvedParent = await realpath(parentDir).catch(() => null);
  if (resolvedParent === null) return false;
  return (
    isHomeBody(resolvedParent, matcher.realHome, matcher.style) ||
    isHomeBody(resolvedParent, matcher.rawHome, matcher.style)
  );
}

/**
 * 异步执行锚定核验、局部过滤与 `olderThanDays` 检查, 合并全部命中来源的动作后返回结果或 null。
 * 多源碰撞规则: `source` 保留首个命中 (内置预设按注册序优先于自定义规则), `action` 保守合并 (`'trash'` 优先于 `'delete'`)。
 * 特批隔离红线: `bypassedExclude === true` 时仅允许评估 `java` 预设, 未通过即返 null, 绝不落入 `compiledRules`;
 * 任何名为 `.gradle` 的目录候选均强制拦截家目录本体 (含软链根指向 `~`)。
 *
 * ### 数据流转示例
 * ```text
 * Input: input = { name: 'target', kind: 'dir', parentDir: '/w/svc', targetPath: '/w/svc/target',
 *                  siblingFiles: Set { 'Cargo.toml' }, ancestors: ['svc'] }
 *        matcher = { activePresets: [rust(action: 'delete')], compiledRules: [rule('old-target', action: 'trash', olderThanDays: 30)] }
 * 步骤 1: 拼路径链 segments = ['svc', 'target'], 轮询预设 -> rust 名称/局部过滤/同级 Cargo.toml 命中
 *         -> firstSource = { kind: 'preset', name: 'rust' }, mergedAction = 'delete'
 * 步骤 2: 轮询自定义规则 -> 'old-target' 命中名称, 惰性 lstat 测得 mtime 超过 30 天
 *         -> 保留 firstSource, 合并动作 mergeCleanupActions('delete', 'trash') = 'trash'
 * Output: { action: 'trash', source: { kind: 'preset', name: 'rust' } }
 * ```
 */
export async function evaluateTargetMatch(
  input: TargetEvalInput,
  matcher: CompiledScanMatcher,
): Promise<TargetMatchResult | null> {
  // 任何名为 .gradle 的目录候选在评估预设与自定义规则前均死守家目录本体护栏 (含软链根 realpath 核验)
  if (input.kind === 'dir' && input.name === '.gradle') {
    if (await isGradleAtHome(input.parentDir, matcher)) {
      return null;
    }
  }

  const segments = [...input.ancestors, input.name];
  const ctx: PresetMatchContext = {
    name: input.name,
    kind: input.kind,
    parentDir: input.parentDir,
    targetPath: input.targetPath,
    siblingFiles: input.siblingFiles,
    realHome: matcher.realHome,
    style: matcher.style,
  };

  // 因 java 特批才越过默认全局护栏 DEFAULT_EXCLUDE 的候选: 只允许评估 java 预设, 严禁落入自定义规则借道命中
  if (input.bypassedExclude === true) {
    const java = matcher.javaPreset;
    if (java === null) return null;
    if (!java.spec.matchesName(input.name, input.kind)) return null;
    if (!passesLocalFilters(segments, java.exclude, java.include)) return null;
    const anchored = await java.spec.verifyAnchor(ctx);
    if (!anchored) return null;
    return {
      action: java.action,
      source: { kind: 'preset', name: 'java' },
    };
  }

  let firstSource: HitSource | null = null;
  let mergedAction: CleanupAction | null = null;

  for (const preset of matcher.activePresets) {
    if (!preset.spec.matchesName(input.name, input.kind)) continue;
    if (!passesLocalFilters(segments, preset.exclude, preset.include)) continue;
    const anchored = await preset.spec.verifyAnchor(ctx);
    if (!anchored) continue;
    if (firstSource === null) {
      firstSource = { kind: 'preset', name: preset.spec.name as PresetName };
    }
    mergedAction =
      mergedAction === null
        ? preset.action
        : mergeCleanupActions(mergedAction, preset.action);
  }

  let cachedMtimeMs: number | null | undefined;
  const readMtime = async (): Promise<number | null> => {
    if (cachedMtimeMs !== undefined) return cachedMtimeMs;
    try {
      const st = await lstat(input.targetPath);
      cachedMtimeMs = st.mtimeMs;
    } catch {
      cachedMtimeMs = null;
    }
    return cachedMtimeMs;
  };

  for (const compiled of matcher.compiledRules) {
    if (!ruleMatchesKind(compiled.rule.kind, input.kind)) continue;
    if (!compiled.matchesName(input.name)) continue;
    if (!passesLocalFilters(segments, compiled.exclude, compiled.include)) {
      continue;
    }
    if (compiled.rule.olderThanDays !== undefined) {
      const mtimeMs = await readMtime();
      if (
        mtimeMs === null ||
        !isOlderThanDays(mtimeMs, compiled.rule.olderThanDays, matcher.nowMs)
      ) {
        continue;
      }
    }
    if (firstSource === null) {
      firstSource = { kind: 'rule', name: compiled.rule.name };
    }
    // 防御性兜底: 即使调用方绕过构造校验传出缺失 action 的规则, 仍死守默认回收站红线
    const ruleAction: CleanupAction = compiled.rule.action ?? 'trash';
    mergedAction =
      mergedAction === null
        ? ruleAction
        : mergeCleanupActions(mergedAction, ruleAction);
  }

  if (firstSource === null || mergedAction === null) return null;
  return { action: mergedAction, source: firstSource };
}
