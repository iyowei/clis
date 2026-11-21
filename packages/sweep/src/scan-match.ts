/**
 * 多预设与自定义规则的扫描期匹配、锚定校验、局部过滤与动作合并引擎 (内部模块)。
 * 上游: scan-parallel.ts 遍历回调; 下游: presets.ts 内置预设规格与 rules.ts 自定义规则编译。
 * 设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md:
 * - 多数预设锚定校验直接查询内存同级文件集合 `siblingFiles`, 零额外磁盘 syscall;
 * - 仅 `python` (`pyvenv.cfg`) 与 `cpp` (`CMakeCache.txt`) 在同级清单未命中时走一次轻量 `lstat`;
 * - `java` 的项目 `.gradle` 须同级含 Gradle 锚点且父目录非 `home` 本体, 未被用户显式覆盖排除;
 * - 多源碰撞时严格取保守优先 (`'trash'` 优先于 `'delete'`)。
 */
import { lstat } from 'node:fs/promises';

import type { CleanupAction, EntryKind, PresetName } from './codes.ts';
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
 * 判定 `.gradle` 是否可作为 `java` 预设的项目级缓存跳过默认全局护栏:
 * 仅当 `java` 预设激活、用户未显式覆盖全局 `exclude` (`excludeExplicit === false`)、
 * `java` 预设局部未排除 `.gradle`、父目录既非 `realHome` 也非 `rawHome`、
 * 且同级存在 Gradle 锚点 (`build.gradle*` / `settings.gradle*`) 时返回 true; 其余情况 (含 `~/.gradle`) 一律保护。
 *
 * ### 数据流转示例
 * ```text
 * Input: entryName = '.gradle', parentDir = '/w/demo', siblingFiles = Set { 'build.gradle.kts' },
 *        matcher = { javaPreset: active(exclude: []), excludeExplicit: false, realHome: '/Users/u', rawHome: '/Users/u' }
 * 步骤 1: 逐条门控 -> 名称是 '.gradle' -> java 激活 -> 全局未显式 exclude -> 局部未排除 -> parentDir !== home
 * 步骤 2: 查内存同级文件集合 hasGradleAnchor(siblingFiles) -> 'build.gradle.kts' 命中
 * Output: true (若 parentDir = '/Users/u' 则在步骤 1 拦截返回 false, 护住全局 ~/.gradle)
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
  if (matcher.realHome !== null && parentDir === matcher.realHome) return false;
  if (matcher.rawHome !== null && parentDir === matcher.rawHome) return false;
  return hasGradleAnchor(siblingFiles);
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

/**
 * 异步执行锚定核验、局部过滤与 `olderThanDays` 检查, 合并全部命中来源的动作后返回结果或 null。
 * 多源碰撞规则: `source` 保留首个命中 (内置预设按注册序优先于自定义规则), `action` 保守合并 (`'trash'` 优先于 `'delete'`)。
 *
 * ### 数据流转示例
 * ```text
 * Input: params = { name: 'target', kind: 'dir', parentDir: '/w/svc', targetPath: '/w/svc/target',
 *                   siblingFiles: Set { 'Cargo.toml' }, ancestors: ['svc'] }
 *        matcher = { activePresets: [rust(action: 'delete')], compiledRules: [rule('old-target', action: 'trash', olderThanDays: 30)] }
 * 步骤 1: 拼路径链 segments = ['svc', 'target'], 轮询预设 -> rust 名称/局部过滤/同级 Cargo.toml 命中
 *         -> firstSource = { kind: 'preset', name: 'rust' }, mergedAction = 'delete'
 * 步骤 2: 轮询自定义规则 -> 'old-target' 命中名称, 惰性 lstat 测得 mtime 超过 30 天
 *         -> 保留 firstSource, 合并动作 mergeCleanupActions('delete', 'trash') = 'trash'
 * Output: { action: 'trash', source: { kind: 'preset', name: 'rust' } }
 * ```
 */
export async function evaluateTargetMatch(
  params: {
    name: string;
    kind: EntryKind;
    parentDir: string;
    targetPath: string;
    siblingFiles: ReadonlySet<string>;
    ancestors: readonly string[];
  },
  matcher: CompiledScanMatcher,
): Promise<TargetMatchResult | null> {
  const segments = [...params.ancestors, params.name];
  const ctx: PresetMatchContext = {
    name: params.name,
    kind: params.kind,
    parentDir: params.parentDir,
    targetPath: params.targetPath,
    siblingFiles: params.siblingFiles,
    realHome: matcher.realHome,
  };

  let firstSource: HitSource | null = null;
  let mergedAction: CleanupAction | null = null;

  for (const preset of matcher.activePresets) {
    if (!preset.spec.matchesName(params.name, params.kind)) continue;
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
      const st = await lstat(params.targetPath);
      cachedMtimeMs = st.mtimeMs;
    } catch {
      cachedMtimeMs = null;
    }
    return cachedMtimeMs;
  };

  for (const compiled of matcher.compiledRules) {
    if (!ruleMatchesKind(compiled.rule.kind, params.kind)) continue;
    if (!compiled.matchesName(params.name)) continue;
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
