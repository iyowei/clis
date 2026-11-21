/**
 * 编排器构造期同步校验与只读选项快照解析 (内部模块, 供 `sweep.ts` 的 `createSweeper` 使用)。
 * 下游依赖: `config.ts` (`DEFAULT_EXCLUDE` / `mergeNames`)、`guard.ts` (`PathStyle`)、`errors.ts`。
 * 职责与红线: 同步校验 `roots` (必填非空绝对路径)、`exclude` / `include`、`home`、`policy.releaseSuspects`,
 * 违规立即同步抛 `SweepError('INVALID_ARGUMENT', ..., { field })`; 合并缺省 (`presets` 与 `rules` 同省略时默认 `{ node: {} }`,
 * `exclude` 缺省注入 `DEFAULT_EXCLUDE` 并设 `excludeExplicit` 区分默认护栏与显式排除) 后返回深冻结只读快照。
 */
import { homedir } from 'node:os';

import { validatePresets, validateRules } from './config-validate.ts';
import { DEFAULT_EXCLUDE, mergeNames } from './config.ts';
import { SweepError } from './errors.ts';
import { type PathStyle, nativeStyle } from './guard.ts';
import type { PresetsMap } from './presets.ts';
import type { CustomRule } from './rules.ts';
import type { ResolvedSweepOptions, SweepOptions } from './types.ts';

const invalidArgument = (field: string, message: string): SweepError =>
  new SweepError('INVALID_ARGUMENT', `${message} (字段: ${field})`, { field });

function assertNameArray(
  value: unknown,
  field: string,
  required: boolean,
): void {
  if (value === undefined) {
    if (required) throw invalidArgument(field, '为必填项');
    return;
  }
  if (
    !Array.isArray(value) ||
    value.some((item) => typeof item !== 'string' || item === '')
  ) {
    throw invalidArgument(field, '必须是非空字符串数组');
  }
  if (required && value.length === 0) {
    throw invalidArgument(field, '不能为空数组');
  }
}

/** 匹配 win32 盘符绝对根 (`C:\` / `C:/`) 或 UNC 共享根 (`\\host\share`), 拦截盘符相对路径 (`C:foo`) */
const WIN32_ABS_ROOT_RE = /^(?:[A-Za-z]:[/\\]|[/\\]{2}[^/\\]+[/\\][^/\\]+)/;

function isAbsoluteRoot(root: string, style: PathStyle): boolean {
  return style.name === 'win32'
    ? WIN32_ABS_ROOT_RE.test(root)
    : style.ops.isAbsolute(root);
}

/** 构造期同步校验 (同步抛 SweepError('INVALID_ARGUMENT')) */
export function assertSweepOptions(options: SweepOptions): void {
  if (typeof options !== 'object' || options === null) {
    throw invalidArgument('options', '构造选项必须是对象');
  }
  assertNameArray(options.roots, 'roots', true);
  const style = options.style ?? nativeStyle();
  if (options.roots.some((root) => !isAbsoluteRoot(root, style))) {
    throw invalidArgument('roots', '必须是绝对路径');
  }
  assertNameArray(options.exclude, 'exclude', false);
  assertNameArray(options.include, 'include', false);
  if (
    options.home !== undefined &&
    options.home !== null &&
    (typeof options.home !== 'string' || options.home === '')
  ) {
    throw invalidArgument('home', '必须是非空字符串或 null');
  }
  if (
    options.policy !== undefined &&
    (typeof options.policy !== 'object' ||
      options.policy === null ||
      typeof options.policy.releaseSuspects !== 'boolean')
  ) {
    throw invalidArgument('policy', 'releaseSuspects 必须是布尔值');
  }
  const checkedPresets = validatePresets(options.presets);
  if (!checkedPresets.ok) {
    throw invalidArgument(
      checkedPresets.failure.field,
      checkedPresets.failure.message,
    );
  }
  const checkedRules = validateRules(options.rules);
  if (!checkedRules.ok) {
    throw invalidArgument(
      checkedRules.failure.field,
      checkedRules.failure.message,
    );
  }
}

/** 合并缺省并产出深冻结只读快照 */
export function resolveSweepOptions(
  options: SweepOptions,
): Readonly<ResolvedSweepOptions> {
  assertSweepOptions(options);
  const checkedPresets = validatePresets(options.presets);
  const checkedRules = validateRules(options.rules);
  let presets: PresetsMap;
  if (options.presets === undefined && options.rules === undefined) {
    presets = { node: {} };
  } else {
    presets = checkedPresets.ok ? checkedPresets.presets : {};
  }
  const rules: CustomRule[] = checkedRules.ok
    ? checkedRules.rules.map((r) => Object.freeze({ ...r }))
    : [];
  return Object.freeze({
    roots: Object.freeze([...options.roots]),
    exclude: Object.freeze(
      mergeNames(options.exclude ?? [...DEFAULT_EXCLUDE], []),
    ),
    include: Object.freeze(mergeNames(options.include ?? [], [])),
    presets: Object.freeze(presets),
    rules: Object.freeze(rules),
    excludeExplicit: options.excludeExplicit ?? options.exclude !== undefined,
    home: options.home === undefined ? homedir() : options.home,
    style: options.style ?? nativeStyle(),
    policy: Object.freeze({
      releaseSuspects: options.policy?.releaseSuspects ?? false,
    }),
  });
}
