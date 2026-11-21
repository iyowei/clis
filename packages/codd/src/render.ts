/**
 * 严格模板渲染器: 供 `emit-podman.ts` / `emit-podman-helpers.ts` / `emit-k8s.ts` 渲染 `.tmpl` 文件。
 * 仅替换大写蛇形占位符 `{{UPPER_SNAKE}}`; 任一变量缺失或渲染后残留未替换花括号均抛 `TemplateRenderError`,
 * 但显式放行 Go/Helm 模板表达式 `{{.Field}}` (如 `podman ps --format '{{.Names}}'`), 避免误报。
 */

export class TemplateRenderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'TemplateRenderError';
  }
}

const TOKEN_RE = /\{\{([A-Z0-9_]+)\}\}/g;
const GO_FORMAT_RE = /\{\{\.[A-Za-z0-9_.]+\}\}/g;
const LEFTOVER_BRACE_RE = /\{\{|\}\}/;

/**
 * 严格替换模板中全部 `{{KEY}}` 占位符并执行残留检查 (放行 `{{.GoField}}` 语法)。
 *
 * ### 数据流转示例
 * ```text
 * Input:  templateName = 'Makefile.tmpl'
 *         rawTemplate  = 'PORT={{MONGO_PORT}}\npodman ps --format "{{.Names}}"'
 *         vars         = { MONGO_PORT: 27117 }
 * Step 1: 正则替换 `{{MONGO_PORT}}` -> '27117'; 若有未提供键则记入 missing 并抛 TemplateRenderError
 * Step 2: 剥离 Go 占位 `{{.Names}}` 后检测是否残留 `{{` 或 `}}` -> 无残留通过
 * Output: 'PORT=27117\npodman ps --format "{{.Names}}"'
 * ```
 */
export const renderTemplate = (
  templateName: string,
  rawTemplate: string,
  vars: Record<string, string | number>,
): string => {
  const missing = new Set<string>();
  const rendered = rawTemplate.replace(TOKEN_RE, (_full, key: string) => {
    const val = vars[key];
    if (val === undefined || val === null) {
      missing.add(key);
      return `{{${key}}}`;
    }
    return String(val);
  });

  if (missing.size > 0) {
    throw new TemplateRenderError(
      `模板 ${templateName} 缺少以下必填变量: ${[...missing].join(', ')}`,
    );
  }
  const withoutGoFmt = rendered.replace(GO_FORMAT_RE, '');
  if (LEFTOVER_BRACE_RE.test(withoutGoFmt)) {
    throw new TemplateRenderError(
      `模板 ${templateName} 渲染后仍残留花括号标记 ({{ 或 }}), 请检查模板语法或变量值`,
    );
  }
  return rendered;
};
