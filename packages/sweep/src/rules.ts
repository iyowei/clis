/**
 * 自定义清理规则 (`rules`) 的安全校验、单段通配编译与年龄判定 (设计见 packages/sweep/docs/adrs/0022-config-v2-presets-and-rules.md)。
 * 上下游: 依赖 codes.ts; 供 config-validate.ts 校验、scan-match.ts 热路径匹配与年龄过滤、sweep.ts 安全闸末段核验。
 * 核心红线:
 * - `action` 缺省强制为 `'trash'`, 绝不默认永久删除;
 * - `match` 硬拒绝空串、首尾空白、`.`、`..`、`.git`、`*`、`**`、纯通配符/点号组合、路径分隔符与控制字符。
 */
import type { CleanupAction, EntryKind, RuleKind } from './codes.ts';

/** 配置文件中的自定义规则输入形态 (`action` 可省, 解析后强制补为 `'trash'`) */
export interface CustomRuleInput {
  name: string;
  kind: RuleKind;
  match: string;
  action?: CleanupAction;
  olderThanDays?: number;
  exclude?: string[];
  include?: string[];
}

/** 归一化后的自定义规则 (`action` 必填且默认 `'trash'`) */
export interface CustomRule {
  name: string;
  kind: RuleKind;
  match: string;
  action: CleanupAction;
  olderThanDays?: number;
  exclude?: string[];
  include?: string[];
}

/** 一天的毫秒数 (olderThanDays 换算基准) */
export const MS_PER_DAY = 86_400_000;

/** 显式禁止的高危/无效 match 字面值 */
const FORBIDDEN_MATCH_LITERALS: ReadonlySet<string> = new Set([
  '',
  '.',
  '..',
  '.git',
  '*',
  '**',
]);

/** 判定文本中是否含 ASCII 控制字符 (0x00..0x1f 或 0x7f, 避免控制字符正则警告) */
function hasControlChar(text: string): boolean {
  for (let i = 0; i < text.length; i += 1) {
    const code = text.charCodeAt(i);
    if (code <= 0x1f || code === 0x7f) return true;
  }
  return false;
}

/**
 * 校验自定义规则的 `match` 字段, 返回中文错误原因或 null (合法)。
 * 严禁空串、首尾空白、`.`、`..`、`.git`、`*`、`**`、纯 `*`/`.`/`?` 组合、路径分隔符与控制字符。
 *
 * ### 数据流转示例
 * - Input: `'*.log'` -> 去空白/禁表/控制字符/分隔符检查 -> 剔除 `[*?.]` 余 `'log'` 非空 -> Output: `null` (合法)
 * - Input: `'*.*'` -> 剔除 `[*?.]` 后为空 -> Output: `'match 模式 "*.*" 过于宽泛, 至少须包含明确字面字符'`
 * - Input: `'logs/*.tmp'` -> 命中路径分隔符 `/` -> Output: `'match 只能匹配单段文件或目录名, 禁止包含路径分隔符'`
 */
export function validateRuleMatch(match: string): string | null {
  const trimmed = match.trim();
  if (trimmed === '' || match !== trimmed) {
    return 'match 不能为空串或含首尾空白';
  }
  if (FORBIDDEN_MATCH_LITERALS.has(match)) {
    return `match 禁止使用危险模式 "${match}"`;
  }
  if (hasControlChar(match)) {
    return 'match 不能包含控制字符';
  }
  if (match.includes('/') || match.includes('\\')) {
    return 'match 只能匹配单段文件或目录名, 禁止包含路径分隔符';
  }
  // 拦截纯通配符/点号组合 (如 `***`、`?`、`*.*`、`.*`、`*?`), 防全盘误匹配
  const withoutWildcards = match.replace(/[*?.]/g, '');
  if (withoutWildcards.length === 0) {
    return `match 模式 "${match}" 过于宽泛, 至少须包含明确字面字符`;
  }
  return null;
}

/** 将简单文件名通配 (`*` / `?`) 编译为确定性匹配函数 (零外部依赖) */
export function compileNameMatcher(pattern: string): (name: string) => boolean {
  if (!pattern.includes('*') && !pattern.includes('?')) {
    return (name: string): boolean => name === pattern;
  }
  let regexText = '^';
  for (let i = 0; i < pattern.length; i += 1) {
    const ch = pattern[i]!;
    if (ch === '*') {
      regexText += '.*';
    } else if (ch === '?') {
      regexText += '.';
    } else if (/[.+^${}()|[\]\\]/.test(ch)) {
      regexText += `\\${ch}`;
    } else {
      regexText += ch;
    }
  }
  regexText += '$';
  const re = new RegExp(regexText);
  return (name: string): boolean => re.test(name);
}

/** 判定条目实体形态是否匹配规则的 `kind` */
export function ruleMatchesKind(ruleKind: RuleKind, kind: EntryKind): boolean {
  return ruleKind === 'any' || ruleKind === kind;
}

/** 判定文件/目录的 mtime 是否满足 `olderThanDays` 条件 */
export function isOlderThanDays(
  mtimeMs: number,
  olderThanDays: number,
  nowMs: number = Date.now(),
): boolean {
  return nowMs - mtimeMs >= olderThanDays * MS_PER_DAY;
}

/** 编译后的运行时规则, 供扫描热路径零重复编译使用 */
export interface CompiledRule {
  readonly rule: CustomRule;
  readonly matchesName: (name: string) => boolean;
  readonly exclude: ReadonlySet<string>;
  readonly include: ReadonlySet<string>;
}

/**
 * 将规则数组编译为热路径匹配结构 (扫描启动前一次编译, 遍历期间零正则重建)。
 *
 * ### 数据流转示例
 * - Input: `[{ name: 'tmp-logs', kind: 'file', match: '*.log', action: 'trash', exclude: ['keep'] }]`
 * - 流程: `compileNameMatcher('*.log')` 生成 `/^.*\.log$/` 闭包 + `exclude`/`include` 转为 `Set`
 * - Output: `[{ rule, matchesName: (s) => /^.*\.log$/.test(s), exclude: Set(['keep']), include: Set() }]`
 */
export function compileRules(
  rules: readonly CustomRuleInput[],
): CompiledRule[] {
  return rules.map((input) => {
    const rule: CustomRule = {
      ...input,
      action: input.action ?? 'trash',
    };
    return {
      rule,
      matchesName: compileNameMatcher(rule.match),
      exclude: new Set(rule.exclude ?? []),
      include: new Set(rule.include ?? []),
    };
  });
}

/** 判定叶名称是否命中任意已配置自定义规则 (用于安全闸校验) */
export function matchesAnyRuleLeaf(
  leaf: string,
  rules: readonly CustomRule[],
): boolean {
  for (const rule of rules) {
    if (compileNameMatcher(rule.match)(leaf)) return true;
  }
  return false;
}
