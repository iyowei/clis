/**
 * 配置 v2 形状校验与归一化 (内部模块, 不进公开 .d.ts; 设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)。
 * 上下游: 依赖 presets.ts (`isPresetName`) 与 rules.ts (`validateRuleMatch`), 仅供 config.ts 与 migrate.ts 复用。
 * 核心红线:
 * - 省略 `roots` 时补 `[defaultRoot]`, 显式 `"roots": []` 硬报错; 省略 `exclude` 继承 32 项默认护栏;
 * - `presets.<k>` 严禁 `enabled` 字段, 未知预设键与未知顶层/子字段一律硬报错;
 * - `rules[].match` 经 `validateRuleMatch` 拦截高危通配, `rules[].action` 省略时强制补 `'trash'`。
 */
import type { CleanupAction, PresetName, RuleKind } from './codes.ts';
import { type PresetConfig, type PresetsMap, isPresetName } from './presets.ts';
import { type CustomRule, validateRuleMatch } from './rules.ts';

export interface ShapeFailure {
  field: string;
  message: string;
}

export interface NormalizedV2 {
  version: 2;
  roots: string[];
  exclude: string[];
  include: string[];
  /** 用户是否在 JSON 中显式写出了 exclude 字段 */
  excludeExplicit: boolean;
  presets: PresetsMap;
  rules: CustomRule[];
}

const TOP_KEYS = new Set([
  'version',
  'roots',
  'exclude',
  'include',
  'presets',
  'rules',
]);
const PRESET_KEYS = new Set(['action', 'exclude', 'include']);
const RULE_KEYS = new Set([
  'name',
  'kind',
  'match',
  'action',
  'olderThanDays',
  'exclude',
  'include',
]);

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function validateStringArray(
  value: unknown,
  field: string,
  allowEmptyItem: boolean,
): { ok: true; items: string[] } | { ok: false; failure: ShapeFailure } {
  if (!Array.isArray(value)) {
    return {
      ok: false,
      failure: { field, message: `字段 ${field} 必须是字符串数组` },
    };
  }
  const items: string[] = [];
  for (let i = 0; i < value.length; i += 1) {
    const item = value[i];
    if (typeof item !== 'string') {
      return {
        ok: false,
        failure: {
          field: `${field}[${i}]`,
          message: `字段 ${field}[${i}] 必须是字符串`,
        },
      };
    }
    if (!allowEmptyItem && item.trim() === '') {
      return {
        ok: false,
        failure: {
          field: `${field}[${i}]`,
          message: `字段 ${field}[${i}] 不能为空字符串`,
        },
      };
    }
    items.push(item);
  }
  return { ok: true, items };
}

function validateAction(
  value: unknown,
  field: string,
): { ok: true; action: CleanupAction } | { ok: false; failure: ShapeFailure } {
  if (value === 'trash' || value === 'delete') {
    return { ok: true, action: value };
  }
  return {
    ok: false,
    failure: {
      field,
      message: `字段 ${field} 只能是 "trash" 或 "delete"`,
    },
  };
}

function validatePresets(
  raw: unknown,
): { ok: true; presets: PresetsMap } | { ok: false; failure: ShapeFailure } {
  if (raw === undefined) return { ok: true, presets: {} };
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      failure: { field: 'presets', message: '字段 presets 必须是对象' },
    };
  }
  const presets: PresetsMap = {};
  for (const [key, value] of Object.entries(raw)) {
    if (!isPresetName(key)) {
      return {
        ok: false,
        failure: {
          field: `presets.${key}`,
          message: `presets 包含未知预设 "${key}" (支持: node, rust, python, java, cpp, os-junk)`,
        },
      };
    }
    if (!isPlainRecord(value)) {
      return {
        ok: false,
        failure: {
          field: `presets.${key}`,
          message: `字段 presets.${key} 必须是对象`,
        },
      };
    }
    if ('enabled' in value) {
      return {
        ok: false,
        failure: {
          field: `presets.${key}.enabled`,
          message: `presets.${key} 禁止使用 enabled 字段 (对象内出现键名即代表激活, 不需要则直接移除该键)`,
        },
      };
    }
    for (const subKey of Object.keys(value)) {
      if (!PRESET_KEYS.has(subKey)) {
        return {
          ok: false,
          failure: {
            field: `presets.${key}.${subKey}`,
            message: `presets.${key} 包含未知字段 "${subKey}"`,
          },
        };
      }
    }
    const presetCfg: PresetConfig = {};
    if (value.action !== undefined) {
      const act = validateAction(value.action, `presets.${key}.action`);
      if (!act.ok) return act;
      presetCfg.action = act.action;
    }
    if (value.exclude !== undefined) {
      const ex = validateStringArray(
        value.exclude,
        `presets.${key}.exclude`,
        false,
      );
      if (!ex.ok) return ex;
      presetCfg.exclude = ex.items;
    }
    if (value.include !== undefined) {
      const inc = validateStringArray(
        value.include,
        `presets.${key}.include`,
        false,
      );
      if (!inc.ok) return inc;
      presetCfg.include = inc.items;
    }
    presets[key as PresetName] = presetCfg;
  }
  return { ok: true, presets };
}

function validateSingleRule(
  raw: unknown,
  index: number,
): { ok: true; rule: CustomRule } | { ok: false; failure: ShapeFailure } {
  const prefix = `rules[${index}]`;
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      failure: { field: prefix, message: `字段 ${prefix} 必须是对象` },
    };
  }
  for (const key of Object.keys(raw)) {
    if (!RULE_KEYS.has(key)) {
      return {
        ok: false,
        failure: {
          field: `${prefix}.${key}`,
          message: `${prefix} 包含未知字段 "${key}"`,
        },
      };
    }
  }
  if (typeof raw.name !== 'string' || raw.name.trim() === '') {
    return {
      ok: false,
      failure: {
        field: `${prefix}.name`,
        message: `字段 ${prefix}.name 必须是非空字符串`,
      },
    };
  }
  if (raw.kind !== 'file' && raw.kind !== 'dir' && raw.kind !== 'any') {
    return {
      ok: false,
      failure: {
        field: `${prefix}.kind`,
        message: `字段 ${prefix}.kind 只能是 "file"、"dir" 或 "any"`,
      },
    };
  }
  if (typeof raw.match !== 'string') {
    return {
      ok: false,
      failure: {
        field: `${prefix}.match`,
        message: `字段 ${prefix}.match 必须是字符串`,
      },
    };
  }
  const matchProblem = validateRuleMatch(raw.match);
  if (matchProblem !== null) {
    return {
      ok: false,
      failure: {
        field: `${prefix}.match`,
        message: `字段 ${prefix}.match 无效: ${matchProblem}`,
      },
    };
  }

  // 自定义规则 action 缺省强制为 'trash' (数据安全红线)
  let action: CleanupAction = 'trash';
  if (raw.action !== undefined) {
    const act = validateAction(raw.action, `${prefix}.action`);
    if (!act.ok) return act;
    action = act.action;
  }

  let olderThanDays: number | undefined;
  if (raw.olderThanDays !== undefined) {
    if (
      typeof raw.olderThanDays !== 'number' ||
      !Number.isFinite(raw.olderThanDays) ||
      raw.olderThanDays <= 0
    ) {
      return {
        ok: false,
        failure: {
          field: `${prefix}.olderThanDays`,
          message: `字段 ${prefix}.olderThanDays 必须是大于 0 的有限数字`,
        },
      };
    }
    olderThanDays = raw.olderThanDays;
  }

  let exclude: string[] | undefined;
  if (raw.exclude !== undefined) {
    const ex = validateStringArray(raw.exclude, `${prefix}.exclude`, false);
    if (!ex.ok) return ex;
    exclude = ex.items;
  }

  let include: string[] | undefined;
  if (raw.include !== undefined) {
    const inc = validateStringArray(raw.include, `${prefix}.include`, false);
    if (!inc.ok) return inc;
    include = inc.items;
  }

  return {
    ok: true,
    rule: {
      name: raw.name.trim(),
      kind: raw.kind as RuleKind,
      match: raw.match,
      action,
      ...(olderThanDays !== undefined ? { olderThanDays } : {}),
      ...(exclude !== undefined ? { exclude } : {}),
      ...(include !== undefined ? { include } : {}),
    },
  };
}

function validateRules(
  raw: unknown,
): { ok: true; rules: CustomRule[] } | { ok: false; failure: ShapeFailure } {
  if (raw === undefined) return { ok: true, rules: [] };
  if (!Array.isArray(raw)) {
    return {
      ok: false,
      failure: { field: 'rules', message: '字段 rules 必须是数组' },
    };
  }
  const rules: CustomRule[] = [];
  for (let i = 0; i < raw.length; i += 1) {
    const parsed = validateSingleRule(raw[i], i);
    if (!parsed.ok) return parsed;
    rules.push(parsed.rule);
  }
  return { ok: true, rules };
}

/**
 * 校验并归一化 v2 配置对象 (调用方已分流旧版本, 本函数严格要求 `version === 2`)。
 *
 * ### 数据流转示例
 * - Input (合法省略项): `{ version: 2, presets: { rust: {} }, rules: [{ name: ' logs ', kind: 'file', match: '*.log' }] }`
 * - 流程: 顶层键白名单 -> `version === 2` -> 缺省 `roots=[defaultRoot]` & `exclude=[...defaultExclude]` (`excludeExplicit=false`) -> 预设键/子字段校验 -> 规则 `name.trim()` 且 `action` 补 `'trash'`
 * - Output: `{ ok: true, value: { version: 2, roots: [defaultRoot], exclude: [...], include: [], excludeExplicit: false, presets: { rust: {} }, rules: [{ name: 'logs', kind: 'file', match: '*.log', action: 'trash' }] } }`
 * - Input (非法): `{ version: 2, roots: [] }` 或 `{ version: 2, presets: { node: { enabled: true } } }` -> Output: `{ ok: false, failure: { field, message } }`
 */
export function parseV2ConfigObject(
  raw: unknown,
  defaultRoot: string,
  defaultExclude: readonly string[],
): { ok: true; value: NormalizedV2 } | { ok: false; failure: ShapeFailure } {
  if (!isPlainRecord(raw)) {
    return {
      ok: false,
      failure: { field: '<root>', message: '配置顶层必须是 JSON 对象' },
    };
  }
  for (const key of Object.keys(raw)) {
    if (!TOP_KEYS.has(key)) {
      return {
        ok: false,
        failure: {
          field: key,
          message: `配置包含未知字段 "${key}"`,
        },
      };
    }
  }
  if (raw.version !== 2) {
    return {
      ok: false,
      failure: {
        field: 'version',
        message: `字段 version 必须为 2 (收到 ${String(raw.version)})`,
      },
    };
  }

  let roots: string[];
  if (raw.roots === undefined) {
    roots = [defaultRoot];
  } else {
    const parsedRoots = validateStringArray(raw.roots, 'roots', false);
    if (!parsedRoots.ok) return parsedRoots;
    if (parsedRoots.items.length === 0) {
      return {
        ok: false,
        failure: {
          field: 'roots',
          message: '字段 roots 不能为空数组 (省略该字段则默认扫描家目录)',
        },
      };
    }
    roots = parsedRoots.items;
  }

  const excludeExplicit = raw.exclude !== undefined;
  let exclude: string[];
  if (!excludeExplicit) {
    exclude = [...defaultExclude];
  } else {
    const parsedExclude = validateStringArray(raw.exclude, 'exclude', true);
    if (!parsedExclude.ok) return parsedExclude;
    exclude = parsedExclude.items;
  }

  let include: string[];
  if (raw.include === undefined) {
    include = [];
  } else {
    const parsedInclude = validateStringArray(raw.include, 'include', true);
    if (!parsedInclude.ok) return parsedInclude;
    include = parsedInclude.items;
  }

  const parsedPresets = validatePresets(raw.presets);
  if (!parsedPresets.ok) return parsedPresets;

  const parsedRules = validateRules(raw.rules);
  if (!parsedRules.ok) return parsedRules;

  return {
    ok: true,
    value: {
      version: 2,
      roots,
      exclude,
      include,
      excludeExplicit,
      presets: parsedPresets.presets,
      rules: parsedRules.rules,
    },
  };
}
